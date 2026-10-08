// ============================================================================
// TESTS: Rate limits con concurrencia real (Promise.all)
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

import { assertLoginAllowed, clearFailedLogins, countRecentAttempts } from '../lib/rateLimit.js';
import { assertCvParseAllowed, countRecentCvParses } from '../lib/cvParseLimit.js';
import { assertApifyAllowed, countTodayApifyUsage } from '../lib/apifyLimit.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@localhost:5432/test?sslmode=disable';
const TEST_EMAIL = 'rate-limit-test@example.com';
const TEST_IP = '192.0.2.1';
const TEST_USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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
  const { query } = await import('../lib/db.js');
  await query('DELETE FROM login_attempts WHERE email = $1', [TEST_EMAIL]);
  await query('DELETE FROM cv_parses WHERE user_id = $1', [TEST_USER_ID]);
  await query('DELETE FROM apify_usage WHERE user_id = $1', [TEST_USER_ID]);
}

describe('Rate limits — concurrencia real', () => {
  before(async () => {
    setupEnv();
    await cleanup();
  });

  after(async () => {
    await cleanup();
  });

  describe('Login rate limit (assertLoginAllowed)', () => {
    it('permite hasta maxPerPair intentos fallidos por (email, ip)', async () => {
      await clearFailedLogins(TEST_EMAIL);
      
      for (let i = 0; i < 3; i++) {
        const result = await assertLoginAllowed({ email: TEST_EMAIL, ip: TEST_IP });
        assert.equal(result.allowed, true, `Attempt ${i + 1} should be allowed`);
      }
      
      try {
        await assertLoginAllowed({ email: TEST_EMAIL, ip: TEST_IP });
        assert.fail('Should have thrown 429 on 4th attempt');
      } catch (err) {
        assert.equal(err.status, 429);
        assert.ok(err.headers?.['Retry-After']);
        assert.ok(err.extra?.retryAfterSeconds > 0);
      }
    });

    it('concurrencia: 10 requests simultáneos no pasan el límite (advisory lock)', async () => {
      await clearFailedLogins(TEST_EMAIL);
      const email = `concurrent-${Date.now()}@test.com`;
      
      const promises = Array(10).fill(null).map(() => 
        assertLoginAllowed({ email, ip: TEST_IP }).catch(e => e)
      );
      
      const results = await Promise.all(promises);
      const allowed = results.filter(r => r?.allowed === true).length;
      const rejected = results.filter(r => r?.status === 429).length;
      
      assert.equal(allowed, 3, `Expected 3 allowed, got ${allowed}`);
      assert.equal(rejected, 7, `Expected 7 rejected, got ${rejected}`);
      
      const count = await countRecentAttempts({ email, ip: TEST_IP });
      assert.equal(count.pair, 3, `DB should have 3 attempts, has ${count.pair}`);
    });

    it('login exitoso limpia los intentos (clearFailedLogins)', async () => {
      await clearFailedLogins(TEST_EMAIL);
      await assertLoginAllowed({ email: TEST_EMAIL, ip: TEST_IP });
      await assertLoginAllowed({ email: TEST_EMAIL, ip: TEST_IP });
      
      let count = await countRecentAttempts({ email: TEST_EMAIL, ip: TEST_IP });
      assert.equal(count.pair, 2);
      
      await clearFailedLogins(TEST_EMAIL);
      
      count = await countRecentAttempts({ email: TEST_EMAIL, ip: TEST_IP });
      assert.equal(count.pair, 0, 'clearFailedLogins should remove all attempts for email');
    });

    it('429 NO cuenta como intento (rollback en transacción)', async () => {
      await clearFailedLogins(TEST_EMAIL);
      const email = `rollback-test-${Date.now()}@test.com`;
      
      for (let i = 0; i < 3; i++) {
        await assertLoginAllowed({ email, ip: TEST_IP });
      }
      
      try {
        await assertLoginAllowed({ email, ip: TEST_IP });
        assert.fail('Should have thrown 429');
      } catch (err) {
        assert.equal(err.status, 429);
      }
      
      const count = await countRecentAttempts({ email, ip: TEST_IP });
      assert.equal(count.pair, 3, '429 should not insert row (rollback)');
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
      const userId = `concurrent-cv-${Date.now()}`;
      
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
      
      const userId = `unlimited-${Date.now()}`;
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
      const userId = `concurrent-apify-${Date.now()}`;
      
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
      
      const userId = `unlimited-apify-${Date.now()}`;
      for (let i = 0; i < 10; i++) {
        const result = await assertApifyAllowed(userId);
        assert.equal(result.allowed, true);
      }
      
      process.env.APIFY_DAILY_LIMIT = '2';
    });
  });
});