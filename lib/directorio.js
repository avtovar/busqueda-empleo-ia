// ============================================================================
// EL DIRECTORIO: A DÓNDE BUSCAR EMPLEO EN ARGENTINA, CON EL OFICIO PUESTO
//
// Punto 11 del pedido original: un catálogo de bolsas de empleo y consultoras de
// selección de Argentina donde cada entrada abre una búsqueda YA filtrada con la
// profesión del usuario.
//
// ── SIN SCRAPING, Y POR QUÉ ESO ES LA RAZÓN DE QUE ESTO SEA UN CATÁLOGO ───────
//
// Ni una sola de estas webs se raspa. Cada entrada es un link que se abre en el
// navegador del usuario, y lo único que hace este archivo es armarlo bien. El
// motivo no es una preferencia: es que de las dos cosas que se podrían hacer con
// estas webs, UNA es de pago por ejecución (Apify, paso 10) y la otra es frágil.
// Scrapear un board cambia el markup y se rompe sin aviso; un link no se rompe.
//
// Y hay una ventaja que el usuario nota: el link se ve ANTES de hacer click. Si
// Computrabajo no acepta la profesión en el path, el catálogo lo dice en el
// `note` en vez de abrir una página vacía y dejar que el usuario piense que no
// hay trabajo.
//
// ── POR QUÉ `linkedinSearchUrl` Y `consultoraSearchUrl` VIVEN ACÁ ─────────────
//
// Los dos estaban en `frontend/src/utils.js` (líneas 636 y 657). Se mudan porque
// el backend los necesita: el catálogo tiene que abrir la búsqueda de LinkedIn
// con los mismos keywords que el botón del toolbar, y si las dos copias vivieran
// en archivos distintos, un día una dejaría de coincidir con la otra y el
// directorio mandaría al usuario a un lado del mismo sitio con una búsqueda y al
// otro lado con otra. Una URL que se arma en dos lugares es una URL que algún día
// se desincroniza. `utils.js` reexporta `linkedinSearchUrl` con un
// `export ... from` para que sus tres consumidores (`Toolbar.jsx:276`,
// `AnalysisPage.jsx:97`, `JobDetailModal.jsx:252`) no cambien ni una línea.
//
// ── CONSULTORAS QUE NO ENTRA, Y POR QUÉ (no es que no se hayan buscado) ───────
//
//   · HAYS. `hays.com.ar`, `hays.ar` y sus www NO RESUELVEN por DNS. No es que el
//     sitio esté caído: el dominio no existe. Y la propia Hays dice operar en
//     Chile, Colombia, México y Brasil: no tiene oficina en Argentina.
//   · KELLY SERVICES. `kellyservices.com.ar` tampoco resuelve por DNS, y el
//     negocio de staffing fue absorbido (Adecco Group compró el de América; Gi
//     Group el europeo en 2024). No hay board argentino.
//   · BOLSATRABAJO.COM. El dominio está A LA VENTA (redirect a GoDaddy). Mandar
//     al usuario a la página de venta de un dominio no es un dato de una bolsa:
//     es una tienda, y un catálogo no es una tienda.
//   · ZONAJOBS. Absorbido por Bumeran: es la MISMA aplicación (mismo shell, mismo
//     comportamiento). Contarla sería duplicar la entrada de Bumeran con otro
//     nombre, y el usuario vería dos tarjetas idénticas.
//
// Poner un link que no funciona en un catálogo que se supone confiable es peor que
// no poner ese link: el usuario pierde la confianza en TODOS los demás.
//
// ── ESTE ARCHIVO NO ABRE LA RED NI TOCA LA BASE ───────────────────────────────
//
// Es lógica pura: sin `fetch`, sin `pg`, sin estado. Eso lo hace verificable sin
// backend (con `node` y listo, que es lo que hace la batería de aserciones) y es
// lo que permite que el frontend importe `linkedinSearchUrl` sin arrastrar nada de
// Node al bundle: los únicos módulos que entran acá son `searchTerms.js` y
// `regions.js`, los dos JS puro.
// ============================================================================

import { primaryTerm, searchTerms } from './searchTerms.js';
import { DEFAULT_REGION, isValidRegion, normalize, REGIONS } from './regions.js';
// ↑ `normalize` (y no un `.replace` de acentos propio) es la normalización del
//   proyecto: minúsculas, sin tildes, con una sola forma de escribir los apóstrofes.
//   Reusarla es lo que hace que "Atención al Cliente" y "atencion al cliente"
//   produzcan el mismo slug, que es el criterio de `textHasSkill` y de
//   `matchRegion` también: un criterio por texto, no uno por archivo.

/**
 * Cuántos términos se le piden al perfil para esta pantalla.
 *
 * 5 y no 1 aunque el directorio solo use UNO (`primaryTerm`): la lista entera se
 * devuelve en la respuesta (`terms`) para que la interfaz pueda ofrecer
 * alternativas —"si no te salen, probá con 'auxiliar'"— sin volver a pegarle al
 * endpoint. Lo que se manda a los portales sigue siendo UNO solo (el bloque de
 * `buildDirectory` dice por qué).
 */
