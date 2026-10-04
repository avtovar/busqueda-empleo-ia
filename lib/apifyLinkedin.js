// ============================================================================
// APIFY LINKEDIN SEARCH — MÓDULO PURO
//
// Busca ofertas REALES en LinkedIn usando el actor de Apify
// `curious_coder~linkedin-jobs-scraper`. Este módulo NO toca la base de datos,
// NO valida sesión, NO escribe logs de usuario: solo arma la query, llama al
// actor y traduce su respuesta cruda al formato interno de oferta que ya usan
// las demás fuentes del proyecto.
//
// Lo que se eliminó del origen y por qué:
//
//   · `import { PROFILE } from './cvProfile.js'` — el perfil global hardcodeado
//     de una sola persona (Ali, QA). Ahora el perfil llega por PARÁMETRO
//     (`searchLinkedInWithApify(profile, region, options)`), que es el contrato
//     que usan `matcher.js`, `analytics.js` y `coverLetter.js` desde el paso 6.
//
//   · `REGION_LOCATIONS` hardcodeado con 6 países — ahora se usa `REGIONS` de
//     `./regions.js` (`REGIONS[key]?.linkedinLocation`). Agregar un país es
//     agregar UNA entrada en `regions.js` y este módulo lo ve solo.
//
//   · `isQARelevant` / regex `/(qa|quality|test|automation|sdet)/i` que filtraba
//     keywords y skills — ELIMINADO. La relevancia la define el vocabulario del
//     USUARIO (`profile.keywords` + `profile.skills` con peso >= 0.9), así que
//     el mismo código rankea para un contador, una enfermera o un QA.
//
//   · `BASE_KEYWORDS` y `ROLE_SYNONYMS` — catálogos de UNA profesión. Se
//     reemplazan por `profile.keywords` (lo que el LLM del CV dijo que busca
//     la persona) y `profile.skills` (lo que la persona tiene).
// ============================================================================

import { REGIONS, isValidRegion } from './regions.js';
import { rankByRegion } from './matcher.js';
import { emptyProfile } from './profile.js';

// ──────────────────────────────────────────────────────────────────────────────
// CONSTANTES
// ──────────────────────────────────────────────────────────────────────────────

// ↑ DEFAULT del tope de ofertas por búsqueda. El actor aguanta ~1000 ofertas
// por ejecución. Con 200 por defecto la búsqueda cubre de sobra lo que una
// persona llega a mirar, sin pagar ni renderizar de más.
const DEFAULT_MAX_RESULTS = 200;

// ↑ Cota dura del clamp: nunca menos de 20 (por debajo no hay búsqueda) ni más
// de 1000 (más allá el actor no rinde y el costo se dispara por nada).
const MIN_RESULTS = 20;
const MAX_RESULTS_CAP = 1000;

// ↑ LinkedIn devuelve ~25 ofertas por página de búsqueda. Este número convierte
// "cuántas ofertas quiero" en "cuántas páginas tengo que pedir".
const RESULTS_PER_PAGE = 25;

// ↑ Máximo de páginas por corrida. Es lo que rompe el techo de ~1000 resultados
// POR URL: más allá de 8 páginas ya son 200 ofertas y no aporta nada nuevo.
// El factor limitPerSource del actor reparte el total entre TODAS las URLs.
const MAX_PAGES = 8;

// ↑ Timeout de la ejecución, en SEGUNDOS, que va en la query string de Apify.
// 300 es el MÁXIMO que acepta el endpoint síncrono de Apify (por arriba
// devuelve 408), así que es el techo real de esta integración.
const APIFY_TIMEOUT_S = 300;

// ↑ Temporizador del AbortController, en MILISEGUNDAS. Tiene que ser SIEMPRE
// MAYOR que el de Apify (300 s) para que el error lo veamos nosotros con un
// mensaje claro y no una respuesta de error de Apify: 320 s = 300 + 20 s de
// margen para el viaje de ida y vuelta de la respuesta.
const CLIENT_TIMEOUT_MS = 320_000;

// ↑ Ventana temporal: nos interesan solo ofertas publicadas en los últimos 30 días.
const DAYS_BACK = 30;

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS PURAS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Resuelve cuántas ofertas se van a pedir, aplicando el MISMO clamp en los tres
 * orígenes posibles. El clamp es duro a propósito: si alguien pone 5000 en el
 * .env o en el body, el actor cobraría por 5000 ofertas que ni se van a mirar.
 * Number() tolera que el valor venga como texto (siempre es así en process.env)
 * y que sea decimal; el isFinite descarta NaN, que es lo que devuelve Number('').
 * @param {unknown} limit Límite explícito del body, o undefined.
 * @returns {number} Límite clampado entre 20 y 1000.
 */
