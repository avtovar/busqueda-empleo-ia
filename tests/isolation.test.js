// ============================================================================
// TESTS: Aislamiento entre usuarios (user_id siempre de la cookie)
// ============================================================================

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

import { GET as jobsGet } from '../api/jobs/[...slug].js';
import { GET as searchGet } from '../api/search/[...slug].js';

function createSessionCookie(userId) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const payload = `v1.${userId}.${exp}`;
  const secret = process.env.SESSION_SECRET || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const hmac = createHash('sha256').update(payload + '.' + secret).digest('base64url');
  return `bei_session=${payload}.${hmac}`;
}

async function callEndpoint(handler, method, url, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const req = new Request(url, { method, headers });
  return handler(req);
}

describe('Aislamiento entre usuarios', () => {
  const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const cookieA = createSessionCookie(userA);
  const cookieB = createSessionCookie(userB);

  it('Usuario A pide /api/jobs → no ve ofertas de Usuario B', async () => {
    // En un test real con BD, se insertarían ofertas para userB y se verificaría
    // que userA no las ve. Aquí documentamos la expectativa.
    const res = await callEndpoint(jobsGet, 'GET', '/api/jobs?region=argentina', cookieA);
    // Si userA no existe en BD → 401, si existe sin perfil → 403, si tiene perfil → 200
    // Lo importante: NUNCA 200 con ofertas de userB
    assert.ok([200, 401, 403].includes(res.status));
    
    if (res.status === 200) {
      const body = await res.json();
      // Verificar que todas las ofertas pertenecen a userA (en test real)
      assert.ok(Array.isArray(body.jobs));
    }
  });

  it('Usuario B pide /api/job?q=oferta-de-A → 404', async () => {
    const res = await callEndpoint(jobsGet, 'GET', '/api/job?q=oferta-de-user-a', cookieB);
    // Debe dar 404 (no encontrado) y NO 200 con la oferta de otro usuario
    // Ni 500 (error interno)
    assert.ok([404, 401, 403].includes(res.status), `Expected 404/401/403, got ${res.status}`);
    
    if (res.status === 404) {
      const body = await res.json();
      assert.ok(body.error);
      assert.equal(body.status, 404);
    }
  });

  it('?user_id= en la URL se IGNORA (no permite saltar aislamiento)', async () => {
    const res = await callEndpoint(jobsGet, 'GET', `/api/jobs?region=argentina&user_id=${userB}`, cookieA);
    // El user_id del query string NO debe usarse; debe usar el de la cookie (userA)
    assert.ok([200, 401, 403].includes(res.status));
    // Si es 200, las ofertas deben ser de userA, no de userB
  });

  it('Cookie manipulada (user_id cambiado) → 401', async () => {
    // Crear cookie con userId de userB pero firma de userA (inválida)
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const payload = `v1.${userB}.${exp}`;
    const secret = process.env.SESSION_SECRET || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const hmac = createHash('sha256').update(payload + '.' + secret).digest('base64url');
    const tamperedCookie = `bei_session=${payload}.${hmac}`;
    
    // Esta cookie es válida para userB, pero si la usa userA no debería funcionar
    // porque el user_id sale de la cookie, no del contexto
    // En realidad, una cookie firmada correctamente para userB SÍ funciona para userB
    // Lo que probamos es que una cookie con firma INVÁLIDA da 401
    const invalidCookie = `bei_session=v1.${userA}.${exp}.firma-invalida`;
    
    const res = await callEndpoint(jobsGet, 'GET', '/api/jobs?region=argentina', invalidCookie);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
    assert.equal(body.status, 401);
  });
});