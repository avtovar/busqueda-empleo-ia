// ============================================================================
// TÉRMINOS DE BÚSQUEDA: con qué palabras se le pregunta a cada bolsa de empleo.
//
// POR QUÉ EXISTE ESTE ARCHIVO (es el bug de raíz que elimina)
// ----------------------------------------------------------
// En el proyecto origen los términos de búsqueda estaban repartidos en CINCO
// lugares distintos, y los CINCO estaban hardcodeados a QA:
//
//   · `BASE_KEYWORDS` en `jobSources.js:13`  → ['qa','quality','tester','test',
//     'automation','sdet']
//   · `REMOTIVE_TERMS` en `jobSources.js:63` → las 5 búsquedas a Remotive
//   · `?q=qa` clavado en la URL de Himalayas (`jobSources.js:139`)
//   · el filtro local sobre RemoteOK con `BASE_KEYWORDS` (`:166-170`)
//   · `?tag=qa` clavado en la URL de Jobicy (`:189`)
//
// Para el único usuario que tenía el origen (un QA) cuatro de los cinco
// acertaban. Para una enfermera o un contador, CUATRO DE LOS CINCO le mandaban a
// la bolsa una query que no era suya: le pedían "qa" y le devolvían la bolsa
// entera (RemoteOK) o literalmente nada (Himalayas, Jobicy).
//
// Y el modo de falla es el peor de todos: NO es un error, es un CERO SILENCIOSO.
// La pantalla muestra "no encontramos ofertas" y no queda nada en ningún log que
// diga por qué. Un bug que no se ve es un bug que se repite en cada bolsa nueva
// que se agrega.
//
// ESTE ARCHIVO ES EL ARREGLO DE RAÍZ: una sola función, y el criterio sale del
// PERFIL del usuario. Cuando aparezca una bolsa nueva, sus términos salen de acá
// y no de una constante nueva que alguien tiene que acordarse de mantener.
//
// LO QUE ESTE ARCHIVO NO HACE, y por qué está dicho:
//   · No decide en qué región está una oferta: eso es `regions.js`.
//   · No matchea skills contra el texto de una oferta: eso es `text.js`.
//   · No sabe nada de ninguna bolsa en particular (ni Remotive ni Jobicy ni qué
//     parámetro acepta cada una). Cada bolsa pide lo que necesita de la lista
//     que arma acá, y cada una recorta la cantidad que le conviene.
//   · No inventa un término por defecto. Sin perfil NO HAY términos, y eso es un
//     dato honesto: preferimos no traer nada antes que traer la bolsa entera
//     como si fuera de la profesión del usuario.
// ============================================================================

import { textHasSkill, toNumber } from './text.js';
// ↑ Son los dos únicos de `text.js` que hacen falta acá, y los dos por lo que
//   dicen en su propio JSDoc: `textHasSkill` es la comparación de términos contra
//   texto (que `matchesAnyTerm` no reimplementa) y `toNumber` es el reader de
//   valores raros, que acá son los pesos de las skills. Lo que NO se importa es
//   `normalize()` de `regions.js`, y es deliberado: ver la nota de `push` más
//   abajo, donde está el porqué entero.

// ════════════════════════════════════════════════════════════════════════════
// LÍMITES DE UN TÉRMINO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Largo máximo de un término, en caracteres.
 *
 * 40 y no 120 como en `portal.js`: acá el término va DENTRO de la URL de la bolsa
 * (`?q=`, `?tag=`, `?search=`), y hay dos razones para que sea más corto que el
 * `queryOf` del portal. Una: algunas bolsas tienen límite de largo de query y
 * cortan en silencio (devuelven 200 con cero resultados y no dicen por qué). Dos:
 * un término de 120 caracteres es una FRASE, y una frase matchea casi cualquier
 * oferta, así que la bolsa devuelve el catálogo entero y se pierde el sentido de
 * "estoy buscando este puesto".
 */
const TERM_MAX_LENGTH = 40;

/**
 * Largo mínimo de un término, en caracteres.
 *
 * El piso existe por `textHasSkill`, no por la URL: `text.js:178` ya corta el
 * término vacío porque un patrón con el término en blanco matchea CASI cualquier
 * texto. Acá el corte es previo, para que un keyword de un carácter (que el LLM
 * del CV produce más seguido de lo que uno creería: "C", "R", "I") ni llegue a la
 * bolsa ni entre en `matchesAnyTerm`.
 */
const TERM_MIN_LENGTH = 2;

/**
 * Cuántos términos se devuelven por defecto.
 *
 * 5 es un presupuesto, no una bolsa de datos: el que llama decide cuántos quiere
 *   y para qué. Remotive, que abre UNA petición HTTP por término, se queda con los
 *   primeros 3 (ver `jobSources.js`). Los otros no.
 */
const DEFAULT_MAX_TERMS = 5;

