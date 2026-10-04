// ============================================================================
// AGREGADOR DE BOLSAS DE EMPLEO GRATUITAS.
//
// Consulta cinco APIs públicas que NO requieren autenticación, limpia cada oferta
// y elimina los duplicados que aparecen en más de una bolsa. Es el camino GRATIS
// de la app: las bolsas que bloquean scraping o que cobran por ejecución (Apify)
// NO entran acá, ni ahora ni después.
//
// QUÉ CAMBIA RESPECTO DEL ORIGEN (`F:\busqueda_trabajo\server\jobSources.js`)
// --------------------------------------------------------------------------
// El origen tenía los términos de búsqueda y la detección de país HARDCODEADOS a
// QA y a otros países. Este archivo no tiene ninguno de los dos:
//
//   · Los términos salen del PERFIL del usuario, vía `searchTerms.js`. El origen
//     los tenía en cinco lugares y los cinco eran de QA (ver la cabecera de
//     `searchTerms.js`, que explica el bug).
//   · NO se calcula la región. La detección de país es de `regions.js:matchRegion`
//     y es el ÚNICO lugar del proyecto que dice qué países existen. El origen
//     tenía `guessRegionFromText()` con siete regex de países hardcodeados y un
//     default `'eeuu'`, que además duplicaba lo que hacía `matcher.js:assignRegion`.
//     Las dos copias se desincronizaban y el `return 'eeuu'` de último recurso
//     metía en EEUU toda oferta remota que no nombraba un país.
//
// LOS CINCO CAMBIOS DE CONTRATO RESPECTO DEL ORIGEN, y son deliberados:
//
//   1. `fetchJobs` devuelve `{ jobs, online }` y no un array pelado. Ver el JSDoc
//      de `fetchJobs`: "las fuentes respondieron" y "no hay ofertas que te
//      sirvan" son dos hechos distintos y el usuario los vive distinto.
//   2. Los errores por fuente se AVISAN con el nombre de la bolsa. El origen los
//      tiraba en silencio, y cuando Remotive devolvía 500 no quedaba ningún rastro
//      de por qué la búsqueda venía con menos resultados.
//   3. `Math.random()` NO aparece en ningún id. El origen lo usaba para Himalayas
//      cuando la oferta no traía `guid` ni `slug` (`:143`), y eso rompía la
//      deduplicación del historial en silencio. Ver `stableKey`.
//   4. La forma del contrato es la MISMA que usaban `matcher.js`, `history.js` y
//      `coverLetter.js` en el origen: `date` (no `postedAt`), `applyUrl` (no
//      `url`), `regionGuess` (siempre `''`). Los nombres no se cambian porque el
//      desempate del ranking lee `date` (`matcher.js:publishedAt`) y las bolsas
//      gratuitas normalizan todas a `date`.
//   5. `clean()` usa `asText()` en vez del default de parámetro. Ver la nota.
//
// MÓDULO QUE PEGA A LA RED, y por eso no importa NADA del proyecto: no importa
// `db.js` (nada acá va a la base: las bolsas son externas y anónimas), ni `pg`, ni
// el módulo del LLM. Sus únicas dependencias son `searchTerms.js` (que es puro) y
// `text.js` (que es puro). Nada de lo que hay acá se puede cobrar.
//
// SIN ESTADO A NIVEL DE MÓDULO: no hay `cache`, no hay `lastJobs`, no hay nada que
// sobreviva entre llamadas. En serverless no hay memoria entre invocaciones y dos
// requests pueden entrar al mismo tiempo (AGENTS.md), así que todo lo que hay acá
// es local a la llamada. Esa es la razón por la que el origen era (accidentalmente)
// serverless-safe: no guardaba el "último resultado" de nada.
// ============================================================================

import { asText } from './text.js';
import { matchesAnyTerm, primaryTerm, searchTerms } from './searchTerms.js';

import { jobText } from './text.js';
// ↑ `jobText` normaliza título + descripción + tags + empresa, que es
//   exactamente el texto contra el que hay que filtrar las ofertas de RemoteOK
//   (que no acepta parámetro de búsqueda). Se separa del import de arriba a
//   propósito: los helpers de RED (`asText`) y los de MATCHING (`jobText`) son
//   cosas distintas y mezclarlos en una línea esconde de dónde sale cada cosa.

// ════════════════════════════════════════════════════════════════════════════
// RED: CABECERAS Y TIMEOUTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cabeceras comunes del fetch.
 *
 * El `User-Agent` del origen era `'Mozilla/5.0 (job-search-app;
 * +https://github.com/avtovar)'`: identificaba la app, sí, pero también el
 * repositorio PERSONAL del único developer. Eso no es información que una app
 * de terceros tenga que mandar a cinco empresas ajenas en cada petición, así que
 * acá va algo genérico y cierto: se declara que es un cliente automatizado
 * compatible con navegadores, que es exactamente lo que es.
 *
 * Y NO se manda `Accept`. No hace falta (`fetch` ya manda uno razonable) y
 * algunas de estas APIs responden distinto si les decís que querés JSON, para bien
 * y para mal. Lo que se manda es lo mínimo.
 *
 * @type {Record<string, string>}
 */
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; busqueda-empleo-ia)' };

/**
 * Tiempo máximo de espera POR REQUEST, en milisegundos.
 *
 * OJO CON LA DIFERENCIA, porque es la que hace que la búsqueda no se corte: esto
 * es el timeout de UNA petición, NO del conjunto. Como las cinco fuentes corren
 * EN PARALELO (`Promise.allSettled`), el tiempo total de la búsqueda es el de la
 * fuente MÁS LENTA, no la suma: 20 segundos en el peor caso, más el parseo.
 *
 * Y 20 < 30, que es el `maxDuration` de `vercel.json` para todos los archivos de
 * `api/`. Ese es el número que hay que respetar al agregar bolsas: si someday son
 * 15 fuentes,
 * el conjunto no puede ir en paralelo y hay que empezar a agrupar en rondas,
 * porque a partir de cierto punto el orçamento se come solo. Con las cinco de hoy
 * hay margen de sobra y por eso NO se implementa todavía un agrupamiento en rondas.
 *
 * @type {number}
 */
