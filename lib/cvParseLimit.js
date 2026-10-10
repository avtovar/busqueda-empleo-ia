// ============================================================================
// RATE LIMIT DEL PARSEO DE CV, CONTRA LA BASE DE DATOS.
//
// `POST /api/cv/parse` es el ÚNICO endpoint del proyecto que llama a un LLM, y un
// LLM se paga por token con la clave del DUEÑO de la app (`LLM_API_KEY`, la misma
// historia que `APIFY_API_TOKEN`). `llm.js` acota el costo POR llamada: recorta el
// CV a 20 000 caracteres y limita la respuesta a `MAX_LLM_TOKENS`, así que el
// techo de una llamada es de unos 7 000 tokens. Lo que no acotaba era el costo
// POR CUENTA, y sin esto un usuario autenticado podía subir su CV en loop y
// vaciar la clave.
//
// Es el mismo problema que Apify con la misma solución, y esa es la razón por la
// que el límite NO es un `Map` a nivel de módulo: en Vercel cada invocación es un
// proceso distinto, así que un contador en memoria contaría SIEMPRE cero. Sería
// un límite que se ve funcionar y no detiene a nadie, que es el peor tipo de
// bug: el que pasa los tests.
//
// ── POR QUÉ UN MÓDULO APARTE Y NO UNA FUNCIÓN MÁS EN `rateLimit.js` ──────────
// `rateLimit.js` existe, funciona y tiene el patrón de ventana + `Retry-After` que
// este archivo copia. Y aun así no se le agregó la función, por cuatro razones
// concretas (las dos primeras son las que importan):
//
//   1. CUENTA COSAS DISTINTAS, Y LA DIFERENCIA ES SEMÁNTICA, NO DE ESTILO.
//      `withLoginAttempt` cuenta INTENTOS FALLIDOS de autenticación. Acá se
//      cuentan LLAMADAS PAGADAS que SALIERON BIEN. No es el mismo contador con otro
//      nombre: la fila que escribe una y la que escribe la otra no significan lo
//      mismo, y un solo módulo con las dos cosas terminaría teniendo un
//      `if (esLogin)` en el medio de la lógica de una de ellas.
//
//   2. LAS DOS FORMAS DE REUSARLO SON PEORES QUE NO REUSARLO, y son las que el
//      propio comentario de `api/profile/[...slug].js` ya descarta:
//
//        · ESCRIBIENDO una fila de `login_attempts` por cada parseo: después de
//          diez parseos el usuario NO PUEDE ENTRAR durante 15 minutos. Es un
//          denial of service contra usuarios reales, causado por un endpoint que
//          no debería tocar el login. Peor que el gasto que se está acotando.
//        · CONSULTÁNDOLO sin escribir: el contador queda en cero para cualquiera
//          que no falle un login, o sea para exactamente el atacante que se
//          quiere frenar. Sería un límite que no limita.
//
//   3. Los namespaces de configuración tienen que ser distintos Y legibles:
//      `LOGIN_LIMIT_MAX_PER_PAIR` contra `CV_PARSE_LIMIT`. En un archivo único, un
//      `CV_PARSE_LIMIT=5` junto a un `LOGIN_LIMIT=0` se mezclan y el que lea el
//      archivo para tocar uno termina tocando el otro.
//
//   4. La purga es distinta: la del login se dispara con un intento fallido y la de
//      acá con un parseo CONCEDIDO. Un solo `purgeOld()` no puede servir a las dos
//      sin inventar un parámetro que después nadie pasa.
//
// Lo que sí se comparte es la FORMA, y está copiada a mano: el `intFromEnv` de
// ocho líneas, la ventana con `make_interval`, el `Retry-After` con el header Y en
// el cuerpo, y el mensaje que no cuenta como error. Duplicar ocho líneas vale
// más que un módulo que mezcla dos cosas que no se parecen. Es la misma decisión
// que ya tomó `llm.js` con el `intFromEnv` de `auth.js`.
//
// ── LO QUE ESTE MÓDULO NO HACE ───────────────────────────────────────────────
// No valida el archivo, no extrae el texto y no llama al LLM. Solo cuenta y
// responde 429. Dónde va la llamada en el orden del endpoint es una decisión del
// endpoint (está en `api/profile/[...slug].js`, con el porqué), y no de acá.
// ============================================================================

import { query, withTransaction } from './db.js';
import { HttpError } from './http.js';

// ════════════════════════════════════════════════════════════════════════════
// VALORES POR DEFECTO
// ════════════════════════════════════════════════════════════════════════════

