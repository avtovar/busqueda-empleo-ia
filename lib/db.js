// ============================================================================
// ACCESO A POSTGRES.
//
// Este es el ÚNICO lugar del proyecto que abre conexiones. Si alguna función
// serverless o algún script abre una por su cuenta, se multiplican los slots
// contra Neon y la app se cae con "too many connections" sin que se vea de quién
// fue la culpa.
//
// La app es serverless, y eso cambia todo lo que uno haría con `pg` en una app
// monolítica:
//   1. Cada invocación de Vercel tiene su propio proceso. El "pool" no se
//      comparte entre requests: N requests en paralelo son N pools. Por eso
//      `max` es chiquito y no el `max: 10` que trae `pg` por default.
//   2. `/api/health` tiene que responder SIN base de datos: es el smoke test del
//      deploy, y si este módulo abriera una conexión al importarse, un problema de
//      red de Neon haría que el deploy "fallara" con la función perfectamente
//      sana. Por eso el pool se crea LA PRIMERA VEZ que alguien consulta de verdad.
//
// NO lleva `export const config`: eso es para las funciones de Vercel que
// exportan GET/POST, y esto es una librería.
// ============================================================================

import { Pool, types } from 'pg';

// ---------------------------------------------------------------------------
// Tipos del driver: NUMERIC → number.
//
// Va a NIVEL DE MÓDULO, y por eso está acá arriba y no adentro de `getPool()`. Es
// un ajuste GLOBAL del driver, no una opción de conexión: registrar el parser lo
// aplica a todos los clientes del pool, así que tiene que estar hecho al importar
// el archivo —o sea ANTES de la primera query— y no en un camino que alguien se
// pueda saltear (por ejemplo, ponerlo en `getPool()` detrás del chequeo de
// `DATABASE_URL`: un import temprano, un test o un script que use `types` sin
// pool, quedan sin el ajuste).
//
// EL PROBLEMA: `pg` devuelve NUMERIC como STRING. Su parser por defecto es la
// identidad (`pg-types`), y hay razón: un `numeric` de Postgres es un decimal
// exacto de precisión arbitraria, que un float de JS no representa. En este
// proyecto eso es `skills.weight` llegando como '0.900' y
// `profiles.years_experience` como '5.5'. Lo que revienta es cualquier
// `.toFixed()`, y también cualquier interpolación que asuma número.
//
// Y ACÁ ESTÁ LA PARTE QUE HACE QUE EL DEFECTO NO SE DESCUBRA SOLO:
//
//   weight * 100        →  90    funciona: `*` coerce la string en silencio
//   weight.toFixed(2)   →  TypeError: w.toFixed is not a function
//
// La aritmética del score de `matcher.js` multiplica, así que da un número con
// la apariencia de estar bien; el mismo dato revienta recién en el formateo de la
// UI. Por eso el parser no puede quedar como "un `Number()` cuando alguien se
// acuerde": la mitad de los usos del dato esconden el bug, y eso da verde a un
// test que solo mira el score.
//
// POR QUÉ SOLO NUMERIC Y NO OTROS TIPOS:
//   - `int8`/`bigint` (OID 20) también viene como string, y es A PROPÓSITO: un
//     int64 no cabe exacto en un number de JS (2^53), así que parsearlo
//     convertiría ids y contadores grandes en números que ya no son el número que
//     uno cree. Es la decisión correcta de `pg`, no un olvido: no se toca.
//   - `int4` (OID 23), `float4`/`float8` y los demás YA llegan como number. No hay
//     nada que arreglar y tocar su parser solo agrega riesgo.
// NUMERIC es el único decimal roto del esquema, y el único que se toca.
//
// SOBRE EL NULL, que es la trampa de esta línea: `Number('')` es `0` y
// `Number('abc')` es `NaN`, así que un parser ingenuo convierte "sin dato" en
// "peso 0" — y en el match de skills un peso ausente NO es lo mismo que un peso de
// 0 real (uno es "no lo declaraste", el otro es "lo declaraste en cero"). No hace
// falta blindarlo a mano porque `pg` ni le llama al parser a un NULL:
// `pg/lib/result.js:63-76` corta antes con `if (rawValue !== null) ... else
// row[campo] = null`, y `_parseRowAsArray:50-61` hace lo mismo para filas como
// array. Un `numeric` NULL llega como `null` sí o sí. Lo que sí llega al parser es
// texto que Postgres YA validó como numeric, así que `Number` no puede inventarse
// un 0. Un caso raro que sí existe y sale bien: el literal `NaN` de Postgres llega
// como el string 'NaN' y se convierte en el NaN de JS, que es su equivalente
// honesto.
// ---------------------------------------------------------------------------
types.setTypeParser(types.builtins.NUMERIC, Number);

