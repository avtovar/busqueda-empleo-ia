// Build timestamp: 2026-10-04T21:58:00Z ============================================================================
// /api/analytics/[...slug] — ENDPOINT CONSOLIDADO DE ANALÍTICA Y CARTAS (Catch-all)
//
// Combina 2 endpoints en 1 función serverless:
//
//   GET /api/analytics       → analítica de mercado (requireProfile)
//   GET /api/cover-letter    → carta de presentación (requireProfile)
// Build timestamp: 2026-10-04T21:58:00Z ============================================================================

import { requireProfile } from '../../lib/auth-fetch.js';
import { buildAnalytics } from '../../lib/analytics.js';
import { generateCoverLetter } from '../../lib/coverLetter.js';
import { getRanked } from '../../lib/jobs.js';
import { findJobById } from '../../lib/history.js';
import { resolveRegion } from '../../lib/jobs.js';
import { loadProfileSkills, normalizeProfile } from '../../lib/profile.js';
import { HttpError } from '../../lib/auth-fetch.js';

export const config = { maxDuration: 30 };

const BASE_PATH = '/api/analytics';

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
// ANALYTICS — GET /api/analytics
// ═════════════════════════════════════════════════════════════════════════════

async function handleAnalytics(req, user, profile) {
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  const { regions } = await getRanked(user.id, contract);

  const data = buildAnalytics(regions, contract);

  // Guard de githubEvidence.projects
  data.githubEvidence = (Array.isArray(data.githubEvidence) ? data.githubEvidence : []).map((skill) => (
    skill && typeof skill === 'object' && !Array.isArray(skill)
      ? { ...skill, projects: Array.isArray(skill.projects) ? skill.projects : [] }
      : skill
  ));

  return jsonResponse(data);
}

// ═════════════════════════════════════════════════════════════════════════════
// COVER-LETTER — GET /api/cover-letter?region=&id=
// ════════════════════════════════════════════════════════════════════════════

async function handleCoverLetter(req, user, profile) {
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  const region = resolveRegion(getQueryParam(req, 'region'));
  const id = getQueryParam(req, 'id') || getQueryParam(req, 'q');

  const found = id ? await findJobById(user.id, id) : null;
  if (!found) {
    return errorResponse('No encontramos esa oferta.', 404);
  }

  return jsonResponse(generateCoverLetter(found.job, region, contract));
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTER PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

async function handleGet(req) {
  const { user, profile } = await requireProfile(req);
  const route = getRoute(req);

  if (route === '/analytics' || route === '/') {
    return handleAnalytics(req, user, profile);
  } else if (route === '/cover-letter') {
    return handleCoverLetter(req, user, profile);
  } else {
    return errorResponse('Endpoint no encontrado', 404);
  }
}

export const GET = withErrorHandling(handleGet);