// Los tres números y la ventana. Configurables por variable de entorno y leídos en
// CADA llamada, no al importar el módulo, por la misma razón que `secret()` en
// `auth.js`: las variables de entorno son lo primero que se toca cuando hay que
// cambiar un límite, y cachearlas haría que el cambio no se viera hasta el cold
// start siguiente. Y leerlas en cada llamada no cuesta nada: es un `parseInt`.

// Cuántos CVs puede analizar un usuario por ventana.
const DEFAULT_MAX_PARSES = 5;

// De cuánto es la ventana.
//
// 60 minutos, y no 15 como el del login, porque el costo por llamada es otro: un
// parseo son ~7 000 tokens contra un login que es un bcrypt en local. El límite
// tiene que ser el que frena a un usuario REAL que se equivoca cinco veces
// seguida ("subí el CV pero sin tilde", "el PDF estaba al revés"), y esos cinco
// intentos tienen que poder caer todos dentro de la misma hora de trabajo.
//
// Y cinco es un número, no un capricho: el flujo real del alta es un parseo (que
// el usuario puede repetir si el LLM se equivocó con el título) y poco más. Cinco
// deja margen para reintentar y para el caso de "subí el que no era", y con el
// techo de costo por llamada de `llm.js` el peor caso de un usuario que agota la
// cuota entera es de unas 35 000 tokens: de las dos formas de conseguir una cuota
// de todos modos (registro abierto, más adelante) esta es la barata.
const DEFAULT_WINDOW_MINUTES = 60;

// Cuánto se guarda un parseo antes de la purga.
//
// 24 horas contra una ventana de 60 minutos: 24 veces de margen. Y el margen NO es
// decorativo, es la condición de que el límite sea correcto: si la retención
// llegara a ser menor que la ventana, la purga borraría filas que todavía están
// contando, el `count` bajaría solo y el usuario recuperaría cuota sin que nadie
// se lo haya otorgado. Por eso `cvParseLimitConfig()` recorta la ventana para que
// nunca alcance a la retención.
const DEFAULT_RETENTION_HOURS = 24;

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Lee un entero de una variable de entorno con default y rango.
 * @param {string} name Nombre de la variable.
 * @param {number} fallback Default.
 * @param {number} min Mínimo.
 * @param {number} max Máximo.
 * @returns {number} El valor usable.
 */
function intFromEnv(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(raw) || raw < min || raw > max) return fallback;
  return raw;
}

/**
 * La configuración del límite, leída del entorno.
 *
 * `enabled: false` apaga TODO, y existe por una sola razón: los tests y el
 * desarrollo local. Un test que tiene que hacer seis parseos seguidos para probar
 * otra cosa no debería tener que esperar una hora, y una máquina de desarrollo no
 * tiene una clave de LLM de la que protegerse. En producción nadie lo apaga, así que
 * el default es `true`.
 *
 * Un valor fuera de rango NO es un error: es el default. `CV_PARSE_LIMIT=hola` es
 * un error de dedo, no una decisión, y tirarle un `ConfigError` convertiría
 * "escribí mal el número" en "la app está caída". (Distinto del `LLM_API_KEY`, que
 * sí es `ConfigError`: sin clave no hay nada que hacer, acá sin límite hay una
 * app que funciona y cuesta plata.)
 *
 * @returns {{enabled: boolean, maxParses: number, windowMinutes: number,
 *   retentionHours: number}} La configuración.
 */
