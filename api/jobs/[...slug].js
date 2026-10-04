// Build timestamp: 2026-10-04T21:58:00Z ============================================================================
// /api/jobs/[...slug] — ENDPOINT CONSOLIDADO DE OFERTAS (Catch-all)
//
// Combina 4 endpoints en 1 función serverless:
//
//   GET  /api/jobs        → jobs (lista rankeada de una región)
//   GET  /api/job         → job (detalle de una oferta con re-rank y resumen)
//   GET  /api/history     → history (ofertas vistas por región)
//   POST /api/refresh     → refresh (fuerza corrida nueva ignorando caché)
//
// El ruteo se hace por `req.url` y `req.method`. Cada handler devuelve
// un objeto Response estándar.
// Build timestamp: 2026-10-04T21:58:00Z ============================================================================

import { requireProfile } from '../../lib/auth-fetch.js';
import { HttpError } from '../../lib/auth-fetch.js';
import {
  bucketOf,
  getRanked,
  resolveRegion,
} from '../../lib/jobs.js';
import { DEFAULT_REGION } from '../../lib/regions.js';
import { findJobById, getHistoryForRegion } from '../../lib/history.js';
import { computeMatch } from '../../lib/matcher.js';
import { summarize } from '../../lib/coverLetter.js';
import { loadProfileSkills, normalizeProfile } from '../../lib/profile.js';

export const config = { maxDuration: 30 };

const BASE_PATH = '/api/jobs';

function getRoute(req) {
  const url = new URL(req.url);
  return url.pathname.replace(BASE_PATH, '') || '/';
}

function getQueryParam(req, name) {
  const url = new URL(req.url);
  return url.searchParams.get(name);
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
      console.error('[error] %s', (err && err.stack) || err);
      return errorResponse('Error interno del servidor.', 500);
    }
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// JOBS — GET /api/jobs?region=
// ════════════════════════════════════════════════════════════════════════════

async function handleJobs(req, user, profile) {
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));
  const region = resolveRegion(getQueryParam(req, 'region'));

  const { regions, _online, source, checkedAt } = await getRanked(user.id, contract, { region });
  const jobs = bucketOf(regions, region);

  return jsonResponse({
    region,
    jobs,
    total: jobs.length,
    _online,
    source,
    checkedAt,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// JOB — GET /api/job?q=<id>
// ═══════════════════════════════════════════════════════════════════════════

async function handleJob(req, user, profile) {
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));
  const id = getQueryParam(req, 'q') || getQueryParam(req, 'id');

  const found = id ? await findJobById(user.id, id) : null;
  if (!found) {
    return errorResponse('No encontramos esa oferta.', 404);
  }

  const job = { ...found.job, ...computeMatch(found.job, contract) };
  return jsonResponse({ job, summary: summarize(job, contract) });
}

// ════════════════════════════════════════════════════════════════════════════
// HISTORY — GET /api/history?region=
// ═══════════════════════════════════════════════════════════════════════════

async function handleHistory(req, user, profile) {
  normalizeProfile(profile, await loadProfileSkills(user.id));

  const region = resolveRegion(getQueryParam(req, 'region'));
  const jobs = await getHistoryForRegion(user.id, region);

  return jsonResponse({ region, jobs });
}

// ════════════════════════════════════════════════════════════════════════════
// REFRESH — POST /api/refresh
// ════════════════════════════════════════════════════════════════════════════

async function handleRefresh(req, user, profile) {
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  const { regions, _online, source, checkedAt } = await getRanked(user.id, contract, {
    force: true,
    region: DEFAULT_REGION,
  });

  const jobs = bucketOf(regions, DEFAULT_REGION);

  return jsonResponse({
    ok: true,
    _online,
    at: checkedAt,
    total: jobs.length,
    source,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTER PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

async function handleGet(req) {
  const { user, profile } = await requireProfile(req);
  const route = getRoute(req);

  if (route === '/jobs' || route === '/') {
    return handleJobs(req, user, profile);
  } else if (route === '/job') {
    return handleJob(req, user, profile);
  } else if (route === '/history') {
    return handleHistory(req, user, profile);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
}

async function handlePost(req) {
  const { user, profile } = await requireProfile(req);
  const route = getRoute(req);

  if (route === '/refresh') {
    return handleRefresh(req, user, profile);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
}

export const GET = withErrorHandling(handleGet);
export const POST = withErrorHandling(handlePost);
