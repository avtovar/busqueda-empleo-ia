// ============================================================================
// POST /api/linkedin-search — BÚSQUEDA DE LINKEDIN VIA APIFY
//
// EJECUTA UN ACTOR DE APIFY QUE SE FACTURA POR EJECUCIÓN.
// NO SE LLAMA EN TESTS, CI, SMOKE TESTS, NI PARA "VERIFICAR QUE ANDA".
// Se factura de verdad. La clave es del dueño de la app (`APIFY_API_TOKEN`).
//
// ── CONTRATO ────────────────────────────────────────────────────────────────
//
// Request:
//   POST /api/linkedin-search
//   Body: { region?: string, limit?: number }
//
//   region: clave de región ('argentina', etc.). Si no viene o no es válida,
//           se usa la región por defecto (nunca 400).
//   limit:  tope de ofertas a pedir (20..1000, clampado). Opcional.
//
// Response 200:
//   { region, jobs, total, regions, stats, _online, source, checkedAt, resultLimit, pages, searchUrl }
//
// Response codes:
//   401  sin cookie válida          → pantalla de acceso
//   403  con cookie pero SIN CV     → onboarding del CV (profileComplete: false)
//   429  límite diario de Apify agotado (Retry-After en header y body)
//   502  error de Apify (token inválido, error del actor, timeout)
//   503  falta APIFY_API_TOKEN en el servidor
//   500  cualquier error de la base
//
// NUNCA 400: `region` inválida cae a default; `limit` inválido se clampaa.
// NUNCA 402: se reenvía si Apify la devuelve (sin saldo), pero no se genera acá.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { sendJson, withErrorHandling, readJsonBody } from './lib/http.js';
import { searchLinkedInWithApify } from './lib/apifyLinkedin.js';
import { assertApifyAllowed } from './lib/apifyLimit.js';
import { isValidRegion, DEFAULT_REGION } from './lib/regions.js';

// ↑ maxDuration: 60 segundos. Apify puede tardar hasta 300s (su timeout), el
// timeout propio del módulo es 320s, pero Vercel corta en 60s por defecto en
// el plan hobby. Si se necesita más, hay que subir el plan o usar una cola.
// El módulo `apifyLinkedin` tiene su propio AbortController a 320s.
export const config = { maxDuration: 60 };

/**
 * Busca ofertas en LinkedIn via Apify para el usuario autenticado.
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const POST = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas: requireProfile tira 401 o 403 antes de que exista una línea más.
  // Devuelve { user, profile } donde profile YA es la fila cruda de `profiles`.
  const { user, profile } = await requireProfile(req);

  // 2) Rate limit diario de Apify ANTES de llamar al actor.
  // Si ya agotó la cuota, lanza HttpError 429 con Retry-After (header + body).
  await assertApifyAllowed(user.id);

  // 3) Leer body JSON (límite 64KB, 400 si no es objeto).
  const body = await readJsonBody(req);

  // 4) Resolver región: misma regla que el resto (isValidRegion ? key : DEFAULT_REGION).
  // Nunca 400 por región inválida.
  const region = isValidRegion(body?.region) ? body.region : DEFAULT_REGION;

  // 5) Limit opcional (se clampaa en apifyLinkedin.maxResults).
  const limit = body?.limit;

  // 6) Normalizar perfil: requireProfile ya trajo la fila de `profiles` (snake_case).
  // Hacemos `normalizeProfile(profile, await loadProfileSkills(user.id))` para
  // tener el contrato completo (camelCase, skills como array [{name, weight}]).
  // Importamos acá para no crear ciclo de dependencias.
  const { normalizeProfile } = await import('./lib/profile.js');
  const { loadProfileSkills } = await import('./lib/profile.js');
  const contractProfile = normalizeProfile(profile, await loadProfileSkills(user.id));

  // 7) Llamar al módulo puro (recibe perfil, región, opciones).
  const result = await searchLinkedInWithApify(contractProfile, region, { limit });

  // 8) Responder.
  sendJson(res, 200, result);
});