const DIRECTORY_MAX_TERMS = 5;

/**
 * Las entradas cuya URL NO sale de su `base`.
 *
 * Hay UNA, y es LinkedIn, por una razón de fondo: su URL de búsqueda tiene tres
 * partes y dos de ellas no son un placeholder sino una REGLA —el `location` de la
 * región y el filtro `f_TPR` de los últimos 30 días—. Si la entrada de LinkedIn
 * tuviera un `base` con `{q}`, habría dos verdades del patrón de URL de LinkedIn
 * en el mismo archivo (el template y `linkedinSearchUrl`), que es exactamente lo
 * que este archivo vino a evitar.
 *
 * Por eso el `base` de LinkedIn es `null`: no significa "no se puede buscar",
 * quiere decir "la URL la arma otra función, y esa es `linkedinSearchUrl`".
 *
 * Se indexa por `id` y no por `site` porque `id` es la clave estable del catálogo
 * (es la que viaja en la respuesta) y `site` es decoración.
 */
const URL_BUILDERS = {
  linkedin: (keyword, region) => linkedinSearchUrl(keyword, region),
};

// ════════════════════════════════════════════════════════════════════════════
// EL CATÁLOGO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Las bolsas y consultoras de una región, con el dato de CÓMO se abre la
 * búsqueda filtrada de cada una.
 *
 * Todas las URLs de acá se MIDIERON el 2026-10-03 (`curl` y/o `webfetch` contra la
 * URL con un término de ejemplo). Lo que se midió y lo que NO se pudo medir está
 * escrito en el `note` de cada entrada, porque un link sin filtro que no se pudo
 * verificar tiene que ser un `note` que lo diga, no un silencio.
 *
 * LA FORMA DE UNA ENTRADA:
 *   · `id`    clave estable. Viaja en la respuesta y es la que usa `URL_BUILDERS`.
 *   · `name`  cómo se muestra.
 *   · `site`  el dominio, para que el usuario sepa a qué sitio lo mandan ANTES de
 *             hacer click. Solo decoración: nadie navega con este campo.
 *   · `via`   el MECANISMO con el que esta web se puede filtrar:
 *               'url'    → la búsqueda va en la URL (`base` la tiene, o la arma
 *                           `linkedinSearchUrl` para LinkedIn).
 *               'google' → no hay URL de búsqueda, pero el sitio es indexable y se
 *                           le pregunta a Google acotado con `site:`.
 *               'none'   → no hay forma honesta de filtrar: se abre `home` y la
 *                           interfaz lo dice con el `note`.
 *   · `base`  template con `{slug}` (término en minúsculas, sin acentos, no
 *             alfanuméricos → `-`, que es lo que piden las bolsas que filtran por
 *             path), `{q}` (el término crudo, con encoding de URLSearchParams,
 *             para las que filtran por query) o `{location}` (el nombre del país
 *             de la región). `null` si esta web NO admite búsqueda por URL.
 *   · `home`  SIEMPRE presente. Es a donde se cae cuando no hay término, o cuando
 *             `via` es 'none'. Nunca queda una entrada sin salida.
 *
 * OJO con `via` y con `searchKind`, que son cosas distintas: `via` es un dato fijo
 * de la web ("así se filtra Computrabajo") y `searchKind` es lo que sale en la
 * respuesta ("quéAbriste"), que además depende de si la request tiene término.
 * `searchKind` NUNCA se guarda acá: se deriva en `searchKindOf`.
 *
 * @type {Record<string, {bolsas: object[], consultoras: object[]}>}
 */
