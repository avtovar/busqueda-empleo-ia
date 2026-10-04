// Build timestamp: 2026-10-04T22:00:00Z
// ============================================================================
// lib/auth-fetch.js — Autenticación compatible con Web Fetch API
//
// Versión de las funciones de auth que trabaja con Request/Response de Fetch API
// en lugar de IncomingMessage/ServerResponse de Node.js.
// ============================================================================

import { createHmac, timingSafeEqual } from 'crypto';

import {
  hashPassword,
  publicUser,
  readCredentials,
  dummyHash,
  hasProfile,
  verifyPassword,
  getClientIp as libClientIp,
  clientIp,
  ConfigError,
  HttpError,
} from './auth.js';
import { query, withTransaction } from './db.js';

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════════════════════════

const MAX_BODY_BYTES = 64 * 1024;
const INVALID_CREDENTIALS = 'El correo o la clave no son correctos.';

// ════════════════════════════════════════════════════════════════════════════
// HELPERS DE REQUEST/RESPONSE
// ═════════════════════════════════════════════════════════════════════════════

/** Extrae el body JSON del request con límite de tamaño. */
export async function readJsonBody(req, { limitBytes = MAX_BODY_BYTES } = {}) {
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > limitBytes) {
    throw new HttpError(413, 'El cuerpo de la petición es demasiado grande.');
  }

  let body;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'El cuerpo de la petición no es JSON válido.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'El cuerpo de la petición tiene que ser un objeto JSON.');
  }
  return body;
}

/** Obtiene un parámetro de la query string. */
export function getQueryParam(req, name) {
  const url = new URL(req.url);
  return url.searchParams.get(name);
}

/** Obtiene la IP del cliente desde los headers de Vercel. */
export function getClientIp(req) {
  const headers = req.headers;
  const candidates = [
    headers.get('x-vercel-forwarded-for'),
    headers.get('x-real-ip'),
    headers.get('x-forwarded-for'),
  ];
  for (const raw of candidates) {
    const first = (raw || '').split(',')[0].trim();
    if (first) return first;
  }
  return 'desconocida';
}

/** Obtiene el valor de una cookie del header Cookie. */
export function getCookie(req, name) {
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) return null;
  const raw = String(cookieHeader);
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const cookieName = part.slice(0, eq).trim();
    if (cookieName === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/** Crea una respuesta JSON con headers estándar. */
export function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** Crea una respuesta de error. */
export function errorResponse(message, status = 500, extra = {}, extraHeaders = {}) {
  return jsonResponse({ error: message, ...extra }, status, extraHeaders);
}

// ════════════════════════════════════════════════════════════════════════════
// AUTH WRAPPERS PARA FETCH API
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Verifica la sesión y devuelve { user, session } o lanza HttpError.
 * Compatible con Web Fetch API.
 */
export async function requireSession(req) {
  const cookie = getCookie(req, 'bei_session');
  if (!cookie) throw new HttpError(401, 'Necesitás iniciar sesión.');

  const session = parseSessionCookie(cookie);
  if (!session) throw new HttpError(401, 'Necesitás iniciar sesión.');

  const { rows } = await query(
    'select id, email, created_at from users where id = $1',
    [session.userId],
  );
  if (!rows[0]) {
    throw new HttpError(401, 'Necesitás iniciar sesión.');
  }

  return { user: rows[0], session };
}

/**
 * Verifica sesión Y perfil. Devuelve { user, profile } o lanza HttpError (401/403).
 */
export async function requireProfile(req) {
  const { user } = await requireSession(req);

  const { rows } = await query('select * from profiles where user_id = $1', [user.id]);
  if (!rows[0]) {
    throw new HttpError(403, 'Te falta completar tu perfil: subí tu CV para empezar.', {
      profileComplete: false,
    });
  }

  return { user, profile: rows[0] };
}

/** Extrae la ruta relativa del endpoint. */
export function getRoute(req, basePath) {
  const url = new URL(req.url);
  return url.pathname.replace(basePath, '') || '/';
}

// ════════════════════════════════════════════════════════════════════════════
// COOKIE HELPERS (Web Fetch API style — devuelven strings de Set-Cookie)
// ════════════════════════════════════════════════════════════════════════════

const SESSION_COOKIE = 'bei_session';
const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_DAYS = 7;

function secret() {
  const raw = process.env.SESSION_SECRET || '';
  if (!raw.trim()) {
    throw new ConfigError(
      'Falta SESSION_SECRET: sin ella no se puede firmar la cookie de sesión.\n'
      + '  · Local: copiá .env.example a .env y pegá el valor.\n'
      + '    Generalo con:\n'
      + "      node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n"
      + '  · Vercel: Settings > Environment Variables > SESSION_SECRET.\n'
      + 'OJO: rotarla invalida TODAS las sesiones abiertas de todos los usuarios.\n'
      + 'Nunca la mandes desde el cliente ni la commitees: es una credencial.',
    );
  }
  if (raw.length < 32) {
    throw new ConfigError(
      `SESSION_SECRET es demasiado corta: ${raw.length} caracteres, y hacen falta 32.\n`
      + '  Con una clave corta, alguien que la adivine puede FORJAR la cookie de\n'
      + '  cualquier usuario sin necesitar la contraseña de nadie. No es un\n'
      + '  problema de robustez, es un agujero.\n'
      + '  Generá una de 32 bytes (64 caracteres hex) con:\n'
      + "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return raw;
}

function ttlSeconds() {
  const days = parseInt(process.env.SESSION_TTL_DAYS || DEFAULT_TTL_DAYS, 10);
  return isNaN(days) || days < 1 || days > 365 ? DEFAULT_TTL_DAYS * 24 * 60 * 60 : days * 24 * 60 * 60;
}

function sign(payload) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function buildSessionCookieForFetch(token, maxAgeSeconds, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    `Expires=${new Date(expiresAt * 1000).toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  const secure = process.env.SESSION_COOKIE_SECURE === '1' || process.env.VERCEL === '1';
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function buildClearSessionCookieForFetch() {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];
  const secure = process.env.SESSION_COOKIE_SECURE === '1' || process.env.VERCEL === '1';
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function createSessionCookie(userId) {
  const seconds = ttlSeconds();
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const payload = `${TOKEN_VERSION}.${userId}.${exp}`;
  const token = `${payload}.${sign(payload)}`;
  return buildSessionCookieForFetch(token, seconds, exp);
}

export function clearSessionCookie() {
  return buildClearSessionCookieForFetch();
}

export function parseSessionCookie(cookieValue) {
  const crudo = typeof cookieValue === 'string' ? cookieValue : '';
  const partes = crudo.split('.');
  if (partes.length !== 4) return null;

  const [version, userId, expRaw, firma] = partes;
  if (version !== TOKEN_VERSION) return null;

  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= 0) return null;

  const payload = `${version}.${userId}.${expRaw}`;
  const esperada = sign(payload);
  if (!safeEqual(firma, esperada)) return null;

  if (exp <= Math.floor(Date.now() / 1000)) return null;

  return { userId, expiresAt: exp };
}

// ════════════════════════════════════════════════════════════════════════════
// RE-EXPORTS
// ════════════════════════════════════════════════════════════════════════════

// Re-export de funciones necesarias (hasProfile y publicUser vienen de auth.js)
export {
  hashPassword,
  publicUser,
  readCredentials,
  dummyHash,
  hasProfile,
  verifyPassword,
  getClientIp: libClientIp,
  ConfigError,
  HttpError,
  // Cookie helpers
  createSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
};
