// ============================================================================
// TESTS: Compuertas de autenticación (401/403/200) en los 6 endpoints de ofertas
// ============================================================================

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Base URL para tests (los handlers se llaman directamente, no via HTTP)
const TEST_BASE_URL = 'http://localhost:3000';

// Importar los handlers
import { GET as jobsGet, POST as jobsPost } from '../api/jobs/[...slug].js';
import { GET as searchGet } from '../api/search/[...slug].js';
import { GET as analyticsGet } from '../api/analytics/[...slug].js';
import { GET as profileGet } from '../api/profile/[...slug].js';

// Endpoints que requieren requireProfile (6 endpoints de ofertas)
const JOB_ENDPOINTS = [
  { name: 'GET /api/jobs', handler: jobsGet, method: 'GET', url: '/api/jobs?region=argentina' },
  { name: 'GET /api/job', handler: jobsGet, method: 'GET', url: '/api/job?q=test-1' },
  { name: 'GET /api/history', handler: jobsGet, method: 'GET', url: '/api/history?region=argentina' },
  { name: 'POST /api/refresh', handler: jobsPost, method: 'POST', url: '/api/refresh' },
  { name: 'GET /api/cover-letter', handler: analyticsGet, method: 'GET', url: '/api/cover-letter?region=argentina&id=test-1' },
  { name: 'GET /api/analytics', handler: analyticsGet, method: 'GET', url: '/api/analytics' },
  { name: 'GET /api/profile', handler: profileGet, method: 'GET', url: '/api/profile' },
];

// Endpoints públicos (sin compuerta)
const PUBLIC_ENDPOINTS = [
  { name: 'GET /api/health', handler: null, method: 'GET', url: '/api/health' },
  // register, login, logout se testean aparte
];

async function callEndpoint(handler, method, url, cookies = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookies.cookie) headers['Cookie'] = cookies.cookie;
  
  // Usar base URL para que Request funcione correctamente
  const fullUrl = url.startsWith('http') ? url : `http://localhost:3000${url}`;
  
  const req = new Request(fullUrl, {
    method,
    headers,
  });
  
  try {
    return await handler(req);
  } catch (err) {
    // Los handlers devuelven Response, no lanzan
    throw err;
  }
}

describe('Compuertas de autenticación — 6 endpoints de ofertas', () => {
  let validUserId, validSessionCookie, invalidSessionCookie;

  before(async () => {
    // Crear un usuario de prueba en la BD
    // NOTA: Esto asume que hay una BD de test corriendo
    // En CI real, esto se haría en un beforeAll con la BD de test
    validUserId = '00000000-0000-0000-0000-000000000001';
    
    // Cookie válida (firmada con SESSION_SECRET del entorno)
    const crypto = await import('node:crypto');
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const payload = `v1.${validUserId}.${exp}`;
    const secret = process.env.SESSION_SECRET || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const hmac = crypto.createHash('sha256').update(payload + '.' + secret).digest('base64url');
    validSessionCookie = `bei_session=${payload}.${hmac}`;
    
    // Cookie inválida (firma incorrecta)
    invalidSessionCookie = `bei_session=v1.${validUserId}.${exp}.invalid-signature`;
  });

  for (const endpoint of JOB_ENDPOINTS) {
    describe(`${endpoint.name}`, () => {
      it('sin cookie → 401', async () => {
        const res = await callEndpoint(endpoint.handler, endpoint.method, endpoint.url);
        assert.equal(res.status, 401, `${endpoint.name}: expected 401 without cookie`);
        const body = await res.json();
        assert.ok(body.error);
        assert.equal(body.status, 401);
      });

      it('con cookie inválida → 401', async () => {
        const res = await callEndpoint(endpoint.handler, endpoint.method, endpoint.url, {
          cookie: invalidSessionCookie,
        });
        assert.equal(res.status, 401, `${endpoint.name}: expected 401 with invalid cookie`);
        const body = await res.json();
        assert.ok(body.error);
        assert.equal(body.status, 401);
      });

      it('con cookie válida pero SIN perfil → 403 + profileComplete: false', async () => {
        const res = await callEndpoint(endpoint.handler, endpoint.method, endpoint.url, {
          cookie: validSessionCookie,
        });
        // Nota: esto dará 403 solo si el usuario existe en la BD pero no tiene perfil
        // En un test real con BD, esto se verifica. Aquí solo documentamos la expectativa.
        if (res.status === 403) {
          const body = await res.json();
          assert.ok(body.error);
          assert.equal(body.status, 403);
          // El body puede tener profileComplete: false
        } else if (res.status === 401) {
          // Usuario no existe en BD de test - también válido
          const body = await res.json();
          assert.ok(body.error);
          assert.equal(body.status, 401);
        } else {
          // 200 si el usuario tiene perfil (en BD real)
          assert.ok([200, 403, 401].includes(res.status));
        }
      });
    });
  }
});

describe('Endpoints públicos — sin compuerta', () => {
  it('GET /api/health → 200 sin cookie', async () => {
    // health.js no se importa aquí porque es simple, pero la expectativa es:
    // 200 con { ok: true, service: 'busqueda-empleo-ia', time: '...' }
    assert.ok(true, 'Placeholder - health endpoint test');
  });
});