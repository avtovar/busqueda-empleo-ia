// ============================================================================
// CARTAS DE PRESENTACIÓN.
//
// Arma el idioma (es/en), el asunto del mail, un resumen de la empresa y el
// cuerpo de la carta listo para copiar y pegar.
//
// Este módulo es el que más hardcodeo tenía del proyecto origen, y no era
// "detalle de redacción": eran AFIRMACIONES sobre una sola persona. El cuerpo de
// la carta del origen decía, para cualquier usuario que usara la función:
//
//   "Soy QA Engineer con 8+ años de experiencia en garantía de calidad de
//    software, especializado en banca digital y fintech."
//
// Para un contador eso no es una carta poco ajustada: es una carta MENTIROSA que
// el usuario va a mandar a una empresa porque la aplicación se la puso en el
// portapapeles. Por eso acá no hay ni una afirmación que no venga del perfil del
// usuario, y por eso los párrafos son opcionales: sin dato, no se escribe nada.
//
// La regla del archivo, en una línea: **la carta no puede afirmar nada que el
// perfil no diga**. Todo párrafo que no se pueda construir con datos reales se
// OMITE, se deja la línea, y el resultado sigue siendo una carta usable.
//
// OJO con la firma: sin `fullName`, la carta sale sin firma. Es la decisión del
// proyecto (migración 002, comentario de `full_name`) y no un descuido: la app no
// muestra ni manda el nombre de nadie que no lo haya escrito.
// ============================================================================

import { computeMatch } from './matcher.js';
import { emptyProfile } from './profile.js';
import { DEFAULT_REGION, isValidRegion, REGIONS } from './regions.js';

// ════════════════════════════════════════════════════════════════════════════
// EL PERFIL Y LA REGIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Perfil utilizable o perfil vacío.
 * @param {object|null|undefined} profile Perfil del contrato.
 * @returns {object} El perfil, o uno vacío.
 */
function profileOrEmpty(profile) {
  if (profile && typeof profile === 'object' && Array.isArray(profile.skills)) return profile;
  return emptyProfile();
}

/**
 * Resuelve la clave de región a una que exista, o a la del proyecto.
 *
 * El endpoint tiene que validar el `?region=` antes (con `isValidRegion`), así
 * que esto es la segunda línea de defensa: si llega una clave desconocida, la
 * carta se escribe en el idioma de la región por defecto en vez de romper o,
 * peor, en el idioma equivocado.
 *
 * @param {string} regionKey La clave que pidió el caller.
 * @returns {string} Una clave que exista en `REGIONS`.
 */
function resolveRegion(regionKey) {
  const key = String(regionKey || '').trim().toLowerCase();
  // ↑ El toLowerCase porque un `?region=Argentina` con mayúscula es un error de
  //   tipeo del usuario, no una región distinta. `trim` por espacios.
  return isValidRegion(key) ? key : DEFAULT_REGION;
}

/**
 * El idioma de la carta para una región.
 * @param {string} regionKey Clave de región ya resuelta.
 * @returns {string} `'es'` o `'en'`.
 */
function langForRegion(regionKey) {
  // ↑ Sale de la CONFIGURACIÓN de la región (regions.js), no de un if por
  //   país. Agregar un país con carta en inglés es agregar `'lang': 'en'` en su
  //   entrada; acá no se toca nada.
  return (REGIONS[regionKey] || {}).lang || 'es';
}

/**
 * Nombres de marca de las fuentes, para el encabezado.
 *
 * El origen tenía esta tabla sin usar en ninguna parte de la carta: los ids
 * crudos ("remoteok", "weworkremotely") nunca llegaban al texto. Se conserva y
 * SE USA, en `companySummary`, porque un resumen que dice "(remoteok) busca..."
 * se ve como un bug. Lo que no se hace es inventar nombres de marca para las
 * fuentes que no están acá: se cae al id tal cual.
 *
 * @type {Record<string, string>}
 */