// ---------------------------------------------------------------------------
// Defaults. Todos configurables por variable de entorno, todos elegidos pensando
// en serverless. El porqué de cada uno está arriba de la constante.
// ---------------------------------------------------------------------------

// Conexiones máximas POR INVOCACIÓN.
//
// El piso es 2 y no 1 por una razón de corrección, no de performance:
// `withTransaction()` retiene un cliente durante toda la transacción, así que si
// dentro del callback alguien llama a `query()` —que toma otro cliente del MISMO
// pool— con `max: 1` esa query espera por siempre y la función revienta al tocar
// `maxDuration: 30`. Con 2 el caso más común del proyecto (escribir `profiles` y
// `skills` en la misma transacción) funciona.
//
// Y el techo es bajo a propósito: Neon da una cantidad finita de conexiones por
// rama y el pooler las reparte entre invocaciones. `max: 30` con 20 invocaciones
// en paralelo son 600 conexiones pedidas; con 2, el pico es 40.
const DEFAULT_POOL_MAX = 2;

// Tiempo que un cliente puede quedar ocioso antes de cerrarse.
//
// El default de `pg-pool` son 30 s, que es JUSTO lo que dura `maxDuration` de una
// función: el cliente se queda checked-out hasta el último instante sin hacer
// nada, ocupándole un slot a Neon. 10 s devuelve los slots mucho antes.
const DEFAULT_POOL_IDLE_MS = 10_000;

// Si la base no responde, hay que enterarse en 10 s y no en 30. En serverless la
// función tiene un reloj: esperar es gastar el tiempo de otra cosa.
const CONNECT_TIMEOUT_MS = 10_000;

// Aparece en `pg_stat_activity`. Cuando algo se cuelga, esta es la forma de saber
// si fue una función de este proyecto y cuál.
const APPLICATION_NAME = 'busqueda-empleo-ia';

// ---------------------------------------------------------------------------
// Estado del pool. Vive a nivel de módulo y NO se exporta: nadie más que este
// archivo tiene derecho a crearlo o cerrarlo.
// ---------------------------------------------------------------------------

/** @type {import('pg').Pool|null} `null` hasta la primera consulta real. */
let pool = null;

/**
 * Lee un entero de una variable de entorno, con default si no es válida.
 *
 * No avisa cuando el valor es inválido, a propósito: esto se lee en cada cold
 * start y un `console.warn` por un número mal tipeado llena el log de Vercel de
 * ruido por algo que tiene un default sensato. Está documentado en `.env.example`.
 * @param {string} name Nombre de la variable.
 * @param {number} fallback Valor a usar si no está, está vacía o no es entero ≥ min.
 * @param {number} min Mínimo aceptable.
 * @returns {number} El valor parseado o el default.
 */
function intFromEnv(name, fallback, min = 1) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw >= min ? raw : fallback;
}