// ════════════════════════════════════════════════════════════════════════════
// LOS TÉRMINOS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Los términos de búsqueda de un usuario, en orden de prioridad.
 *
 * EL ORDEN ES EL CRITERIO, y está pensado así:
 *
 *   1. `profile.title` PRIMERO, siempre. Es el puesto al que la persona se
 *      postula, escrito por ella o por el LLM del CV: es el término más preciso
 *      que existe, y las bolsas lo entienden literal ("Enfermera" trae
 *      enfermeras, "Auxiliar de enfermería" trae auxiliares).
 *   2. `profile.keywords`, en el orden en que los dio el LLM del CV.
 *   3. Los `profile.skills` con más peso, de mayor a menor.
 *
 * Por qué las skills van AL FINAL y no antes que los keywords: un keyword es
 * texto que el LLM eligió como "lo que define a esta persona" y ya viene
 * deduplicado y limpio (`profile.js:normalizeKeywords`). Un nombre de skill es
 * una palabra suelta, muchas veces una tecnología ("Postgres") que sola no
 * describe ningún puesto. Es el mejor relleno que hay, pero es relleno.
 *
 * OJO con el criterio de pesos: `normalizeSkills` YA devuelve el array ordenado
 * por peso descendente, así que acá el `sort` es redundante para los perfiles que
 * salen de la base. Se hace igual, y con `.map` primero para no mutar el array
 * del perfil: esta función es pura y no puede reordenar el objeto del usuario.
 *
 * @param {object|null} profile Perfil del contrato (`api/lib/profile.js`), o null.
 * @param {{max?: number}} [options] `max` = cuántos términos devolver como
 *   máximo. `0` o negativo devuelve `[]`, que es un corte válido (una bolsa que
 *   solo puede hacer una petición y no quiere gastar el presupuesto en una).
 * @returns {string[]} Términos limpios, sin repetidos, de a lo sumo `max`. `[]`
 *   si el perfil no tiene nada usable: NO hay término por defecto.
 */
export function searchTerms(profile, options = {}) {
  const max = Math.floor(toNumber(options?.max, DEFAULT_MAX_TERMS));
  // ↑ `toNumber` y no `options.max || DEFAULT`: un `max: 0` explícito vale, y con
  //   `||` el 0 caería al default y "no me pases términos" sería indistinguible de
  //   "no me dijiste cuántos". `Math.floor` porque un `2.7` de un número que viene
  //   de un query param no puede devolver tres términos.

  const out = [];
  const seen = new Set();

  // ↑ Un `Set` para la deduplicación en vez de `out.includes(...)`: la lista es
  //   corta, pero el criterio acá NO puede ser `normalize()` (ver la nota de
  //   `push`), así que la comparación es por minúsculas y una lista corta con
  //   `includes` sería un O(n²) por nada.

  /**
   * Agrega un término si sirve y si todavía hay lugar. No tira: si no entra, no
   * entra.
   * @param {unknown} raw El término crudo del perfil.
   */
  const push = (raw) => {
    if (out.length >= max) return;
    const term = collapseTerm(raw);
    if (!term) return;
    // ↑ `toLowerCase()` y NO `normalize()` de `regions.js`, y la diferencia no es
    //   cosmetics. `normalize()` saca acentos: "atención" y "atencion" pasarían a
    //   ser el MISMO término, y acá dos términos que se diferencian SOLO por la
    //   tilde son dos búsquedas distintas para el usuario. Peor: estos términos
    //   van dentro de una URL, y una bolsa que compare literal ("atención" con
    //   tilde contra su índice) encuentra una cosa y sin tilde otra. La
    //   normalización para COMPARAR vive en `textHasSkill`, que normaliza los dos
    //   lados; acá solo hace falta no repetir la misma búsqueda dos veces.
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };

  push(profile?.title);

  if (Array.isArray(profile?.keywords)) {
    for (const keyword of profile.keywords) push(keyword);
  }
  // ↑ El `Array.isArray` es defensivo y NO por desconfianza del normalizador:
  //   `profile.js` garantiza el array, pero este archivo también se puede llamar
  //   con un perfil armado a mano desde un endpoint o un test, y `for...of` sobre
  //   un string recorre letras (mandaría "a","t","e"... a la bolsa) y sobre `null`
  //   tira. El corte es acá porque es el lugar donde el tipo importa.

  for (const name of skillNamesByWeight(profile?.skills)) push(name);

  return out;
}

/**
 * El término más preciso de una lista, o `''` si no hay ninguno.
 *
 * Existe para las bolsas que aceptan UN solo término y no varios: el parámetro
 * `?q=` de Himalayas y el `?tag=` de Jobicy son de a uno, así que la pregunta no
 * es "con cuál de estos" sino "mandá el que más chance tiene", y ese es el
 * primero (el título, por `searchTerms`). Las demás bolsas, que aceptan texto
 * libre, pueden usar la lista entera.
 *
 * Pasa el valor por `collapseTerm` otra vez: es idempotente y así el que llama no
 * tiene que asumir que la lista que le pasaron ya venía normalizada.
 *
 * @param {string[]} [terms] Lista de términos.
 * @returns {string} El primero, o `''`.
 */