export const DIRECTORIO = {
  argentina: {
    bolsas: [
      {
        id: 'linkedin',
        name: 'LinkedIn Jobs',
        site: 'linkedin.com',
        via: 'url',
        // ↑ `base: null` con `via: 'url'`: la URL la arma `linkedinSearchUrl`
        //   (ver `URL_BUILDERS`). Es la bolsa más grande del país y la única cuyo
        //   buscador acepta cualquier combinación de palabras sin comillas.
        base: null,
        home: 'https://www.linkedin.com/jobs/search/',
        note: 'El buscador más completo, y el único que además filtra por fecha (publicadas en los últimos 30 días).',
      },
      {
        id: 'indeed-ar',
        name: 'Indeed Argentina',
        site: 'ar.indeed.com',
        via: 'url',
        // ↑ `l=` (location) lleva el nombre de la región, y sale del MISMO dato que
        //   usa LinkedIn (`REGIONS[key].linkedinLocation`): es una verdad sola para
        //   "cómo se llama este país para un buscador de empleo". El host ya es el
        //   argentino, así que `l` es un refuerzo, no lo que hace que las ofertas
        //   sean de acá.
        base: 'https://ar.indeed.com/jobs?q={q}&l={location}',
        home: 'https://ar.indeed.com/jobs?q=',
        note: 'Ojo: Indeed bloquea a los scripts con un error 403. Si el link no te abre, es el bloqueo, no que esté caído.',
      },
      {
        id: 'computrabajo',
        name: 'Computrabajo',
        site: 'ar.computrabajo.com',
        via: 'url',
        // ↑ LA MÁS LIMPIA DE TODAS: la palabra va EN EL PATH, no en la query. Por
        //   eso usa `{slug}` y no `{q}` ("trabajo-de-enfermera", no
        //   "?q=enfermera"). Y por eso NO lleva ningún parámetro de ubicación: se
        //   midió que `?l=` no funciona en este sitio (devuelve el listado
        //   completo), así que mandarlo sería meter un filtro que no filtra.
        base: 'https://ar.computrabajo.com/trabajo-de-{slug}',
        home: 'https://ar.computrabajo.com/',
        note: 'Busca por el nombre del puesto en la dirección: es el link más preciso de toda la lista.',
      },
      {
        id: 'bumeran',
        name: 'Bumeran',
        site: 'bumeran.com.ar',
        via: 'url',
        // ↑ ESTA FORMA NO SE PUDO MEDIR, y está escrito acá por qué: Bumeran es
        //   una SPA y su servidor devuelve los MISMOS bytes para cualquier ruta
        //   (una `/ruta-que-no-existe` responde 200 con el shell vacío), así que un
        //   fetch NO puede distinguir "esta búsqueda tiene 300 ofertas" de "esta
        //   ruta no existe". El patrón sale del SITEMAP DE BUERAN, que lista
        //   `/empleos-busqueda-<slug>.html` para cada búsqueda real. Con eso se
        //   terminó: si algún día hay que confirmarlo en vivo, hay que abrirlo con
        //   un navegador, no con `curl`.
        base: 'https://www.bumeran.com.ar/empleos-busqueda-{slug}.html',
        home: 'https://www.bumeran.com.ar/',
        note: 'El patrón de búsqueda sale del sitemap de Bumeran: no se puede confirmar con un fetch porque la web es una SPA.',
      },
      {
        id: 'empleo-com',
        name: 'Empleo.com',
        site: 'ar.empleo.com',
        via: 'url',
        // ↑ Es de los pocos que sí: es un formulario GET con un input `name="q"`
        //   de verdad, en español y con vacantes de Argentina.
        base: 'https://ar.empleo.com/jobs?q={q}',
        home: 'https://ar.empleo.com/',
        note: 'Bolsa en español, con muchas vacantes de administración y de atención al cliente.',
      },
      {
        id: 'randstad',
        name: 'Randstad Argentina',
        site: 'randstad.com.ar',
        via: 'url',
        // ↑ SIN el prefijo `s-`. Ojo con esto porque es la trampa del sitio: los
        //   buscadores y los enlaces viejos mandan `/trabajos/s-enfermera/`, y esa
        //   forma devuelve un SHELL DE JS VACÍO (una página sin un solo resultado
        //   renderizado). La forma buena, la que trae el listado con sus contadores
        //   ya en el HTML, es `/trabajos/<slug>/`.
        base: 'https://www.randstad.com.ar/trabajos/{slug}/',
        home: 'https://www.randstad.com.ar/',
        note: 'Es una consultora grande con su propio portal de vacantes: el listado abre con los números adentro.',
      },
      {
        id: 'michael-page',
        name: 'Michael Page Argentina',
        site: 'michaelpage.com.ar',
        via: 'url',
        // ↑ Solo la palabra, sin ubicación. La razón está en el `note`: se midió
        //   que su parámetro de ubicación NO es confiable, y mandar un filtro que
        //   puede dejar la lista vacía es peor que no mandarlo.
        base: 'https://www.michaelpage.com.ar/jobs?search={q}',
        home: 'https://www.michaelpage.com.ar/jobs',
        note: 'Filtra solo por la palabra clave; su buscador de ubicación no es confiable.',
      },
      {
        id: 'jooble-ar',
        name: 'Jooble Argentina',
        site: 'ar.jooble.org',
        via: 'url',
        // ↑ LA ÚNICA QUE NO SE PUDO VERIFICAR. Jooble devuelve 403 a cualquier
        //   pedido automatizado, INCLUSO a la raíz del sitio: o sea que no hay
        //   forma de distinguir "el patrón está bien" de "el patrón está mal" con
        //   un fetch. El patrón sale del índice de búsqueda de Jooble, donde
        //   `/trabajo-en-<slug>/Argentina` es la forma de los enlaces reales.
        //   Entra igual porque es una bolsa argentina de primer nivel y la
        //   probabilidad de que el patrón haya cambiado es baja; y entra DICHO:
        //   el `note` le avisa al usuario que la forma salió del índice y no de una
        //   medición.
        base: 'https://ar.jooble.org/trabajo-en-{slug}/Argentina',
        home: 'https://ar.jooble.org/',
        note: 'No bloquea a las personas: rechaza a los scripts con un 403, por eso su forma de búsqueda salió del índice y no de una medición.',
      },
      {
        id: 'get-on-board',
        name: 'Get on Board',
        site: 'getonbrd.com.ar',
        via: 'none',
        // ↑ base: null Y via: 'none': esta entrada NO SE FILTRA. La bolsa es
        //   real, está viva y es en español, pero su servidor IGNORA el `?q=` (el
        //   campo de búsqueda llega vacío al backend) y su búsqueda real es un
        //   endpoint interno al que no se le puede poner un link. Lo que SÍ
        //   funciona es `?country=Argentina`, y es lo que trae el `home`.
        //
        //   Dejarla igual así, sin disfrazar el `home` de "búsqueda filtrada", es el
        //   criterio de todo el archivo: un `note` que dice "acá tenés que elegir el
        //   puesto a mano" es INFORMACIÓN; un link que parece filtrado y no lo está
        //   hace que el usuario piense que no hay trabajo de su profesión.
        base: null,
        home: 'https://www.getonbrd.com.ar/jobs?country=Argentina',
        note: 'Es la más moderna de la lista, pero su buscador es interno: abrís la lista de Argentina y elegís el puesto vos.',
      },
    ],

    consultoras: [
      {
        id: 'randstad-consultora',
        name: 'Randstad (selección de personal)',
        site: 'randstad.com.ar',
        // ↑ base: null, y NO es una falta: es el mecanismo. No se raspa a Randstad
        //   (ni a nadie acá) y no se conoce una URL estable para su búsqueda de
        //   vacantes de selección, así que lo que se abre es una búsqueda de Google
        //   acotada a su dominio. Funciona, y el `site:` además cubre los
        //   subdominios donde suelen estar los avisos.
        base: null,
        via: 'google',
        home: 'https://www.randstad.com.ar/',
        note: 'Se abre una búsqueda de Google dentro de su sitio, no su portal: es la forma de ver sus avisos sin meterse a la web.',
      },
      {
        id: 'michael-page-consultora',
        name: 'Michael Page (selección de personal)',
        site: 'michaelpage.com.ar',
        base: null,
        via: 'google',
        home: 'https://www.michaelpage.com.ar/',
        note: 'También por búsqueda en Google: a diferencia de Randstad, su sitio no tiene un listado de vacantes propio donde filtrar.',
      },
      {
        id: 'adecco',
        name: 'Adecco Argentina',
        site: 'adecco.com',
        // ↑ base: null Y via: 'none'. La diferencia con las dos de arriba es
        //   TÉCNICA y está medida: el buscador de Adecco es un `POST` a un API
        //   interno (los inputs del formulario no tienen ni `name`, así que no hay
        //   nada que poner en una URL) y no hay forma de armar un link de búsqueda.
        //   Por eso entra con `home` al board real y no con un `site:` de Google:
        //   sí se podría abrir Google, pero se presentaría como "su buscador"
        //   algo que no es, y el usuario pierde el hilo de la tarjeta.
        base: null,
        via: 'none',
        home: 'https://empleo.adecco.com.ar/',
        note: 'Su buscador no admite links: abrís su portal de Argentina y filtrás por medio del formulario.',
      },
      {
        id: 'manpower',
        name: 'Manpower Argentina',
        site: 'manpower.com.ar',
        // ↑ Mismo caso que Adecco y por otra razón: el portal es IBM WebSphere y
        //   sus filtros son URLs opacas que se generan con JavaScript. No hay un
        //   link de búsqueda que se pueda escribir a mano.
        base: null,
        via: 'none',
        home: 'https://www.manpower.com.ar/',
        note: 'Es la consultora con más vacantes del país, pero su portal no admite links de búsqueda: hay que filtrar en el sitio.',
      },
    ],
  },
};