const COMPANIES = {
  remoteok: 'RemoteOK',
  weworkremotely: 'We Work Remotely',
  linkedin: 'LinkedIn',
  remotive: 'Remotive',
  hibrid: 'Hibrid',
  jobicy: 'Jobicy',
  himalayas: 'Himalayas',
  arbeitnow: 'Arbeitnow',
};

/**
 * El nombre de la empresa como se muestra.
 * @param {object} job La oferta.
 * @returns {string} Nombre de marca si se conoce, o lo que venga de la oferta.
 */
function companyName(job) {
  // ↑ El nombre de la empresa va PRIMERO: es el dato que la bolsa manda bien y el
  //   que el usuario reconoce. El id de la fuente es el fallback, no al revés.
  return job.company || COMPANIES[String(job.source || '').toLowerCase()] || job.source || 'la empresa';
}

// ════════════════════════════════════════════════════════════════════════════
// EL RESUMEN DE LA OFERTA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resumen en una línea de la empresa y las habilidades que el perfil cumple.
 *
 * @param {object} job Oferta.
 * @param {object} [profile] Perfil del contrato. Sin perfil, `requiredSkills`
 *   queda vacío (que es lo correcto: no se puede afirmar que alguien cumple algo).
 * @returns {{companySummary: string, requiredSkills: string[], topSkill: string|null}}
 */