export function primaryTerm(terms) {
  if (!Array.isArray(terms)) return '';
  return collapseTerm(terms[0]);
}

/**
 * ¿El texto de una oferta menciona ALGUNO de los términos?
 *
 * Para el FILTRADO LOCAL de las bolsas que no aceptan parámetro de búsqueda (hoy
 * RemoteOK, que devuelve el feed completo). Es el reemplazo del filtro de QA del
 * origen: en vez de "estas son las palabras de la profesión", son "las palabras
 * de ESTE usuario".
 *
 * Delega en `textHasSkill`, que normaliza los DOS lados y exige PALABRA COMPLETA
 * (que "qa" no entre adentro de "quality"). No se reimplementa: es exactamente el
 * mismo criterio con el que `matcher.js` matchea skills, y dos copias de esa
 * comparación pueden divergir sin que nadie se entere.
 *
 * CONTRATO DEL PARÁMETRO `text`: tiene que venir de `jobText()` o de
 * `normalize()`. `textHasSkill` normaliza el término, no el texto, y romper el
 * contrato da `false` en silencio (es la nota de `text.js:159-164`).
 *
 * @param {string} text Texto YA normalizado de la oferta.
 * @param {string[]} [terms] Los términos del usuario.
 * @returns {boolean} Si alguno aparece.
 */
export function matchesAnyTerm(text, terms) {
  if (!Array.isArray(terms)) return false;
  for (const term of terms) {
    if (textHasSkill(text, term)) return true;
    // ↑ `continue` implícito: con 5 términos el `||` acumulado se leería igual de
    //   bien, pero el loop corta en el primer acierto y es lo que se quiere: se
    //   compara contra el texto de una oferta UNA vez, no cinco.
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// Ayudantes
// ════════════════════════════════════════════════════════════════════════════

/**
 * Deja un término presentable en una URL: espacios colapsados, sin vacío, con un
 * tope de largo.
 *
 * El corte por palabra y no a los 40 caracteres exactos: un keyword del LLM
 * puede ser "Diseño e implementación de pipelines de datos para análisis de" y
 * cortarlo en seco deja "...para análisis de", que es una búsqueda distinta (y
 * peor) de la que quería el usuario. Si hay una palabra completa reasonably cerca
 * del límite, se corta ahí; si no hay ninguna (una sola palabra enorme), se corta
 * donde sea. El piso del último corte evita "Enferm" o "Inge".
 *
 * @param {unknown} raw Lo que haya en el perfil.
 * @returns {string} El término, o `''` si no sirve.
 */
function collapseTerm(raw) {
  // ↑ `raw == null` y no `asText()`: acá `null`, `undefined` y `''` significan
  //   todos lo mismo (no hay término), y `0` o `false` tampoco son términos. Un
  //   keyword numérico del LLM ("5 años de experiencia") SÍ es texto válido y
  //   entra por el `String()`.
  if (raw === null || raw === undefined) return '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (text.length < TERM_MIN_LENGTH) return '';
  if (text.length <= TERM_MAX_LENGTH) return text;

  const cut = text.lastIndexOf(' ', TERM_MAX_LENGTH);
  // ↑ `lastIndexOf` con el segundo argumento es el último espacio que cabe DENTRO
  //   del límite. Si ese corte queda muy al principio (una sola palabra larga), no
  //   sirve: "Enferm" es peor que "Enfermera profesional".
  if (cut >= Math.floor(TERM_MAX_LENGTH / 2)) return text.slice(0, cut).trim();
  return text.slice(0, TERM_MAX_LENGTH).trim();
}

/**
 * Los nombres de las skills del perfil, de la que más pesa a la que menos.
 *
 * Ordena una COPIA y no el array del perfil: esta función es pura y no puede
 * reordenar el objeto de otro usuario (y en serverless, el objeto compartido
 * entre llamadas). El `filter` de objetos es porque `skills` es
 * `[{name, weight}]` y un elemento raro (un string suelto) no tiene `.name`.
 *
 * @param {unknown} skills El `profile.skills`.
 * @returns {string[]} Nombres, ordenados por peso descendente.
 */
function skillNamesByWeight(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((skill) => skill && typeof skill === 'object')
    .map((skill) => ({ name: skill.name, weight: toNumber(skill.weight, 0) }))
    .sort((a, b) => b.weight - a.weight)
    // ↑ `toNumber(w, 0)` y no `toNumber(w)`: el default de `toNumber` sin
    //   segundo argumento ya es 0, pero dejarlo explícito dice que el default
    //  ACA es "no pesó nada". Un peso no numérico (el LLM respondió `"alta"`)
    //   manda al final en vez de romper el `sort` con un NaN.
    .map((skill) => skill.name);
}