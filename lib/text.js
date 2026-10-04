// ============================================================================
// TEXTO DE OFERTA: las TRES funciones que usan todos los módulos que matchean.
//
// En el proyecto origen estas tres estaban DUPLICADAS, línea por línea, en
// `matcher.js` y en `analytics.js`. Es la peor duplicación posible: las dos
// copias pueden divergir sin que nada se entere, y el resultado visible es que
// la página de análisis le dice al usuario "el mercado pide playwright" medido
// con un criterio distinto del que le dio el score que está mirando en pantalla.
// Una sola implementación hace imposible esa mentira, y por eso viven acá y no
// en ninguno de los dos.
//
// Además este módulo es donde viven las TRAMPAS del texto de una oferta, que son
// las que hacen aparecer un `TypeError` en producción y nunca en desarrollo:
//
//   · `job.tags` puede no ser un array. Las ofertas de Apify vienen sin `tags`,
//     y el `job.tags.join(' ')` del origen tiraba `TypeError: job.tags.join is
//     not a function` — no un error de "datos malos", un crash entero.
//   · `title`, `description` y `company` pueden faltar: una bolsa que cambió su
//     formato manda campos null y el `.toLowerCase()` de `undefined` reventa.
//
// OJO: este archivo NO es "el de las utilidades". Solo lo que tiene que ver con
// leer el texto de una oferta y con comparar un término contra ese texto. Lo que
// sea normalización de DATOS (pesos, arrays, jsonb) va en el módulo que lo usa.
// ============================================================================

import { normalize } from './regions.js';

// `regions.js` es el módulo que define la normalización; acá se importa para
// usarla en `textHasSkill` y además se reexporta (abajo), para que los
// consumidores no tengan que saber en qué archivo vive.

// ════════════════════════════════════════════════════════════════════════════
// EL TEXTO DE UNA OFERTA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Arma el texto completo de una oferta, ya NORMALIZADO, para buscarle skills.
 *
 * Los cuatro campos son los que el origen usaba y son los que de verdad describen
 * el puesto: título, descripción, tags y empresa. NO se suma `location`: el
 * lugar no dice qué sabe hacer la persona, y meterlo haría matchear "Buenos
 * Aires" contra una skill.
 *
 * EL TEXTO SALE NORMALIZADO (minúsculas, sin acentos) Y ESO ES OBLIGATORIO, no un
 * detalle cosmético. `textHasSkill` normaliza el término que busca, así que la
 * comparación solo funciona si los dos lados están normalizados. El bug real que
 * esto previene: con el texto solo en minúsculas (como hacía el origen con su
 * `.toLowerCase()`), la skill "clínica" NUNCA matcheaba contra una oferta que
 * decía "Clínica", porque el patrón busca "clinica" y en el texto había una "í".
 * Y ese modo de falla es el peor de todos: no es un error, es un 0 silencioso. La
 * skill está en el CV, la oferta la pide, y el match baja sin que nada rompa.
 *
 * Por qué no se normaliza adentro de `textHasSkill`: se llama skills × ofertas
 * veces (con 40 skills y 300 ofertas, 12.000 llamadas), y normalizar un texto de
 * 2.000 caracteres 12.000 veces es trabajo carísimo para hacer lo mismo. La
 * normalización va una vez por oferta, acá.
 *
 * @param {object} job Oferta de cualquier fuente. Todos sus campos son opcionales.
 * @returns {string} El texto normalizado en minúsculas, o `''` si no hay nada.
 */
export function jobText(job) {
  if (!job || typeof job !== 'object') return '';
  // ↑ `job` puede ser null si un endpoint lo pasa sin chequear. Devolver `''` es
  //   lo honesto: sin texto no hay nada que comparar, y un `''` después no
  //   matchea ninguna skill (porque `textHasSkill` exige un término no vacío).

  // ↑ El `(Array.isArray(...) ? ... : '')` reemplaza al `job.tags.join(' ')` del
  //   origen. Es la diferencia entre "una bolsa manda los tags como string" y
  //   "toda la función de matching deja de existir con un 500".
  const tags = Array.isArray(job.tags) ? job.tags.join(' ') : '';

  return normalize([
    job.title,
    job.description,
    tags,
    job.company,
    // ↑ Cada campo pasa por `asText`, que convierte null/undefined en cadena
    //   vacía. Sin eso, un solo campo faltante en UNA oferta tumba la función
    //   entera y con ella la búsqueda del usuario.
  ].map(asText).join(' '));
}

/**
 * Convierte cualquier valor en texto, sin romper nunca.
 *
 * `String(null)` es `'null'` y `String(undefined)` es `'undefined'`: los dos
 * strings aparecerían después en el texto de la oferta y los dos son
 *informaticsamente ciertos (nadie tiene una skill llamada "undefined") pero
 * usan caracteres del matcher. Por eso `null`/`undefined` van a `''`.
 *
 * @param {unknown} value Cualquier cosa.
 * @returns {string} El valor como texto, nunca `'undefined'`.
 */
export function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  // ↑ `typeof` en vez de `instanceof String`: no hay ningún caso en este proyecto
  //   donde valga la distinction y el chequeo barato cubre los dos casos.
  return String(value);
}

/**
 * Normaliza texto para comparar sin acentos.
 *
 * Rexportado de `regions.js` para que quien importa este módulo no tenga que
 * saber en qué archivo vive la normalización: `regions.js` la define porque la
 * usa para detectar países, y acá se usa para que "atención" y "atencion" sean la
 * MISMA skill. Es el mismo criterio en todo el proyecto o no sirve de nada.
 *
 * OJO: se importa arriba Y se reexporta acá. `export { x } from 'y'` NO crea una
 * binding local (solo reexporta), así que un módulo que use `normalize(...)` por
 * dentro necesita el `import` además del `export ... from`. Es el mismo error que
 * el que throws `ReferenceError: normalize is not defined` en el primer test.
 */
