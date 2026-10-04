// Build timestamp: 2026-10-04T21:58:00Z ============================================================================
// /api/profile/[...slug] — ENDPOINT CONSOLIDADO DE PERFIL Y CV (Catch-all)
//
// Combina 3 endpoints en 1 función serverless:
//
//   GET  /api/profile     → leer perfil (requireProfile)
//   PUT  /api/profile     → guardar perfil (requireSession)
//   POST /api/cv/parse    → parsear CV con LLM (requireSession)
//
// maxDuration: 60 para cubrir /api/cv/parse (LLM puede tardar 25s + cold start)
// Build timestamp: 2026-10-04T21:58:00Z ============================================================================

import { requireProfile, requireSession } from '../../lib/auth-fetch.js';
import { HttpError } from '../../lib/auth-fetch.js';
import { loadProfileSkills, normalizeProfile, normalizeSkills, saveProfile } from '../../lib/profile.js';
import { asText, toNumber } from '../../lib/text.js';
import { MAX_CV_BYTES, extractCvText, validateCvFile } from '../../lib/cvText.js';
import { assertCvParseAllowed } from '../../lib/cvParseLimit.js';
import { parseCvToProfile } from '../../lib/llm.js';

export const config = { maxDuration: 60 };

const BASE_PATH = '/api/profile';
const MAX_CV_TEXT_CHARS = 20_000;

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTES Y HELPERS DEL ENDPOINT /api/profile (GET/PUT)
// ════════════════════════════════════════════════════════════════════════════

const MAX_NAME_CHARS = 120;
const MAX_TITLE_CHARS = 160;
const MAX_LOCATION_CHARS = 160;
const MAX_SUMMARY_CHARS = 2000;
const MAX_SKILL_CHARS = 80;
const MAX_KEYWORD_CHARS = 120;
const MAX_URL_CHARS = 300;
const MAX_PROJECT_NAME_CHARS = 160;
const MAX_PROJECT_DESC_CHARS = 1000;
const MAX_PROJECT_LANG_CHARS = 80;
const MAX_SKILLS = 60;
const MAX_KEYWORDS = 30;
const MAX_MARKET_SKILLS = 60;
const MAX_PROJECTS = 30;
const MAX_ALIASES = 8;
const MAX_YEARS = 99.9;

function cleanText(value, maxChars) {
  if (value === null || value === undefined) return null;
  const s = asText(value).trim();
  if (!s) return null;
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

function cleanYears(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = toNumber(value, Number.NaN);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_YEARS);
}

function cleanUrl(value) {
  const raw = asText(value).trim();
  if (!raw) return null;
  const corta = raw.length > MAX_URL_CHARS ? raw.slice(0, MAX_URL_CHARS) : raw;
  const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(corta) ? corta : `https://${corta}`;
  let url;
  try {
    url = new URL(conEsquema);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

function cleanList(value, { maxItems, maxChars }) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (item !== null && typeof item === 'object') continue;
    const s = cleanText(item, maxChars);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanMarketSkills(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = cleanText(item.name, MAX_SKILL_CHARS);
    if (!name) continue;
    out.push({
      name,
      has: item.has === true,
      aliases: cleanList(item.aliases, { maxItems: MAX_ALIASES, maxChars: MAX_SKILL_CHARS }),
    });
    if (out.length >= MAX_MARKET_SKILLS) break;
  }
  return out;
}

function cleanProjects(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const nombre = cleanText(item.nombre ?? item.name, MAX_PROJECT_NAME_CHARS);
    if (!nombre) continue;
    out.push({
      nombre,
      descripcion: cleanText(item.descripcion ?? item.description, MAX_PROJECT_DESC_CHARS),
      url: cleanUrl(item.url),
      home: item.home === true,
      lenguaje: cleanText(item.lenguaje ?? item.language, MAX_PROJECT_LANG_CHARS),
    });
    if (out.length >= MAX_PROJECTS) break;
  }
  return out;
}

