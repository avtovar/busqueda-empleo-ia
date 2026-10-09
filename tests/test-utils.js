// ============================================================================
// Utilidades compartidas para tests
// ============================================================================

import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Base URL para tests locales (apunta al servidor de desarrollo o CI)
export const TEST_BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// Perfiles de prueba para diferentes profesiones
export const TEST_PROFILES = {
  qa: {
    fullName: 'Test QA',
    title: 'QA Engineer',
    yearsExperience: 5,
    summary: 'Experienced QA',
    photo: null,
    location: 'Buenos Aires, Argentina',
    skills: [
      { name: 'Cypress', weight: 0.95 },
      { name: 'Playwright', weight: 0.9 },
      { name: 'JavaScript', weight: 0.8 },
      { name: 'TypeScript', weight: 0.75 },
      { name: 'Testing', weight: 0.9 },
    ],
    keywords: ['qa', 'testing', 'automation', 'cypress', 'playwright'],
    marketSkills: [],
    projects: [],
  },

  chef: {
    fullName: 'Test Chef',
    title: 'Chef de Cocina',
    yearsExperience: 8,
    summary: 'Experienced Chef',
    photo: null,
    location: 'Córdoba, Argentina',
    skills: [
      { name: 'Cocina', weight: 0.95 },
      { name: 'Gestión de cocina', weight: 0.9 },
      { name: 'Costos', weight: 0.8 },
      { name: 'Menú', weight: 0.85 },
      { name: 'HACCP', weight: 0.7 },
    ],
    keywords: ['chef', 'cocina', 'gastronomia', 'restaurant'],
    marketSkills: [],
    projects: [],
  },

  enfermera: {
    fullName: 'Test Enfermera',
    title: 'Enfermera',
    yearsExperience: 4,
    summary: 'Experienced Nurse',
    photo: null,
    location: 'Rosario, Argentina',
    skills: [
      { name: 'Enfermería', weight: 0.95 },
      { name: 'Cuidados intensivos', weight: 0.9 },
      { name: 'Triaje', weight: 0.85 },
      { name: 'Medicación', weight: 0.8 },
      { name: 'Heridas', weight: 0.75 },
    ],
    keywords: ['enfermera', 'enfermeria', 'salud', 'hospital'],
    marketSkills: [],
    projects: [],
  },

  vacio: {
    fullName: null,
    title: null,
    yearsExperience: null,
    summary: null,
    photo: null,
    location: null,
    skills: [],
    keywords: [],
    marketSkills: [],
    projects: [],
  },
};

// Ofertas de prueba congeladas (fixtures)
export const TEST_JOBS = [
  {
    id: 'test-1',
    source: 'Remotive',
    portal: 'Remotive',
    sourceUrl: 'https://remotive.io/jobs/1',
    title: 'QA Automation Engineer',
    company: 'TechCorp',
    location: 'Remote',
    regionGuess: 'argentina',
    applyUrl: 'https://remotive.io/apply/1',
    description: 'We need a QA Automation Engineer with Cypress and Playwright experience. Strong JavaScript skills required.',
    tags: ['qa', 'automation', 'cypress', 'playwright', 'javascript'],
    salary: '$80,000 - $100,000',
    date: new Date().toISOString(),
  },
  {
    id: 'test-2',
    source: 'Arbeitnow',
    portal: 'Arbeitnow',
    sourceUrl: 'https://arbeitnow.com/jobs/2',
    title: 'Senior QA Engineer',
    company: 'StartupXYZ',
    location: 'Buenos Aires, Argentina',
    regionGuess: 'argentina',
    applyUrl: 'https://arbeitnow.com/apply/2',
    description: 'Looking for a Senior QA Engineer. Experience with testing frameworks, automation, and CI/CD pipelines.',
    tags: ['qa', 'testing', 'automation', 'ci/cd'],
    salary: 'ARS 1,500,000',
    date: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: 'test-3',
    source: 'RemoteOK',
    portal: 'RemoteOK',
    sourceUrl: 'https://remoteok.io/jobs/3',
    title: 'Chef de Cuisine',
    company: 'Restaurant Group',
    location: 'Remote',
    regionGuess: 'argentina',
    applyUrl: 'https://remoteok.io/apply/3',
    description: 'Experienced Chef needed for high-volume kitchen. Menu planning, cost control, HACCP compliance.',
    tags: ['chef', 'cocina', 'menu', 'costos', 'haccp'],
    salary: '$60,000 - $80,000',
    date: new Date(Date.now() - 172800000).toISOString(),
  },
  {
    id: 'test-4',
    source: 'Himalayas',
    portal: 'Himalayas',
    sourceUrl: 'https://himalayas.app/jobs/4',
    title: 'Enfermera ICU',
    company: 'Hospital Central',
    location: 'Córdoba, Argentina',
    regionGuess: 'argentina',
    applyUrl: 'https://himalayas.app/apply/4',
    description: 'Enfermera para unidad de cuidados intensivos. Experiencia en triaje, medicación IV, manejo de ventiladores.',
    tags: ['enfermeria', 'icu', 'cuidados intensivos', 'triaje', 'medicacion'],
    salary: 'ARS 800,000',
    date: new Date(Date.now() - 259200000).toISOString(),
  },
  {
    id: 'test-5',
    source: 'Jobicy',
    portal: 'Jobicy',
    sourceUrl: 'https://jobicy.com/jobs/5',
    title: 'Frontend Developer',
    company: 'Web Agency',
    location: 'Remote',
    regionGuess: 'argentina',
    applyUrl: 'https://jobicy.com/apply/5',
    description: 'Frontend Developer with React, TypeScript. No QA skills required.',
    tags: ['react', 'typescript', 'frontend', 'javascript'],
    salary: '$70,000 - $90,000',
    date: new Date(Date.now() - 345600000).toISOString(),
  },
];

// Crea una cookie de sesión válida para tests
export function createTestSessionCookie(userId) {
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 días
  const payload = `v1.${userId}.${exp}`;
  const secret = process.env.SESSION_SECRET || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const hmac = createHash('sha256').update(payload + '.' + secret).digest('base64url');
  return `bei_session=${payload}.${hmac}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
}

// Helper para hacer requests a endpoints locales (simulando fetch)
// Si TEST_BASE_URL está definido y la URL es relativa, úsalo como base (para tests contra servidor real)
// Si no, usa la URL relativa directamente (para tests de handlers directos)
export async function fetchLocal(handler, method, url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : (process.env.TEST_BASE_URL ? `${process.env.TEST_BASE_URL}${url}` : url);
  const req = new Request(fullUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return handler(req);
}

// Verifica que una respuesta tenga el contrato de error esperado
export async function assertErrorResponse(response, expectedStatus, expectedMessageContains = null) {
  if (response.status !== expectedStatus) {
    throw new Error(`Expected status ${expectedStatus}, got ${response.status}`);
  }
  const body = await response.json();
  if (expectedMessageContains && !body.error?.includes(expectedMessageContains)) {
    throw new Error(`Error message "${body.error}" does not contain "${expectedMessageContains}"`);
  }
  if (!Number.isInteger(body.status) || body.status < 400 || body.status > 599) {
    throw new Error(`Error response missing valid status field: ${JSON.stringify(body)}`);
  }
  return body;
}

// Helper para esperar un poco
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));