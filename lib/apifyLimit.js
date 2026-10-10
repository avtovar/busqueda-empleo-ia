// ============================================================================
// RATE LIMIT DIARIO DE APIFY, CONTRA LA BASE DE DATOS.
//
// `POST /api/linkedin-search` ejecuta un actor de Apify que se factura POR
// EJECUCIÓN (la clave es `APIFY_API_TOKEN`, del dueño de la app). Sin un límite
// diario, un usuario autenticado podría disparar búsquedas en loop y vaciar la
// cuenta de Apify. Este módulo evita eso contando cuántas veces el usuario ya
// buscó HOY (en UTC).
//
// Es el MISMO PROBLEMA que el login y el parseo de CV con la MISMA SOLUCIÓN:
// en Vercel no hay memoria entre invocaciones, así que un contador en memoria
// contaría SIEMPRE cero. Sería un límite que se ve funcionar y no detiene a
// nadie — el peor tipo de bug: el que pasa los tests.
//
// ── POR QUÉ UN MÓDULO APARTE ─────────────────────────────────────────────────
// `rateLimit.js` (login) y `cvParseLimit.js` (CV) ya existen y funcionan. No se
// les agregó esta lógica por tres razones concretas:
//
//   1. CUENTA COSAS DISTINTAS. `withLoginAttempt` cuenta INTENTOS FALLIDOS de
//      autenticación. `assertCvParseAllowed` cuenta LLAMADAS PAGADAS que SALIERON
//      BIEN. `assertApifyAllowed` cuenta EJECUCIONES DE ACTOR (también pagadas,
//      pero con otro proveedor y otro costo). No es el mismo contador con otro
//      nombre: la semántica de lo que se escribe en cada fila es distinta.
//
//   2. LA VENTANA ES DIFERENTE. Login = 15 min, CV = 60 min, Apify = 1 DÍA (UTC).
//      Un solo módulo con `if (tipo === 'apify')` en el medio de la lógica mezcla
//      tres políticas que no se parecen.
//
//   3. LA PURGA ES DISTINTA. Login purga en intento fallido, CV purga en parseo
//      concedido, Apify purga en búsqueda CONCEDIDA. Un solo `purgeOld()` no
//      sirve a las tres sin inventar parámetros que nadie pasa.
//
// Lo que SÍ se comparte es la FORMA: el `intFromEnv`, la ventana con
// `make_interval`, el `Retry-After` con header Y en el cuerpo, y el mensaje que
// no cuenta como error. Duplicar las líneas vale más que un módulo que mezcla
// tres cosas que no se parecen.
// ============================================================================

import { query, withTransaction } from './db.js';
import { HttpError } from './http.js';

// ════════════════════════════════════════════════════════════════════════════
// VALORES POR DEFECTO
// ════════════════════════════════════════════════════════════════════════════

// Cuántas búsquedas de LinkedIn puede hacer un usuario POR DÍA (UTC).
const DEFAULT_DAILY_LIMIT = 3;

// Ventana: 1 día. Se usa `make_interval(days => 1)` en las queries.
// NO es configurable por variable de entorno a propósito: "por día" es la unidad
// natural de facturación de Apify, y cambiarla a "por 12 horas" o "por semana"
// solo confundiría al usuario (y al dueño de la clave).
const WINDOW_DAYS = 1;

// Cuánto se guarda un registro antes de la purga.
// 60 días contra una ventana de 1 día: 60x de margen. Con 1 día de ventana y
// 60 de retención, cada request borra casi siempre cero filas; la primera del
// mes es la que hace trabajo.
const DEFAULT_RETENTION_DAYS = 60;

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
 * La configuración del límite, leída del entorno en CADA llamada.
 * `enabled: false` apaga TODO (para tests y desarrollo local).
 * @returns {{enabled: boolean, dailyLimit: number, retentionDays: number}}
 */