// ════════════════════════════════════════════════════════════════════════════
// EL SLUG
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convierte un texto en la parte de una URL que los portales filtran por path
 * (`/trabajo-de-{slug}`, `/trabajos/{slug}/`).
 *
 * POR QUÉ HACE FALTA: hay bolsas que filtran por PATH y no por query, así que el
 * término tiene que sobrevivir un viaje donde no hay dónde meter un `%20` ni una
 * tilde. Y el slug es parte de la DIRECCIÓN de esos portales, no un parámetro:
 * `/trabajo-de-italiano` es una página que Computrabajo tiene indexada desde
 * siempre, y el link hay que escribirlo exactamente como ellos lo escriben.
 *
 * El criterio (reusando `normalize` de `regions.js`):
 *   1. minúsculas y sin tildes — "Atención al Cliente" → `atencion-al-cliente`.
 *   2. todo lo que no sea letra o dígito se junta en UN solo guion, así nunca
 *      quedan guiones dobles ni el término partido: "C#/C++" → `c-c`, que es feo
 *      pero no rompe la URL (un `/` suelto en el path rompe el path).
 *   3. los guiones de los extremos se cortan: `/trabajo-de--enfermera/` no es lo
 *      mismo que `/trabajo-de-enfermera/`, y el primero da error 404.
 *
 * Con `''` de entrada devuelve `''`, y eso NO es un error: la entrada cae a `home`
 * con `searchKind: 'ninguno'` (ver `searchUrlFor`), porque un slug vacío daría
 * `/trabajo-de/` y eso no es una búsqueda de nada.
 *
 * @param {unknown} value Cualquier cosa (un término del perfil, normalmente).
 * @returns {string} El slug, o `''` si del texto no queda nada utilizable.
 */
