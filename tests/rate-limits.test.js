// ============================================================================
// TESTS: Rate limits con concurrencia real (Promise.all)
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

import { query } from '../lib/db.js';
import { withLoginAttempt, countRecentAttempts } from '../lib/rateLimit.js';
import { assertCvParseAllowed, countRecentCvParses } from '../lib/cvParseLimit.js';
import { assertApifyAllowed, countTodayApifyUsage } from '../lib/apifyLimit.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@localhost:5432/test?sslmode=disable';
const TEST_EMAIL = `rate-limit-${randomUUID()}@example.test`;
const TEST_IP = `test-ip-${randomUUID()}`;
const TEST_USER_ID = randomUUID();
const testEmails = new Set([TEST_EMAIL]);
const testIps = new Set([TEST_IP]);
const testUserIds = new Set([TEST_USER_ID]);

function setupEnv() {
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.LOGIN_LIMIT = '1';
  process.env.LOGIN_LIMIT_MAX_PER_PAIR = '3';
  process.env.LOGIN_LIMIT_MAX_PER_IP = '5';
  process.env.LOGIN_LIMIT_WINDOW_MINUTES = '1';
  process.env.CV_PARSE_LIMIT = '2';
  process.env.CV_PARSE_LIMIT_WINDOW_MINUTES = '1';
  process.env.APIFY_DAILY_LIMIT = '2';
}

async function cleanup() {
  await query(
    'delete from login_attempts where email = any($1::text[]) or ip = any($2::text[])',
    [[...testEmails], [...testIps]],
  );
  await query('delete from users where id = any($1::uuid[])', [[...testUserIds]]);
}

async function createTestUser() {
  const userId = randomUUID();
  testUserIds.add(userId);
  await query(
    'insert into users (id, email, password_hash) values ($1, $2, $3)',
    [userId, `rate-limit-${userId}@example.test`, 'test-hash'],
  );
  return userId;
}

async function createFixedTestUser() {
  await query(
    'insert into users (id, email, password_hash) values ($1, $2, $3)',
    [TEST_USER_ID, `rate-limit-${TEST_USER_ID}@example.test`, 'test-hash'],
  );
}

function failedLogin(email, ip) {
  return withLoginAttempt({ email, ip }, async () => ({ authenticated: false }));
}

