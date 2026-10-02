#!/usr/bin/env node
// ============================================================================
// RUNNER DE MIGRACIONES.
//
// Aplica los archivos de `migrations/*.sql` en orden ascendente de nombre, una
// transacción por archivo, y deja registrado en `schema_migrations` cuáles ya
// están aplicados. Este es el archivo que `package.json:17` ya declaraba y que no
// existía: sin él, `npm run migrate` fallaba.
//
// NO es una función serverless, así que no lleva `export const config`: eso solo
// lo usan los archivos de `api/` que exportan GET/POST. Este corre en tu máquina
// (o en CI), una vez, a mano.
//
// Las reglas del proyecto: cada migración es su propia transacción; si un archivo
// falla, el runner para y NO aplica los siguientes (aplicar 004 sin 003 deja el
// esquema en un estado que nadie pidió); y un archivo ya aplicado cuyo contenido
// cambió es un error HUMANO que se reporta, no se pisa en silencio. Este proyecto
// no tiene migraciones de rollback: eso hace que "reaplicar lo editado" sea peor
// que "no hacer nada", porque el schema de producción ya se construyó con el
// contenido viejo.
// ============================================================================

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closePool, withClient } from '../api/lib/db.js';

// La raíz del repo: el lugar donde vive package.json. Todo se resuelve desde acá
// para que el script funcione sin importar desde dónde se lo ejecute.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const ENV_FILE = join(ROOT, '.env');

// Solo `.sql`. Un `README.md`, un `.gitkeep` o un `schema.sql.bak` en la carpeta
// no son migraciones y no se tocan.
const IS_SQL = /\.sql$/i;
// El prefijo `001_` es lo que hace que el orden lexicográfico coincida con el
// cronológico. Sin ceros a la izquierda, `010_x.sql` ordenaría antes que `9_y.sql`.
const HAS_PREFIX = /^\d+_/;

// Clave del advisory lock. Va dentro del SQL y no como parámetro $1 porque es
// una constante del proyecto, no un dato: `hashtext` la deriva del nombre en el
// servidor, así que es legible y todas las corridas del proyecto toman el mismo
// lock sin tener que coordinarse. (Postgres tiene dos versiones de la función: la
// de dos int y la de un bigint; por eso el `::bigint`, para que no haya ambigüedad
// al resolver cuál se está llamando.)
const LOCK_KEY = "hashtext('busqueda_empleo_ia:migrate')::bigint";

const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 500;

/**
 * Error esperado: algo que puede hacer un humano (olvidó una variable, editó un
 * archivo ya aplicado, tiene un `.sql` con error de sintaxis). Se imprime solo el
 * mensaje, sin stack trace, porque un stack de 40 líneas de `pg` esconde la
 * línea que dice qué hacer. Cualquier otro error (bug, red) sí muestra el stack,
 * porque ahí el stack es la información.
 */
class MigrateError extends Error {}

/**
 * Lee `.env` si existe, SIN sobrescribir lo que ya está en el entorno.
 *
 * Por qué a mano y no con `dotenv`: en el proyecto origen (`F:\busqueda_trabajo`)
 * `dotenv` era la ÚNICA dependencia de runtime, y tenía sentido. Acá ya están `pg`,
 * `bcryptjs`, `mammoth` y `pdf-parse`: sumar una sexta dependencia para parsear 20
 * líneas de texto no se justifica. Y leer el archivo es tarea de `node:fs`.
 *
 * Por qué no `node --env-file=.env`: también existe (Node ≥20.6) pero es una
 * bandera de la línea de comandos, no algo que se pueda hacer desde adentro del
 * script, y si `.env` no existe el proceso muere antes de imprimir un mensaje
 * nuestro. Además `node --env-file` pisa el entorno real, y en local eso
 * significa que un `.env` viejo le gana a la variable que exportaste en la terminal.
 *
 * NO sobrescribir lo que ya está es exactamente por eso: en Vercel (o en un CI)
 * las variables reales del entorno mandan sobre cualquier `.env` del repo.
 * @returns {boolean} Si se leyó el archivo.
 */