export function slugify(value) {
  return normalize(value)
    // ↑ `normalize` ya bajó a minúsculas, sacó tildes, quit apóstrofes y colapsó
    //   espacios: ninguna de esas reglas se reescribe acá porque son las del
    //   proyecto entero, y dos criterios de normalización divergen solos.
    .replace(/[^a-z0-9]+/g, '-')
    // ↑ `+` y NO `*`: el `+` además de reemplazar, junta los separadores entre sí,
    //   y dos guiones seguidos no son parte de ninguna URL de ningún portal.
    .replace(/^-+|-+$/g, '');
}

// ════════════════════════════════════════════════════════════════════════════
// LAS DOS URLs QUE VENÍAN DEL FRONTEND
// ════════════════════════════════════════════════════════════════════════════

/**
 * Una búsqueda directa de LinkedIn, limitada a publicaciones de los últimos 30 días.
 *
 * MOVIDA TAL QUAL desde `frontend/src/utils.js`. La implementación no se tocó (el
 * resultado tiene que ser byte a byte el mismo, porque este mismo botón ya está
 * publicado en la barra de la app y en el detalle de cada oferta); lo único que
 * cambió es de dónde sale el `location` de la región: antes salía del
 * `REGION_LOCATION` del frontend y ahora sale de `REGIONS[key].linkedinLocation`,
 * que es el MISMO dato del que ese mapa se derivaba. Un origen, dos derivaciones.
 *
 * @param {string} keywords La query de LinkedIn (la que arma `linkedinProfileKeywords`).
 * @param {string} region Clave de región.
 * @returns {string} La URL completa.
 */
export function linkedinSearchUrl(keywords, region) {
  const params = new URLSearchParams({
    keywords,
    // ↑ Si la región no está en la configuración, mandamos vacío: LinkedIn busca
    //   en todas. Se lee `(REGIONS[region] || {}).linkedinLocation` y no
    //   `REGIONS[region].linkedinLocation` porque una clave inventada tiene que dar
    //   `''` y no un TypeError en el navegador.
    location: (REGIONS[region] || {}).linkedinLocation || '',
    // ↑ f_TPR es el filtro de "publicado en los últimos N segundos" de LinkedIn
    //   (30 días expresados en segundos). Es un parámetro propio de su sitio.
    f_TPR: `r${30 * 24 * 60 * 60}`,
  });
  // ↑ URLSearchParams codifica los parámetros de forma segura (espacios, tildes, etc.).
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

/**
 * Una búsqueda de Google acotada a un sitio (`site:`), con las keywords del perfil.
 *
 * MOVIDA TAL QUAL desde `frontend/src/utils.js` (donde era el helper del
 * `ConsultorasList.jsx` que se borró en el paso 3), con la misma respuesta byte a
 * byte: ahora la usa el backend para las consultoras del catálogo.
 *
 * POR QUÉ GOOGLE Y NO EL BUSCADOR DE LA CONSULTORA: porque no se raspa, y porque no
 * se sabe si cada consultora tiene siquiera un listado de vacantes con URL estable.
 * Un `site:` es la forma de buscar DENTRO de un sitio sin saber cómo está armado
 * por dentro, y el resultado es real: son páginas de ese sitio.
 *
 * @param {string} link La URL del sitio donde acotar la búsqueda.
 * @param {string} keywords Las palabras del perfil.
 * @returns {string} La URL de la búsqueda de Google.
 */
export function consultoraSearchUrl(link, keywords) {
  // ↑ Devuelve una búsqueda de Google acotada al sitio de la consultora.
  let dominio = '';
  // ↑ `let` (y no const) porque el valor se reasigna en los dos caminos del try.
  try {
    dominio = new URL(link).hostname.replace(/^www\./, '');
    // ↑ Sacamos el "www." para que el site: search sea más amplio (incluye subdominios).
  } catch {
    // ↑ Si el link no es una URL válida, new URL() lanza un error y caemos acá:
    //   dejamos el dominio vacío y después buscamos sin el filtro de sitio.
    dominio = '';
  }
  const query = dominio
    // ↑ `site:ejemplo.com` es un operador de Google: solo páginas de ese sitio.
    ? `site:${dominio} (empleo OR empleos OR vacante OR "trabajá con nosotros") ${keywords}`
    // ↑ Sin dominio no se puede usar site:, así que buscamos las keywords sueltas.
    : `${keywords} empleos`;
  const params = new URLSearchParams({ q: query });
  // ↑ `q` es el parámetro de búsqueda de Google. URLSearchParams se encarga de
  //   escapar los paréntesis y las comillas para que no rompan la URL.
  return `https://www.google.com/search?${params.toString()}`;
}

// ════════════════════════════════════════════════════════════════════════════
// ARMADO DE LA RESPUESTA
// ════════════════════════════════════════════════════════════════════════════

/**
 * La clave de región resuelta, o la de la región por defecto.
 *
 * MISMA REGLA que `resolveRegion` de `lib/jobs.js` y que el `resolveRegion` de
 * `coverLetter.js`: una región que no existe NO es un error, es la región por
 * defecto. Un `?region=` desconocido puede venir de un link viejo o de un país que
 * se borró, y en los dos casos lo que el usuario espera es el catálogo, no un 400.
 *
 * Vive acá y no en el endpoint para que la regla esté escrita UNA vez: los dos
 * endpoints que llaman a `buildDirectory` (o al futuro que la agregue) no tienen
 * forma de olvidarse de ella.
 *
 * @param {unknown} value Clave de región (o `null`).
 * @returns {string} Una clave que existe en `regions.js`. Siempre.
 */
function resolveRegionKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return key && isValidRegion(key) ? key : DEFAULT_REGION;
}

