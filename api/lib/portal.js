// ============================================================================
// PORTAL DE ORIGEN: responde "¿de DÓNDE salió esta oferta?".
//
// El modelo de oferta tenía dos campos de procedencia y ninguno servía:
//   · `source`   → texto libre. En el origen había 44 valores distintos
//                  ('Directo (link)', 'Reclutador (LinkedIn)',
//                  'QA Watcher (via LinkedIn)'...) porque cada curador escribió el
//                  que quiso.
//   · `applyUrl` → adónde POSTULAR, no de dónde se leyó la oferta.
// Lo que faltaba eran los dos campos que el frontend consume:
//   · `portal`    → nombre corto y legible: 'LinkedIn', 'Remotive', 'Arbeitnow',
//                   'Himalayas', 'RemoteOK', 'Jobicy', 'Curada', 'Demo'.
//   · `sourceUrl` → link a la PÁGINA DE BÚSQUEDA de ese portal, para poder volver
//                   a encontrar la oferta (y no la oferta en sí, que puede haber
//                   expirado). Puede ser '' si no se puede deducir.
//
// Este módulo es el ÚNICO lugar donde se decide eso, y se aplica de forma central
// (`enrichJob`/`enrichJobs`/`enrichRegions`) para no editar a mano las entradas de
// cada fuente de ofertas.
//
// MÓDULO SIN IMPORTS, y eso es una GARANTÍA y no un detalle de estilo: no hay
// ningún `import` en todo el archivo, ni de `db.js`, ni de `profile.js`, ni de
// `text.js`. Es el módulo más chico y el que se carga en el camino de TODA
// respuesta con ofertas, así que su grafo de dependencias tiene que ser vacío. Si
// algún día hace falta `normalize()` o `escapeReg()` de acá, se copia el patrón
// (son una línea) en vez de agregar un import.
//
// OJO CON EL ALCANCE DEL PROYECTO (solo Argentina): que en las tablas estén
// `Indeed`, `InfoJobs`, `Glassdoor`, `Computrabajo` y `OCC` (que es de Francia)
// NO es una contradicción con el alcance. `portal` responde de dónde vio la
// oferta el usuario, no dónde está el puesto: si una bolsa de España trae una
// oferta remota alcanzable, la oferta entra al bucket (eso lo decide
// `regions.js:matchRegion`, NO este archivo) y su badge dice "Indeed", que es
// honesto. Lo que este archivo no puede hacer es cambiar el RANKING, y no lo
// hace: no toca `location`, ni `region`, ni el score.
//
// Las 12 entradas de `PORTAL_PATTERNS` se conservan tal cual del origen. Los
// casos con riesgo de falso positivo (`OCC`, `Demo`) usan límites de palabra en
// vez de un substring suelto: 'occ' aparece adentro de 'occupational' o de
// cualquier host que lo contenga de pasada.
// ============================================================================

/**
 * ORDEN de detección: gana la PRIMERA coincidencia.
 *
 * LinkedIn va primero a propósito, porque es el portal que más formas distintas
 * toma en el campo `source` ('Reclutador (LinkedIn)', 'Capgemini (LinkedIn)',
 * 'QA Watcher (via LinkedIn)'): todas son, de hecho, ofertas de LinkedIn.
 *
 * Cada entrada es un regex que se prueba contra `source` + `applyUrl`. El orden
 * importa también entre las bolsas: `remote[\s-]?ok` antes que... no, no hay
 * ambigüedad real entre las cinco bolsas gratuitas, pero el orden hace que el
 * archivo sea determinista si mañana se agrega una que se parezca a otra.
 *
 * @type {ReadonlyArray<{portal: string, re: RegExp}>}
 */
export const PORTAL_PATTERNS = [
  { portal: 'LinkedIn', re: /linkedin/i },
  { portal: 'Remotive', re: /remotive/i },
  { portal: 'Arbeitnow', re: /arbeitnow/i },
  { portal: 'Himalayas', re: /himalayas/i },
  { portal: 'RemoteOK', re: /remote[\s-]?ok/i },
  { portal: 'Jobicy', re: /jobicy/i },
  { portal: 'Computrabajo', re: /computrabajo/i },
  { portal: 'Indeed', re: /indeed/i },
  { portal: 'InfoJobs', re: /infojobs/i },
  { portal: 'Glassdoor', re: /glassdoor/i },
  { portal: 'OCC', re: /(?:^|[^a-z0-9])occ(?:[^a-z0-9.]|$)|occ\.fr|observatoire/i },
  { portal: 'Demo', re: /(?:^|[^a-z0-9])demos?(?:[^a-z0-9]|$)|simulad|demostrativ/i },
];

