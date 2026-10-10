// ============================================================================
// TESTS: matcher.js — computeMatch y rankByRegion
// ============================================================================

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { computeMatch, rankByRegion } from '../lib/matcher.js';
import { TEST_PROFILES, TEST_JOBS } from './test-utils.js';

describe('matcher.js — computeMatch', () => {
  let qaProfile, chefProfile, enfermeraProfile;

  before(() => {
    qaProfile = TEST_PROFILES.qa;
    chefProfile = TEST_PROFILES.chef;
    enfermeraProfile = TEST_PROFILES.enfermera;
  });

  it('devuelve score alto para QA contra oferta de QA', () => {
    const job = TEST_JOBS[0]; // QA Automation Engineer
    const result = computeMatch(job, qaProfile);
    assert.ok(result.score >= 70, `QA vs QA job: expected >= 70, got ${result.score}`);
    assert.ok(result.matched.includes('Cypress') || result.matched.includes('Playwright'),
      'Should match Cypress or Playwright');
  });

  it('devuelve score medio para Chef contra oferta de Chef', () => {
    const job = TEST_JOBS[2]; // Chef de Cuisine
    const result = computeMatch(job, chefProfile);
    assert.ok(result.score >= 50, `Chef vs Chef job: expected >= 50, got ${result.score}`);
    assert.ok(result.matched.some(s => ['Cocina', 'Gestión de cocina', 'Costos', 'Menú', 'HACCP'].includes(s)),
      'Should match at least one chef skill');
  });

  it('devuelve score alto para Enfermera contra oferta de Enfermera ICU', () => {
    const job = TEST_JOBS[3]; // Enfermera ICU
    const result = computeMatch(job, enfermeraProfile);
    assert.ok(result.score >= 60, `Enfermera vs Enfermera job: expected >= 60, got ${result.score}`);
    assert.ok(result.matched.some(s => ['Enfermería', 'Cuidados intensivos', 'Triaje', 'Medicación', 'Heridas'].includes(s)),
      'Should match at least one nurse skill');
  });

  it('devuelve score BAJO para QA contra oferta de Chef (cross-profession)', () => {
    const job = TEST_JOBS[2]; // Chef de Cuisine
    const result = computeMatch(job, qaProfile);
    assert.ok(result.score <= 30, `QA vs Chef job: expected <= 30, got ${result.score}`);
  });

  it('devuelve score BAJO para Chef contra oferta de QA (cross-profession)', () => {
    const job = TEST_JOBS[0]; // QA Automation Engineer
    const result = computeMatch(job, chefProfile);
    assert.ok(result.score <= 25, `Chef vs QA job: expected <= 25, got ${result.score}`);
  });

  it('devuelve score 0 para perfil vacío contra cualquier oferta', () => {
    const emptyProfile = TEST_PROFILES.vacio;
    for (const job of TEST_JOBS) {
      const result = computeMatch(job, emptyProfile);
      assert.equal(result.score, 0, `Empty profile vs ${job.title}: expected 0, got ${result.score}`);
      assert.deepEqual(result.matched, []);
      assert.deepEqual(result.missed, []);
    }
  });

  it('score está clampado entre 0 y 100', () => {
    const job = TEST_JOBS[0];
    const result = computeMatch(job, qaProfile);
    assert.ok(result.score >= 0 && result.score <= 100, `Score ${result.score} out of bounds`);
  });

  it('matched y missed son arrays de strings (nombres de skills)', () => {
    const job = TEST_JOBS[0];
    const result = computeMatch(job, qaProfile);
    assert.ok(Array.isArray(result.matched));
    assert.ok(Array.isArray(result.missed));
    for (const s of [...result.matched, ...result.missed]) {
      assert.ok(typeof s === 'string', `Expected string, got ${typeof s}: ${s}`);
    }
  });

  it('no muta el perfil original', () => {
    const profile = { ...TEST_PROFILES.qa, skills: [...TEST_PROFILES.qa.skills] };
    const originalSkills = JSON.stringify(profile.skills);
    computeMatch(TEST_JOBS[0], profile);
    assert.equal(JSON.stringify(profile.skills), originalSkills, 'Profile was mutated');
  });
});

describe('matcher.js — rankByRegion', () => {
  it('ordena por score descendente', () => {
    const profile = TEST_PROFILES.qa;
    const ranked = rankByRegion(TEST_JOBS, profile).argentina;
    for (let i = 1; i < ranked.length; i++) {
      assert.ok(ranked[i - 1].score >= ranked[i].score,
        `Ranking not descending at index ${i}: ${ranked[i - 1].score} < ${ranked[i].score}`);
    }
  });

  it('desempata por fecha de publicación (más nueva primero)', () => {
    // Crear dos ofertas con mismo score pero fechas distintas
    const jobA = { ...TEST_JOBS[0], id: 'tie-a', date: new Date().toISOString() };
    const jobB = { ...TEST_JOBS[0], id: 'tie-b', date: new Date(Date.now() - 86400000).toISOString() };
    const ranked = rankByRegion([jobA, jobB], TEST_PROFILES.qa).argentina;
    assert.equal(ranked[0].id, 'tie-a', 'Newer job should come first on tie');
  });

  it('filtra ofertas con score 0', () => {
    const profile = TEST_PROFILES.qa;
    const ranked = rankByRegion(TEST_JOBS, profile).argentina;
    for (const job of ranked) {
      assert.ok(job.score > 0, `Job ${job.id} has score 0 but should be filtered`);
    }
  });

  it('devuelve array vacío si ninguna oferta pasa el filtro', () => {
    const ranked = rankByRegion(TEST_JOBS, TEST_PROFILES.vacio, 'argentina');
    assert.deepEqual(ranked, { argentina: [] });
  });

  it('añade campos de match (score, matched, missing) a cada oferta', () => {
    const ranked = rankByRegion(TEST_JOBS, TEST_PROFILES.qa).argentina;
    for (const job of ranked) {
      assert.ok('score' in job);
      assert.ok('matched' in job);
      assert.ok('missed' in job);
      assert.ok(Array.isArray(job.matched));
      assert.ok(Array.isArray(job.missed));
    }
  });
});