const REQ_TIMEOUT = 20000;

// ════════════════════════════════════════════════════════════════════════════
// RED: EL FETCH
// ════════════════════════════════════════════════════════════════════════════

/**
 * Descarga el JSON de una URL, con timeout y sin reintentos.
 *
 * CERO REINTENTOS, y es una decisión: un reintento multiplica el tiempo en el
 * peor caso (que es el que importa, porque el peor caso es el que se come el
 * `maxDuration`), y con las cinco fuentes en paralelo ya hay redundancia natural:
 * si Remotive falla hay cuatro bolsas más. Un reintento sobre una fuente que
 * vuelve a fallar no agrega información, solo agrega latencia al caso que el
 * usuario ya está esperando.
 *
 * @param {string} url La URL completa, con su query ya armada.
 * @returns {Promise<any>} El JSON parseado.
 * @throws {Error} Lo que tire `fetch` (red caída, `AbortError` por timeout) o un
 *   `Error('HTTP <status>')` si la respuesta no fue 2xx.
 */
async function getJSON(url) {
  // ↑ `AbortController` permite cortar el fetch cuando el timeout se cumple. Sin
  //   él, una bolsa que acepta la conexión y nunca manda el body (que es lo que
  //   hacen las APIs colgadas) deja el request colgado hasta que el plataforma le
  //   corta la invocación, y se lleva por delante las otras cuatro fuentes que sí
  //   iban bien.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    // ↑ Este bloque SIEMPRE corre: limpia el timer aunque haya funcionado o
    //   fallado. Sin esto, cada petición deja un timer de 20 segundos vivo en el
    //   event loop, y con ocho peticiones simultáneas la invocación no puede
    //   terminar a tiempo aunque todas las respuestas hayan llegado. En un
    //   monolito eso era un leak invisible; acá es un 504.
    clearTimeout(timer);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LIMPIEZA DE LOS DATOS CRUDOS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Saca etiquetas HTML, colapsa espacios repetidos y recorta.
 *
 * CUATRO de las cinco bolsas mandan la descripción con HTML adentro, así que sin
 * esto el `description` que ve el usuario es HTML crudo y el texto de la oferta
 * que matchea `textHasSkill` viene con `<p>` pegado a cada palabra.
 *
 * DIFERENCIA CON EL ORIGEN, y es a propósito: el origen era
 * `clean(str = '')`, o sea `clean(null)` devolvía la CADENA `'null'`. El default
 * de parámetro solo corre con `undefined`, así que una bolsa que manda
 * `title: null` (que pasa) producía una oferta titulada "null" que además entraba
 * al ranking y al historial. Acá se usa `asText()` de `text.js`, que convierte
 * null/undefined en `''` y cualquier otra cosa en texto: el resultado es
 * IDÉNTICO para todos los valores que no sean null/undefined, y para esos dos es
 * la respuesta correcta en vez de la letra 'n','u','l'.
 *
 * @param {unknown} str Lo que vino de la bolsa.
 * @returns {string} Texto limpio, o `''`.
 */
function clean(str) {
  return asText(str).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Normaliza una lista de tags a strings limpios y en minúsculas.
 *
 * La forma de los tags es la que el matcher y la UI ya esperan: minúsculas, sin
 * HTML, sin vacíos. Y el `if (!Array.isArray()) return []` no es defensivo por
 * gusto: `job.tags.join(' ')` del origen tiraba `TypeError: job.tags.join is not
 * a function` con las ofertas de Apify (que no traen tags), y el efecto de un
 * TypeError en un `.map` es la búsqueda entera perdida.
 *
 * @param {unknown} arr La lista de tags.
 * @returns {string[]} Tags limpios en minúsculas.
 */
function tagsOf(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((t) => clean(t).toLowerCase())
    .filter(Boolean);
  // ↑ `clean(t)` y no `clean(String(t))`: `clean` ya convierte con `asText`, y
  //   el `String(t)` de adentro era el que producía el `'null'` del punto de
  //   arriba en un tag null.
}

/**
 * El texto de salario legible de una oferta, con min/max y su moneda.
 *
 * @param {object} j La oferta cruda de la bolsa.
 * @returns {string} El texto, o `''` si la bolsa no trae salario.
 */
function firstSalary(j) {
  const lo = j.salary_min ?? j.minSalary;
  const hi = j.salary_max ?? j.maxSalary;
  if (!lo && !hi) return '';
  const cur = j.currency || 'USD';
  return `${cur} ${lo || ''}${hi ? ' - ' + hi : ''}`.trim();
}

/**
 * Une una lista de valores en un string separado por comas, sin romper nunca.
 *
 * El origen hacía `(j.locationRestrictions || []).join(', ')` y eso es un
 * `TypeError` esperando: `locationRestrictions` es un array en la API de
 * Himalayas HOY, pero una bolsa puede mandar `null`, un string o un objeto, y
 * `null` lo cubría el `||` mientras que un string no (`'AR'.join` no existe). Un
 * TypeError adentro del `.map` no tira solo esa oferta: si el `allSettled` de
 * arriba no lo cubre, se lleva la fuente entera.
 *
 * @param {unknown} value La lista (o lo que venga).
 * @returns {string} Los valores unidos, o `''`.
 */
function joinList(value) {
  if (!Array.isArray(value)) return '';
  return value.map((v) => clean(v)).filter(Boolean).join(', ');
}

/**
 * Una fecha de Himalayas a ISO, o `''` si no se puede.
 *
 * Himalayas manda `pubDate` en SEGUNDOS (epoch), no en milisegundos ni en ISO, y
 * por eso el `* 1000`. El origen no chequeaba nada: `new Date('lo que sea')` da
 * una Date inválida y `.toISOString()` sobre una Date inválida tira
 * `RangeError: Invalid time value`, y ese RangeError se llevaba la fuente
 * Himalayas COMPLETA (no una oferta), porque pasaba por el mismo `.map`.
 *
 * @param {unknown} pubDate Epoch en segundos, o cualquier cosa.
 * @returns {string} Fecha ISO, o `''`.
 */
function isoFromEpochSeconds(pubDate) {
  const seconds = Number(pubDate);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const date = new Date(seconds * 1000);
  // ↑ `<= 0` además del `isFinite`: un `0` o un negativo es una fecha válida para
  //   `new Date` (1970) y sería una fecha de publicación de 1970, que es peor que
  //   no tener fecha.
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// IDENTIDAD DETERMINISTA DE UNA OFERTA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Un id estable a partir del CONTENIDO de una oferta.
 *
 * ESTE ES EL ARREGLO DE UN BUG REAL DEL ORIGEN. `jobSources.js:143` del origen
 * hacía `id: \`himalaya-${j.guid || j.slug || Math.random()}\``, y ese
 * `Math.random()` rompía DOS cosas que el usuario ve:
 *
 *   1. La deduplicación del historial NUNCA coincidía. La misma oferta, en la
 *      siguiente búsqueda, llegaba con otro id, así que `recordSearch()` la veía
 *      como nueva: el contador de "vistas nuevas" subía sin parar y `job_history`
 *      crecía con filas duplicadas de ofertas que el usuario ya había visto.
 *   2. El enlace de detalle (`/api/job?q=<id>`) daba 404 al refrescar la página,
 *      porque el id de la URL ya no era el de la fila.
 *
 * Y el modo de falla es el peor: no hay ningún error, la app "funciona", solo
 * que el historial es basura y los links expiran solos.
 *
 * El contenido que se hashea es `title::company::applyUrl`, en ese orden de
 * preferencia, y con la descripción como último recurso. Lo que NO se hace es
 * hashear la fecha: `pubDate` cambia cuando la bolsa renueva una oferta, y con la
 * fecha dentro del id la oferta sería "otra" cada vez que la renuevan.
 *
 * POR QUÉ UN HASH PROPIO Y NO `crypto`: son 30 líneas de aritmética de enteros
 * y da ~64 bits, contra ~256 bits de un SHA. La diferencia importa solo para un
 * adversario que quisiera colar 2^32 ofertas crafted para chocar ids, y con 5
 * bolsas y un feed de ~1000 ofertas la probabilidad de una colisión natural es
 * de ~10^-14. A cambio, `crypto` agrega un builtin de Node a un módulo que hoy
 * es JS puro importable desde el navegador, y el id queda de 13 caracteres en vez
 * de 40 (los ids van en la URL).
 *
 * @param {...unknown} parts Las partes que identifican la oferta.
 * @returns {string} Hash en base36, determinista.
 */
function stableKey(...parts) {
  const text = parts.map((part) => asText(part)).join('::');
  // ↑ Dos hashes FNV-1a de 32 bits con semillas distintas, concatenados en base36.
  //   Uno solo daría 32 bits: con 1000 ofertas, la chance de que dos colisionen
  //   es ~10^-4, que es baja pero no despreciable, y el costo de la segunda vuelta
  //   es la mitad de un módulo.

  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
  // ↑ `>>> 0` en cada vuelta porque `Math.imul` devuelve un entero CON SIGNO de 32
  //   bits: sin el `>>> 0`, el acumulador se vuelve negativo en la segunda vuelta y
  //   `toString(36)` produce un string con signo menos, que es feo pero más
  //   importante: dos textos distintos con el mismo hash firmado siguen teniendo
  //   el mismo string, así que la deduplicación aguanta igual. El `>>> 0` está
  //   porque el id se muestra y se compara en tests, y un id con `-` adentro es
  //   una sorpresa.
}

/**
 * El id interno de una oferta, con el prefijo de la bolsa.
 *
 * El `id` oficial de la bolsa gana SIEMPRE. Cuando no viene (o viene vacío), se
 * deriva del contenido con `stableKey`. El origen en ese caso interpolaba
 * `undefined` o `Math.random()`, y las dos opciones están mal: `'arbeitnow-
 * undefined'` hace que TODAS las ofertas sin id de esa bolsa sean la misma (una
 * se muestra y las demás desaparecen en la deduplicación), y `Math.random()`
 * rompe el historial, que es lo que se explica arriba.
 *
 * Se aplica igual en las cinco bolsas y no solo en Himalayas, y es el mismo
 * criterio: una bolsa que cambió su formato y dejó de mandar el identificador no
 * tiene por qué romper el historial entero de la app.
 *
 * @param {string} prefix El prefijo de la bolsa ('remotive', 'himalaya'...).
 * @param {unknown} rawId El identificador oficial, si viene.
 * @param {object} job La oferta ya normalizada, para el contenido.
 * @returns {string} El id interno.
 */
function jobIdOf(prefix, rawId, job) {
  const official = asText(rawId).trim();
  if (official) return `${prefix}-${official}`;
  return `${prefix}-${stableKey(job?.title, job?.company, job?.applyUrl, job?.description)}`;
  // ↑ La descripción va de último recurso, pero está en la lista igual: si el
  //   título, la empresa y la URL vinieran vacíos, sin ella las ofertas con
  //   `title: ''` colapsarían todas en el mismo id.
}

// ════════════════════════════════════════════════════════════════════════════
// DEDUPLICACIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Clave de deduplicación entre bolsas: mismo título + misma empresa.
 *
 * Misma oferta publicada en dos bolsas es el caso NORMAL, no el raro (las cuatro
 * bolsas remotas se pisan entre sí), y sin esto el usuario ve la misma vacante
 * cuatro veces con cuatro botones.
 *
 * OJO CON LA LIMITACIÓN CONOCIDA de este regex, y se documenta en vez de
 * cambiarlo porque el resto del sistema (el historial) usa la misma clave: el
 * `[^a-z0-9:]+` saca los caracteres que no son letras ASCII, así que "atención" y
 * "atencion" dan la MISMA clave (seNworalmente es lo que se quiere) pero dos
 * ofertas con títulos en otro sistema de escritura dan la clave `'::'` entre
 * ellas, y la segunda desaparece. Es un costo aceptable y consciente para el
 * alcance actual (bolsas en español/inglés); si alguna vez hay que arreglarlo, el
 * lugar es acá y el de `history.js`, y los dos a la vez.
 *
 * @param {object} job Oferta ya normalizada.
 * @returns {string} La clave.
 */
function dedupeKey(job) {
  return `${job.title}::${job.company}`.toLowerCase().replace(/[^a-z0-9:]+/g, ' ').trim();
}

// ════════════════════════════════════════════════════════════════════════════
// LAS CINCO FUENTES
//
// Cada fetcher devuelve `{ jobs, online }` y NUNCA tira: se traga sus propios
// errores y avisa con `console.warn`. La razón de que devuelvan las dos cosas y
// no un array pelado está en el JSDoc de `fetchJobs`.
//
// El shape de una oferta normalizada, y NO SE CAMBIA (ver la cabecera del
// archivo): `{ id, source, title, company, location, regionGuess, applyUrl,
// description, tags, salary, date }`.
// ════════════════════════════════════════════════════════════════════════════

/* ------------------------------ 1. Remotive ------------------------------- */

/**
 * Cuántos términos se le mandan a Remotive.
 *
 * Remotive es la única de las cinco que abre UNA PETICIÓN POR TÉRMINO, así que
 * acá el número es un presupuesto de red y no un detalle: son peticiones
 * simultáneas que compiten por el mismo socket y por el rate limit de la bolsa.
 *
 * El origen mandaba 5 porque tenía 5 términos fijos, currados uno por uno para QA.
 * Ahora los términos salen del perfil y el primero es el título, que vale más
 * que los otros cuatro juntos: 3 peticiones bien elegidas traen más ofertas
 * útiles que 5 con dos términos repetidos del mismo puesto.
 *
 * @type {number}
 */
const REMOTIVE_MAX_TERMS = 3;

/**
 * Remotive: bolsa remota que acepta búsqueda por texto (`?search=`).
 *
 * @param {string[]} terms Los términos del perfil.
 * @returns {Promise<{jobs: object[], online: boolean}>}
 */
async function fetchRemotive(terms) {
  // ↑ Si NO hay término (perfil sin nada usable) se hace UNA petición SIN el
  //   parámetro `search`, que es lo que devuelve el catálogo completo. Es la
  //   misma decisión que en Jobicy y por el mismo motivo: si un usuario sin
  //   términos fijos se queda sin resultados de esta bolsa, y no es que no
  //   haya ofertas, es que la app decidió no preguntar. La respuesta va a
  //   matchearse contra su perfil igual, así que lo que no le sirve se descarta
  //   sola, del lado del matcher.
  const queries = terms.length ? terms.slice(0, REMOTIVE_MAX_TERMS) : [''];

  const results = await Promise.allSettled(
    queries.map((term) =>
      getJSON(`https://remotive.com/api/remote-jobs${term ? `?search=${encodeURIComponent(term)}` : ''}`),
    ),
  );

  const seen = new Set();
  const jobs = [];
  let online = false;

  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.warn('[job-sources] Remotive no respondió (%s): %s', queries[i] || 'sin término', errMessage(r.reason));
      return;
    }
    online = true;
    // ↑ `online` se pone por PETICIÓN y no por fuente, y por eso el `allSettled`
    //   de adentro: Remotive abre tres peticiones, y si las tres fallan tiene
    //   que decir "no se pudo contactar Remotive". Si el `online` se calculara
    //   arriba, con este diseño, Remotive habría devuelto `[]` y parecería
    //   "respondió y no había nada", que es una mentira que el usuario ve como
    //   "no hay ofertas".
    for (const j of (r.value && r.value.jobs) || []) {
      if (!j || seen.has(j.id)) continue;
      seen.add(j.id);
      const job = mapRemotiveJob(j);
      if (job) jobs.push(job);
    }
  });

  return { jobs, online };
}