/**
 * Valor por defecto SEGURO: si no se reconoce la procedencia, la oferta se
 * considera curada a mano.
 *
 * Es el mejor default porque NUNCA miente. Una oferta sin portal identificado sí
 * viene de una bolsa propia, de un mail o de un link que pasó alguien, no de
 * LinkedIn ni de Remotive. El default alternativo ("la última bolsa conocida")
 * produce un badge FALSO, que es el peor default posible en algo que el usuario
 * usa para decidir a dónde va a postear.
 *
 * @type {string}
 */
export const DEFAULT_PORTAL = 'Curada';

/**
 * URL de BÚSQUEDA por texto, a la que se le pega la query escapada.
 *
 * De las 12 bolsas detectadas, SOLO Remotive expone un parámetro de búsqueda por
 * texto en la URL. No es que las otras no tengan buscador: es que no hay un
 * parámetro que se pueda adivinar sin inventarlo, y pegarle la query al final de
 * un listado produce una URL rota que el usuario descubre clickeando. Una URL
 * rota es peor que un listado sin filtro: una lo delata con un error de la
 * plataforma, la otra lo delata con un 404 dentro del mismo portal.
 *
 * @type {Record<string, string>}
 */
export const PORTAL_QUERY_SEARCH = {
  Remotive: 'https://remotive.com/remote-jobs/search?query=',
};

/**
 * URL de listado o home para los portales SIN buscador por texto.
 *
 * Con estas se devuelve la URL tal cual, sin concatenarle nada.
 *
 * @type {Record<string, string>}
 */
export const PORTAL_LISTING = {
  Arbeitnow: 'https://www.arbeitnow.com/',
  Himalayas: 'https://himalayas.app/jobs',
  RemoteOK: 'https://remoteok.com/remote-jobs',
  Jobicy: 'https://jobicy.com/',
  LinkedIn: 'https://www.linkedin.com/jobs/search/',
  Computrabajo: 'https://www.computrabajo.com/',
  Indeed: 'https://www.indeed.com/',
  InfoJobs: 'https://www.infojobs.net/',
  Glassdoor: 'https://www.glassdoor.com/',
  OCC: 'https://www.occ.fr/',
};

// ↑ `Curada` y `Demo` NO están en ninguna de las dos tablas, y es a propósito: son
//   los dos valores sin dónde buscar. Su `sourceUrl` es `''` y el frontend lo
//   maneja (muestra "no hay link" en vez de un botón roto). Agregarles una URL de
//   listado sería inventar un destino.

// ════════════════════════════════════════════════════════════════════════════
// LAS TRES FUNCIONES DEL ORIGEN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Texto con el que se busca la oferta: título + empresa.
 *
 * Se recorta a 120 caracteres porque los títulos largos producen URLs imposibles
 * de mostrar, y de mostrar: en el celular es un `<a>` que se corta y no se puede
 * leer, y la URL larga se come el link en los sitios donde se comparte.
 *
 * @param {object} [job] Oferta.
 * @returns {string} La query, siempre string.
 */
