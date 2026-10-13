// ============================================================================
// PRUEBAS UNITARIAS DE MÓDULOS PURAS (SIN BASE DE DATOS NI SERVICIOS EXTERNOS)
// ============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProfileKeywords, maxResults } from '../lib/apifyLinkedin.js';
import { readParam, resolveRegion } from '../lib/jobs.js';
import { generateCoverLetter, summarize } from '../lib/coverLetter.js';
import { buildAnalytics } from '../lib/analytics.js';
import { buildDirectory } from '../lib/directorio.js';
import { normalizeProfile } from '../lib/profile.js';
import { extractCvText, validateCvFile, looksLikePdf, MIN_CV_TEXT_CHARS } from '../lib/cvText.js';

test('lib/apifyLinkedin.js — buildProfileKeywords & maxResults', async (t) => {
  await t.test('buildProfileKeywords combina keywords y skills de peso alto', () => {
    const profile = normalizeProfile(
      {
        keywords: ['QA Engineer', 'Software Tester'],
      },
      [
        { name: 'JavaScript', weight: 0.95 },
        { name: 'Git', weight: 0.5 },
      ],
    );
    const query = buildProfileKeywords(profile);
    assert.equal(query, '"QA Engineer" OR "Software Tester" OR JavaScript');
  });

  await t.test('maxResults realiza clamp entre 20 y 1000', () => {
    assert.equal(maxResults(5), 20);
    assert.equal(maxResults(50), 50);
    assert.equal(maxResults(2000), 1000);
    assert.equal(maxResults(undefined), 200);
  });
});

test('lib/jobs.js — resolveRegion & readParam', async (t) => {
  await t.test('resolveRegion devuelve region valida o DEFAULT_REGION', () => {
    assert.equal(resolveRegion('argentina'), 'argentina');
    assert.equal(resolveRegion('  argentina  '), 'argentina');
    assert.equal(resolveRegion('desconocido'), 'argentina');
    assert.equal(resolveRegion(null), 'argentina');
  });

  await t.test('readParam lee query param de req.query o req.url', () => {
    assert.equal(readParam({ query: { region: ' argentina ' } }, 'region'), 'argentina');
    assert.equal(readParam({ url: 'http://localhost/api/jobs?q=test-id' }, 'q'), 'test-id');
    assert.equal(readParam(null, 'q'), null);
  });
});

test('lib/coverLetter.js — summarize & generateCoverLetter', async (t) => {
  const profile = normalizeProfile(
    {
      full_name: 'Juan Perez',
      title: 'Desarrollador Full Stack',
      years_experience: 5,
      summary: 'Desarrollador apasionado con experiencia en Node.js y React.',
      links: { linkedin: 'https://linkedin.com/in/juanperez' },
    },
    [
      { name: 'JavaScript', weight: 0.9 },
      { name: 'React', weight: 0.9 },
    ],
  );

  const job = {
    title: 'Desarrollador React Senior',
    company: 'Empresa Tech',
    location: 'CABA, Argentina',
    description: 'Buscamos desarrollador React y JavaScript con experiencia.',
  };

  await t.test('summarize genera el resumen y topSkill', () => {
    const sum = summarize(job, profile);
    assert.equal(typeof sum.companySummary, 'string');
    assert.ok(sum.requiredSkills.includes('JavaScript') || sum.requiredSkills.includes('React'));
  });

  await t.test('generateCoverLetter arma subject y body', () => {
    const letter = generateCoverLetter(job, 'argentina', profile);
    assert.equal(letter.lang, 'es');
    assert.equal(letter.region, 'argentina');
    assert.ok(letter.subject.includes('Desarrollador React Senior'));
    assert.ok(letter.subject.includes('Juan Perez'));
    assert.ok(letter.body.includes('Juan Perez'));
    assert.ok(letter.body.includes('Empresa Tech'));
  });
});

test('lib/analytics.js — buildAnalytics', async (t) => {
  const profile = normalizeProfile(
    {
      full_name: 'Maria Lopez',
      title: 'Contadora Pública',
      years_experience: 4,
      market_skills: [{ name: 'Power BI', has: false, aliases: ['power bi'] }],
      projects: [{ nombre: 'Dashboard Financiero', descripcion: 'Tablero en Power BI para finanzas', lenguaje: '' }],
    },
    [{ name: 'Excel', weight: 0.9 }],
  );

  const regions = {
    argentina: [
      { id: '1', title: 'Analista Contable', company: 'Estudio Contable', description: 'Manejo de Excel y Power BI', score: 85 },
    ],
  };

  await t.test('buildAnalytics estructura KPIs y evidencia de proyectos', () => {
    const data = buildAnalytics(regions, profile);
    assert.equal(data.candidato.nombre, 'Maria Lopez');
    assert.equal(data.total, 1);
    assert.equal(data.avgScore, 85);
    assert.equal(data.githubEvidence.length, 1);
    assert.equal(data.githubEvidence[0].name, 'Power BI');
    assert.ok(Array.isArray(data.recommendations));
  });
});

test('lib/directorio.js — buildDirectory', async (t) => {
  const profile = normalizeProfile(
    {
      title: 'QA Engineer',
    },
    [{ name: 'Automation', weight: 0.9 }],
  );

  await t.test('buildDirectory genera bolsas y consultoras', () => {
    const dir = buildDirectory(profile, 'argentina');
    assert.equal(dir.region, 'argentina');
    assert.ok(Array.isArray(dir.bolsas));
    assert.ok(Array.isArray(dir.consultoras));
    assert.ok(dir.bolsas.length > 0);
  });
});

test('lib/cvText.js — validacion y deteccion de CVs', async (t) => {
  await t.test('looksLikePdf reconoce magia %PDF-', () => {
    assert.equal(looksLikePdf(Buffer.from('%PDF-1.4 test content')), true);
    assert.equal(looksLikePdf(Buffer.from('not a pdf')), false);
    assert.equal(looksLikePdf(null), false);
  });

  await t.test('validateCvFile aprueba archivo valido', () => {
    const file = {
      mimetype: 'application/pdf',
      filename: 'mi_cv.pdf',
      size: 1024,
      buffer: Buffer.from('%PDF-1.4 test pdf file'),
    };
    const validated = validateCvFile(file);
    assert.equal(validated.filename, 'mi_cv.pdf');
  });

  await t.test('validateCvFile rechaza archivo vacio o nulo', () => {
    assert.throws(() => validateCvFile(null), { status: 400 });
    assert.throws(() => validateCvFile({ buffer: null }), { status: 400 });
    assert.throws(
      () => validateCvFile({ mimetype: 'application/pdf', filename: 'cv.pdf', buffer: Buffer.alloc(0) }),
      { status: 400 },
    );
  });

  await t.test('validateCvFile infiere MIME de extension si es application/octet-stream', () => {
    const file = {
      mimetype: 'application/octet-stream',
      filename: 'mi_cv.pdf',
      size: 1024,
      buffer: Buffer.from('%PDF-1.4 header'),
    };
    const validated = validateCvFile(file);
    assert.equal(validated.filename, 'mi_cv.pdf');
  });

  await t.test('validateCvFile rechaza extensiones no soportadas', () => {
    const file = {
      mimetype: 'image/png',
      filename: 'foto_cv.png',
      size: 1024,
      buffer: Buffer.from('png content'),
    };
    assert.throws(() => validateCvFile(file), { status: 415 });
  });
});