/**
 * Remotive crudo → shape interno.
 *
 * @param {object} j La oferta de la API.
 * @returns {object|null} La oferta normalizada, o null si no tiene título.
 */
function mapRemotiveJob(j) {
  const title = clean(j.title);
  // ↑ Una oferta sin título no se puede mostrar ni matchear: el título es la
  //   primera mitad de la clave de deduplicación y lo que el usuario ve en la
  //   tarjeta. Se descarta acá, una sola vez, en vez de dejarlo para que cada
  //   fuente lo resuelva distinto.
  if (!title) return null;

  return {
    id: jobIdOf('remotive', j.id, { title, company: clean(j.company_name), applyUrl: j.url || j.application_url || '' }),
    source: 'Remotive',
    title,
    company: clean(j.company_name),
    location: clean(j.candidate_required_location) || 'Remote',
    // ↑ El 'Remote' de acá es el del ORIGEN y se conserva: `regions.js` trata
    //   "remote" como una palabra de trabajo remoto y lo mete en el bucket, y una
    //   ubicación vacía también entraría (regla 4), pero con `location: ''` la
    //   tarjeta no muestra dónde es y el usuario no puede filtrar por lugar.
    regionGuess: '',
    applyUrl: j.url || j.application_url || '',
    description: clean(j.description),
    tags: tagsOf(j.tags),
    salary: clean(j.salary),
    // ↑ `salary` de Remotive es TEXTO libre ("$100k - $150k"), no dos números,
    //   así que va por `clean` y no por `firstSalary`. Es el único caso así entre
    //   las cinco bolsas.
    date: j.publication_date || '',
  };
}