export { normalize };

// ════════════════════════════════════════════════════════════════════════════
// COMPARAR UN TÉRMINO CONTRA EL TEXTO
// ════════════════════════════════════════════════════════════════════════════

// Caché de RegExp compilados, por término.
//
// Por qué existe: `textHasSkill` se llama skills × ofertas veces. Con 40 skills
// y 300 ofertas son 12.000 compilaciones de RegExp por búsqueda, y el motor tiene
// que compilar el patrón cada vez. La caché no cambia NI UNO de los resultados:
// es memoización pura, y si la instancia de Vercel se apaga y la pierde, el
// código compila de nuevo y da exactamente lo mismo.
//
// ↑ NO es "estado entre requests" (lo que el proyecto prohíbe): no hay ningún
//   resultado guardado, ningún "último Apify", nada de lo que una respuesta
//   dependa. Es una caché de patrones, como la de `matchRegion()` en regions.js.
//   Además está acotada para que un perfil con 5.000 skills no la crezca sin
//   límite: al superar el tope se vacía entera, que es una operación O(1) amortizada.
const REGEX_CACHE = new Map();
const REGEX_CACHE_MAX = 512;

/**
 * Escapa los metacaracteres de un término para usarlo como literal en un RegExp.
 *
 * SIN esto, la skill `c++` compila un patrón que quiere decir "una o más c", y
 * la skill `node.js` matchearía "nodeXjs". Los nombres de skill vienen de un LLM
 * y de bolsas de empleo, así que traen puntos, signos más y barras sin que nadie
 * los revise: el escape no es opcional.
 *
 * @param {unknown} term Término a escapar.
 * @returns {string} El término con los metacaracteres escapados.
 */
export function escapeReg(term) {
  return asText(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * ¿El término aparece como PALABRA COMPLETA dentro del texto?
 *
 * El patrón `(^|[^a-z])término([^a-z]|$)` es lo que hace que "qa" NO entre
 * dentro de "quality", y está SEGURO: es la técnica del código heredado y se
 * conserva. Lo que cambió es QUÉ términos se buscan (los del usuario), no cómo.
 *
 * CONTRATO DEL PARÁMETRO `text`: tiene que venir de `jobText()` o de `normalize()`
 * de `regions.js`. Esta función normaliza el TÉRMINO, no el texto, porque
 * normalizar un texto de 2.000 caracteres skills × ofertas veces sería carísimo
 * (ver el comentario de `jobText`). La consecuencia de romper el contrato es un
 * `false` silencioso, no un error: si le pasás texto crudo con tildes, la
 * comparación contra el término normalizado no va a matchear nunca.
 *
 * @param {string} text Texto ya normalizado (el de `jobText`).
 * @param {string} term El término a buscar: un nombre de skill o un keyword. Se
 *   normaliza acá, así que puede venir con acentos y con mayúsculas.
 * @returns {boolean} Si aparece como palabra completa.
 */
export function textHasSkill(text, term) {
  const t = asText(term).trim();
  // ↑ El `trim` no es decorativo: un término que es un espacio o una cadena
  //   vacía compila `(^|[^a-z])([^a-z]|$)`, que matchea CASI cualquier texto. Sin
  //   este corte, una skill en blanco haría que TODAS las ofertas den score > 0 y
  //   el buscador mostrara basura. Es un bug que no se ve en desarrollo porque en
  //   desarrollo los datos están bien.
  if (!t) return false;

  // ↑ Se normaliza el término (minúsculas, sin tildes) para que la comparación
  //   sea con el mismo criterio con el que se arma el texto: si "atención" del
  //   perfil se buscara con tilde contra un texto ya normalizado, nunca matchearía.
  const key = normalize(t);
  if (!key) return false;

  let re = REGEX_CACHE.get(key);
  if (!re) {
    re = new RegExp(`(^|[^a-z])${escapeReg(key)}([^a-z]|$)`, 'i');
    // ↑ Sin la 'i' el texto ya viene en minúsculas de `jobText`, pero el término
    //   normalizado también puede traer mayúsculas si el LLM las dejó: la 'i'
    //   hace el chequeo idempotente y no cuesta nada.
    if (REGEX_CACHE.size >= REGEX_CACHE_MAX) REGEX_CACHE.clear();
    // ↑ Vaciar y no borrar el más viejo: sacar el más viejo es O(n) y esta caché
    //   se llena una vez por instancia, no en un loop caliente.
    REGEX_CACHE.set(key, re);
  }
  return re.test(asText(text));
}

/**
 * Convierte a número, con un default si no se puede.
 *
 * El peso de las skills viene de `numeric(4,3)` y el driver ya lo devuelve como
 * number (ver el type parser de `db.js`), pero el MISMO dato pasa por el LLM del
 * onboarding, y un LLM puede devolver `"alta"`, `null` o `85` en vez de `0.85`.
 * Acá no se decide qué hacer con eso: se convierte a número y, si no se puede, se
 * usa el default. Quien llama decide qué default.
 *
 * OJO con `Number('')`: da `0`, no `NaN`. Un peso ausente y un peso 0 son cosas
 * distintas (uno es "no lo declaraste", el otro es "lo declaraste en cero"), así
 * que la cadena vacía y el `null` devuelven el default, no cero.
 *
 * @param {unknown} value Lo que haya llegado.
 * @param {number} [fallback] Valor a devolver si no se puede convertir.
 * @returns {number} El número, o el fallback.
 */
export function toNumber(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback === undefined ? 0 : fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}