function loadEnvFile() {
  if (!existsSync(ENV_FILE)) return false;
  const raw = readFileSync(ENV_FILE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;   // vacías y comentarios
    // `export FOO=bar` también es válido en un .env.
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    // `eq <= 0`: sin `=` no es una asignación, y con `=` en la posición 0 tampoco
    // (el nombre de la variable estaría vacío). Se ignora en vez de tirar: un .env
    // con una línea rara no debería impedir correr migraciones.
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
    if (quoted) {
      // ↑ Con comillas, el contenido va literal: un `#` adentro no es comentario.
      value = quoted[2];
    } else {
      // Comentario al final SOLO si el `#` va precedido de espacio, así un valor
      // con `#` adentro no se corta (no toda contraseña tiene solo letras).
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

/**
 * Los archivos de migración, ordenados.
 * @returns {string[]} Nombres de archivo (no rutas) en orden ascendente.
 * @throws {MigrateError} Si la carpeta no existe.
 */
function listMigrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new MigrateError(
      `No existe la carpeta ${MIGRATIONS_DIR}.\n`
      + '  Las migraciones SQL del proyecto van en migrations/NNN_nombre_en_snake.sql.\n'
      + '  Si la acabás de clonar, es normal que todavía no esté: no hay nada que aplicar.',
    );
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => IS_SQL.test(name) && statSync(join(MIGRATIONS_DIR, name)).isFile())
    .sort();
  // ↑ Orden lexicográfico sobre el NOMBRE, no sobre la fecha de modificación: las
  //   migraciones se ordenan por número, no por cuándo se escribió el archivo.
  return files;
}

/**
 * Lee un archivo de migración una sola vez, como Buffer.
 *
 * Buffer y no string a propósito: el checksum tiene que ser el sha256 de los
 * BYTES CRUOS del archivo, y si se leyera como texto y se volviera a codificar
 * podría dar un hash distinto al del archivo en disco (BOM, finales de línea o
 * cualquier rareza de encoding). Con el Buffer en la mano, el hash y el SQL salen
 * de los mismos bytes, garantizado.
 * @param {string} name Nombre del archivo.
 * @returns {Buffer} Los bytes del archivo.
 */
function readMigration(name) {
  return readFileSync(join(MIGRATIONS_DIR, name));
}

/**
 * Saca el BOM de un texto SQL.
 * Los editores de Windows a veces guardan UTF-8 con BOM, y Postgres no lo entiende
 * al principio de un statement: el error que tira es de sintaxis en la línea 1, que
 * no dice nada de un BOM. Dos caracteres y el archivo anda.
 * @param {string} text Texto del archivo.
 * @returns {string} El texto sin BOM inicial.
 */
function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

/**
 * Espera un instante.
 * @param {number} ms Milisegundos.
 * @returns {Promise<void>} Se resuelve pasado el tiempo.
 */
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Toma el lock de corrida, o se rinde si otro la tiene mucho rato.
 *
 * Usa `pg_try_advisory_lock` y no `pg_advisory_lock` a secas. Los dos toman
 * EXACTAMENTE el mismo lock (comparten el espacio de nombres), así que la
 * garantía de que no se apliquen dos veces la misma migración es la misma; lo que
 * cambia es qué ve el segundo runner: con el lock bloqueante se queda esperando
 * en silencio y parece colgado, y con este se le puede avisar cada medio segundo y
 * finalmente decirle que hay otra migración corriendo. Para un comando que alguien
 * corre en una terminal, eso vale mucho más.
 *
 * OJO: el lock es de SESIÓN, no de transacción. Por eso este cliente del pool se
 * reserva para toda la corrida y no se suelta nunca: si se pidiera con `query()` a
 * pelo, el pool lo devolvería y el lock se quedaría ahí colgado hasta que la
 * conexión muriera.
 * @param {import('pg').PoolClient} client Cliente dedicado de la corrida.
 * @returns {Promise<void>} Cuando tiene el lock.
 * @throws {MigrateError} Si otro runner lo tiene y no lo suelta a tiempo.
 */
async function acquireLock(client) {
  const budget = Number.parseInt(process.env.MIGRATE_LOCK_TIMEOUT_MS || '', 10);
  const timeout = Number.isInteger(budget) && budget > 0 ? budget : DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  let avisado = false;
  for (;;) {
    const res = await client.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`);
    if (res.rows[0].locked) return true;
    if (Date.now() >= deadline) {
      throw new MigrateError(
        'Otra migración está corriendo y no terminó en '
        + `${Math.round(timeout / 1000)} s.\n`
        + '  Esperala, o mirá quién la tiene:\n'
        + "    SELECT pid, application_name, state, query FROM pg_stat_activity\n"
        + "     WHERE query ILIKE '%schema_migrations%';\n"
        + '  Para esperarla más, subí MIGRATE_LOCK_TIMEOUT_MS (ms).',
      );
    }
    if (!avisado) {
      avisado = true;
      console.log(`migrate: hay otra corrida en progreso, esperando (máx ${Math.round(timeout / 1000)} s)...`);
    }
    await sleep(LOCK_POLL_MS);
  }
}

/**
 * Devuelve el lock. Va en el `finally` de la corrida: si el proceso muere sin
 * liberar, Postgres lo libera solo cuando corta la sesión, así que tampoco es
 * catastrófico, pero dejarlo explícito es lo correcto.
 * @param {import('pg').PoolClient} client Cliente dedicado de la corrida.
 * @returns {Promise<void>} No hace nada si ya no lo tenía.
 */
async function releaseLock(client) {
  try {
    await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
  } catch {
    // ↑ Si ni siquiera se puede liberar, la sesión se va a cerrar al terminar el
    //   script y Postgres libera el lock con ella. No vale la pena tapar el error
    //   real de la migración con un "no pude liberar el lock".
  }
}

/**
 * Crea la tabla de control si no está.
 * @param {import('pg').PoolClient} client Cliente de la corrida.
 * @returns {Promise<void>}
 */
async function ensureControlTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   text PRIMARY KEY,
       checksum   text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

/**
 * Lee las migraciones ya aplicadas.
 * @param {import('pg').PoolClient} client Cliente de la corrida.
 * @returns {Promise<Map<string, string>>} filename → checksum.
 */
async function readApplied(client) {
  const res = await client.query('SELECT filename, checksum FROM schema_migrations');
  return new Map(res.rows.map((row) => [row.filename, row.checksum]));
}

/**
 * Aplica un archivo: su SQL y, en la MISMA transacción, el registro de que se
 * aplicó. Si el SQL falla, el INSERT tampoco ocurrió (todo se cae junto con el
 * ROLLBACK), así que el archivo queda pendiente y volver a correr es seguro.
 * @param {import('pg').PoolClient} client Cliente de la corrida.
 * @param {string} name Nombre del archivo.
 * @param {Buffer} bytes Los bytes crudos del archivo.
 * @param {string} checksum sha256 de esos bytes.
 * @returns {Promise<void>}
 * @throws {MigrateError} Si el SQL falla.
 */
async function applyOne(client, name, bytes, checksum) {
  const sql = stripBom(bytes.toString('utf8'));
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
      [name, checksum],
    );
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ↑ Si el rollback falla, la conexión está muerta y el `closePool()` del
      //   final la va a tirar igual. Lo que importa es no tapar el error real.
    }
    throw new MigrateError(
      `Falló la migración ${name}.\n\n`
      + `  ${err.message}\n\n`
      + '  · Se hizo ROLLBACK: este archivo NO quedó aplicado.\n'
      + '  · Los archivos siguientes NO se intentaron, a propósito: no tiene sentido\n'
      + '    construir el esquema encima de una migración que no entró.\n'
      + '  · Corregí el .sql y volvé a correr `npm run migrate`. Es seguro: como\n'
      + '    quedó sin registrar, se va a intentar de nuevo desde cero.',
    );
  }
}

/**
 * Traduce un error de conexión a algo que un humano pueda usar, o `null` si no es
 * un error de conexión conocido.
 *
 * Existe porque `pg` no es claro en este punto, y este es EL error que va a ver
 * la primera persona que corre `npm run migrate`: Node 20+ agrupa los intentos de
 * conexión y devuelve un `AggregateError` cuyo `message` es nada más que
 * `ECONNREFUSED`. Eso no dice si hay que levantar Postgres, corregir el host o
 * cambiar la contraseña. El stack, que es lo único informativo que trae, lo
 * esconde.
 *
 * OJO: esto vive ACÁ y no en `db.js`. En el servidor el error crudo va al log de
 * Vercel y quien lo lee quiere el código; en la terminal lo lee alguien que
 * necesita que le digan qué hacer. Envolver en `db.js` obligaría a elegir una de
 * las dos audience.
 *
 * @param {any} err Error de `pg` o de Node.
 * @returns {string|null} Explicación en español, o `null` si no hay nada que decir.
 */
function explainConnectionError(err) {
  if (!err) return null;
  // ↑ `pg` 8.20+ envuelve los errores de conexión en un `AggregateError` con un
  //   error por dirección resuelta, y el código real vive adentro, no afuera.
  const codigo = err.code || (Array.isArray(err.errors) ? (err.errors[0] || {}).code : null);
  let host = '';
  try {
    host = new URL(process.env.DATABASE_URL || '').hostname;
  } catch {
    // Si ni la URL se puede parsear, `host` se queda vacío y los mensajes no lo
    // nombran: no pasa nada, siguen siendo accionables sin el host.
  }
  const donde = host ? ` (${host})` : '';

  switch (codigo) {
    case 'ECONNREFUSED':
      return `No hay nada escuchando${donde} en el puerto de la URL.\n`
        + '  · O no levantaste Postgres, o la URL apunta al host o al puerto equivocado.\n'
        + '  · Si esperabas Neon, revisá que la URL sea la del POOLER.';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `No se pudo resolver el host${donde} del DATABASE_URL.\n`
        + '  · Tipeaste mal el dominio, o la URL no trae host.';
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `No se pudo llegar a${donde || ' la base'} (timeout o red inalcanzable).\n`
        + '  · Proxy o firewall en el medio. Con Neon casi nunca es la base.';
    case '28P01':
    case '28000':
      return 'La base rechazó las credenciales del DATABASE_URL.\n'
        + '  · Revisá usuario y contraseña. Ojo con una URL pegada a medias.';
    case '3D000':
      return 'La base del DATABASE_URL no existe con el nombre indicado.';
    case '53300':
      return 'La base rechazó la conexión: demasiadas conexiones abiertas.\n'
        + '  · Subir PG_POOL_MAX NO ayuda: el tope es del servidor, no de esta corrida.';
    case '57P01':
      return 'El servidor cerró la conexión (se está reiniciando o apagando). Reintentá en un momento.';
    case '42P01':
      return 'Falta una tabla que esta migración usa, así que el orden de aplicación cambió.\n'
        + '  · Revisá que el prefijo numérico de cada archivo siga el orden real del esquema.';
    default:
      // Sin código conocido: mejor no inventar una explicación.
      return null;
  }
}

/**
 * Corre todo.
 * @returns {Promise<number>} Código de salida: 0 salió bien, 1 no.
 */
async function main() {
  const leyoEnv = loadEnvFile();
  if (!process.env.DATABASE_URL) {
    // ↑ Se verifica acá y no adentro de `db.js` porque el mensaje es distinto según
    //   el contexto: en la terminal querés saber qué archivo copiar; en una función
    //   serverless querés un error corto. Los dos son el mismo chequeo.
    console.error('');
    console.error('FALTA DATABASE_URL. No hay a qué conectarse.');
    console.error('');
    console.error(`  ${leyoEnv ? 'Se leyó .env pero no tiene DATABASE_URL (o está vacía).' : 'No hay .env en la raíz del repo.'}`);
    console.error('');
    console.error('  · Local:');
    console.error('      copy .env.example .env      (PowerShell: Copy-Item)');
    console.error('      y pegá la URL de Neon en el DATABASE_URL=');
    console.error('      Neon > Connection Details > Pooled connection (la del pooler).');
    console.error('  · Vercel: Settings > Environment Variables > DATABASE_URL.');
    console.error('  · CI: configurar la variable en el panel del proyecto.');
    console.error('');
    console.error('  La URL es una credencial: nunca en el código, nunca en un commit.');
    console.error('');
    return 1;
  }

  let files;
  try {
    files = listMigrationFiles();
  } catch (err) {
    console.error(`\nFALLA: ${err.message}\n`);
    return 1;
  }
  if (files.length === 0) {
    console.error(`\nFALLA: no hay ningún .sql en migrations/.\n`);
    console.error('  Las migraciones van como migrations/001_nombre_en_snake.sql.');
    console.error('  Un exit 0 acá sería un falso verde en CI.\n');
    return 1;
  }

  // Se anuncia la lista ANTES de conectarse. Dos razones: si la red está lenta o
  // caída, el que corrió el comando ve igual qué es lo que había para aplicar en
  // vez de una pantalla en blanco mientras expira el timeout; y si `migrations/`
  // está vacía o con nombres raros, el problema se ve sin necesitar base ninguna.
  console.log(`migrate: ${files.length} migración(es) en migrations/`);

  const aplicadas = [];
  const yaEstaban = [];

  try {
    // Un SOLO cliente para toda la corrida. Dos razones y las dos importan:
    //  1. El advisory lock es de sesión: si se suelta el cliente, el lock se queda
    //     colgado en una conexión que ya no es nuestra.
    //  2. Por eso NO se usa `withTransaction()` de `db.js`, que toma un cliente
    //     nuevo del pool por transacción. Con el cliente de la corrida ya tomado,
    //     cada transacción nueva haría falta un segundo cliente, y con
    //     `PG_POOL_MAX=1` (que alguien podría configurar) eso se traba para
    //     siempre. Acá el BEGIN/COMMIT va sobre este mismo cliente y el runner
    //     depende cero del tamaño del pool.
    await withClient(async (client) => {
      await acquireLock(client);
      try {
        await ensureControlTable(client);
        const applied = await readApplied(client);

        for (const name of files) {
          const bytes = readMigration(name);
          const checksum = createHash('sha256').update(bytes).digest('hex');
          const previa = applied.get(name);

          if (previa !== undefined) {
            if (previa === checksum) {
              console.log(`  ya estaba   ${name}`);
              yaEstaban.push(name);
              continue;
            }
            // ↑ No se reaplica y no se pisa: se corta acá. Reaplicar el contenido
            //   nuevo sobre un esquema ya construido con el viejo produce un estado
            //   que nadie eligió, y como no hay rollback no se puede volver atrás.
            throw new MigrateError(
              `migrations/${name} ya fue aplicado pero su contenido cambió.\n\n`
              + `  checksum aplicado: ${previa}\n`
              + `  checksum en disco: ${checksum}\n\n`
              + '  Este proyecto NO tiene migraciones de rollback, así que el esquema\n'
              + '  de la base ya se construyó con el contenido anterior. Corregilo así:\n'
              + '    · Si el cambio es de formato o un comentario: restaurá el archivo\n'
              + '      (`git checkout -- migrations/' + name + '`).\n'
              + '    · Si el cambio es real de esquema: NO toques este archivo. Escribí\n'
              + '      una migración nueva (00X_....sql) con los ALTER que correspondan.\n'
              + '  Volver a correr migrate con el archivo editado no lo arregla.\n\n'
              + '  Se abortó sin aplicar NADA: las migraciones anteriores a esta ya\n'
              + '  estaban aplicadas y las siguientes no se intentaron.',
            );
          }

          if (!HAS_PREFIX.test(name)) {
            // Aviso y se sigue: el archivo se aplica igual. Renombrarlo en un repo
            // con gente arriba sería peor que el desorden de orden que produce.
            console.warn(`  AVISO  ${name} no sigue el formato NNN_nombre_en_snake.sql; se aplica igual y puede ordenar mal.`);
          }

          await applyOne(client, name, bytes, checksum);
          console.log(`  APLICADA  ${name}`);
          aplicadas.push(name);
        }
      } finally {
        await releaseLock(client);
      }
    });
} catch (err) {
    // Un error de conexión NO es un bug: es una operación que falló, y lo que
    // hace falta es qué hacer al respecto, no el stack. Se pide la explicación
    // primero y solo si no la hay se cae al mensaje crudo + stack.
    const explicado = explainConnectionError(err);
    if (explicado) {
      console.error(`\nFALLA: ${explicado}\n`);
      return 1;
    }
    // `String(err)` como red de seguridad: si alguien tira algo que no es un Error,
    // `err.message` sería `undefined` y el mensaje saldría vacío.
    const motivo = (err && err.message) || String(err);
    console.error(`\nFALLA: ${motivo}\n`);
    // El stack solo cuando el error NO es esperado: ahí el stack es la información
    // (bug propio o algo raro), y sin él no hay por dónde empezar.
    if (!(err instanceof MigrateError) && err && err.stack) console.error(err.stack);
    return 1;
  } finally {
    // Sin esto el proceso no termina nunca: quedan sockets abiertos sosteniendo el
    // event loop. Por eso `db.js` además pone `allowExitOnIdle`.
    try {
      await closePool();
    } catch {
      // Si cerrar el pool falla, lo que importa es el código de salida, que ya está.
    }
  }

  console.log('');
  console.log(`migrate: listo. ${aplicadas.length} aplicada(s), ${yaEstaban.length} ya estaba(n).`);
  if (aplicadas.length) {
    console.log(`  aplicadas:  ${aplicadas.join(', ')}`);
  } else {
    console.log('  no había nada nuevo que aplicar.');
  }
  if (yaEstaban.length) console.log(`  ya estaban: ${yaEstaban.join(', ')}`);
  console.log('');
  return 0;
}

// ↑ `process.exitCode` y NO `process.exit()`: en Windows, cuando la salida es un
//   pipe (CI, `npm run ... | tee`), `process.exit()` corta lo que no llegó a
//   escribirse y el mensaje de error se pierde justo cuando más hace falta.
//   Dejando que el proceso termine solo, la salida se vacía y el código sigue
//   siendo el que se retornó.
process.exitCode = await main();