/* ----------------------------- 2. Arbeitnow ------------------------------- */

/**
 * Arbeitnow: portal de empleo dev con foco en Europa (páginas de ~100 ofertas).
 *
 * NO tiene parámetro de búsqueda: trae un listado y se filtra del lado del
 * matcher. Se piden 2 páginas, que son ~200 ofertas, y con eso alcanza: la API no
 * pagina más (el origen también pedía 2) y pedir más páginas por la misma bolsa es
 * traer la misma oferta repetida con distinto `created_at` en algunos casos.
 *
 * @returns {Promise<{jobs: object[], online: boolean}>}
 */
async function fetchArbeitnow() {
  const pages = await Promise.allSettled([
    getJSON('https://www.arbeitnow.com/api/job-board-api'),
    getJSON('https://www.arbeitnow.com/api/job-board-api?page=2'),
  ]);

  const jobs = [];
  let online = false;

  pages.forEach((p, i) => {
    if (p.status !== 'fulfilled' || !Array.isArray(p.value?.data)) {
      console.warn('[job-sources] Arbeitnow no respondió (página %d): %s', i + 1, errMessage(p.reason));
      return;
    }
    online = true;
    for (const j of p.value.data) {
      const job = mapArbeitnowJob(j);
      if (job) jobs.push(job);
    }
  });

  return { jobs, online };
}

