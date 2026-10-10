// Rate limit del login. El contador vive en Postgres para compartirlo entre
// invocaciones serverless; el lock mantiene atómicos el chequeo y el resultado
// de bcrypt, evitando que requests concurrentes aprovechen el mismo contador.

import { query, withTransaction } from './db.js';
import { HttpError } from './http.js';

const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_MAX_PER_PAIR = 10;
const DEFAULT_MAX_PER_IP = 30;
const DEFAULT_RETENTION_HOURS = 24;

function intFromEnv(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export function loginLimitConfig() {
  return {
    enabled: process.env.LOGIN_LIMIT !== '0',
    windowMinutes: intFromEnv('LOGIN_LIMIT_WINDOW_MINUTES', DEFAULT_WINDOW_MINUTES, 1, 24 * 60),
    maxPerPair: intFromEnv('LOGIN_LIMIT_MAX_PER_PAIR', DEFAULT_MAX_PER_PAIR, 1, 10_000),
    maxPerIp: intFromEnv('LOGIN_LIMIT_MAX_PER_IP', DEFAULT_MAX_PER_IP, 1, 100_000),
    retentionHours: intFromEnv('LOGIN_ATTEMPTS_RETENTION_HOURS', DEFAULT_RETENTION_HOURS, 1, 24 * 365),
  };
}

/**
 * Ejecuta la autenticación dentro del lock que protege el rate limit.
 * @template T
 * @param {{email: string, ip: string}} identity Identidad normalizada y origen.
 * @param {(client: import('pg').PoolClient) => Promise<{authenticated: boolean} & T>} authenticate Verifica las credenciales.
 * @returns {Promise<{authenticated: boolean} & T>} Resultado de la autenticación.
 * @throws {HttpError} 429 si se agotó el límite.
 */
export async function withLoginAttempt({ email, ip }, authenticate) {
  const cfg = loginLimitConfig();
  const result = await withTransaction(async (client) => {
    if (cfg.enabled) {
      // Las solicitudes de la misma IP se serializan incluso mientras bcrypt verifica.
      await client.query(
        'select pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`login-ip:${ip}`],
      );

      const { rows } = await client.query(
        `select
           count(*) filter (where email = $1)         as por_pareja,
           min(attempted_at) filter (where email = $1) as pareja_desde,
           count(*)                                   as por_ip,
           min(attempted_at)                           as ip_desde
         from login_attempts
         where ip = $2
           and attempted_at > clock_timestamp() - make_interval(mins => $3)`,
        [email, ip, cfg.windowMinutes],
      );
      const fila = rows[0] || {};
      const porPareja = Number(fila.por_pareja || 0);
      const porIp = Number(fila.por_ip || 0);
      const desde = porPareja >= cfg.maxPerPair
        ? fila.pareja_desde
        : porIp >= cfg.maxPerIp
          ? fila.ip_desde
          : null;

      if (desde) {
        const antiguedad = (Date.now() - new Date(desde).getTime()) / 1000;
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil(cfg.windowMinutes * 60 - antiguedad),
        );
        throw new HttpError(
          429,
          'Demasiados intentos de acceso. Esperá un momento antes de volver a intentar.',
          { retryAfterSeconds, retryAfter: retryAfterSeconds },
          { 'Retry-After': String(retryAfterSeconds) },
        );
      }
    }

    const outcome = await authenticate(client);
    if (outcome.authenticated) {
      await client.query('delete from login_attempts where email = $1', [email]);
    } else if (cfg.enabled) {
      await client.query(
        'insert into login_attempts (email, ip, attempted_at) values ($1, $2, clock_timestamp())',
        [email, ip],
      );
    }
    return outcome;
  });

  if (cfg.enabled && !result.authenticated) await purgeOldAttempts();
  return result;
}

export async function purgeOldAttempts() {
  const cfg = loginLimitConfig();
  try {
    await query(
      'delete from login_attempts where attempted_at < clock_timestamp() - make_interval(hours => $1)',
      [cfg.retentionHours],
    );
  } catch (err) {
    console.warn('[rate-limit] no se pudo purgar login_attempts: %s', err.message);
  }
}

export async function countRecentAttempts({ email, ip }) {
  const cfg = loginLimitConfig();
  const { rows } = await query(
    `select
       count(*) filter (where email = $1) as por_pareja,
       count(*)                       as por_ip
     from login_attempts
     where ip = $2
       and attempted_at > clock_timestamp() - make_interval(mins => $3)`,
    [email, ip, cfg.windowMinutes],
  );
  const fila = rows[0] || {};
  return {
    pair: Number(fila.por_pareja || 0),
    ip: Number(fila.por_ip || 0),
    windowMinutes: cfg.windowMinutes,
  };
}
