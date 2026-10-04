// ============================================================================
// CONFIGURACIÓN ÚNICA DE REGIONES.
//
// Este archivo es el ÚNICO lugar del proyecto donde se dice qué países soporta la
// app y cómo se busca en cada uno. Todo lo demás lo importa:
//   - matcher.js        detecta en qué región cae una oferta
//   - apifyLinkedin.js  arma la query de búsqueda de LinkedIn
//   - coverLetter.js    decide el idioma de la carta (es/en)
//   - analytics.js      los labels de los contadores
//   - frontend utils.js las pestañas y los títulos de la UI
//
// Por qué existe: en el proyecto origen las regiones estaban repetidas en 5
// archivos, y agregar un país obligaba a editar los 5. Acá se agrega UNA entrada
// y los 5 se enteran solos. No hardcodees nombres de países en otro archivo.
//
// ALCANCE ACTUAL: solo Argentina (decisión del pedido). Agregar otro país es
// agregar una clave acá y, si hace falta, mover sus marcadores de `excludes`
// a su propia entrada.
// ============================================================================

/**
 * Normaliza texto para comparar sin acentos.
 * "Córdoba" y "cordoba" tienen que ser la MISMA palabra: las bolsas de empleo
 * escriben las ciudades de las dos formas según cuál API sea, y si solo
 * reconociéramos una, la mitad de las ofertas de Córdoba se irían al descarte.
 * @param {string} value Texto cualquiera.
 * @returns {string} El texto en minúsculas, sin tildes ni signos.
 */