/**
 * Arbeitnow crudo → shape interno.
 *
 * @param {object} j La oferta de la API.
 * @returns {object|null} La oferta normalizada, o null si no tiene título.
 */
function mapArbeitnowJob(j) {
  const title = clean(j.title);
  if (!title) return null;

  const company = clean(j.company_name);
  const applyUrl = j.url || `https://www.arbeitnow.com/jobs/${j.slug || ''}`;
  // ↑ El `|| ''` del final: el origen interpolaba `j.slug` sin más y producía
  //   'https://www.arbeitnow.com/jobs/undefined', que es un link que lleva a un
  //   404 con el nombre del portal puesto. Un link inútil es peor que ninguno:
  //   el frontend muestra "buscar en Arbeitnow" con ese link cuando `applyUrl`
  //   está vacío.

  return {
    id: jobIdOf('arbeitnow', j.slug || j.id, { title, company, applyUrl }),
    source: 'Arbeitnow',
    title,
    company,
    location: clean(j.location),
    regionGuess: '',
    applyUrl,
    description: clean(j.description),
    tags: tagsOf(j.tags),
    salary: firstSalary(j),
    date: j.created_at || '',
  };
}

/* ----------------------------- 3. Himalayas ------------------------------- */

/**
 * Himalayas: ofertas remotas globales, con búsqueda por texto (`?q=`).
 *
 * @param {string[]} terms Los términos del perfil.
 * @returns {Promise<{jobs: object[], online: boolean}>}
 */
async function fetchHimalayas(terms) {
  const term = primaryTerm(terms);
  // ↑ UNA sola petición y UN solo término: la API acepta un `?q=` solo. Es
  //   `primaryTerm` y no `terms[0] || terms[1]` porque el primero es el título del
  //   perfil, y para esta bolsa en particular el título es la búsqueda correcta:
  //   su índice es de puestos completos, no de skills sueltas.
  const url = `https://himalayas.app/jobs/api/search?limit=20${term ? `&q=${encodeURIComponent(term)}` : ''}`;

  let data;
  try {
    data = await getJSON(url);
  } catch (err) {
    console.warn('[job-sources] Himalayas no respondió (%s): %s', term || 'sin término', errMessage(err));
    return { jobs: [], online: false };
  }

  const jobs = [];
  for (const j of (data && data.jobs) || []) {
    const job = mapHimalayasJob(j);
    if (job) jobs.push(job);
  }

  return { jobs, online: true };
  // ↑ `true` porque LLEGÓ una respuesta con la forma esperada. Que `.jobs` venga
  //   vacío significa "su búsqueda no tiene resultados", que es un hecho distinto
  //   del que nos dice el aviso de arriba.
}

/**
 * Himalayas crudo → shape interno.
 *
 * @param {object} j La oferta de la API.
 * @returns {object|null} La oferta normalizada, o null si no tiene título.
 */
function mapHimalayasJob(j) {
  const title = clean(j.title);
  if (!title) return null;

  const company = clean(j.companyName || j.company);
  const applyUrl = j.applicationLink || j.url || '';

  return {
    // ↑ AQUÍ ESTÁ EL ARREGLO: el origen caía a `Math.random()` y con eso
    //   rompía el historial y los links de detalle. Ver `stableKey`.
    id: jobIdOf('himalaya', j.guid || j.slug, { title, company, applyUrl, description: clean(j.description) }),
    source: 'Himalayas',
    title,
    company,
    location: joinList(j.locationRestrictions) || clean(j.city) || 'Remote',
    regionGuess: '',
    applyUrl,
    description: clean(j.description),
    tags: tagsOf(j.categories || j.tags),
    salary: firstSalary(j),
    date: isoFromEpochSeconds(j.pubDate),
  };
}

/* ------------------------------ 4. RemoteOK ------------------------------- */