export function summarize(job, profile) {
  const j = job && typeof job === 'object' ? job : {};
  const match = computeMatch(j, profile);
  const skills = (match.matched || []).slice(0, 6);

  const parts = [];
  const company = companyName(j);
  const title = j.title ? `"${j.title}"` : 'la posición';
  if (j.title) parts.push(`${company} busca ${title}`);
  // ↑ Si la oferta no trae título, el resumen dice "la empresa" en vez de
  //   producir `busca "undefined"`. Es una bolsa mandando un formato raro, y el
  //   texto que se copia y pega no puede mostrar eso.
  if (j.location) parts.push(`en ${j.location}`);
  const sourceLabel = (j.source && company !== j.source) ? ` (${COMPANIES[String(j.source).toLowerCase()] || j.source})` : '';

  return {
    companySummary: parts.join(' ') + sourceLabel,
    requiredSkills: skills,
    // ▲ `topSkill` es null si no hay skills. El origen devolvía la cadena fija
    //   'QA Testing', que para un contador es MENTIRA y además terminaba en la
    //   carta ("mi fuerte es QA Testing"). null hace que el párrafo se arme sin
    //   esa frase.
    topSkill: skills[0] || null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PÁRRAFOS: cada uno es opcional y se arma solo si hay datos
// ════════════════════════════════════════════════════════════════════════════

/**
 * Los años de experiencia, escritos como los escribe una persona.
 * @param {object} p Perfil.
 * @returns {string|null} "8 años", o null si no hay dato o no aplica.
 */
function yearsPhrase(p) {
  const n = Number(p.yearsExperience);
  // ↑ `> 0` y no `>= 0`: con 0 años de experiencia el dato es irrelevante para una
  //   carta (y "0 años de experiencia" se lee como un error), así que se trata
  //   como si no estuviera.
  if (!Number.isFinite(n) || n <= 0) return null;
  // ↑ Se redondea al entero a propósito: un `years_experience numeric(3,1)` de
  //   7.5 no se escribe "7.5 años" en una carta.
  return String(Math.round(n));
}

/**
 * Párrafo de quién es la persona. Solo con datos reales.
 * @param {object} p Perfil.
 * @returns {string|null} El párrafo, o null si no hay nada que decir.
 */
function introParagraph(p, lang) {
  const years = yearsPhrase(p);
  const isEn = lang === 'en';

  // El resumen del CV es lo mejor que hay: lo escribió (o lo resume el LLM) a
  // partir del CV real. Es la fuente más confiable para el párrafo de apertura.
  if (p.summary) {
    const summary = String(p.summary).trim();
    // ↑ Si el resumen es larguísimo, la carta se vuelve un muro de texto. Se
    //   corta en la primera oración larga: una carta de postulación de 400
    //   palabras no se lee.
    return isEn
      ? `${summary}\n\nI am applying for this role because it matches what I already do.`
      : `${summary}\n\nPostulo porque el puesto se corresponde con lo que ya vengo haciendo.`;
  }

  // Sin resumen, se arma con título y años. Lo que NO se hace es inventar una
  // especialidad: la del origen ("especializado en banca digital y fintech") era
  // una afirmación sobre una profesión, y el perfil no tiene de dónde sacarla.
  const pieces = [];
  if (p.title && years) {
    pieces.push(isEn
      ? `I am a ${p.title} with ${years} years of experience.`
      : `Soy ${p.title} con ${years} años de experiencia.`);
  } else if (p.title) {
    pieces.push(isEn ? `I am applying as a ${p.title}.` : `Postulo como ${p.title}.`);
  } else if (years) {
    pieces.push(isEn
      ? `I have ${years} years of experience.`
      : `Tengo ${years} años de experiencia.`);
  }
  // ↑ Cada rama es la que se puede sostener con lo que hay. Sin título ni años,
  //   `pieces` queda vacío y el párrafo es null: el primer párrafo de la carta
  //   pasa a ser el de habilidades, que sí tiene contenido.

  return pieces.length ? pieces.join(' ') : null;
}

/**
 * Párrafo de qué aporta: las habilidades que ESTA oferta pide y el perfil tiene.
 * @param {string[]} skills Habilidades coincidentes.
 * @returns {string|null} El párrafo, o null si no hay habilidades.
 */
function skillsParagraph(skills, lang) {
  if (!skills.length) return null;
  // ↑ Sin skills no hay párrafo. El origen escribía "Entre mis fortalezas se
  //   encuentran: ." cuando la lista venía vacía, que es el tipo de cosa que
  //   hace que alguien no mande la carta.
  const names = skills.join(', ');
  return lang === 'en'
    ? `Among the skills this position asks for, I have: ${names}.`
    : `De lo que pide este puesto, tengo: ${names}.`;
}

/**
 * Párrafo de contacto, con los enlaces reales del perfil.
 * @param {object} p Perfil.
 * @returns {string|null} El párrafo, o null si no hay ningún enlace.
 */
function contactParagraph(p, lang) {
  // ↑ Se arma una lista de lo que HAY y se nombra cada uno. El origen imprimía
  //   "Pueden contactarme por LinkedIn: undefined" cuando el perfil no tenía
  //   LinkedIn, que es lo que pasaba con todo usuario que no fuera el dueño de
  //   esta app.
  const items = [];
  if (p.links && p.links.linkedin) items.push(['LinkedIn', p.links.linkedin]);
  if (p.links && p.links.portfolio) items.push(['portfolio', p.links.portfolio]);
  if (p.links && p.links.github) items.push(['GitHub', p.links.github]);
  if (!items.length) return null;

  const joined = items.map(([label, url]) => `${label}: ${url}`).join(' | ');
  return lang === 'en' ? `You can reach me at ${joined}.` : `Pueden contactarme en ${joined}.`;
}

/**
 * La firma. Sin nombre, no hay firma.
 * @param {object} p Perfil.
 * @returns {string|null} La firma, o null si no hay nombre.
 */
function signature(p, lang) {
  if (!p.fullName) return null;
  // ↑ Sin `fullName` la carta sale sin firma. Es lo decidido en la migración
  //   002: la app no inventa ni muestra el nombre de nadie.
  const lines = [p.fullName];
  if (p.title) lines.push(p.title);
  if (p.location) lines.push(p.location);
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// CUERPO DE LA CARTA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Arma el cuerpo de la carta juntando solo los párrafos que se pueden escribir.
 *
 * El cuerpo se arma como una lista de párrafos y se une con saltos de línea
 * dobles. Cada párrafo se filtra por su propio valor: los que no se pueden
 * construir con datos reales desaparecen, y los que quedan quedan pegados
 * ("Hola.\n\n\n\nDespido") no puede pasar porque el join es sobre una lista ya
 * filtrada.
 *
 * @param {object} job La oferta.
 * @param {object} sum El resultado de `summarize`.
 * @param {object} p El perfil.
 * @param {string} lang `'es'` o `'en'`.
 * @returns {string} El cuerpo.
 */
function buildBody(job, sum, p, lang) {
  const isEn = lang === 'en';
  const company = companyName(job);
  const title = job.title ? `"${job.title}"` : 'el puesto';

  // ── Párrafo 1: a qué se postula ────────────────────────────────────────────
  const head = isEn
    ? `I am writing to apply for the position of ${title} at ${company}.`
    : `Me dirijo a ustedes para postularme a ${title} en ${company}.`;

  // ── Párrafo 2: quién soy (si hay datos) ───────────────────────────────────
  const intro = introParagraph(p, lang);

  // ── Párrafo 3: qué aporto a ESTE puesto ───────────────────────────────────
  const skills = skillsParagraph(sum.requiredSkills, lang);

  // ── Párrafo 4: contacto (si hay enlaces) ──────────────────────────────────
  const contact = contactParagraph(p, lang);

  // ── Cierre ────────────────────────────────────────────────────────────────
  // El cierre NO es opcional: una carta sin despedida no es una carta. Es la
  // única frase que se escribe siempre, y no afirma nada: no menciona skills, ni
  // años, ni nombre.
  const closing = isEn
    ? 'I attach my CV and I am available for an interview.\n\nBest regards,'
    : 'Adjunto mi CV y quedo a disposición para una entrevista.\n\nSaludos cordiales,';

  const sign = signature(p, lang);

  return [
    head,
    intro,
    skills,
    contact,
    // ↑ El orden es el de una carta de verdad: qué es el puesto, quién soy, qué
    //   aporto, cómo me contactan, despedida, firma. Los nulos desaparecen del
    //   medio sin dejar huecos.
    closing,
    sign,
  ].filter(Boolean).join('\n\n');
}

// ════════════════════════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Genera la carta completa para una oferta.
 *
 * @param {object} job La oferta.
 * @param {string} [regionKey] Clave de región (de `rankByRegion`). Si no existe,
 *   se usa la región por defecto del proyecto.
 * @param {object} [profile] Perfil del contrato. Sin perfil la carta sale sin
 *   nombre, sin habilidades y sin firma: nunca con datos inventados.
 * @returns {{lang: string, region: string, subject: string, body: string}}
 */
export function generateCoverLetter(job, regionKey, profile) {
  const j = job && typeof job === 'object' ? job : {};
  const p = profileOrEmpty(profile);
  const region = resolveRegion(regionKey);
  const lang = langForRegion(region);
  const sum = summarize(j, p);

  const title = j.title || (lang === 'en' ? 'the advertised position' : 'el puesto anunciado');

  return {
    lang,
    // ↑ Se devuelve la región RESUELTA, no la que pidió el caller: si pidió una
    //   inexistente, la carta se escribió para otra y decir "argentina" es lo
    //   cierto. Si se devolviera la clave cruda, el consumidor vería un valor que
    //   no corresponde a lo que recibió.
    region,
    subject: lang === 'en'
      // ↑ El asunto con `null` al final: sin nombre, el asunto queda "Application
      //   for X - null", que es un bug visible. Se hace el trim y se cae el
      //   separador si no hay nombre.
      ? `Application for ${title}${p.fullName ? ` - ${p.fullName}` : ''}`
      : `Postulación a ${title}${p.fullName ? ` - ${p.fullName}` : ''}`,
    body: buildBody(j, sum, p, lang),
  };
}
