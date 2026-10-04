// ============================================================================
// /api/auth/[...slug] — ENDPOINT CONSOLIDADO DE AUTENTICACIÓN (Catch-all)
//
// Combina 5 endpoints en 1 función serverless para quedarse bajo el límite
// de 12 funciones del plan Hobby de Vercel:
// Build timestamp: 2026-10-04T21:58:00Z
//
//   POST /api/register     → register
//   POST /api/login        → login
//   POST /api/logout       → logout
//   GET  /api/me           → me
//   DELETE /api/account    → account
//
// El ruteo se hace por `req.url` y `req.method`. Cada handler devuelve
// un objeto Response estándar.
// ============================================================================

import {
  hashPassword,
  publicUser,
  readCredentials,
  dummyHash,
  hasProfile,
  verifyPassword,
  requireSession,
  requireProfile,
  clientIp,
} from '../../lib/auth.js';
import {
  createSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  getCookie,
} from '../../lib/auth-fetch.js';
import { query, withTransaction } from '../../lib/db.js';
import { HttpError, ConfigError } from '../../lib/http.js';
import { assertLoginAllowed, clearFailedLogins, recordFailedLogin } from '../../lib/rateLimit.js';

export const config = { maxDuration: 30 };

const MAX_BODY_BYTES = 64 * 1024;
const INVALID_CREDENTIALS = 'El correo o la clave no son correctos.';

function getRoute(req) {
  const url = new URL(req.url);
  return url.pathname.replace('/api/auth', '') || '/';
}

function getClientIp(req) {
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

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 500, extra = {}, extraHeaders = {}) {
  return jsonResponse({ error: message, ...extra }, status, extraHeaders);
}

// ═════════════════════════════════════════════════════════════════════════════
// REGISTER — POST /api/register
// ════════════════════════════════════════════════════════════════════════════

async function handleRegister(req) {
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return errorResponse('El cuerpo de la petición es demasiado grande.', 413);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse('El cuerpo de la petición no es JSON válido.', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('El cuerpo de la petición tiene que ser un objeto JSON.', 400);
  }

  const { email, password } = readCredentials(body);
  const passwordHash = await hashPassword(password);

  let user;
  try {
    const { rows } = await query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email, created_at',
      [email, passwordHash],
    );
    user = rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      return errorResponse('Ya existe una cuenta con ese correo.', 409);
    }
    throw err;
  }

  const sessionCookie = createSessionCookie(user.id);
  return jsonResponse(
    { ok: true, user: publicUser(user), profileComplete: false },
    200,
    { 'Set-Cookie': sessionCookie }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// LOGIN — POST /api/login
// ═══════════════════════════════════════════════════════════════════════════

async function handleLogin(req) {
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    return errorResponse('El cuerpo de la petición es demasiado grande.', 413);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse('El cuerpo de la petición no es JSON válido.', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('El cuerpo de la petición tiene que ser un objeto JSON.', 400);
  }

  const { email, password } = readCredentials(body);
  const ip = getClientIp(req);

  await assertLoginAllowed({ email, ip });

  const { rows } = await query(
    'select id, email, password_hash, created_at from users where email = $1',
    [email],
  );
  const user = rows[0] || null;

  const hash = user ? user.password_hash : dummyHash();
  const claveOk = await verifyPassword(password, hash);

  if (!user || !claveOk) {
    await recordFailedLogin({ email, ip });
    return errorResponse(INVALID_CREDENTIALS, 401);
  }

  await clearFailedLogins(email);

  const profileComplete = await hasProfile(user.id);
  const sessionCookie = createSessionCookie(user.id);

  return jsonResponse(
    { ok: true, user: publicUser(user), profileComplete },
    200,
    { 'Set-Cookie': sessionCookie }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGOUT — POST /api/logout
// ═════════════════════════════════════════════════════════════════════════

async function handleLogout() {
  const clearCookie = clearSessionCookie();
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearCookie });
}

// ═══════════════════════════════════════════════════════════════════════════
// ME — GET /api/me
// ═════════════════════════════════════════════════════════════════════════

async function handleMe(req) {
  const sessionCookie = getCookie(req, 'session');
  if (!sessionCookie) {
    return errorResponse('No hay sesión válida.', 401);
  }

  const session = parseSessionCookie(sessionCookie);
  if (!session) {
    return errorResponse('Sesión inválida.', 401);
  }

  const { rows } = await query(
    'select id, email, created_at from users where id = $1',
    [session.userId],
  );
  const user = rows[0];
  if (!user) {
    return errorResponse('Usuario no encontrado.', 401);
  }

  const profileComplete = await hasProfile(user.id);

  return jsonResponse({
    user: publicUser(user),
    profileComplete,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNT — DELETE /api/account
// ══════════════════════════════════════════════════════════════════════════

async function handleAccount(req) {
  const sessionCookie = getCookie(req, 'session');
  if (!sessionCookie) {
    return errorResponse('No hay sesión válida.', 401);
  }

  const session = parseSessionCookie(sessionCookie);
  if (!session) {
    return errorResponse('Sesión inválida.', 401);
  }

  const { rows } = await query(
    'select id, email from users where id = $1',
    [session.userId],
  );
  const user = rows[0];
  if (!user) {
    return errorResponse('Usuario no encontrado.', 401);
  }

  const ip = getClientIp(req);
  const userAgent = req.headers.get('user-agent');

  await withTransaction(async (client) => {
    await client.query(
      'insert into account_deletions (user_id, email, ip, user_agent) values ($1, $2, $3, $4)',
      [user.id, user.email, ip, userAgent],
    );

    await client.query('delete from users where id = $1', [user.id]);
  });

  const clearCookie = clearSessionCookie();
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearCookie });
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTER PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

function withErrorHandling(handler) {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = {};
        if (err.headers) {
          for (const [key, value] of Object.entries(err.headers)) {
            headers[key] = value;
          }
        }
        return errorResponse(err.message, err.status, err.extra, headers);
      }
      if (err instanceof ConfigError) {
        console.error('[config] %s', err.message);
        return errorResponse(err.message, 500);
      }
      console.error('[error] %s', (err && err.stack) || err);
      return errorResponse('Error interno del servidor.', 500);
    }
  };
}

export const POST = withErrorHandling(async (req) => {
  const route = getRoute(req);

  if (route === '/register') {
    return handleRegister(req);
  } else if (route === '/login') {
    return handleLogin(req);
  } else if (route === '/logout') {
    return handleLogout(req);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
});

export const GET = withErrorHandling(async (req) => {
  const route = getRoute(req);

  if (route === '/me') {
    return handleMe(req);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
});

export const DELETE = withErrorHandling(async (req) => {
  const route = getRoute(req);

  if (route === '/account') {
    return handleAccount(req);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
});// force rebuild