/**
 * Cuántas ofertas se toman del feed de RemoteOK.
 *
 * RemoteOK NO tiene parámetro de búsqueda: devuelve el feed COMPLETO. Y acá está
 * el problema que el origen no tenía: como el filtro local de QA se va (le
 * sobraba a este proyecto), el feed deja de ser "el feed entero que después
 * filtro" y pasa a ser "el feed entero que me devuelvo". Medido en la corrida de
 * este módulo, el feed trae del orden de **900 ofertas y varios MB de JSON** (la
 * descarga ya ocurre igual, no hay forma de pedir menos), y cada una de esas
 * ofertas después hay que limpiarla (`clean` sobre una descripción de varios KB),
 * meterla en el texto normalizado y compararla contra CADA skill del usuario: con
 * 40 skills son 36.000 comparaciones de regex que después se tiran a la basura
 * porque el `rankByRegion` descarta toda oferta con score 0.
 *
 * 150 es el corte, y el número sale de dos restricciones a la vez:
 *   · Es lo que el usuario llega a leer. El listado muestra las mejores de cada
 *     región y hay paginación; 150 ofertas del RemoteOK contra las otras cuatro
 *     bolsas no cambian una pantalla.
 *   · Es lo que cubre "lo fresco". El feed viene ordenado de más nuevo a más
 *     viejo, así que las 150 primeras son las últimas semanas, que es el
 *     horizonte útil de una oferta remota.
 *
 * Subirlo a 500 no agrega nada visible y triplica el trabajo inútil; bajarlo a 20
 * deja la fuente inservible para un perfil con muchas skills. Y NO se sube el
 * corte "por las dudas": la descarga del feed completo ya está hecha y es el
 * costo irreducible de esta bolsa, no la limpieza.
 *
 * @type {number}
 */
const REMOTEOK_LIMIT = 150;

/**
 * RemoteOK: feed remoto global, SIN búsqueda.
 *
 * @param {string[]} terms Los términos del perfil, para el filtro LOCAL.
 * @returns {Promise<{jobs: object[], online: boolean}>}
 */
async function fetchRemoteOK(terms) {
  let data;
  try {
    data = await getJSON('https://remoteok.com/api');
  } catch (err) {
    console.warn('[job-sources] RemoteOK no respondió: %s', errMessage(err));
    return { jobs: [], online: false };
  }

  if (!Array.isArray(data)) {
    console.warn('[job-sources] RemoteOK respondió 200 con un cuerpo que no es una lista.');
    return { jobs: [], online: false };
  }

  // El feed arranca con un aviso legal que no tiene `id`: sin este corte se
  // mapearía como una oferta sin empresa y con `remoteok-undefined` de id.
  const feed = data.filter((j) => j && j.id);

  const head = feed.slice(0, REMOTEOK_LIMIT);
  const jobs = [];
  for (const j of head) {
    const job = mapRemoteOKJob(j);
    // ↑ Se descarta acá y no al final: el filtro de términos (que es lo que
    //   reemplaza al `BASE_KEYWORDS` del origen) se aplica sobre la lista YA
    //   recortada, así que las 750 ofertas que no llegan a `head` no cuestan ni
    //   un `jobText` ni un `clean`.
    if (job && matchesAnyTerm(jobText(job), terms)) jobs.push(job);
  }

  return { jobs, online: true };
}

/**
 * RemoteOK crudo → shape interno.
 *
 * @param {object} j La oferta del feed.
 * @returns {object|null} La oferta normalizada, o null si no tiene título.
 */
function mapRemoteOKJob(j) {
  const title = clean(j.position);
  // ↑ `position`, no `title`: así las llama la API de RemoteOK.
  if (!title) return null;

  const company = clean(j.company);
  const applyUrl = j.url ? `https://remoteok.com${j.url}` : (j.apply_url || '');
  // ↑ `j.url` es un PATH relativo ('/remote-jobs/12345'), no una URL. Concatenar
  //   es correcto y es lo que hacía el origen. `apply_url` sí es absoluta, y es
  //   el campo que usa RemoteOK cuando la oferta está en su propio sitio.

  return {
    id: jobIdOf('remoteok', j.id, { title, company, applyUrl }),
    source: 'RemoteOK',
    title,
    company,
    location: clean(j.location) || 'Remote',
    regionGuess: '',
    applyUrl,
    description: clean(j.description),
    tags: tagsOf(j.tags),
    salary: firstSalary(j),
    date: j.date || '',
  };
}

/* ------------------------------- 5. Jobicy -------------------------------- */

/**
 * Jobicy: bolsa remota con filtro por tag en la URL (`?tag=`).
 *
 * El `tag` es un ÍNDICE, no texto libre: tiene que ser una palabra que exista como
 * categoría en el catálogo de Jobicy. Por eso va el TÍTULO del perfil (lo más
 * parecido a un nombre de categoría que hay) y no el nombre de una skill.
 *
 * Y el `tag` tiene un MÍNIMO DE 3 CARACTERES, que es la única cosa que puede
 * hacer que esta bolsa se pierda entera. Ver la nota del largo, más abajo.
 *
 * @param {string[]} terms Los términos del perfil.
 * @returns {Promise<{jobs: object[], online: boolean}>}
 */