export function maxResults(limit) {
  const clamp = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESULTS;
    return Math.min(MAX_RESULTS_CAP, Math.max(MIN_RESULTS, Math.round(n)));
  };
  // ↑ PRIORIDAD 1: el `limit` explícito del body del request (lo manda el frontend).
  if (limit !== undefined && limit !== null && limit !== '') return clamp(limit);
  // ↑ PRIORIDAD 2: la variable de entorno APIFY_MAX_RESULTS (config del proyecto).
  const fromEnv = process.env.APIFY_MAX_RESULTS;
  if (fromEnv !== undefined && fromEnv !== '') return clamp(fromEnv);
  // ↓ PRIORIDAD 3: el default de arriba.
  return DEFAULT_MAX_RESULTS;
}

/**
 * Cuántas páginas de resultados hay que pedir para llegar al límite pedido.
 * El mínimo es 1 (nunca se pide cero páginas) y el máximo MAX_PAGES.
 * @param {number} limit Límite ya clampado.
 * @returns {number} Número de páginas (1..MAX_PAGES).
 */
function pageCount(limit) {
  return Math.min(MAX_PAGES, Math.max(1, Math.ceil(limit / RESULTS_PER_PAGE)));
}

/**
 * Construye el texto de la query de búsqueda a partir del perfil del usuario.
 * Usa: `profile.keywords` (array de strings, ya limpio del LLM) — TODO entra,
 * y `profile.skills` con `weight >= 0.9` (array de `{name, weight}`) — solo el `name`.
 * Deduplica con Map (clave = minúsculas), términos con espacio → `"termino"`,
 * une con ` OR `. Si no hay nada usable → devuelve `''` (no inventa búsqueda).
 * @param {object} profile Perfil del contrato de `api/lib/profile.js`.
 * @returns {string} Query lista para LinkedIn (puede ser vacía).
 */
export function buildProfileKeywords(profile) {
  const p = profile && typeof profile === 'object' ? profile : emptyProfile();
  // ↑ Un Map usado como set: guarda "clave normalizada" -> "término original".
  // Sirve para DEDUPLICAR sin perder las mayúsculas: si aparecen "QA" y "qa",
  // la clave en minúsculas es la misma, así que solo sobrevive el primero.
  const terms = new Map();

  // Paso 1: TODOS los keywords del perfil (sin filtro de QA).
  const roleKeywords = (p.keywords || []).map((term) => String(term).trim()).filter(Boolean);

  // Paso 2: Skills del CV con peso >= 0.9 (las más importantes).
  // El peso ya viene como number normalizado por `normalizeSkills` de profile.js.
  const coreSkills = (p.skills || [])
    .filter((s) => Number(s.weight) >= 0.9)
    .map((s) => s.name);

  // Paso 3: Juntamos las dos listas y las vamos metiendo en el Map, que deduplica solo.
  for (const term of [...roleKeywords, ...coreSkills]) {
    const normalized = term.trim().toLowerCase();
    if (normalized && !terms.has(normalized)) terms.set(normalized, term.trim());
  }

  // Paso 4: Los términos CON espacios van entre comillas, porque LinkedIn interpreta
  // el OR sobre palabras sueltas: sin comillas, "test automation" se rompería en dos.
  return [...terms.values()]
    .map((term) => (/\s/.test(term) ? `"${term}"` : term))
    .join(' OR ');
}

/**
 * Construye la URL de búsqueda de LinkedIn para una región Y una página.
 * Se usa el objeto URL + searchParams en vez de concatenar strings a mano: él se
 * encarga de escapar los caracteres especiales y los acentos, y arma el "?" y los "&".
 * `pageNum` es el número de página del listado (0 = primera).
 * @param {string} region Clave de región ('argentina', etc.).
 * @param {number} pageNum Número de página (0-based).
 * @returns {string} URL completa de búsqueda de LinkedIn.
 */