/**
 * La configuración del directorio de una región, o la de la región por defecto.
 *
 * El fallback tiene un paso más que `resolveRegion` de `jobs.js`: si la región
 * EXISTE en `regions.js` pero todavía NO tiene catálogo, también cae en la región
 * por defecto. Es el orden en que se van a agregar países: primero `regions.js` (que
 * es lo que las bolsas y la carta necesitan), después el catálogo. Sin este paso,
 * `/api/directorio?region=chile` contestaría un catálogo vacío y la interfaz
 * dibujaría una página en blanco sin decir por qué.
 *
 * @param {unknown} region Clave de región (o `null`).
 * @returns {{bolsas: object[], consultoras: object[]}} El catálogo de la región.
 */
export function directorioFor(region) {
  const resolved = resolveRegionKey(region);
  return DIRECTORIO[resolved] || DIRECTORIO[DEFAULT_REGION];
}

/**
 * El directorio completo de una región, con la búsqueda prellena del perfil.
 *
 * ── POR QUÉ UN SOLO TÉRMINO Y NO LA QUERY CON `(a OR b)` ─────────────────────
 *
 * El botón de LinkedIn del toolbar manda `(enfermera OR hospital OR excel)`, y esa
 * query es CORRECTA para LinkedIn: su buscador entiende paréntesis y `OR`. Acá no
 * se puede usar, por dos razones que lo hacen un problema y no una preferencia de
 * estilo:
 *
 *   1. Las bolsas que filtran por PATH (`/trabajo-de-{slug}`) no pueden recibir una
 *      query con paréntesis y `OR`: el slug de "(enfermera OR hospital)" es
 *      `enfermera-or-hospital`, que es una página que NO EXISTE y da un 404.
 *   2. Una query OR en un slug es una búsqueda DISTINTA, no una búsqueda más
 *      amplia: en Computrabajo no hay "la unión de A y B", hay o `/trabajo-de-a/`
 *      o `/trabajo-de-b/`. Mandar la unión sería mentir sobre lo que se abre.
 *
 * Por eso sale UNO, `primaryTerm(terms)`, que es el título del perfil primero y
 * después los keywords: es el término más preciso que existe y es el que todas las
 * bolsas entienden literal.
 *
 * Y si ese término NO EXISTE (perfil sin `title`, sin `keywords` y sin skills con
 * peso), NO se inventa ninguno: las trece entradas caen a su `home` con
 * `searchKind: 'ninguno'`. Es el mismo criterio de `searchTerms` ("sin perfil no
 * hay términos") y es un estado HONESTO, que la interfaz tiene que poder mostrar.
 *
 * Este módulo es puro: no lee la base ni llama a ningún portal. El perfil ya viene
 * cargado por el endpoint (y ya salió por `requireProfile`, o sea que es el del
 * usuario de la cookie, no un `user_id` de la URL).
 *
 * @param {object|null} profile Perfil del CONTRATO (`lib/profile.js`), o null.
 * @param {string} [region] Clave de región; se resuelve acá adentro.
 * @returns {{
 *   region: string,
 *   keyword: string,
 *   terms: string[],
 *   bolsas: object[],
 *   consultoras: object[],
 * }} La respuesta de `GET /api/directorio`.
 */