function queryOf(job) {
  // ↑ `job?.` y no un `if (!job) return ''`: la función es puro y se llama con
  //   ofertas incompletas todo el tiempo (una bolsa que mandó `title` y nada más).
  //   Devolver `''` y no tirar es lo que permite que `searchUrlFor` funcione
  //   siempre, que es su contrato.
  return `${job?.title || ''} ${job?.company || ''}`.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Deriva el nombre del portal a partir de `source` y de la URL de postulación.
 *
 * Es una función PURA: no toca el objeto, solo devuelve un string. Se puede
 * llamar en cualquier momento (incluso con una oferta incompleta) y SIEMPRE
 * devuelve algo utilizable.
 *
 * @param {object} [job] Oferta de cualquier fuente. Todos sus campos son
 *   opcionales.
 * @returns {string} El nombre del portal. Nunca `undefined`.
 */
export function portalOf(job) {
  const source = String(job?.source || '');
  const url = String(job?.applyUrl || '');
  // ↑ `source` va PRIMERO y `applyUrl` después: si el source dice LinkedIn pero el
  //   link es de otra bolsa, el patrón de LinkedIn igual gana, y es lo que quiere
  //   el usuario (le importa dónde se encontró la oferta, no dónde está el puesto).
  const haystack = `${source} ${url}`;

  for (const { portal, re } of PORTAL_PATTERNS) {
    if (re.test(haystack)) return portal;
    // ↑ `RegExp.test` con un regex SIN la bandera 'g' no arrastra `lastIndex`
    //   entre llamadas. Si algún día alguien le agrega 'g' a uno de estos
    //   patrones, este `if` empieza a devolver resultados alternados (una vez sí,
    //   una vez no) según cuántas ofertas se procesaron antes: es el bug clásico
    //   de `lastIndex` y se ve como "el portal se pierde cada cierta cantidad".
  }

  if (source.includes('#')) return 'Demo';
  // ↑ El '#' SOLO se mira en `source` (nunca en la URL) para no inventar un
  //   portal a partir de un ancla de navegación como '.../oferta#postular'. En
  //   `source` sí tiene sentido: es la forma que el origen usaba para marcar
  //   "esto es de mentira".
  return DEFAULT_PORTAL;
}

/**
 * Arma el link con el que se puede volver a buscar la oferta en su portal.
 *
 * NO es la URL de la oferta: es la página de resultados de una búsqueda que, muy
 * probablemente, la vuelva a listar. Para los portales sin buscador por texto
 * devuelve la home/listado, y para los que no tienen dónde buscar (`Demo`,
 * `Curada`) devuelve `''`.
 *
 * Las cuatro prioridades, en orden:
 *   1. `job.sourceUrl` si ya viene. Gana siempre, porque hay ofertas cuyo link de
 *      búsqueda se arma con los filtros REALES con los que se encontró la oferta
 *      (es el caso de las de Apify, que se scrapean con un query concreto). Es un
 *      link mejor que cualquiera de los que se pueden adivinar acá, así que
 *      inventar uno por encima sería perder información.
 *   2. LinkedIn: URL + `searchParams`, con la query y el lugar.
 *   3. `PORTAL_QUERY_SEARCH`: base + query escapada.
 *   4. `PORTAL_LISTING` o `''`.
 *
 * @param {object} [job] Oferta.
 * @returns {string} La URL de búsqueda, o `''` si no hay dónde buscar.
 */
export function searchUrlFor(job) {
  if (job?.sourceUrl) return job.sourceUrl;

  const portal = job?.portal || portalOf(job);

  if (portal === 'LinkedIn') {
    // ↑ `URL` + `searchParams` en vez de concatenar: él escapa los acentos, los
    //   espacios y los `&`, que en un título de oferta aparecen SIEMPRE. Un
    //   título con "R&D" concatenado a mano rompe la URL en el primer `&`.
    const url = new URL(PORTAL_LISTING.LinkedIn);
    // ↑ `new URL` y no `URL.canParse` + try/catch: la base es una constante de
    //   este archivo, así que si fallara el error sería de programación y tiene
    //   que verse. El que puede fallar es el PARÁMETRO, y `searchParams.set`
    //   no falla nunca: escapa lo que le des.
    url.searchParams.set('keywords', queryOf(job));
    // Los MISMOS dos campos que se usan para buscar (keywords + location), para
    // que el link devuelva un resultado parecido al que originó la oferta.
    if (job?.location) url.searchParams.set('location', String(job.location));
    // ↑ Si la oferta no dice dónde está, se OMITE el location en vez de mandar
    //   "undefined": una búsqueda por todo el mundo es más útil que una rota, y
    //   //   `?location=undefined` es literalmente una búsqueda rota.
    return url.toString();
  }

  const withQuery = PORTAL_QUERY_SEARCH[portal];
  if (withQuery) return withQuery + encodeURIComponent(queryOf(job));

  return PORTAL_LISTING[portal] || '';
  // ↑ `|| ''` y no `??`: un `PORTAL_LISTING[portal]` que sea `''` tiene que
  //   seguir siendo `''`, y las dos son "no hay link" para el consumidor.
}

// ════════════════════════════════════════════════════════════════════════════
// EL PASO OBLIGATORIO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Enriquecimiento central: devuelve una COPIA de la oferta con `portal` y
 * `sourceUrl` ya resueltos.
 *
 * Nunca pisa valores que ya vengan (una oferta de Apify ya viene con su portal y
 * su URL de búsqueda reales) y NUNCA MUTA el objeto original.
 *
 * Por qué nunca mutar, y no es PURITÉS: los objetos de ofertas son COMPARTIDOS
 * entre llamadas. En el origen eran los de `curatedJobs.js` y los de la caché de
 * `getRanked()`, que vivían en el proceso para siempre; acá el que se comparte es
 * lo que devuelve la lectura de la base o la respuesta de una bolsa dentro del
 * mismo request. Mutarlos haría que el `portal` de una request se filtrara a otra,
 * y el síntoma es una oferta que aparece con el portal del usuario anterior sin
 * que nada en el código parezca capable de eso.
 *
 * @param {object} job Oferta. Si no es un objeto se devuelve tal cual, para que
 *   aguas arriba no reviente una lista con un hueco.
 * @returns {object} La copia, con `portal` y `sourceUrl`.
 */
export function withPortal(job) {
  if (!job || typeof job !== 'object') return job;
  // ↑ Defensa: si no es un objeto (por ejemplo una lista vacía que se coló), se
  //   devuelve tal cual y no se rompe nada aguas arriba.

  return {
    ...job,
    // ↓ `||` y no `??`: un string vacío también tiene que rellenarse. `??` dejaría
    //   el `''` y el frontend vería "tiene link vacío" en vez de "le calculamos
    //   el portal".
    portal: job.portal || portalOf(job),
    sourceUrl: job.sourceUrl || searchUrlFor(job),
  };
}

/**
 * El MISMO `withPortal`, con el nombre que usa el endpoint.
 *
 * Existe como alias y no como función aparte, y el motivo es de lectura: en el
 * origen `enrichJob`/`enrichJobs`/`enrichRegions` vivían en `server/index.js` y
 * eran la única forma de no olvidarse de `withPortal`. Después se agregaron
 * endpoints, y el que no se acordaba devolvía ofertas sin `portal` ni `sourceUrl`
 * sin ningún error: el frontend cae a su fallback de `portalLabel` y la UI no se
 * rompe, solo muestra "Curada" (o nada) donde debería decir "Remotive". Eso es un
 * bug que no se ve hasta que alguien pregunta "¿por qué esta oferta no tiene
 * link?".
 *
 * Con el nombre `enrichJob` la intención se lee en el call site, y con el archivo
 * exporting las tres funciones, el que las necesita tiene que importarlas de acá.
 *
 * @param {object} job Oferta.
 * @returns {object} La copia enriquecida.
 */
export function enrichJob(job) {
  return withPortal(job);
}

/**
 * Enriquece una lista completa de ofertas.
 *
 * LA GARANTÍA DEL PROYECTO: TODO lo que devuelva ofertas tiene que pasar por acá.
 * Un endpoint que devuelve un array de ofertas y se olvidó de esta llamada entrega
 * al frontend ofertas sin `portal` ni link de origen, y no hay ningún error que
 * lo delate.
 *
 * @param {unknown} jobs Lista de ofertas.
 * @returns {object[]} La lista enriquecida, o `[]`.
 */
export function enrichJobs(jobs) {
  return Array.isArray(jobs) ? jobs.map((job) => withPortal(job)) : [];
  // ↑ Tolera null/undefined (y un string, y un objeto) para no tener que defender
  //   en cada endpoint: una lista vacía devuelve una lista vacía. Y el chequeo es
  //   `Array.isArray` y NO truthiness: un objeto `{}` es truthy y no tiene `.map`,
  //   así que el `jobs && jobs.map(...)` reventaría justo con el caso más inofensivo
  //   (una respuesta de la base que vino vacía y no como array).
}

/**
 * Enriquece un mapa `{ region: [ofertas] }` entero, bucket por bucket.
 *
 * Existe porque el RANKING devuelve esa forma (`matcher.js:rankByRegion`) y es la
 * que consume el listado del frontend: enriquecer bucket por bucket y no oferta
 * por oferta es lo que evita que alguien tenga que acordarse de hacer un
 * `Object.values(regions).flat()` para no olvidarse ninguno.
 *
 * @param {Record<string, unknown>|null|undefined} regions Buckets por región.
 * @returns {Record<string, object[]>} Los mismos buckets, enriquecidos.
 */
export function enrichRegions(regions) {
  const out = {};
  for (const [region, list] of Object.entries(regions || {})) {
    out[region] = enrichJobs(list);
    // ↑ `enrichJobs` y no `withPortal`: cada bucket es una lista, y el `|| {}`
    //   del `for` cubre el null/undefined del mismo modo que el `Array.isArray`
    //   de adentro.
  }
  return out;
}