// ---------------------------------------------------------------------------
// TLS.
//
// La `DATABASE_URL` de Neon ya trae `?sslmode=require` y `pg` lo interpreta solo:
// `pg-connection-string/index.js:77-156` saca un objeto `ssl` del `sslmode`, y
// `pg/lib/connection-parameters.js:59-60` le DA PRIORIDAD al connection string
// sobre cualquier `ssl` que le pasemos. O sea que, si la URL trae `sslmode`,
// mandarle un `ssl` no cambiaría nada.
//
// La regla igual es NO tocar `ssl` cuando la URL trae `sslmode`, y el porqué no es
// que `pg` lo ignore: es que `sslmode=disable` (una base local que no habla TLS) es
// una decisión HUMANA que no tenemos derecho a pisar con un `require`. El día que
// `pg` 9 cambie ese orden de prioridades, este código sigue diciendo la verdad.
//
// Cuando la URL NO trae `sslmode` y el host no es local, se agrega
// `ssl: { rejectUnauthorized: true }`. Dos comentarios sobre por qué `true` y no
// `false`:
//   - `rejectUnauthorized: false` —lo que hacen casi todos los tutoriales— cifra
//     el tráfico pero no verifica CONTRA QUIÉN: abre la puerta a un man in the
//     middle que se haga pasar por la base. Con las credenciales de la app en
//     juego, no verificar es peor que no cifrar, porque el error pasa inadvertido.
//   - `true` NO es más estricto que lo que hace la propia `pg` con
//     `sslmode=require`, que deja `rejectUnauthorized` en su default, o sea
//     `true`. Neon y Supabase sirven certificado de CA pública: verificar funciona
//     y no hay que bajar ningún bundle de CA.
// Si algún día el certificado no valida, la salida es `sslrootcert=` en la URL (o
// `NODE_EXTRA_CA_CERTS`), nunca desactivar la verificación.
//
// Y al revés para una base SIN TLS (un Postgres en Docker, por ejemplo): ahí hay
// que poner `?sslmode=disable` en la URL. No es opcional: `pg/lib/connection.js:84-86`
// hace que el servidor conteste `N` al pedido de TLS y `pg` tira "The server does
// not support SSL connections" y cierra. `pg` NO degrada a texto plano solo, así
// que un `ssl` de más rompe la conexión en vez de molestarla. Por eso la decisión
// se toma mirando el host y no encogiéndose.
// ---------------------------------------------------------------------------

/**
 * Host de la `DATABASE_URL`, en minúsculas; `''` si es un socket Unix (URL válida
 * sin host), o `null` si la URL ni se puede parsear.
 * @param {string} url Connection string.
 * @returns {string|null} El hostname, `''`, o `null` si es ilegible.
 */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // ↑ `null` y no `''`, y la diferencia importa: `''` es una URL válida de
    //   socket Unix (o sea, 100% local), mientras que `null` es una URL que no se
    //   entiende. `null` NO se trata como local: si no sabemos a dónde vamos, la
    //   apuesta segura es cifrar. Mandar credenciales en claro a un host remoto
    //   es un agujero silencioso; activar TLS de más en una base local solo
    //   produce un error visible de `pg` en el primer arranque.
    return null;
  }
}

/**
 * ¿El host es de esta máquina?
 * @param {string|null} host Host de la `DATABASE_URL`, ya en minúsculas.
 * @returns {boolean} Si es local o un socket Unix. `null` (ilegible) NO es local.
 */
function isLocalHost(host) {
  // ↑ El caso desconocido cae en `false` a propósito, y es lo que hace que una URL
  //   rota termine con `ssl` activado en vez de desactivado.
  if (host === null) return false;
  return host === ''
    || host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '0.0.0.0'
    || /^127\./.test(host)
    || host.endsWith('.localhost')
    // ↑ `.local` y `.localhost` cuben los nombres de los contenedores y de la red
    //   local, que no salen a internet y no tienen nada que interceptar.
    || host.endsWith('.local');
}

/**
 * Decide el objeto `ssl` de la configuración del pool.
 * @param {string} url Connection string completa.
 * @returns {object|undefined} `undefined` = que decida `pg`, o sea no tocarlo.
 */
