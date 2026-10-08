// ============================================================================
// /api/favorites — ENDPOINTS DE FAVORITOS (Guardar/Quitar/Listar)
// ============================================================================

import { requireProfile } from '../lib/auth-fetch.js';
import { HttpError } from '../lib/auth-fetch.js';
import { query, withTransaction } from '../lib/db.js';

export const config = { maxDuration: 30 };

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
      console.error('[favorites] error: %s', (err && err.stack) || err);
      return errorResponse('Error interno del servidor.', 500);
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/favorites — Lista favoritos del usuario
// ═════════════════════════════════════════════════════════════════════════════

async function handleGetFavorites(req, user) {
  const { rows } = await query(
    `select job, created_at as savedAt
       from favorites
      where user_id = $1
      order by created_at desc`,
    [user.id],
  );

  return jsonResponse({
    favorites: rows.map((r) => ({ ...r.job, savedAt: r.savedAt })),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/favorites — Guardar una oferta (toggle: guarda si no está, quita si está)
// Body: { key, job }
// ═════════════════════════════════════════════════════════════════════════════

async function handleToggleFavorite(req, user) {
  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse('El cuerpo de la petición no es JSON válido.', 400);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('El cuerpo de la petición tiene que ser un objeto JSON.', 400);
  }

  const { key, job } = body;
  if (!key || typeof key !== 'string') {
    return errorResponse('Falta la clave (key) de la oferta.', 400);
  }
  if (!job || typeof job !== 'object') {
    return errorResponse('Falta la oferta (job) a guardar.', 400);
  }

  const exists = await query(
    `select 1 from favorites where user_id = $1 and key = $2`,
    [user.id, key],
  );

  if (exists.rows.length > 0) {
    // Ya existe → quitar
    await query(`delete from favorites where user_id = $1 and key = $2`, [user.id, key]);
    return jsonResponse({ ok: true, saved: false });
  } else {
    // No existe → guardar
    await withTransaction(async (client) => {
      await client.query(
        `insert into favorites (user_id, key, job) values ($1, $2, $3)
         on conflict (user_id, key) do update set job = $3`,
        [user.id, key, JSON.stringify(job)],
      );
    });
    return jsonResponse({ ok: true, saved: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ROUTER
// ═════════════════════════════════════════════════════════════════════════════

export const GET = withErrorHandling(async (req) => {
  const { user } = await requireProfile(req);
  return handleGetFavorites(req, user);
});

export const POST = withErrorHandling(async (req) => {
  const { user } = await requireProfile(req);
  return handleToggleFavorite(req, user);
});