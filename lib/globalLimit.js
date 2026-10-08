// ============================================================================
// LÍMITE GLOBAL DIARIO DE GASTO (LLM + APIFY)
// ============================================================================
//
// Protege el bolsillo del dueño de la app: suma TODOS los CVs parseados y
// TODAS las búsquedas de LinkedIn de TODOS los usuarios por día (UTC).
// Si se pasa el tope, devuelve 503 con mensaje claro.
// Es la capa final que funciona aunque todo lo demás falle (miles de cuentas falsas).
//
// Variables de entorno:
//   GLOBAL_DAILY_CV_LIMIT      — max CVs parseados por día en TODA la app (default 100)
//   GLOBAL_DAILY_APIFY_LIMIT   — max búsquedas LinkedIn por día en TODA la app (default 10)
//   GLOBAL_DAILY_SIGNUP_LIMIT  — max registros por día en TODA la app (default 50)
//
// Tabla: global_usage (day PK, cv_parses, apify_searches, signups)
// Purga: 60 días
// ============================================================================

import { query, withTransaction } from './db.js';
import { HttpError } from './http.js';

const DEFAULT_CV_LIMIT = 100;
const DEFAULT_APIFY_LIMIT = 10;
const DEFAULT_SIGNUP_LIMIT = 50;
const RETENTION_DAYS = 60;

function intFromEnv(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(raw) || raw < min || raw > max) return fallback;
  return raw;
}

export function globalLimitConfig() {
  return {
    enabled: process.env.GLOBAL_DAILY_LIMIT !== '0',
    cvLimit: intFromEnv('GLOBAL_DAILY_CV_LIMIT', DEFAULT_CV_LIMIT, 1, 100_000),
    apifyLimit: intFromEnv('GLOBAL_DAILY_APIFY_LIMIT', DEFAULT_APIFY_LIMIT, 1, 10_000),
    signupLimit: intFromEnv('GLOBAL_DAILY_SIGNUP_LIMIT', DEFAULT_SIGNUP_LIMIT, 1, 100_000),
  };
}

const LIMIT_EXCEEDED = 'Se alcanzó el límite diario global de uso. ' +
  'Volvé a intentarlo mañana (se reinicia a medianoche UTC).';

/**
 * Verifica que el contador global no haya superado el límite para el tipo dado.
 * Tipos: 'cv' | 'apify' | 'signup'
 * @throws {HttpError} 503 si se pasó el límite global
 */
export async function checkGlobalDailyLimit(type) {
  const cfg = globalLimitConfig();
  if (!cfg.enabled) return { allowed: true };

  const limit = type === 'cv' ? cfg.cvLimit : type === 'apify' ? cfg.apifyLimit : cfg.signupLimit;
  const column = type === 'cv' ? 'cv_parses' : type === 'apify' ? 'apify_searches' : 'signups';

  const { rows } = await query(
    `select ${column} from global_usage where day = (now() at time zone 'utc')::date`
  );
  const used = rows[0] ? Number(rows[0][column]) : 0;

  if (used >= limit) {
    const now = new Date();
    const midnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const retryAfter = Math.max(1, Math.ceil((midnightUTC - now) / 1000));
    throw new HttpError(
      503,
      LIMIT_EXCEEDED,
      { retryAfterSeconds: retryAfter, retryAfter },
      { 'Retry-After': String(retryAfter) }
    );
  }
  return { allowed: true, used, remaining: limit - used, limit };
}

/**
 * Incrementa el contador global para el tipo dado.
 * Se llama DESPUÉS de que la operación individual (rate limit por usuario) pasó.
 * @param {'cv'|'apify'|'signup'} type
 */
export async function recordGlobalUsage(type) {
  const cfg = globalLimitConfig();
  if (!cfg.enabled) return;

  const column = type === 'cv' ? 'cv_parses' : type === 'apify' ? 'apify_searches' : 'signups';

  await withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['global_limit']);
    const { rows } = await client.query(
      `select ${column} from global_usage where day = (now() at time zone 'utc')::date`
    );
    const used = rows[0] ? Number(rows[0][column]) : 0;
    const limit = type === 'cv' ? cfg.cvLimit : type === 'apify' ? cfg.apifyLimit : cfg.signupLimit;
    
    if (used >= limit) {
      // No debería pasar porque checkGlobalDailyLimit ya se llamó antes
      const now = new Date();
      const midnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const retryAfter = Math.max(1, Math.ceil((midnightUTC - now) / 1000));
      throw new HttpError(503, LIMIT_EXCEEDED, { retryAfterSeconds: retryAfter }, { 'Retry-After': String(retryAfter) });
    }

    await client.query(
      `insert into global_usage (day, ${column}) values ((now() at time zone 'utc')::date, 1)
       on conflict (day) do update set ${column} = global_usage.${column} + 1`
    );
  });

  await purgeOldGlobalUsage();
}

async function purgeOldGlobalUsage() {
  try {
    await query(
      `delete from global_usage where day < (now() at time zone 'utc')::date - make_interval(days => $1)`,
      [RETENTION_DAYS]
    );
  } catch (err) {
    console.warn('[global-limit] no se pudo purgar global_usage: %s', err.message);
  }
}