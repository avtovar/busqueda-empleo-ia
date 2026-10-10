// ============================================================================
// TESTS: Aislamiento entre usuarios (user_id siempre de la cookie)
// ============================================================================

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query } from '../lib/db.js';
import { createTestSessionCookie } from './test-utils.js';
import { GET as jobsGet } from '../api/jobs/[...slug].js';

const userA = randomUUID();
const userB = randomUUID();
const jobId = `isolation-${randomUUID()}`;
const emailA = `isolation-${userA}@example.test`;
const emailB = `isolation-${userB}@example.test`;
const cookieA = createTestSessionCookie(userA);
const cookieB = createTestSessionCookie(userB);

async function callEndpoint(url, cookie) {
  const req = new Request(`http://localhost:3000${url}`, {
    method: 'GET',
    headers: cookie ? { Cookie: cookie } : {},
  });
  return jobsGet(req);
}

describe('Aislamiento entre usuarios', () => {
  before(async () => {
    await query(
      `insert into users (id, email, password_hash)
       values ($1, $2, 'test-hash'), ($3, $4, 'test-hash')`,
      [userA, emailA, userB, emailB],
    );
    await query(
      `insert into profiles (user_id, full_name, title)
       values ($1, 'Test A', 'QA Engineer'), ($2, 'Test B', 'QA Engineer')`,
      [userA, userB],
    );
    await query(
      `insert into job_history (user_id, key, job, regions, expires_at)
       values ($1, $2, $3::jsonb, array['argentina'], clock_timestamp() + interval '1 day')`,
      [
        userA,
        `qa engineer::testcorp::${jobId}`,
        JSON.stringify({
          id: jobId,
          title: 'QA Engineer',
          company: 'TestCorp',
          description: 'QA testing role',
          tags: ['qa', 'testing'],
          regionGuess: 'argentina',
          applyUrl: 'https://example.test/apply',
          date: new Date().toISOString(),
        }),
      ],
    );
  });

  after(async () => {
    await query('delete from users where id = any($1::uuid[])', [[userA, userB]]);
  });

  it('el usuario dueño puede consultar su oferta guardada', async () => {
    const res = await callEndpoint(`/api/jobs/job?q=${encodeURIComponent(jobId)}`, cookieA);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.job.id, jobId);
  });

  it('otro usuario no puede consultar la oferta aunque conozca su id', async () => {
    const res = await callEndpoint(`/api/jobs/job?q=${encodeURIComponent(jobId)}`, cookieB);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });

  it('user_id en la URL no cambia el dueño de la sesión', async () => {
    const owned = await callEndpoint(
      `/api/jobs/job?q=${encodeURIComponent(jobId)}&user_id=${userB}`,
      cookieA,
    );
    assert.equal(owned.status, 200);

    const foreign = await callEndpoint(
      `/api/jobs/job?q=${encodeURIComponent(jobId)}&user_id=${userA}`,
      cookieB,
    );
    assert.equal(foreign.status, 404);
  });

  it('cookie manipulada se rechaza con 401', async () => {
    const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const invalidCookie = `bei_session=v1.${userA}.${exp}.firma-invalida`;
    const res = await callEndpoint(`/api/jobs/job?q=${encodeURIComponent(jobId)}`, invalidCookie);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  });
});