function sslFor(url) {
  // La URL manda: si el humano puso `sslmode`, se respeta tal cual.
  if (/[?&]sslmode=/i.test(url)) return undefined;
  // Host local sin `sslmode`: no hay nada que cifrar contra nadie.
  if (isLocalHost(hostOf(url))) return undefined;
  return { rejectUnauthorized: true };
}

/**
 * La configuración del pool, sin abrir nada. Exportada para poder inspeccionarla
 * desde un script (y para que el error de configuración se vea sin una conexión).
 * @returns {object} Configuración lista para `new Pool(...)`.
 */
export function poolConfig() {
  const url = process.env.DATABASE_URL || '';
  const config = {
    connectionString: url,
    // ↑ 2, no el 10 de `pg`. Ver el porqué de la constante.
    max: intFromEnv('PG_POOL_MAX', DEFAULT_POOL_MAX, 1),
    // ↑ 10 s, no los 30 s de `pg-pool`.
    idleTimeoutMillis: intFromEnv('PG_POOL_IDLE_MS', DEFAULT_POOL_IDLE_MS, 0),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: APPLICATION_NAME,
    // ↑ Si queda un cliente ocioso, que Node pueda salir. `pg-pool/index.js:417-425`
    //   hace `unref()` del timer y del socket con esto. Sin él, cualquier script que
    //   consulte la base y termine sin llamar a `closePool()` queda colgado para
    //   siempre en vez de terminar.
    allowExitOnIdle: true,
  };
  // La clave solo se agrega si hay algo que decidir. Mandar `ssl: undefined` es
  // indistinguible de no mandarla, pero no mandarla deja el comentario de arriba
  // diciendo la verdad sobre lo que hace el código.
  const ssl = sslFor(url);
  if (ssl) config.ssl = ssl;
  return config;
}

/**
 * El pool, creándolo la primera vez que se lo pide.
 *
 * Importar este módulo NO conecta con la base: recién en esta función se valida
 * `DATABASE_URL` y se abre el socket. Es lo que permite que importar medio backend
 * sea gratis para las funciones que no tocan la base.
 * @returns {import('pg').Pool} El pool, reutilizado en las llamadas siguientes.
 * @throws {Error} Si falta `DATABASE_URL`.
 */
export function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    // ↑ Un error que dice QUÉ HACER, no el `TypeError: connectionString: undefined`
    //   que tiraría `pg`. El primero se arregla en 30 segundos; el segundo manda a
    //   buscar el problema a ciegas por todo el proyecto.
    throw new Error(
      'Falta DATABASE_URL.\n'
      + '  · Local: copiá .env.example a .env y pegá la URL de Neon\n'
      + '    (Neon > Connection Details > Pooled connection: es la del pooler, no la directa).\n'
      + '  · Vercel: Settings > Environment Variables > DATABASE_URL.\n'
      + 'La URL es una credencial: va solo en variables de entorno, nunca en el código.',
    );
  }
  pool = new Pool(poolConfig());
  // ↑ Si el pool emite un error en background —una conexión que se cae sola, que en
  //   serverless pasa todo el tiempo— sin listener, Node lo sube como excepción no
  //   manejada y tumba la función. Este listener lo traga a propósito.
  pool.on('error', () => {});
  return pool;
}

/**
 * Toma un cliente del pool y devuelve un `release` que se puede llamar UNA sola vez
 * (las llamadas siguientes no hacen nada).
 *
 * Existe porque `pg-pool/index.js:372-375` tira `throwOnDoubleRelease()` si se
 * libera dos veces: cualquier camino de error tiene que poder liberar "por las
 * dudas" sin que eso se convierta en un segundo bug, más difícil de encontrar.
 * @returns {Promise<{client: import('pg').PoolClient, release: (err?: Error) => void}>}
 *   El cliente y su liberador.
 */