function buildDraft(body) {
  const fullName = cleanText(body.fullName, MAX_NAME_CHARS);
  const title = cleanText(body.title, MAX_TITLE_CHARS);

  const crudas = Array.isArray(body.skills) ? body.skills : [];
  const skills = normalizeSkills(
    crudas
      .slice(0, MAX_SKILLS)
      .map((s) => (typeof s === 'string' ? { name: s } : s)),
  ).filter((s) => s.name.length <= MAX_SKILL_CHARS);

  if (!fullName) throw new HttpError(400, 'Falta tu nombre.');
  if (!title) throw new HttpError(400, 'Falta el puesto al que te postulás.');
  if (!skills.length) throw new HttpError(400, 'Cargá al menos una skill.');

  return {
    fullName,
    title,
    location: cleanText(body.location, MAX_LOCATION_CHARS),
    summary: cleanText(body.summary, MAX_SUMMARY_CHARS),
    yearsExperience: cleanYears(body.yearsExperience),
    keywords: cleanList(body.keywords, { maxItems: MAX_KEYWORDS, maxChars: MAX_KEYWORD_CHARS }),
    skills,
    marketSkills: cleanMarketSkills(body.marketSkills),
    projects: cleanProjects(body.projects),
    links: {
      github: cleanUrl(body.links?.github) || cleanUrl(body.github),
      portfolio: cleanUrl(body.links?.portfolio) || cleanUrl(body.portfolio),
      linkedin: cleanUrl(body.links?.linkedin) || cleanUrl(body.linkedin),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CONSTANTES Y HELPERS DEL ENDPOINT /api/cv/parse (POST)
// ═════════════════════════════════════════════════════════════════════════════

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_MULTIPART_BYTES = MAX_CV_BYTES + MULTIPART_OVERHEAD_BYTES;
const FIELD_NAME = 'cv';
const HEADER_SEP = Buffer.from('\r\n\r\n', 'latin1');

function text(value) {
  return typeof value === 'string' ? value : '';
}

function looksLikeFile(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return looksLikeFile(value[0]);
  return Buffer.isBuffer(value.buffer) || Buffer.isBuffer(value.data);
}

function toFile(value) {
  const f = Array.isArray(value) ? value[0] : value;
  if (!f || typeof f !== 'object') return null;
  const buffer = Buffer.isBuffer(f.buffer) ? f.buffer
    : (Buffer.isBuffer(f.data) ? f.data : null);
  if (!buffer) return null;

  const filename = text(f.filename || f.name).replace(/^.*[\\/]/, '');
  const declarado = Number(f.size);
  return {
    mimetype: text(f.mimetype || f.type || f.contentType).toLowerCase(),
    filename,
    size: Number.isFinite(declarado) && declarado >= 0 ? declarado : buffer.length,
    buffer,
  };
}

function pickFile(body) {
  const directo = toFile(body[FIELD_NAME]);
  if (directo) return directo;
  for (const valor of Object.values(body)) {
    const f = toFile(valor);
    if (f) return f;
  }
  return null;
}

function boundaryOf(req) {
  const type = text(req.headers.get('content-type'));
  const esMultipart = /^\s*multipart\/form-data\s*(;|$)/i.test(type);
  const match = esMultipart ? type.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i) : null;
  if (!match || (!match[1] && !match[2])) {
    throw new HttpError(
      400,
      'El CV tiene que enviarse como archivo: un formulario multipart con el campo "cv".',
    );
  }
  return (match[1] || match[2]).trim();
}

function splitParts(raw, boundary) {
  const marca = Buffer.from(`--${boundary}`, 'latin1');
  const partes = [];
  let inicio = raw.indexOf(marca);
  while (inicio !== -1) {
    const siguiente = raw.indexOf(marca, inicio + marca.length);
    if (siguiente === -1) break;
    let desde = inicio + marca.length;
    if (raw[desde] === 0x0d && raw[desde + 1] === 0x0a) desde += 2;
    let hasta = siguiente;
    if (raw[hasta - 2] === 0x0d && raw[hasta - 1] === 0x0a) hasta -= 2;
    if (hasta > desde) partes.push(raw.subarray(desde, hasta));
    inicio = siguiente;
  }
  return partes;
}

function dispositionParam(disposition, key) {
  const estrella = disposition.match(new RegExp(`(?:^|;)\\s*\\b${key}\\*\\s*=\\s*([^;]+)`, 'i'));
  if (estrella) {
    const bruto = estrella[1].trim();
    const partido = bruto.split("''");
    const codificado = partido.length > 1 ? partido.slice(1).join("''") : bruto;
    try {
      return decodeURIComponent(codificado.replace(/^"|"$/g, '')).trim();
    } catch {
      return codificado.trim();
    }
  }
  const conComillas = disposition.match(new RegExp(`(?:^|;)\\s*\\b${key}\\s*=\\s*"([^"]*)"`, 'i'));
  if (conComillas) return conComillas[1].trim();
  const simple = disposition.match(new RegExp(`(?:^|;)\\s*\\b${key}\\s*=\\s*([^;]+)`, 'i'));
  return simple ? simple[1].trim().replace(/^"|"$/g, '') : null;
}

function parsePart(parte) {
  const corte = parte.indexOf(HEADER_SEP);
  if (corte === -1) return null;

  const headers = {};
  for (const linea of parte.subarray(0, corte).toString('latin1').split('\r\n')) {
    const dos = linea.indexOf(':');
    if (dos < 1) continue;
    headers[linea.slice(0, dos).trim().toLowerCase()] = linea.slice(dos + 1).trim();
  }

  const disposition = headers['content-disposition'] || '';
  const filename = dispositionParam(disposition, 'filename') || '';
  const contenido = parte.subarray(corte + HEADER_SEP.length);

  return {
    name: dispositionParam(disposition, 'name') || '',
    filename,
    file: {
      mimetype: (headers['content-type'] || '').toLowerCase(),
      filename: filename.replace(/^.*[\\/]/, ''),
      size: contenido.length,
      buffer: contenido,
    },
  };
}

function fileFromRaw(req, raw) {
  const partes = splitParts(raw, boundaryOf(req));
  let conNombre = null;
  for (const parte of partes) {
    const p = parsePart(parte);
    if (!p) continue;
    if (p.name.replace(/\[\]$/, '').trim().toLowerCase() === FIELD_NAME) return p.file;
    if (p.filename && !conNombre) conNombre = p.file;
  }
  return conNombre;
}

async function readRawBody(req) {
  if (typeof req[Symbol.asyncIterator] !== 'function') return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_MULTIPART_BYTES) {
      throw new HttpError(
        413,
        `El CV es demasiado grande. El máximo son ${MAX_CV_BYTES / (1024 * 1024)} MB.`,
      );
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

async function readCvFile(req) {
  const contentType = req.headers.get('content-type');
  const isMultipart = /^\s*multipart\/form-data\s*(;|$)/i.test(contentType || '');

  if (isMultipart) {
    const raw = await readRawBody(req);
    return raw ? fileFromRaw(req, raw) : null;
  }

  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const archivo = pickFile(req.body);
      if (archivo) return archivo;
    }
  }
  return null;
}

function textForLlm(texto) {
  if (texto.length <= MAX_CV_TEXT_CHARS) return texto;
  const ultimoSalto = texto.lastIndexOf('\n', MAX_CV_TEXT_CHARS);
  const recorte = ultimoSalto > MAX_CV_TEXT_CHARS / 2 ? texto.slice(0, ultimoSalto) : texto.slice(0, MAX_CV_TEXT_CHARS);
  console.warn(
    '[cv] el texto del CV era de %d caracteres y se recortó a %d antes del LLM.',
    texto.length,
    recorte.length,
  );
  return recorte;
}

function getRoute(req) {
  const url = new URL(req.url);
  return url.pathname.replace(BASE_PATH, '') || '/';
}

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function errorResponse(message, status = 500, extra = {}, extraHeaders = {}) {
  return jsonResponse({ error: message, ...extra }, status, extraHeaders);
}

function withErrorHandling(handler) {
  return async (req) => {
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = {};
        if (err.headers) {
          for (const [key, value] of Object.entries(err.headers)) {
            headers[key] = value;
          }
        }
        return errorResponse(err.message, err.status, err.extra, headers);
      }
      console.error('[error] %s', (err && err.stack) || err);
      return errorResponse('Error interno del servidor.', 500);
    }
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/profile — LEER PERFIL
// ════════════════════════════════════════════════════════════════════════════

async function handleGetProfile(req) {
  const { user, profile } = await requireProfile(req);
  const skills = await loadProfileSkills(user.id);
  return jsonResponse(normalizeProfile(profile, skills));
}

// ════════════════════════════════════════════════════════════════════════════
// PUT /api/profile — GUARDAR PERFIL
// ════════════════════════════════════════════════════════════════════════════

async function handlePutProfile(req) {
  const { user } = await requireSession(req);
  const body = await req.json();
  const draft = buildDraft(body);
  const profile = await saveProfile(user.id, draft);

  return jsonResponse({
    ok: true,
    profileComplete: true,
    profile,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/cv/parse — PARSEAR CV CON LLM
// ═══════════════════════════════════════════════════════════════════════════

async function handleParseCv(req) {
  const { user } = await requireSession(req);

  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_MULTIPART_BYTES) {
    return errorResponse(`El CV es demasiado grande. El máximo son ${MAX_CV_BYTES / (1024 * 1024)} MB.`, 413);
  }

  const file = await readCvFile(req);
  validateCvFile(file);
  const { text: cvText, kind } = await extractCvText(file);

  await assertCvParseAllowed(user.id);

  const profile = await parseCvToProfile(textForLlm(cvText));

  return jsonResponse({
    ok: true,
    profile,
    kind,
    saved: false,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// ROUTER PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

async function handleGet(req) {
  const route = getRoute(req);
  if (route === '/profile' || route === '/') {
    return handleGetProfile(req);
  }
  return errorResponse('Endpoint no encontrado', 404);
}

async function handlePut(req) {
  const route = getRoute(req);
  if (route === '/profile' || route === '/') {
    return handlePutProfile(req);
  }
  return errorResponse('Endpoint no encontrado', 404);
}

async function handlePost(req) {
  const route = getRoute(req);
  if (route === '/cv/parse') {
    return handleParseCv(req);
  }
  return errorResponse('Endpoint no encontrado', 404);
}

export const GET = withErrorHandling(handleGet);
export const PUT = withErrorHandling(handlePut);
export const POST = withErrorHandling(handlePost);