async function fetchJobicy(terms) {
  const term = primaryTerm(terms);
  // ↑ Igual que Himalayas: un solo `?tag=`. Y sale de `primaryTerm`, o sea del
  //   TÍTULO del perfil, que es lo más cercano a un nombre de categoría del
  //   índice. NO se manda el nombre de una skill ("Postgres") aunque el título
  //   no sirva: ese no existe como categoría, así que el `tag` devuelve 200 con
  //   lista vacía, que NO es una caída (la bolsa está viva: simplemente no tiene
  //   nada de eso) y sí es una bolsa perdida para ese usuario.

  // EL MÍNIMO DE 3 CARACTERES POR `tag`, MEDIDO contra la API real y no de
  // manual. Son DOS REGLAS DISTINTAS, y el bug era no verlas separadas:
  //
  //   tag=qa      (2) → HTTP 400                    ← la bolsa RECHAZA la consulta
  //   tag=go      (2) → HTTP 400
  //   tag=ai      (2) → HTTP 400
  //   tag=dev     (3) → HTTP 200  jobCount=50
  //   tag=zzz     (3) → HTTP 200  jobCount=0
  //   tag=xyzzy   (5) → HTTP 200  jobCount=0
  //   tag=nurse   (6) → HTTP 200  jobCount=1
  //
  // O sea que un tag INEXISTENTE NO es un error: es una lista vacía con la bolsa
  // viva, y ese caso hay que dejarlo pasar (no "arreglarlo" buscando el tag más
  // parecido). Lo único que rompe la bolsa es el tag CORTO, y el caso es
  // REALISTA y no un borde: "QA" o "QA Engineer" colapsa a `qa`, "Desarrollador
  // Go" a `go`, "Developer JS" a `js`, "Analista AI" a `ai`. `collapseTerm` tiene
  // un piso de 2 caracteres, o sea que el título de un usuario puede ser
//   perfectamente válido y quedar CORTO para esta bolsa.
  //
  // EL ARREGLO ES DEGRADAR, NO RESISTIR: con un término corto se pide el catálogo
  // entero (que es lo que ya hace la rama sin término). Se pierde el FILTRO y no
  // la BOLSA, y el filtro lo puede rehacer `matcher` del lado del cliente, donde
  // un tag de 2 letras no cuesta un 400.
  const tag = term.length >= 3 ? `&tag=${encodeURIComponent(term)}` : '';
  // ↑ `term.length` sin `typeof` ni `String()`: `primaryTerm` devuelve SIEMPRE
  //   un string (`collapseTerm` devuelve `''` si no hay término), así que el
  //   `''` cae por el largo y nunca llega un `undefined.length`. El
  //   `encodeURIComponent` está DENTRO de la rama larga a propósito: si el tag no
  //   se manda, no hay nada que escapar.

  const url = `https://jobicy.com/api/v2/remote-jobs?count=50${tag}`;
  // ↑ Interpolar `${tag}` y no `${term ? '...' : ''}`: el caso "sin término" y el
  //   caso "término demasiado corto" tienen que producir EXACTAMENTE la misma
//   URL que la consulta sin filtro (`?count=50`), y con un solo `tag` las dos
  //   quedan idénticas sin duplicar la condición.

  // POR QUÉ EL `catch` DE ABAJO SIGUE DIENDO `online: false`, y por qué NO se
  // "arregla" mapeando el 400 a bolsa sana: un 400 puede ser cualquier cosa (query
  // mal armada, parámetro desconocido, cuota) y no se midió que significara "estoy
  // viva". Mapearlo sería una regla NUEVA y sin verificar, y una regla sin
  // verificar en un valor que el frontend le muestra al usuario ("no pudimos
  // contactar las bolsas") es peor que un `false` honesto. Con la guarda de 3
  // caracteres el 400 de ESTE caso desaparece, así que la semántica no hace falta.
  // Tampoco se reintenta: `getJSON` no reintenta por diseño (su propio JSDoc), y
  // con las cinco bolsas en paralelo ya hay redundancia. El arreglo era una línea
  // de lógica, no una política de reintentos.
  let data;
  try {
    data = await getJSON(url);
  } catch (err) {
    console.warn('[job-sources] Jobicy no respondió (%s): %s', term || 'sin término', errMessage(err));
    return { jobs: [], online: false };
  }

  const jobs = [];
  for (const j of (data && data.jobs) || []) {
    const job = mapJobicyJob(j);
    if (job) jobs.push(job);
  }

  return { jobs, online: true };
}

/**
 * Jobicy crudo → shape interno.
 *
 * @param {object} j La oferta de la API.
 * @returns {object|null} La oferta normalizada, o null si no tiene título.
 */