export function apifyLimitConfig() {
  return {
    enabled: process.env.APIFY_DAILY_LIMIT !== '0',
    dailyLimit: intFromEnv('APIFY_DAILY_LIMIT', DEFAULT_DAILY_LIMIT, 1, 10_000),
    retentionDays: intFromEnv('APIFY_USAGE_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, 1, 365),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EL LÍMITE
// ════════════════════════════════════════════════════════════════════════════

// Mensaje del 429.
const LIMITE_ALCANZADO = 'Ya hiciste todas las búsquedas de LinkedIn que podemos por hoy. '
  + 'El límite se reinicia a medianoche (UTC). Esperá un ratito y volvé a intentarlo.';

/**
 * Verifica que este usuario pueda hacer otra búsqueda de LinkedIn hoy, y le cuenta UNA.
 * Lanza HttpError 429 si ya llegó al límite diario. Si no, incrementa el contador
 * (upsert) y devuelve el nuevo count.
 *
 * @param {string} userId UUID del usuario, de `requireSession(req).user.id`.
 * @returns {Promise<{allowed: true, used: number, remaining: number, limit: number}>}
 *   El estado del contador después de contar esta búsqueda.
 * @throws {HttpError} 429 con `Retry-After` (segundos hasta medianoche UTC) si ya se agotó la cuota.
 */
export async function assertApifyAllowed(userId) {
  if (typeof userId !== 'string' || !userId) {
    throw new Error('assertApifyAllowed necesita un userId de requireSession.');
  }

  const cfg = apifyLimitConfig();
  if (!cfg.enabled) {
    return { allowed: true, used: 0, remaining: cfg.dailyLimit, limit: cfg.dailyLimit };
  }

  const estado = await withTransaction(async (client) => {
    // 1) El candado por usuario, primero. Serializa el conteo para ESTE usuario.
    // hashtextextended devuelve bigint (64 bits), así que dos usuarios distintos
    // no se bloquean entre sí (probabilidad despreciable). PG 11+.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);

    // 2) El día de HOY en UTC (date, sin hora). Es la PK parcial de la tabla.
    const { rows: dayRows } = await client.query(
      `select (now() at time zone 'utc')::date as hoy`
    );
    const hoy = dayRows[0]?.hoy;
    if (!hoy) throw new Error('No se pudo obtener la fecha actual de Postgres.');

    // 3) Upsert: inserta (user_id, day, count=1) o incrementa count si ya existe.
    // Hacemos el upsert ANTES del count para que la transacción sea atómica y
    // el contador no se pueda "colar" entre dos requests concurrentes.
    // Pero necesitamos saber el count ANTES de decidir si permitimos o no.
    // Solución: SELECT FOR UPDATE (o advisory lock que ya tenemos) + upsert condicional.
    //
    // Con el advisory lock ya tomado, podemos leer, decidir y escribir en la misma tx.
    const { rows: countRows } = await client.query(
      `select count from apify_usage where user_id = $1 and day = $2`,
      [userId, hoy]
    );
    const usados = countRows[0] ? Number(countRows[0].count) : 0;

    // 4) El límite. `>=` y no `>`: con el límite en 3, la 3ra búsqueda pasa y la 4ta choca.
    if (usados >= cfg.dailyLimit) {
      // Calcular segundos hasta medianoche UTC para Retry-After.
      const now = new Date();
      const midnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const retryAfterSeconds = Math.max(1, Math.ceil((midnightUTC - now) / 1000));

      // El throw entra en la transacción y la hace ROLLBACK: el upsert de abajo
      // NO se ejecuta, así que un 429 NO cuenta. Es la misma propiedad que el
      // login y el CV parse: un rechazo no extiende la ventana.
      throw new HttpError(
        429,
        LIMITE_ALCANZADO,
        { retryAfterSeconds, retryAfter: retryAfterSeconds },
        { 'Retry-After': String(retryAfterSeconds) }
      );
    }

    // 5) Incrementar (o insertar) el contador.
    await client.query(
      `insert into apify_usage (user_id, day, count)
       values ($1, $2, 1)
       on conflict (user_id, day) do update set count = apify_usage.count + 1`,
      [userId, hoy]
    );

    return {
      allowed: true,
      used: usados + 1,
      remaining: Math.max(0, cfg.dailyLimit - usados - 1),
      limit: cfg.dailyLimit,
    };
  });

  // 6) La purga, AFUERA de la transacción y con errores tragados.
  // Oportunista: se dispara desde el único lugar que escribe en la tabla.
  await purgeOldApifyUsage();

  return estado;
}

// ════════════════════════════════════════════════════════════════════════════
// PURGAR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Borra los registros de uso viejos, los que ya no cuentan para ninguna ventana.
 * Oportunista: se dispara desde `assertApifyAllowed` (el único que escribe).
 * El error se traga a propósito: si la purga falla, la búsqueda tiene que
 * devolver el 200 de siempre.
 * @returns {Promise<void>}
 */
export async function purgeOldApifyUsage() {
  const cfg = apifyLimitConfig();
  try {
    await query(
      `delete from apify_usage where day < (now() at time zone 'utc')::date - make_interval(days => $1)`,
      [cfg.retentionDays],
    );
  } catch (err) {
    console.warn('[apify-limit] no se pudo purgar apify_usage: %s', err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PARA LOS TESTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cuántas búsquedas lleva este usuario HOY (en UTC).
 * NO lo usa el endpoint: existe para que un script de verificación pueda
 * comprobar que el límite corta de verdad, que un 429 NO cuenta, y que el día
 * se reinicia solo.
 * @param {string} userId UUID del usuario.
 * @returns {Promise<{used: number, remaining: number, limit: number, day: string}>}
 */
export async function countTodayApifyUsage(userId) {
  const cfg = apifyLimitConfig();
  const { rows } = await query(
    `select count from apify_usage where user_id = $1 and day = (now() at time zone 'utc')::date`,
    [userId],
  );
  const usados = rows[0] ? Number(rows[0].count) : 0;
  const hoy = new Date().toISOString().split('T')[0];
  return {
    used: usados,
    remaining: Math.max(0, cfg.dailyLimit - usados),
    limit: cfg.dailyLimit,
    day: hoy,
  };
}