export function buildDirectory(profile, region = DEFAULT_REGION) {
  const resolved = resolveRegionKey(region);
  const config = directorioFor(resolved);
  // ↑ Se resuelve DOS veces (acá y en `directorioFor`) y es a propósito: acá hace
  //   falta para el `region` de la respuesta, que tiene que ser la RESUELTA (la
  //   que se usó de verdad), no la que pedía la URL. Es la misma regla que
  //   `/api/jobs`: `region` en el body es el que `App.jsx` usa para saber qué
  //   pestaña está activa.

  const terms = searchTerms(profile, { max: DIRECTORY_MAX_TERMS })
    .map((term) => term.toLowerCase());
  // ↑ `searchTerms` con `profile` en null (no hay perfil) devuelve `[]` sin tirar:
  //   es exactamente el estado que produce `searchKind: 'ninguno'` en todo.
  //
  //   El `.map` a minúsculas es de ACÁ y no de `searchTerms`, y es a propósito. En
  //   `searchTerms` la palabra se COMPARA contra el texto de una oferta, y comparar
  //   no distingue mayúsculas; acá la palabra se CONVIERTE EN UNA DIRECCIÓN, y las
  //   rutas de búsqueda de estos portales están indexadas en minúsculas
  //   (`/trabajo-de-enfermera`). En un path una mayúscula es, según el portal, una
  //   página distinta o un 404, y en un query param es ruido que no aporta nada.
  const keyword = primaryTerm(terms);
  // ↑ `primaryTerm` y no `terms[0]`: vuelve a pasar el valor por el recorte de
  //   `collapseTerm`, o sea que es idempotente, y devuelve `''` en vez de
  //   `undefined` si la lista viene vacía. Acá `keyword` es lo que se muestra arriba
  //   en la pantalla, así que un `undefined` se vería en la interfaz.

  return {
    region: resolved,
    keyword,
    terms,
    bolsas: config.bolsas.map((entry) => entryFor(entry, keyword, resolved)),
    consultoras: config.consultoras.map((entry) => entryFor(entry, keyword, resolved)),
  };
}

/**
 * Una entrada del catálogo, ya con su URL y con lo que el usuario va a recibir.
 *
 * `home` NO sale en la respuesta y no es una omisión: cuando no hay búsqueda, la
 * `searchUrl` ES el `home`, así que mandarlo sería mandar la misma dirección dos
 * veces.
 *
 * @param {object} entry Una entrada de `DIRECTORIO`.
 * @param {string} keyword El término elegido, o `''`.
 * @param {string} region La región ya resuelta.
 * @returns {{id: string, name: string, site: string, note: string, searchUrl: string, searchKind: string}}
 *   La entrada para la respuesta.
 */
function entryFor(entry, keyword, region) {
  return {
    id: entry.id,
    name: entry.name,
    site: entry.site,
    note: entry.note,
    searchUrl: searchUrlFor(entry, keyword, region),
    // ↑ `searchKind` va SIEMPRE, incluso valiendo `'ninguno'`: la interfaz decide
    //   qué pintar con el VALOR, no con la ausencia del campo. Es la misma razón
    //   por la que `_online` se manda siempre en `/api/jobs`.
    searchKind: searchKindOf(entry, keyword),
  };
}

/**
 * Qué recibe el usuario en esta request: una búsqueda del portal, una búsqueda de
 * Google, o la portada sin filtrar.
 *
 * POR QUÉ UN STRING Y NO UN `prefilled: true/false`: un booleo obliga a la
 * interfaz a decidir QUÉ hacer cuando no hay búsqueda prellena, y esa decisión
 * termina tomada en el `.jsx`, que es donde nadie la va a leer. Con el string, la
 * respuesta dice las tres cosas: qué se abrió (`searchUrl`), por qué se abrió así
 * (`searchKind`) y el aviso al usuario (`note`). Es la diferencia entre "el link no
 * trae nada" y "el link te lleva a la portada porque en esta bolsa no se puede
 * filtrar".
 *
 * NUNCA se guarda `searchKind` en el catálogo: depende de si ESTA request tiene
 * término, así que se deriva acá, en el momento, con la misma `keyword` que se
 * mandó a armar `searchUrl`. Un `searchKind` guardado en la entrada y
 * desincronizado del `searchUrl` es un bug que no se ve hasta que alguien hace
 * click.
 *
 * @param {object} entry Una entrada de `DIRECTORIO`.
 * @param {string} keyword El término elegido, o `''`.
 * @returns {'sitio' | 'google' | 'ninguno'} Qué se abre.
 */