export function cvParseLimitConfig() {
  const retentionHours = intFromEnv('CV_PARSE_RETENTION_HOURS', DEFAULT_RETENTION_HOURS, 1, 24 * 365);
  const pedida = intFromEnv('CV_PARSE_LIMIT_WINDOW_MINUTES', DEFAULT_WINDOW_MINUTES, 1, 24 * 60);
  return {
    enabled: process.env.CV_PARSE_LIMIT !== '0',
    maxParses: intFromEnv('CV_PARSE_LIMIT', DEFAULT_MAX_PARSES, 1, 10_000),
    // ▲ La ventana se recorta para no comerse la retención. Es una línea y evita
    //   una configuración que parecería estar y estaría rota: con
    //   `CV_PARSE_LIMIT_WINDOW_MINUTES=1440` y 24 horas de retención, la purga
    //   empezaría a borrar filas de la ventana en curso y el límite se aflojaría
    //   solo, sin que nadie lo tocara. Un límite que se afloja solo es peor que no
    //   tenerlo, porque deja de avisar. El `- 1` es porque la ventana tiene que ser
    //   ESTRICTAMENTE menor: si fueran iguales, la fila del minuto 0 sería borrada
    //   en el mismo instante en que empieza a estar libre.
    windowMinutes: Math.min(pedida, retentionHours * 60 - 1),
    retentionHours,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EL LÍMITE
// ════════════════════════════════════════════════════════════════════════════

// El mensaje del 429.
//
// ▲ NO dice cuántos parseos se hicieron ni cuál es el límite. No es por
//   mysteriousness como en el login (allí era un oráculo sobre la existencia del
//   correo), sino porque el número es CONFIGURACIÓN INTERNA: si mañana se sube a
//   10, el mensaje no puede quedar diciendo "5 por hora". Y tampoco dice "error":
//   el usuario no rompió nada, la app lo está protegiendo de pagar su cuenta
//   veinte veces, y lo que necesita saber es cuándo puede volver a intentarlo.
//
//   El `Retry-After` va en el cuerpo Y como header, por lo mismo que en el login
//   (RFC 6585, y MEMORIA.md §2.6: un 429 sin `Retry-After` hace que un cliente con
//   backoff reintente a ciegas).
const LIMITE_ALCANZADO = 'Ya analizamos todos los CVs que podemos por hora. '
  + 'Esperá un ratito y volvé a intentarlo: tu cuenta y tu perfil no se pierden.';

/**
 * Verifica que este usuario pueda analizar otro CV, y le cuenta UNO.
 *
 * ── POR QUÉ UNA TRANSACCIÓN CON UN ADVISORY LOCK Y NO "LEER, COMPARAR, ESCRIBIR" ──
 * Esta es la parte que no se puede simplificar, y el motivo está en
 * `migrations/007_apify_usage.sql:70-78`, donde la solución de Apify fue poner el
 * `+ 1` DENTRO de un upsert. Con un contador por día ese upsert alcanza. Con una
 * VENTANA RELATIVA no, por dos razones encadenadas:
 *
 *   1. La fila que hay que insertar no se puede meter en un `on conflict do
 *      nothing`: el "conflict" que hay que detectar acá es "ya hubo N en la
 *      ventana", y eso no es una restricción de unicidad, es un `count`.
 *   2. Meter el `count` y el `insert` en UNA sola sentencia (un CTE) tampoco
 *      sirve, y la razón es de PostgreSQL, no de este proyecto: todas las
 *      sub-sentencias de un CTE con `insert` comparten EL MISMO SNAPSHOT, así que
 *      el `select` del CTE principal NO ve la fila que acaba de insertar. O sea
 *      que el `count` saldría con un parseo menos y el límite aceptaría uno de más
 *      en el primer request, para siempre. Es un error que no se ve en un test
 *      secuencial: con dos requests a la vez, los dos leen "4", los dos aceptan y
 *      quedan 6 filas con un límite de 5.
//
// Así que la fila se SERIALIZA por usuario, con un lock de transacción:
//
//   · `pg_advisory_xact_lock` es un candado de Postgres que se suelta solo cuando
//     la transacción termina, INCLUDING en el camino del ROLLBACK. No hay que
//     acordarse de liberarlo y no puede quedar colgado si la función se corta: la
//     conexión se cierra, la transacción muere y el candado se va con ella.
//   · Es POR USUARIO, no global: el hash es del `user_id`, así que dos personas
//     distintos se serializan solo si son la misma persona, y el tráfico de la app
//     no se frena entero por el rate limit de uno. El costo es un round trip, y
//     el nombre del otro usuario no puede chocar con este porque es un hash de 64
//     bits del identificador, no el identificador en crudo.
//   · `hashtextextended` y no `hashtext` porque devuelve un bigint: `hashtext`
//     devuelve un int4 y el espacio de nombres de advisory locks de una sola
//     clave son 2^32, o sea que dos usuarios distintos se bloquean entre sí con
//     probabilidad no despreciable. Es PG 11+ y el proyecto exige 13 o más.
//
// Y el `throw` del 429 va ADENTRO de la transacción a propósito: `withTransaction`
// hace ROLLBACK y no queda la fila. Es la misma propiedad que tiene el del login
// (MEMORIA.md §4.4: trece intentos dejan diez filas, no catorce) y por la misma
// razón — si el rechazo contara, cada intento rechazado extendería la ventana y el
// bloqueo sería permanente sin que nadie pudiera desbloquearse.
//
// ── POR QUÉ EL LLM SE LLAMA DESPUÉS DE QUE ESTO TERMINE ─────────────────────
// Porque la transacción se committea antes de que el endpoint llame al proveedor
// (ver el paso 5 de `api/profile/[...slug].js`). El candado dura lo que dura el `count` y
// el `insert`, no lo que dura la llamada al LLM: si el lock quedara tomado durante
// los 25 segundos del `fetch`, dos requests del mismo usuario se pondrían en
// fila, y el segundo pagaría su parseo para recibir un 429 que no le corresponde.
// Serializar el CONTEO es barato; serializar la llamada de pago, no.
//
// ── LO QUE CUENTA Y LO QUE NO ────────────────────────────────────────────────
// Cuenta: los parseos que llegan hasta acá, o sea los que van a pagar tokens. Un
// 502, un 504 o un `finish_reason: 'length'` DESPUÉS de esta función cuentan
// igual, y es deliberado: los tokens ya se facturaron aunque la respuesta no
// llegara, y contar después dejaría el límite sin efecto contra un atacante que
// dispara llamadas que dan timeout. El precio es un falso positivo acotado.
//
// NO cuentan: los 401 (no hay sesión, no hay `user_id`), los 415/413/400 de
// archivo (van antes, en el endpoint) y los 429 de esta misma función (el ROLLBACK).
//
// @param {string} userId UUID del usuario, de `requireSession(req).user.id`.
 * @returns {Promise<{allowed: true, used: number, remaining: number,
 *   limit: number, windowMinutes: number}>} El estado del contador después de
 *   contar este parseo.
 * @throws {HttpError} 429 con `Retry-After` si ya se agotó la cuota de la ventana.
 */
export async function assertCvParseAllowed(userId) {
  if (typeof userId !== 'string' || !userId) {
    // ↑ No es un 4xx del usuario: es un endpoint que llamó mal a la función. Se
    //   dice explícitamente para que un `null` en column "user_id"` de Postgres
    //   (o una violación de la FK, si el id no existe) no sea el primer síntoma de
    //   que el `user_id` no vino de `requireSession`.
    throw new Error('assertCvParseAllowed necesita un userId de requireSession.');
  }

  const cfg = cvParseLimitConfig();
  if (!cfg.enabled) {
    return {
      allowed: true,
      used: 0,
      remaining: cfg.maxParses,
      limit: cfg.maxParses,
      windowMinutes: cfg.windowMinutes,
    };
  }

  const estado = await withTransaction(async (client) => {
    // 1) El candado, primero. Todo lo de abajo corre ya con el usuario tomado.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);

    // 2) El count de la ventana. UNA sola fila, con el `min(parsed_at)` que arma el
    //    `Retry-After`: el tiempo que falta no se calcula con "la ventana entera"
    //    (que sería mentira si hace dos minutos que hubo un parseo) sino con la
    //    fila más vieja, que es la que se libera primero.
    //
    //    `count(*)::int` y no `count(*)` a secas: `count` devuelve `int8`, que
    //    `pg` deja como string (db.js §2.4) y que hay que castear para no
    //    compararlo con un número. El cast a `int4` no puede desbordar con una
    //    ventana de un día y una retención de 24 horas.
    const { rows } = await client.query(
      `select count(*)::int as total, min(parsed_at) as primero
         from cv_parses
        where user_id = $1
          and parsed_at > now() - make_interval(mins => $2)`,
      [userId, cfg.windowMinutes],
    );
    const fila = rows[0] || {};
    const usados = Number(fila.total || 0);

    // 3) El límite. `>=` y no `>`: con el límite en 5, el quinto parseo es el
    //    último que pasa y el sexto es el que choca. Un `>` permitiría un sexto.
    if (usados >= cfg.maxParses) {
      // El `throw` entra en la transacción y la hace ROLLBACK. Ver el bloque de
      // arriba: es lo que hace que un 429 no cuente.
      const antiguedad = fila.primero
        ? (Date.now() - new Date(fila.primero).getTime()) / 1000
        : 0;
      const retryAfterSeconds = Math.max(1, Math.ceil(cfg.windowMinutes * 60 - antiguedad));
      // ↑ Se usa `Date.now()` y no el `now()` de Postgres por lo mismo que en el
      //   login: el número va en una cabecera HTTP y lo cuenta el reloj del que
      //   recibió la respuesta. La diferencia entre los dos relojes es de
      //   milisegundos y no importa; lo que importa es que sea decreciente.
      //
      //   `fila.primero` no puede ser null acá (`min()` de al menos una fila que
      //   `usados >= 1` garantiza), pero el `|| 0` evita un `NaN` en un header si
      //   algún día la consulta cambia: un `Retry-After: NaN` es peor que un
      //   segundo de espera.
      throw new HttpError(
        429,
        LIMITE_ALCANZADO,
        {
          retryAfterSeconds,
          // En el cuerpo va el dato para el frontend, que es el único que sabe
          // traducirlo a un mensaje en pantalla.
          retryAfter: retryAfterSeconds,
        },
        // Y ACÁ va el header de verdad: `Retry-After` es obligatorio en un 429
        // (RFC 6585) y lo leen los clientes que hacen backoff sin mirar el JSON.
        { 'Retry-After': String(retryAfterSeconds) },
      );
    }

    // 4) El insert. Dentro de la misma transacción y después del `count`: si
    //    estuviera antes, el count ya lo vería y el primer parseo de cada usuario
    //    se contaría dos veces.
    await client.query('insert into cv_parses (user_id) values ($1)', [userId]);

    return {
      allowed: true,
      used: usados + 1,
      remaining: Math.max(0, cfg.maxParses - usados - 1),
      limit: cfg.maxParses,
      windowMinutes: cfg.windowMinutes,
    };
  });

  // 5) La purga, AFUERA de la transacción y con los errores tragados. Ver la nota
  //    de `purgeOldCvParses`. Va acá y no dentro porque es una operación global
  //    sobre todos los usuarios y no tiene nada que ver con la transacción del
  //    usuario: si fallara, tiene que fallar sola.
  await purgeOldCvParses();

  return estado;
}

// ════════════════════════════════════════════════════════════════════════════
// PURGAR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Borra los parseos viejos, los que ya no cuentan para ninguna ventana.
 *
 * Oportunista, y la decisión es la MISMA que la de 007 (`apify_usage`) y la de 009
 * (`login_attempts`): en esta app no hay cron —las funciones de Vercel no corren
 * por sí solas— así que la purga se dispara desde el único lugar que escribe en
 * la tabla, que es un parseo CONCEDIDO. Con la ventana en 60 minutos y la
 * retención en 24, cada request borra casi siempre cero filas; la primera de la
 * mañana es la que hace trabajo. Y funciona igual aunque el tráfico sea bajo: si
 * nadie parsea, no hay filas nuevas y no hay nada que crezca.
 *
 * El error se traga a propósito, igual que en `purgeOldAttempts`: si la purga
 * falla, el parseo tiene que devolver el 200 de siempre. Tirar acá convertiría
 * "no se pudo limpiar una tabla de conteo" en "el usuario no puede cargar su CV",
 * que es un problema de permisos o de conexión presentado como un problema del
 * CV.
 *
 * La purga es GLOBAL y por `parsed_at`, así que usa el índice `cv_parses_time_idx`
 * y no el de `user_id`: es un range scan sobre la ventana de retención, no un
 * recorrido de la tabla entera.
 *
 * @returns {Promise<void>}
 */
export async function purgeOldCvParses() {
  const cfg = cvParseLimitConfig();
  try {
    await query(
      'delete from cv_parses where parsed_at < now() - make_interval(hours => $1)',
      [cfg.retentionHours],
    );
  } catch (err) {
    console.warn('[cv-parse-limit] no se pudo purgar cv_parses: %s', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PARA LOS TESTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * ¿Cuántos parseos lleva este usuario dentro de la ventana?
 *
 * NO lo usa el endpoint: existe para que un script de verificación pueda
 * comprobar que el límite corta de verdad, que un 429 NO cuenta, y que la ventana
 * se abre sola, sin tener que inferirlo del estado de la base a ojo. Es la misma
 * razón por la que `rateLimit.js` tiene `countRecentAttempts`, y por eso la
 * función es pública y no un detalle interno.
 *
 * NO llama a `assertCvParseAllowed` a propósito: Contar no puede contar. Reusar la
 * función del límite para esto insertaría una fila por cada verificación, que es
 * justo el defecto que este módulo existe para no tener.
 *
 * @param {string} userId UUID del usuario.
 * @returns {Promise<{used: number, remaining: number, limit: number,
 *   windowMinutes: number, oldestParsedAt: string|null}>} El estado real.
 */
export async function countRecentCvParses(userId) {
  const cfg = cvParseLimitConfig();
  const { rows } = await query(
    `select count(*)::int as total, min(parsed_at) as primero
       from cv_parses
      where user_id = $1
        and parsed_at > now() - make_interval(mins => $2)`,
    [userId, cfg.windowMinutes],
  );
  const fila = rows[0] || {};
  const usados = Number(fila.total || 0);
  return {
    used: usados,
    remaining: Math.max(0, cfg.maxParses - usados),
    limit: cfg.maxParses,
    windowMinutes: cfg.windowMinutes,
    oldestParsedAt: fila.primero ? new Date(fila.primero).toISOString() : null,
  };
}