function mapJobicyJob(j) {
  const title = clean(j.jobTitle);
  if (!title) return null;

  return {
    id: jobIdOf('jobicy', j.id, { title, company: clean(j.companyName) }),
    source: 'Jobicy',
    title,
    company: clean(j.companyName),
    location: clean(j.jobGeo) || 'Remote',
    regionGuess: '',
    applyUrl: j.url || '',
    description: clean(j.jobExcerpt || j.jobDescription),
    // ↑ `jobExcerpt` (el resumen corto) tiene prioridad sobre `jobDescription`
    //   porque es lo que la bolsa considera relevante para el listado, y es lo
    //   bastante corto para matchear sin arrastrar 8 KB de HTML de un
    //   `jobDescription` que además incluye el pie de la bolsa.
    tags: tagsOf(j.jobIndustry || j.jobType),
    salary: (j.annualSalaryMin || j.annualSalaryMax)
      ? `${j.salaryCurrency || 'USD'} ${j.annualSalaryMin || ''}${j.annualSalaryMax ? ' - ' + j.annualSalaryMax : ''}`.trim()
      : '',
    // ↑ Salario propio y no `firstSalary`: Jobicy manda `annualSalaryMin` /
    //   `annualSalaryMax` con otra moneda (`salaryCurrency`) y el nombre distinto,
    //   y forzarlo por `firstSalary` devolvería SIEMPRE `''` porque no hay
    //   `salary_min` ni `minSalary` en su formato.
    date: j.pubDate || '',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// EL AGREGADOR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Las cinco fuentes, con su NOMBRE para los logs.
 *
 * El nombre no es decorativo: es lo único que hace útil un `console.warn` de una
 * bolsa caída. El origen los descartaba en silencio y cuando Remotive devolvía 500
 * el síntoma era "la búsqueda vino con menos ofertas" sin forma de saber cuál
 * bolsa era. Con el nombre, un `grep '[job-sources]'` en el log de Vercel dice
 * qué bolsa está caída sin tener que reproducirlo.
 *
 * @type {ReadonlyArray<{name: string, run: (terms: string[]) => Promise<{jobs: object[], online: boolean}>}>}
 */
const SOURCES = [
  { name: 'Remotive', run: fetchRemotive },
  { name: 'Arbeitnow', run: fetchArbeitnow },
  { name: 'Himalayas', run: fetchHimalayas },
  { name: 'RemoteOK', run: fetchRemoteOK },
  { name: 'Jobicy', run: fetchJobicy },
];

/**
 * Consulta las cinco bolsas gratuitas y devuelve las ofertas deduplicadas.
 *
 * EL CONTRATO DEVUELVE `{ jobs, online }` Y NO UN ARRAY, y el motivo es que
 * "las bolsas respondieron y no hay ofertas que te sirvan" y "no pudimos
 * contactar a ninguna bolsa" son dos hechos DISTINTOS que el usuario vive
 * distinto:
 *
 *   · `online: true, jobs: []`  → las bolsas respondieron y no hay nada para vos. Se
 *     dice "no encontramos ofertas" y se puede buscar con otros términos.
 *   · `online: false, jobs: []` → no se sabe si hay. Se dice "no pudimos
 *     consultar las bolsas" y reintentar tiene sentido.
 *
 * `online` NO se deriva de `jobs.length`, y esa es la parte importante: si se
 * derivara, una bolsa que responde 200 con cero resultados para el término del
 * usuario se reportaría como caída, y el frontend le diría al usuario que las
 * bolsas están rotas cuando en realidad le respondieron que no hay nada. Al revés
 * también duele: con `jobs.length > 0` nunca se puede expresar "trajo 300 ofertas
 * crudas y después el filtro de región dejó 0".
 *
 * `@param {object|null} [profile]` El perfil del usuario. Los términos de búsqueda
 *   salen de acá (ver `searchTerms`), y es un perfil y no una lista de términos
 *   para que el endpoint no tenga que saber cómo se derivan ni cuántos quiere cada
 *   bolsa. Como en el resto del proyecto (`computeMatch(job, profile)`), el perfil
 *   es un PARÁMETRO y no un import: `null` es un estado válido (un usuario sin CV)
 *   y lo que se hace en ese caso es consultar sin término, que es una búsqueda
 *   real.
 *
 * @param {{terms?: string[], maxTerms?: number}} [options]
 *   · `terms`: fuerza la lista de términos y salta la derivación del perfil. Es
 *     para el que ya las tiene (tests, o un endpoint con un criterio propio), y
 *     evita tener que armar un perfil falso para probar la red.
 *   · `maxTerms`: cuántos términos derivar del perfil (default 5, el de
 *     `searchTerms`). Remotive se queda con los primeros 3 igual, por su propio
 *     presupuesto de peticiones.
 *
 * @returns {Promise<{jobs: object[], online: boolean}>} Las ofertas y si al menos
 *   una bolsa respondió. NUNCA tira: `Promise.allSettled` y los `try/catch` de
 *   cada fuente garantizan que una bolsa caída no se lleve la búsqueda entera.
 *   Un error acá sería un 500 en `/api/jobs` por culpa de una API de terceros, y
 *   eso es exactamente lo que hace que las otras cuatro no sirvan de nada.
 */
export async function fetchJobs(profile = null, options = {}) {
  const terms = Array.isArray(options?.terms)
    ? options.terms.map((t) => asText(t)).filter(Boolean)
    : searchTerms(profile, { max: options?.maxTerms });

  const settled = await Promise.allSettled(SOURCES.map((source) => source.run(terms)));
  // ↑ Las cinco EN PARALELO. Es lo que hace que el tiempo total sea el de la más
  //   lenta (20 s, el `REQ_TIMEOUT`) en vez de la suma, y lo que hace que una
  //   bolsa caída no affecte a las otras. El `allSettled` de arriba es la red de
  //   seguridad para errores NO previstos (un `.map` que revienta por un dato
  //   raro que no se contempló); los errores previstos los maneja cada fuente,
  //   porque cada una necesita poder decir en su `console.warn` qué petición
  //   fue la que falló.

  const seen = new Set();
  const jobs = [];
  let online = false;

  settled.forEach((result, i) => {
    if (result.status !== 'fulfilled' || !result.value || typeof result.value !== 'object') {
      console.warn('[job-sources] %s tiró una excepción no prevista: %s', SOURCES[i].name, errMessage(result.reason));
      return;
    }
    if (result.value.online) online = true;

    for (const job of result.value.jobs || []) {
      if (!job || typeof job !== 'object') continue;
      const key = dedupeKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
      // ↑ Deduplicación por título+empresa y NO por `id`, porque el `id` incluye
      //   el prefijo de la bolsa: la misma oferta en Remotive y en RemoteOK tiene
      //   dos `id` distintos y aparecería dos veces. La clave es el último corte,
      //   después de las cinco fuentes, así que el orden de los buckets no decide
      //   cuál gana: gana la primera que se recorrió, que es siempre la misma
      //   (el orden de `SOURCES`), así que tampoco varies entre requests.
    }
  });

  return { jobs, online };
}

// ════════════════════════════════════════════════════════════════════════════
// Ayudantes
// ════════════════════════════════════════════════════════════════════════════

/**
 * El mensaje de un error, sin romper si lo que se catcheó no es un Error.
 *
 * `fetch` en Node tira `TypeError` y `DOMException` (el `AbortError` del timeout),
 * y una bolsa puede responder con algo que el driver no sabe parsear y que llega
 * como un string. `err && err.message` con el fallback es lo que evita que el
 * `console.warn` que existe PARA DIAGNOSTICAR sea el que se reviente.
 *
 * @param {unknown} err Lo que se catcheó.
 * @returns {string} Un mensaje, nunca `undefined`.
 */
function errMessage(err) {
  if (!err) return 'error desconocido';
  return asText(err.message || err).slice(0, 200);
  // ↑ Recortado a 200: algunas APIs devuelven el HTML de su página de error
  //   completo en el mensaje, y un solo warn de 40 KB llena el log de Vercel.
}