function searchKindOf(entry, keyword) {
  if (!keyword) return 'ninguno';
  // ↑ Es lo PRIMERO y no lo último a propósito: sin término no hay búsqueda
  //   prellena, diga lo que diga el `via` de la entrada. El caso real es un usuario
  //   sin CV servido por una versión de este endpoint que no exigía perfil: las
  //   trece entradas tienen que caer a `home`, no seis con un `?q=` vacío.

  if (entry.via === 'url') return 'sitio';
  // ↑ `sitio`: la URL es del portal y ya viene filtrada.

  if (entry.via === 'google') return 'google';
  // ↑ `google`: no se raspa y no se conoce una URL de búsqueda, así que se le
  //   pregunta a Google acotado a `site:`. El `note` de esas entradas lo avisa.

  return 'ninguno';
  // ↑ `'none'` (Adecco, Manpower, Get on Board) y, por el primer corte, también
  //   "no hay término". Los dos casos comparten respuesta y lo correcto es decirlo.
}

/**
 * La dirección que se abre para una entrada: la del portal filtrada, la de Google,
 * o la portada.
 *
 * @param {object} entry Una entrada de `DIRECTORIO`.
 * @param {string} keyword El término elegido, o `''`.
 * @param {string} region La región ya resuelta.
 * @returns {string} Una URL. SIEMPRE empieza con `http`.
 */
function searchUrlFor(entry, keyword, region) {
  // El orden de los cortes es el MISMO que el de `searchKindOf`, y por el mismo
  // motivo: cada corte tiene que producir exactamente lo que el `searchKind` que
  // sale promete. Si los dos se desincronizan, la tarjeta miente.
  if (!keyword) return entry.home;

  if (entry.via === 'google') {
    // ↑ Se acota al DOMINIO de `home` y no al de `site`: el que se indexa es el
    //   que abre el usuario, y `new URL()` saca solo el `www.` que estorba al
    //   operador `site:`.
    return consultoraSearchUrl(entry.home, keyword);
  }

  if (entry.via !== 'url') return entry.home;
  // ↑ `'none'`: se abre la portada, que es lo único honesto que hay.

  const builder = URL_BUILDERS[entry.id];
  // ↑ LinkedIn: la URL la arma `linkedinSearchUrl`, no un template.
  if (builder) return builder(keyword, region);

  const slug = slugify(keyword);
  if (entry.base.includes('{slug}') && !slug) return entry.home;
  // ↑ Un slug vacío con `{slug}` en el `base` daría `/trabajo-de/`, que es una URL
  //   que no busca nada. Pasa poco (a `collapseTerm` le exige 2 caracteres) pero
  //   el costo de cubrirlo es cero.

  return fillTemplate(entry.base, { q: keyword, slug, location: locationOf(region) });
}

/**
 * Rellena un template de URL.
 *
 * `encodeURIComponent` y NO `URLSearchParams`, a propósito. `URLSearchParams` sirve
 * para armar una query desde cero, que es lo que hacen `linkedinSearchUrl` y
 * `consultoraSearchUrl`; pero acá el query YA está escrito adentro de `base`
 * (`?search={q}`, `?q={q}&l={location}`) y no hay forma de saber qué claves son
 * parámetro y cuáles no sin parsear cada template. Encima `URLSearchParams` manda
 * el espacio como `+`, que solo significa espacio en una query form-encoded: en un
 * PATH (`/trabajo-de-{slug}/`) un `+` es un carácter literal y la búsqueda sería de
 * otra cosa. `encodeURIComponent` da `%20`, que es válido en los dos lugares.
 *
 * @param {string} base El template.
 * @param {{q: string, slug: string, location: string}} parts Los valores.
 * @returns {string} La URL.
 */
function fillTemplate(base, parts) {
  return String(base)
    // ↑ `split().join()` y no `replace` con regex: los placeholders son texto
    //   LITERAL y este recorrido de izquierda a derecha garantiza que un valor con
    //   la forma "{q}" adentro no se vuelva a interpretar. Es el mismo criterio con
    //   el que `searchTerms` deduplica.
    .split('{slug}').join(encodeURIComponent(parts.slug))
    .split('{location}').join(encodeURIComponent(parts.location))
    // ↑ `{location}` va antes que `{q}`: si algún día el nombre de una región
    //   tuviera la forma de un placeholder (no la tiene), este orden lo evita.
    .split('{q}').join(encodeURIComponent(parts.q));
}

/**
 * El nombre del país que esta región le pasa a los portales de empleo.
 *
 * Reusa `linkedinLocation` de `regions.js`, y el nombre del campo dice "linkedin"
 * por historia: el primer consumidor fue el buscador de LinkedIn. El dato es
 * "cómo se llama este país acá", que le sirve igual a Indeed (que lo usa en `l=`).
 * Agregar un país es agregar su `linkedinLocation` UNA vez en `regions.js`.
 *
 * @param {string} region Clave de región ya resuelta.
 * @returns {string} El nombre, o `''` si la región no está en la configuración.
 */
function locationOf(region) {
  return (REGIONS[region] || {}).linkedinLocation || '';
}