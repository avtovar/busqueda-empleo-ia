// Build timestamp: 2026-10-04T21:58:00Z ============================================================================
// /api/search/[...slug] — ENDPOINT CONSOLIDADO DE DIRECTORIO Y LINKEDIN (Catch-all)
//
// Combina 2 endpoints en 1 función serverless:
//
//   GET  /api/directorio        → catálogo de bolsas/consultoras (requireProfile)
//   POST /api/linkedin-search   → búsqueda LinkedIn vía Apify (requireProfile)
//
// maxDuration: 60 para cubrir /api/linkedin-search (Apify puede tardar mucho)
// Build timestamp: 2026-10-04T21:58:00Z ============================================================================

import { requireProfile } from '../../lib/auth-fetch.js';
import { buildDirectory } from '../../lib/directorio.js';
import { searchLinkedInWithApify } from '../../lib/apifyLinkedin.js';
import { assertApifyAllowed } from '../../lib/apifyLimit.js';
import { isValidRegion, DEFAULT_REGION } from '../../lib/regions.js';
import { loadProfileSkills, normalizeProfile } from '../../lib/profile.js';
import { HttpError } from '../../lib/auth-fetch.js';

export const config = { maxDuration: 60 };

const BASE_PATH = '/api/search';

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

// ════════════════════════════════════════════════════════════════════════════
// DIRECTORIO — GET /api/directorio?region=
// ══════════════════════════════════════════════════════════════════════════

async function handleDirectorio(req, user, profile) {
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));
  return jsonResponse(buildDirectory(contract, getQueryParam(req, 'region')));
}

// ══════════════════════════════════════════════════════════════════════════
// LINKEDIN-SEARCH — POST /api/linkedin-search
// ═════════════════════════════════════════════════════════════════════════

async function handleLinkedInSearch(req, user, profile) {
  await assertApifyAllowed(user.id);

  const body = await req.json();
  const region = isValidRegion(body?.region) ? body.region : DEFAULT_REGION;
  const limit = body?.limit;

  const { normalizeProfile: np, loadProfileSkills: lps } = await import('../../lib/profile.js');
  const contractProfile = np(profile, await lps(user.id));

  const result = await searchLinkedInWithApify(contractProfile, region, { limit });
  return jsonResponse(result);
}

// ═════════════════════════════════════════════════════════════════════════
// ROUTER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════

async function handleGet(req) {
  const { user, profile } = await requireProfile(req);
  const route = getRoute(req);

  if (route === '/directorio' || route === '/') {
    return handleDirectorio(req, user, profile);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
}

async function handlePost(req) {
  const { user, profile } = await requireProfile(req);
  const route = getRoute(req);

  if (route === '/linkedin-search') {
    return handleLinkedInSearch(req, user, profile);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
}

export const GET = withErrorHandling(handleGet);
export const POST = withErrorHandling(handlePost);