function searchUrl(region, pageNum = 0) {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  // ↑ position=1 es el desplazamiento del listado: la primera oferta es la número 1
  url.searchParams.set('position', '1');
  // ↑ pageNum: la página que se está pidiendo (0, 1, 2...). Cada página trae
  // ~25 ofertas nuevas, así que esto es lo que permite pedir más de 1000.
  url.searchParams.set('pageNum', String(pageNum));
  // ↑ keywords: la query que armamos arriba, envuelta en paréntesis
  const keywords = buildProfileKeywords({}); // placeholder, se setea después
  url.searchParams.set('keywords', `(${keywords})`);
  // ↑ location: la traducción de la región, sacada de REGIONS
  const location = REGIONS[region]?.linkedinLocation || '';
  url.searchParams.set('location', location);
  // ↑ f_TPR es el filtro de "publicada en las últimas X". Lleva el prefijo r (segundos)
  // y el número de segundos: 30 días * 24 h * 60 min * 60 s.
  url.searchParams.set('f_TPR', `r${DAYS_BACK * 24 * 60 * 60}`);
  return url.toString();
}

/**
 * Arma TODAS las URLs de la búsqueda: las páginas 0..N-1 de la misma query.
 * El actor acepta un array de URLs y reparte `limitPerSource` entre todas, así
 * que limitar la cantidad de páginas es lo que mantiene el costo acotado.
 * @param {string} region Clave de región.
 * @param {number} limit Límite ya clampado.
 * @returns {string[]} Array de URLs de búsqueda.
 */
function searchUrls(region, limit) {
  return Array.from({ length: pageCount(limit) }, (_, page) => searchUrl(region, page));
}

/**
 * Normalizador "tolera cualquier cosa": convierte en texto plano lo que venga de Apify.
 * El actor no garantiza el tipo de cada campo (a veces string, a veces número o lista),
 * así que antes de usar un dato lo pasamos por acá y siempre sale un string limpio.
 * @param {unknown} value Cualquier valor.
 * @returns {string} Texto limpio, o '' si no hay nada usable.
 */
function asText(value) {
  // ↑ Si es una lista, mapeamos cada elemento y unimos con ' · '.
  // La RECURSIÓN es la clave: dentro del map llamamos a asText otra vez, así que si un
  // elemento es otra lista, esa lista también se resuelve sola, hasta llegar al texto.
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' · ');
  // ↑ Si es string o número, lo pasamos a texto y le quitamos los espacios sobrantes.
  // Cualquier otro tipo (null, undefined, objeto) devuelve '' en vez de romper el código.
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/**
 * Normaliza la fecha de publicación. El actor devuelve la fecha en formatos distintos
 * (un número que puede ser segundos o milisegundos, o un string). Si no lo unificamos,
 * new Date() nos da resultados equivocados o inválidos.
 * @param {object} job Oferta cruda de Apify.
 * @returns {string} Fecha ISO, o '' si no hay fecha usable.
 */