describe('Rate limits — concurrencia real', () => {
  before(async () => {
    setupEnv();
    await cleanup();
    await createFixedTestUser();
  });

  after(async () => {
    await cleanup();
  });

  describe('Login rate limit (withLoginAttempt)', () => {
    it('registra fallos y rechaza el siguiente intento al llegar al límite', async () => {
      for (let i = 0; i < 3; i++) {
        const result = await failedLogin(TEST_EMAIL, TEST_IP);
        assert.equal(result.authenticated, false);
      }

      await assert.rejects(failedLogin(TEST_EMAIL, TEST_IP), (err) => {
        assert.equal(err.status, 429);
        assert.ok(err.headers?.['Retry-After']);
        assert.ok(err.extra?.retryAfterSeconds > 0);
        return true;
      });
    });

    it('concurrencia: solicitudes simultáneas no pasan el límite', async () => {
      const email = `concurrent-${randomUUID()}@example.test`;
      const ip = `test-ip-${randomUUID()}`;
      testEmails.add(email);
      testIps.add(ip);
      const results = await Promise.all(
        Array(10).fill(null).map(() => failedLogin(email, ip).catch((err) => err)),
      );
      const allowed = results.filter((result) => result?.authenticated === false).length;
      const rejected = results.filter((result) => result?.status === 429).length;

      assert.equal(allowed, 3, `Expected 3 failed logins admitted, got ${allowed}`);
      assert.equal(rejected, 7, `Expected 7 rejected, got ${rejected}`);
      const count = await countRecentAttempts({ email, ip });
      assert.equal(count.pair, 3);
    });

    it('login exitoso limpia intentos previos del correo', async () => {
      const email = `success-${randomUUID()}@example.test`;
      const ip = `test-ip-${randomUUID()}`;
      testEmails.add(email);
      testIps.add(ip);
      await failedLogin(email, ip);
      await failedLogin(email, ip);
      assert.equal((await countRecentAttempts({ email, ip })).pair, 2);

      await withLoginAttempt({ email, ip }, async () => ({ authenticated: true }));
      assert.equal((await countRecentAttempts({ email, ip })).pair, 0);
    });

    it('429 no agrega otro intento', async () => {
      const email = `rollback-${randomUUID()}@example.test`;
      const ip = `test-ip-${randomUUID()}`;
      testEmails.add(email);
      testIps.add(ip);
      for (let i = 0; i < 3; i++) await failedLogin(email, ip);
      await assert.rejects(failedLogin(email, ip), { status: 429 });
      assert.equal((await countRecentAttempts({ email, ip })).pair, 3);
    });
  });

  describe('CV Parse rate limit (assertCvParseAllowed)', () => {
    it('permite hasta maxParses parseos por ventana', async () => {
      const result1 = await assertCvParseAllowed(TEST_USER_ID);
      assert.equal(result1.allowed, true);
      assert.equal(result1.used, 1);
      
      const result2 = await assertCvParseAllowed(TEST_USER_ID);
      assert.equal(result2.allowed, true);
      assert.equal(result2.used, 2);
      
      try {
        await assertCvParseAllowed(TEST_USER_ID);
        assert.fail('Should have thrown 429 on 3rd parse');
      } catch (err) {
        assert.equal(err.status, 429);
        assert.ok(err.headers?.['Retry-After']);
      }
    });

    it('concurrencia: 5 requests simultáneos respetan límite de 2', async () => {
      const userId = await createTestUser();
      
      const promises = Array(5).fill(null).map(() => 
        assertCvParseAllowed(userId).catch(e => e)
      );
      
      const results = await Promise.all(promises);
      const allowed = results.filter(r => r?.allowed === true).length;
      const rejected = results.filter(r => r?.status === 429).length;
      
      assert.equal(allowed, 2, `Expected 2 allowed, got ${allowed}`);
      assert.equal(rejected, 3, `Expected 3 rejected, got ${rejected}`);
      
      const count = await countRecentCvParses(userId);
      assert.equal(count.used, 2, `DB should have 2 parses, has ${count.used}`);
    });

    it('CV_PARSE_LIMIT=0 desactiva el límite', async () => {
      process.env.CV_PARSE_LIMIT = '0';
      
      const userId = await createTestUser();
      for (let i = 0; i < 10; i++) {
        const result = await assertCvParseAllowed(userId);
        assert.equal(result.allowed, true);
      }
      
      process.env.CV_PARSE_LIMIT = '2';
    });
  });

  describe('Apify rate limit (assertApifyAllowed)', () => {
    it('permite hasta dailyLimit búsquedas por día (UTC)', async () => {
      const result1 = await assertApifyAllowed(TEST_USER_ID);
      assert.equal(result1.allowed, true);
      assert.equal(result1.used, 1);
      
      const result2 = await assertApifyAllowed(TEST_USER_ID);
      assert.equal(result2.allowed, true);
      assert.equal(result2.used, 2);
      
      try {
        await assertApifyAllowed(TEST_USER_ID);
        assert.fail('Should have thrown 429 on 3rd search');
      } catch (err) {
        assert.equal(err.status, 429);
        assert.ok(err.headers?.['Retry-After']);
        assert.ok(err.extra?.retryAfterSeconds > 0);
        assert.ok(err.extra?.retryAfterSeconds <= 86400);
      }
    });

    it('concurrencia: 5 requests simultáneos respetan límite diario de 2', async () => {
      const userId = await createTestUser();
      
      const promises = Array(5).fill(null).map(() => 
        assertApifyAllowed(userId).catch(e => e)
      );
      
      const results = await Promise.all(promises);
      const allowed = results.filter(r => r?.allowed === true).length;
      const rejected = results.filter(r => r?.status === 429).length;
      
      assert.equal(allowed, 2, `Expected 2 allowed, got ${allowed}`);
      assert.equal(rejected, 3, `Expected 3 rejected, got ${rejected}`);
      
      const count = await countTodayApifyUsage(userId);
      assert.equal(count.used, 2, `DB should have 2 searches, has ${count.used}`);
    });

    it('APIFY_DAILY_LIMIT=0 desactiva el límite', async () => {
      process.env.APIFY_DAILY_LIMIT = '0';
      
      const userId = await createTestUser();
      for (let i = 0; i < 10; i++) {
        const result = await assertApifyAllowed(userId);
        assert.equal(result.allowed, true);
      }
      
      process.env.APIFY_DAILY_LIMIT = '2';
    });
  });
});