async function checkout() {
  const client = await getPool().connect();
  let released = false;

  return {
    client,
    release(err) {
      if (released) return;
      released = true;
      // ↑ Con error, `pg-pool/index.js:392` destruye el cliente en vez de
      //   devolverlo al pool. Se usa cuando la conexión quedó en estado desconocido.
      client.release(err);
    },
  };
}

/**
 * Corre una query.
 *
 * Es el atajo para el 90% de las llamadas: el pool toma un cliente, corre la query
 * y lo devuelve solo. Para lo que `query()` no alcanza —transacciones, `COPY`,
 * cursores, un `SET` de sesión que deba valer para varias queries— están
 * `withClient()` y `withTransaction()`.
 * @param {string} text SQL con placeholders `$1`, `$2`, ...
 * @param {any[]} [params] Valores de los placeholders. NUNCA interpolar strings
 *   adentro del SQL: un `${userId}` en el texto es inyección SQL esperando.
 * @returns {Promise<import('pg').QueryResult<any>>} El resultado de `pg`.
 */
export function query(text, params) {
  // ↑ Sin `async` a propósito: se reenvía la promesa de `pg` sin agregar un
  //   microtask. El error de "falta DATABASE_URL" se sigue lanzando, porque
  //   `getPool()` se evalúa antes de que exista la promesa.
  return getPool().query(text, params);
}

/**
 * Toma un cliente, se lo pasa a `fn`, y lo devuelve al pool SIEMPRE.
 *
 * El `finally` es lo importante: sin él, cualquier `throw` adentro del callback
 * deja el cliente tomado del pool para siempre y, a las pocas invocaciones, el
 * pool se queda sin conexiones y la app entera se cuelga.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>|T} fn Qué hacer con el cliente.
 * @returns {Promise<T>} Lo que devuelva `fn`.
 */
export function withClient(fn) {
  return checkout().then(({ client, release }) =>
    Promise.resolve(fn(client)).finally(() => release()));
}

/**
 * Corre `fn` dentro de una transacción: si tira, hace ROLLBACK y vuelve a tirar.
 *
 * Todo el `BEGIN`..`COMMIT` va por UN SOLO cliente. Pedirlos al pool por separado
 * sería un bug: cada `query()` puede caer en una conexión distinta, y la
 * transacción dejaría de ser una transacción.
 *
 * El error que ve el que llama es el ORIGINAL. Si el ROLLBACK falla también —la
 * conexión se cortó justo ahí— ese error se descarta a propósito: reportar el
 * rollback en lugar del error de negocio esconde la causa real, que es la que
 * sirve para arreglar algo. En ese caso sí se destruye la conexión con
 * `release(err)`: una transacción que quedó abierta no puede devolver ese cliente
 * al pool sin envenenar el resto.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>|T} fn Lo que deba ser atómico.
 * @returns {Promise<T>} Lo que devuelva `fn`, ya committeado.
 */
export async function withTransaction(fn) {
  const { client, release } = await checkout();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      release(rollbackErr);
    }
    throw err;
  } finally {
    release();
  }
}

/**
 * Cierra el pool y lo deja en `null`.
 *
 * Para los scripts: sin esto el proceso no termina nunca, porque quedan sockets y
 * timers abiertos sosteniendo el event loop. Es idempotente —se puede llamar dos
 * veces sin romper— y deja el módulo listo para reconectar si se lo vuelve a usar,
 * que es lo que pasa si el mismo proceso consulta otra vez más tarde.
 * @returns {Promise<boolean>} Si había un pool que cerrar.
 */
export async function closePool() {
  if (!pool) return false;
  const dying = pool;
  // ↑ Se pone en `null` ANTES del `await`: si dos cosas llaman a `closePool()` a
  //   la vez, la segunda ya no tiene pool que cerrar y no se queda esperando un
  //   `end()` que ya se está haciendo.
  pool = null;
  await dying.end();
  return true;
}