function normalizeDate(job) {
  // ↑ Probamos tres nombres de campo por orden de prioridad. El ?? significa "usá el
  // primero que no sea null ni undefined".
  const raw = job.postedAtTimestamp ?? job.postedAt ?? job.date ?? '';
  if (!raw) return '';
  const numeric = Number(raw);
  // ↑ ¿Es un número entero escrito solo con dígitos? El /^\d+$/ lo evita: sin él, un
  // string como "2024-01-05" o "1.5e9" se confundiría con un timestamp.
  const date = Number.isFinite(numeric) && /^\d+$/.test(String(raw))
    // ↑ El umbral 1e12 (un billón) decide la escala: los timestamps en MILISEGUNDOS
    // tienen 13 dígitos (1.700.000.000.000) y los de SEGUNDOS tienen 10 (1.700.000.000).
    // Si el número es chico, son segundos y hay que multiplicarlo por 1000.
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    // ↑ Si no es un número, se lo pasamos tal cual a new Date() y que JS lo interprete.
    : new Date(raw);
  // ↑ Si la fecha quedó inválida (NaN) devolvemos '' en vez de un "Invalid Date"
  // que después rompería el filtro de ofertas viejas.
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/**
 * Traduce UNA oferta cruda de Apify al formato interno que usa el resto de la app.
 * Devuelve { job, reason }: `job` es null cuando la oferta no sirve (y `reason`
 * dice POR QUÉ, para que la estadística de la respuesta no tenga que adivinarlo).
 * @param {object} job Oferta cruda de Apify.
 * @param {string} region Clave de región buscada.
 * @param {string} sourceUrl URL de búsqueda usada (página 0).
 * @returns {{job: object|null, reason: string|null}} Oferta normalizada o motivo de descarte.
 */
function mapJob(job, region, sourceUrl) {
  // ↑ Lectura tolerante: cada campo tiene alternativas porque no siempre llega con el
  // mismo nombre (por ejemplo la empresa puede venir como companyName o como company).
  const title = asText(job.title);
  const company = asText(job.companyName || job.company);
  const link = asText(job.link || job.jobUrl || job.applyUrl);
  // ↑ Descarte obligatorio: si falta el título, la empresa o el link no se puede mostrar
  // la tarjeta ni el botón de postulación, así que la oferta no vale nada.
  if (!title || !company || !link) return { job: null, reason: 'sinLink' };

  // ↑ Descripción en texto plano: descriptionText ya viene limpia, pero si no existe
  // caemos en descriptionHtml y ahí sí hay que limpiar el HTML a mano.
  const description = asText(job.descriptionText)
    // ↑ /<[^>]*>/g reemplaza todo lo que parezca una etiqueta por un espacio. Se pone un
    // espacio y no vacío a propósito: si no, "dev</b>qa" se volvería "devqa".
    // El segundo replace(/\s+/g, ' ') colapsa todos los espacios que quedaron pegados.
    || asText(job.descriptionHtml).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  // ↑ Tags: juntamos los que trae el actor con los campos sueltos (nivel de seniority,
  // tipo de contrato, función, industria) y el filter(Boolean) se queda solo con los
  // que tienen texto, tirando los vacíos.
  const tags = [
    ...(Array.isArray(job.tags) ? job.tags.map(asText) : []),
    asText(job.seniorityLevel),
    asText(job.employmentType),
    asText(job.jobFunction),
    asText(job.industries),
  ].filter(Boolean);
  const salary = asText(job.salaryInfo || job.salary);
  const date = normalizeDate(job);

  // ↑ Filtro de ofertas viejas: si la fecha existe y es más antigua que la ventana de
  // DAYS_BACK, la oferta se descarta. Ojo el "y": si NO hay fecha la oferta pasa,
  // porque no tenemos información para juzgarla.
  if (date && Date.now() - new Date(date).getTime() > DAYS_BACK * 24 * 60 * 60 * 1000) {
    return { job: null, reason: 'vieja' };
  }

  return {
    job: {
      // ↑ El id lleva el prefijo "linkedin-" porque tiene que ser único entre TODAS las
      // fuentes: si viniera el mismo id que en otra fuente, se pisarían en el historial.
      // El link funciona como id de respaldo cuando el actor no trae id.
      id: `linkedin-${asText(job.id || job.jobId) || link}`,
      // ↑ source deja constancia de dónde vino la oferta (se ve en la UI y en el historial)
      source: 'LinkedIn / Apify',
      // ↑ Acá el portal es SIEMPRE LinkedIn y se pone en el momento del scrape, sin
      // pasar por server/portal.js: es el único lugar donde se sabe con certeza.
      portal: 'LinkedIn',
      // ↑ sourceUrl = la URL real de búsqueda que se usó para traer esta oferta, que
      // es la página 0 (la primera) de los mismos filtros de esta corrida.
      sourceUrl: sourceUrl || searchUrl(region, 0),
      title,
      company,
      // ↑ Si la oferta no dice dónde está, se asume la región que el usuario pidió buscar
      location: asText(job.location) || REGIONS[region]?.linkedinLocation || '',
      // ↑ regionGuess deja la huella de la región buscada; matcher.js la usa como pista
      // para decidir en qué bucket del ranking entra cada oferta.
      regionGuess: region,
      applyUrl: asText(job.applyUrl) || link,
      description,
      tags,
      salary,
      date,
    },
    // ↓ Oferta válida: no hay motivo de descarte.
    reason: null,
  };
}

/**
 * Crea un error que además viaja con su código de estado HTTP.
 * El truco es Object.assign: le "pega" la propiedad statusCode al objeto Error. Así, en
 * el catch del servidor se puede leer error.statusCode y responder con ese código en
 * lugar de un 500 genérico. Por eso los errores se tiran con `throw` y no con `return`.
 * @param {string} message Mensaje para el cliente.
 * @param {number} statusCode Código HTTP.
 * @returns {Error & {statusCode: number}} Error con statusCode adjunto.
 */
function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

// ──────────────────────────────────────────────────────────────────────────────
// FUNCIÓN PRINCIPAL
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Busca ofertas de LinkedIn para una región usando Apify.
 * @param {object} profile Perfil del contrato de `api/lib/profile.js`.
 * @param {string} region Clave de región ('argentina', etc.).
 * @param {object} [options] Opciones: `{ limit }`.
 * @returns {Promise<object>} Paquete { region, jobs, total, regions, stats, _online, source, checkedAt, resultLimit, pages, searchUrl }.
 */
export async function searchLinkedInWithApify(profile, region, options = {}) {
  // 1. Validar región: isValidRegion de regions.js. Si no → 400.
  if (!isValidRegion(region)) throw httpError('Región no válida.', 400);

  // 2. Keywords: buildProfileKeywords(profile). Si '' → 400 "tu perfil no tiene keywords para buscar".
  const keywords = buildProfileKeywords(profile);
  if (!keywords) throw httpError('Tu perfil no tiene keywords para buscar en LinkedIn.', 400);

  // 3. Token: process.env.APIFY_API_TOKEN. Si no hay → 503 (falta config del servidor).
  const token = process.env.APIFY_API_TOKEN;
  if (!token) {
    throw httpError('Falta APIFY_API_TOKEN. Configúralo en las variables de entorno del servidor.', 503);
  }

  // 4. Rate limit: await assertApifyAllowed(userId) de api/lib/apifyLimit.js. Si 429 → lanzar httpError 429 con Retry-After.
  // NOTA: El rate limit se hace en el ENDPOINT (api/linkedin-search.js) ANTES de llamar a esta función,
  // porque el userId sale de la sesión (requireProfile). El módulo puro no conoce userId.

  // 5. limit = maxResults(options.limit), pages = searchUrls(region, limit), sourceUrl = pages[0].
  const limit = maxResults(options.limit);
  const pages = searchUrls(region, limit);
  const sourceUrl = pages[0];

  // 6. POST a Apify (mismo endpoint, headers, body del origen).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(
      `https://api.apify.com/v2/acts/curious_coder~linkedin-jobs-scraper/run-sync-get-dataset-items?format=json&clean=true&timeout=${APIFY_TIMEOUT_S}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          urls: pages,
          limitPerSource: limit,
          autoConvertToAiSearch: true,
          scrapeCompany: false,
          splitByLocation: false,
        }),
        signal: controller.signal,
      }
    );
  } catch (error) {
    if (error.name === 'AbortError') throw httpError('Apify tardó demasiado en responder. Prueba de nuevo más tarde.', 504);
    throw httpError('No se pudo conectar con Apify.', 502);
  } finally {
    clearTimeout(timeout);
  }

  // 7. Traducir errores Apify: 401/403 → 502 (token), 402 → 402 (sin saldo), otros → 502.
  if (response.status === 401 || response.status === 403) {
    throw httpError('Apify rechazó el token. Revísalo en las variables de entorno.', 502);
  }
  if (response.status === 402) {
    throw httpError('Apify no tiene saldo disponible para ejecutar esta búsqueda.', 402);
  }
  if (!response.ok) throw httpError(`El actor de Apify respondió con error HTTP ${response.status}.`, 502);

  // 8. Parse JSON defensivo, validar Array.isArray.
  let items;
  try {
    items = await response.json();
  } catch {
    throw httpError('Apify devolvió una respuesta que no es JSON válido.', 502);
  }
  if (!Array.isArray(items)) throw httpError('Apify devolvió un formato de resultados inesperado.', 502);

  // 9. Stats (recibidos, guardados, duplicados, sinLink, viejas, sinMatch, otrasRegiones).
  const stats = {
    recibidos: items.length,
    guardados: 0,
    duplicados: 0,
    sinLink: 0,
    viejas: 0,
    sinMatch: 0,
    otrasRegiones: 0,
  };

  // 10. Dedup por id (Map), mapJob(item, region, sourceUrl) para cada una.
  const unique = new Map();
  for (const item of items) {
    const { job, reason } = mapJob(item, region, sourceUrl);
    if (!job) {
      if (reason === 'sinLink') stats.sinLink += 1;
      else if (reason === 'vieja') stats.viejas += 1;
      continue;
    }
    if (unique.has(job.id)) {
      stats.duplicados += 1;
      continue;
    }
    unique.set(job.id, job);
  }
  stats.guardados = unique.size;

  // 11. rankByRegion([...unique.values()], profile) → ranked (usa profile, no el global).
  const ranked = rankByRegion([...unique.values()], profile);
  const rankedTotal = Object.values(ranked).reduce((acc, list) => acc + list.length, 0);

  // 12. stats.sinMatch = guardados - rankedTotal; stats.otrasRegiones = rankedTotal - jobs.length.
  stats.sinMatch = stats.guardados - rankedTotal;
  const jobs = ranked[region] || [];
  stats.otrasRegiones = rankedTotal - jobs.length;

  // 13. Devolver paquete de salida.
  return {
    region,
    jobs,
    total: jobs.length,
    regions: ranked,
    stats,
    _online: true,
    source: 'LinkedIn / Apify',
    checkedAt: new Date().toISOString(),
    resultLimit: limit,
    pages: pages.length,
    searchUrl: sourceUrl,
  };
}