export function normalize(value) {
  return String(value || '')
    .toLowerCase()
    // NFD descompone "ó" en "o" + tilde combinante; al quitar los diacríticos
    // queda la "o" pelada. Ese es el truco para comparar sin acentos.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Deja una sola forma de escribir los apóstrofes y los guiones, porque
    // "diseño" y "diseno" aparecen indistintamente según la bolsa.
    .replace(/[’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escapa un término para usarlo como literal dentro de un RegExp.
 * Necesario porque los nombres de ciudades tienen caracteres que son metacaracteres.
 * @param {string} value Término a escapar.
 * @returns {string} El término con los metacaracteres escapados.
 */
function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Las regiones soportadas, con todos sus datos.
 * - `label`: cómo se llama en la interfaz.
 * - `lang`: idioma de las cartas de presentación de esa región.
 * - `places`: nombres y abreviaturas con los que las bolsas describen el lugar.
 * - `remoteWords`: cómo escriben "trabajo remoto" sin decir un país.
 * - `excludes`: marcadores de países que NO son esta región. Sirven para no
 *   meter en el bucket una oferta que es explícitamente de otro lado ("Remote - US").
 *   Cuando ese país tenga su propia entrada, se saca de acá.
 * - `linkedinLocation`: el texto que LinkedIn espera en su parámetro location.
 * @type {Record<string, object>}
 */
export const REGIONS = {
  argentina: {
    label: 'Argentina',
    // ↑ 'es' porque la carta de presentación se escribe en español. OJO: es el
    //   idioma de la CARTA, no el de la búsqueda: una oferta en inglés para
    //   Argentina se matchea igual y su carta sigue saliendo en español.
    lang: 'es',
    linkedinLocation: 'Argentina',
    places: [
      'argentina',
      'bs as',
      'buenos aires',
      'caba',
      'capital federal',
      'cordoba',
      'rosario',
      'mendoza',
      'la plata',
      'mar del plata',
      'tucuman',
      'neuquen',
      'salta',
      'san juan',
      'santa fe',
      'entre rios',
      'bahia blanca',
      'parana',
      'resistencia',
      'posadas',
      'formosa',
      'san luis',
      'la rioja',
      'catamarca',
      'jujuy',
      'misiones',
      'corrientes',
      'chaco',
      'santa cruz',
      'comodoro rivadavia',
      'rio gallegos',
      'ushuaia',
    ],
    remoteWords: ['remote', 'remoto', 'remota', 'worldwide', 'anywhere', 'global', 'teletrabajo', 'home office'],
    excludes: [
      'united states',
      'usa',
      'us only',
      'remote us',
      'spain',
      'espana',
      'germany',
      'france',
      'netherlands',
      'united kingdom',
      'uk',
      'ireland',
      'portugal',
      'mexico',
      'peru',
      'colombia',
      'chile',
      'uruguay',
      'paraguay',
      'bolivia',
    ],
  },
};

/** Región que se usa cuando la URL o el body no dice ninguna. */
export const DEFAULT_REGION = 'argentina';

/**
 * ¿La clave existe en la configuración?
 * Sirve para validar el `?region=` que llega por la URL ANTES de usarlo: sin esto,
 * un `?region=<script>` o un `?region=xyz` se cuela hasta donde arma la query.
 * @param {string} key Clave de región pedida.
 * @returns {boolean} Si la región está soportada.
 */
export function isValidRegion(key) {
  return Object.prototype.hasOwnProperty.call(REGIONS, key);
}

/**
 * Nombre visible de una región, o la misma clave si no la hay.
 * @param {string} key Clave de región.
 * @returns {string} El label para mostrar.
 */
export function regionLabel(key) {
  return (REGIONS[key] || {}).label || key;
}

/**
 * Un bucket vacío por cada región configurada.
 * Se usa para partir las ofertas: sin esto habría que ir creando claves a mano
 * y un país nuevo sin ofertas no aparecería en la UI.
 * @returns {Record<string, any[]>} Un objeto con una lista vacía por región.
 */
export function emptyBuckets() {
  const out = {};
  for (const key of Object.keys(REGIONS)) out[key] = [];
  return out;
}

/**
 * Detecta a qué región pertenece una oferta según su texto.
 *
 * REEMPLAZA a las dos funciones que había antes: `guessRegionFromText()` de
 * jobSources.js y `assignRegion()` de matcher.js. Las dos eran una cadena de
 * `if` hardcodeada, y por esovivían en dos lugares distintos.
 *
 * Prioridad, en este orden (es una decisión de negocio, no un accidente):
 *  1. Si el texto dice explícitamente otro país, NO es de esta región (se
 *     descarta). Es lo que evita que una oferta "Remote - US" caiga en
 *     Argentina solo porque dice "remote".
 *  2. Si el texto nombra un lugar de la región, es de la región.
 *  3. Si dice "remote" o "worldwide" sin país, es trabajo remoto: para un
 *     usuario de Argentina ES alcanzable, así que entra a su región.
 *  4. Si no dice nada, se asume remoto y entra igual.
 *
 * @param {string} text Texto de ubicación de la oferta.
 * @returns {string|null} La clave de la región, o null si no corresponde.
 */
export function matchRegion(text) {
  const t = ` ${normalize(text)} `;
  const results = [];

  for (const [key, region] of Object.entries(REGIONS)) {
    // Se arma UN regex por región y se prueban todos de una: así agregar un
    // país es agregar su entrada acá, sin tocar ninguna función.
    const placeRe = new RegExp(`(^|[^a-z])(${region.places.map(escapeReg).join('|')})([^a-z]|$)`);
    const remoteRe = new RegExp(`(^|[^a-z])(${region.remoteWords.map(escapeReg).join('|')})([^a-z]|$)`);
    // Se compila el patrón de exclusiones una sola vez y se cachea en la región,
    // porque acá se llama una vez por oferta y las hay cientos.
    if (!region._excludeRe) {
      region._excludeRe = new RegExp(`(^|[^a-z])(${region.excludes.map(escapeReg).join('|')})([^a-z]|$)`);
    }

    if (region._excludeRe.test(t)) continue;      // regla 1: es de otro país
    if (placeRe.test(t)) {                        // regla 2: nombró un lugar
      results.push({ key, remote: false });
      continue;
    }
    if (remoteRe.test(t)) {                       // regla 3: remoto sin país
      results.push({ key, remote: true });
      continue;
    }
    // Regla 4: no dijo nada. Se asume remoto alcanzable, PERO solo si es la
    // única región configurada: con varios países, "no dijo nada" no alcanza
    // para decidir, y el que no diga país que quede afuera.
    if (Object.keys(REGIONS).length === 1) results.push({ key, remote: true });
  }

  // Con más de una región podría haber varios candidatos; el primero gana.
  // Con una sola, el resultado es 0 o 1.
  const hit = results[0] || null;
  if (!hit) return null;

  // Se devuelve la clave, y `isRemote` aparte para que la UI pueda marcar la
  // oferta como remoto sin tener que volver a parsear el texto.
  return { region: hit.key, remote: hit.remote };
}
