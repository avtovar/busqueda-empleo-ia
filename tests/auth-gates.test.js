// ============================================================================
// TESTS: Compuertas de autenticación (401/403/200) en endpoints protegidos
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../lib/db.js';
import { createTestSessionCookie } from './test-utils.js';

// Importar los handlers
import { GET as jobsGet, POST as jobsPost } from '../api/jobs/[...slug].js';
import { GET as analyticsGet } from '../api/analytics/[...slug].js';
import { GET as profileGet } from '../api/profile/[...slug].js';
import { GET as healthGet } from '../api/health.js';

// Endpoints de ofertas y perfil protegidos por requireProfile.
const JOB_ENDPOINTS = [
  { name: 'GET /api/jobs', handler: jobsGet, method: 'GET', url: '/api/jobs?region=argentina' },
  { name: 'GET /api/job', handler: jobsGet, method: 'GET', url: '/api/job?q=test-1' },
  { name: 'GET /api/history', handler: jobsGet, method: 'GET', url: '/api/history?region=argentina' },
  { name: 'POST /api/refresh', handler: jobsPost, method: 'POST', url: '/api/refresh' },
  { name: 'GET /api/cover-letter', handler: analyticsGet, method: 'GET', url: '/api/analytics/cover-letter?region=argentina&id=test-1' },
  { name: 'GET /api/analytics', handler: analyticsGet, method: 'GET', url: '/api/analytics/analytics' },
  { name: 'GET /api/profile', handler: profileGet, method: 'GET', url: '/api/profile/profile' },
];

async function callEndpoint(handler, method, url, cookies = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookies.cookie) headers['Cookie'] = cookies.cookie;
  
  // Usar base URL para que Request funcione correctamente
  const req = new Request(url.startsWith('http') ? url : `http://localhost:3000${url}`, {
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

describe('Compuertas de autenticación — endpoints protegidos', () => {
  let validUserId, validSessionCookie, invalidSessionCookie;

  before(async () => {
    validUserId = '00000000-0000-0000-0000-000000000001';
    await query(
      `insert into users (id, email, password_hash)
       values ($1, $2, 'test-hash')
       on conflict (id) do update set email = excluded.email`,
      [validUserId, 'auth-gates-test@example.test'],
    );
    await query('delete from profiles where user_id = $1', [validUserId]);
    
    // Se firma con el mismo helper que usa la app; un hash de concatenación
    // no equivale al HMAC que valida requireSession().
    validSessionCookie = createTestSessionCookie(validUserId);
    
    // Cookie inválida (firma incorrecta)
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    invalidSessionCookie = `bei_session=v1.${validUserId}.${exp}.invalid-signature`;
  });

  after(async () => {
    await query('delete from users where id = $1', [validUserId]);
  });

  for (const endpoint of JOB_ENDPOINTS) {
    describe(`${endpoint.name}`, () => {
      it('sin cookie → 401', async () => {
        const res = await callEndpoint(endpoint.handler, endpoint.method, endpoint.url);
        assert.equal(res.status, 401, `${endpoint.name}: expected 401 without cookie`);
        const body = await res.json();
        assert.ok(body.error);
      });

      it('con cookie inválida → 401', async () => {
        const res = await callEndpoint(endpoint.handler, endpoint.method, endpoint.url, {
          cookie: invalidSessionCookie,
        });
        assert.equal(res.status, 401, `${endpoint.name}: expected 401 with invalid cookie`);
        const body = await res.json();
        assert.ok(body.error);
      });

      it('con cookie válida pero SIN perfil → 403 + profileComplete: false', async () => {
        const res = await callEndpoint(endpoint.handler, endpoint.method, endpoint.url, {
          cookie: validSessionCookie,
        });
        assert.equal(res.status, 403, `${endpoint.name}: profile-less user must get 403`);
        const body = await res.json();
        assert.ok(body.error);
        assert.equal(body.profileComplete, false);
      });
    });
  }
});

describe('Endpoints públicos — sin compuerta', () => {
  it('GET /api/health → 200 sin cookie', async () => {
    const res = await callEndpoint(healthGet, 'GET', '/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'busqueda-empleo-ia');
  });
});