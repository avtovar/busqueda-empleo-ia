// ============================================================================
// MOTOR DE MATCHING: convierte cada oferta en una oferta rankeada.
//
// Calcula el porcentaje de compatibilidad (0-100) entre UNA oferta y el perfil
// de UN usuario. La fórmula, los nombres de los campos y los recortes son
// EXACTAMENTE los del módulo del proyecto origen: la fórmula del score es una
// decisión de producto ya tomada y medida, y cambiar un número acá invalida
// cualquier comparación que el usuario haya hecho. Lo que cambia es de dónde
// salen las palabras con las que se decide qué es relevante.
//
// Lo que se eliminó del origen, y por qué:
//
//   · `import { PROFILE }` — el perfil global hardcodeado de una sola persona.
//     Ahora el perfil llega por parámetro. Es el motivo de todo este módulo.
//
//   · `isRelevant` / `BASE_KEYWORDS` (de jobSources.js) — una lista fija de
//     palabras de QA. Para un contador o una enfermera devolvía "no es relevante"
//     y el buscador quedaba vacío. Acá la relevancia la define el vocabulario
//     DEL USUARIO, así que no hay lista fija: no hay nada que mantener por
//     profesión.
//
//   · `ROLE_SYNONYMS` — la tabla `words -> categoría de rol QA` que traducía
//     "tester" a 'tester' y "devops" a 'devops'. Es un catálogo de roles de UNA
//     profesión. Se reemplaza por los `keywords` del propio perfil (migración
//     002): si el LLM del CV dijo que esa persona busca trabajo como "QA" o como
//     "contadora", esas palabras son las que se buscan en el título, y no hacen
//     falta tablas de sinónimos ni tocar el código para agregar una profesión.
//
// NO se muta ningún objeto que venga de afuera: `matched` y `roles` son arrays
// nuevos, y el objeto de retorno es una copia. Los objetos de `jobs` son
// compartidos con las demás funciones de la request (ver AGENTS.md sobre
// `withPortal`), y mutarlos filtraría datos entre llamadas.
// ============================================================================

import { emptyBuckets, matchRegion } from './regions.js';
import { emptyProfile } from './profile.js';
import { jobText, textHasSkill } from './text.js';

// ════════════════════════════════════════════════════════════════════════════
// EL PERFIL QUE USA ESTE MÓDULO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Devuelve un perfil utilizable, o un perfil vacío si no hay ninguno.
 *
 * Lo que permite: un endpoint puede llamar a `computeMatch(job)` sin perfil y
 * obtener `{ score: 0, ... }` con la forma completa en vez de un TypeError. No es
 * un atajo: con `emptyProfile()` el recorrido de skills no encuentra nada, la
 * relevancia da false y el resultado es el shape de cero. O sea, el score 0
 * sale SOLO, sin un if que devuelva "0 hardcodeado" por otro lado.
 *
 * @param {object|null|undefined} profile Perfil del contrato (el de
 *   `loadProfile`), o null/undefined.
 * @returns {object} El perfil, o uno vacío.
 */
function profileOrEmpty(profile) {
  if (profile && typeof profile === 'object' && Array.isArray(profile.skills)) {
    return profile;
  }
  // ↑ La forma del array de skills es el criterio de "es un perfil normalizado".
  //   Si viene algo que no la tiene (o nada), se usa el vacío. Así un perfil
  //   roto no rompe el matching: degrada a cero, que es el resultado que el
  //   usuario entendería ("ninguna oferta me coincide"), no un 500.
  //   OJO: no se copian los arrays del perfil. Se usa el objeto tal cual porque
  //   `computeMatch` no lo muta nunca (ver la nota de no-mutación arriba).
  return emptyProfile();
}

/**
 * ¿El perfil tiene datos suficientes para que un match signifique algo?
 *
 * Sin skills, `matched` nunca puede tener nada, la relevancia da false y el
 * resultado sería 0 igual. Lo que esta función agrega es el comentario que
 * explica el 0: "no tengo skills cargadas" es un problema del perfil y se
 * distingue de "busqué y no encontré nada". Ver el `comment` del retorno.
 *
 * @param {object} profile Perfil normalizado.
 * @returns {boolean} Si tiene al menos una skill.
 */
function hasAnySkill(profile) {
  return profile.skills.length > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// EL MATCH DE UNA OFERTA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Calcula el porcentaje de match entre una oferta y un perfil.
 *
 * El resultado tiene SIEMPRE los mismos seis campos, incluso cuando el score es
 * 0: `score`, `matched`, `missed`, `requested`, `roles`, `inTitle`. Que la forma
 * sea constante es lo que permite que los consumidores no hagan `if (!match)`
 * ni esperen `null` en ningún camino. En el camino del score 0 se agrega un
 * `comment` opcional que explica POR QUÉ el 0 (ver más abajo).
 *
 * @param {object} job Oferta de cualquier fuente. Todos sus campos son opcionales.
 * @param {object} [profile] Perfil del contrato (el de `loadProfile`). Opcional:
 *   sin perfil el resultado es score 0, no un error.
 * @returns {{score: number, matched: string[], missed: string[], requested: string[], roles: string[], inTitle: boolean, comment?: string|null}}
 */
export function computeMatch(job, profile) {
  const p = profileOrEmpty(profile);
  const text = jobText(job);
  const title = job.title ? String(job.title).toLowerCase() : '';

  // ── Skills del PERFIL que la oferta pide y que la persona tiene ────────────
  const matched = [];
  for (const skill of p.skills) {
    const name = skill.name;
    if (textHasSkill(text, name)) {
      // ↑ `inTitle` marca si además sale en el TÍTULO. Vale 1.5x en el score: si
      //   la skill está en el título es porque es central al puesto, no un
      //   requisito suelto. Es el mismo criterio del origen (línea 66).
      matched.push({ skill: name, weight: toWeight(skill.weight), inTitle: textHasSkill(title, name) });
    }
  }

  // ── Skills del MERCADO que la oferta pide (para detectar gaps reales) ─────
  const requestedMarket = [];
  const missing = [];
  for (const ms of p.marketSkills) {
    const present = ms.aliases.some((a) => textHasSkill(text, a));
    if (!present) continue;
    requestedMarket.push(ms.name);
    if (!ms.has) missing.push(ms.name);
    // ↑ `!ms.has` significa "el mercado lo pide y la persona NO lo tiene": esa es
    //   la definición de brecha. Un `has: true` que sí aparece en la oferta no es
    //   una brecha, es una fortaleza (y sale en `requested`, no en `missed`).
  }

  // ── Roles: los keywords DEL USUARIO que salen en el título de la oferta ────
  const roles = [];
  for (const kw of p.keywords) {
    if (textHasSkill(title, kw)) roles.push(String(kw).trim().toLowerCase());
    // ↑ Se guarda el keyword en minúsculas porque es un resultado de detección,
    //   no vocabulario del usuario: se muestra como un chip ("¿es QA?" → "qa").
    //   El `keywords` del perfil conserva su capitalización original, que la
    //   UI muestra como lo escribió el LLM.
    //   `trim()` antes del toLowerCase evita un chip con espacio en los bordes.
    //   Mismo criterio de matcheo que las skills (palabra completa): es el
    //   criterio único del módulo, y dos criterios distintos dan dos scores.
  }

  // ── RELEVANCIA ────────────────────────────────────────────────────────────
  // El origen tenía DOS cortes: `isQARelevant` (que el rol fuera de QA, o que
  // una keyword de QA saliera en título o tags) y el de "falsa relevancia" (que
  // matcheara alguna skill). Con la relevancia derivada del perfil, los dos
  // cortes se COLLAPSAN en uno: "la oferta habla de mi vocabulario" ya no puede
  // ser verdadero sin que matched o roles tengan algo, y una keyword que
  // aparece solo en un tag sin matchear ninguna skill igual da score 0 (coverage
  // 0 + roleAffinity 0 - penalizaciones, todo ≤ 0, y el clamp lo lleva a 0).
  // Un solo corte, y el comentario que explica por qué.
  //
  // ↑ Además: si el usuario todavía no cargó skills, el 0 es un problema de perfil
  //   y no de mercado. El `comment` lo dice para que el endpoint pueda explicarlo
  //   en vez de devolver una lista vacía sin contexto.
  const relevant = matched.length > 0 || roles.length > 0;
  if (!relevant) {
    return {
      score: 0,
      matched: [],
      missed: [],
      requested: [],
      roles: [],
      inTitle: false,
      // ▲ `comment` no estaba en el contrato del origen. Es un campo NUEVO y
      //   opcional: la UI lo puede mostrar o ignorar. Sirve para que "no hay
      //   resultados" sea accionable ("cargá tus skills") en vez de un misterio.
      comment: hasAnySkill(p)
        ? null
        : 'sin skills cargadas',
    };
  }

  // ── requested: unión de skills del perfil pedidos + del mercado pedidos ───
  // Las skills del perfil que matchearon son, por definición, las skills del
  // perfil que la oferta pide. Así que `requestedPerfil` del origen ES `matched`.
  // No hay que volver a recorrer el perfil preguntando lo mismo otra vez.
  const requested = [...new Set([...matched.map((m) => m.skill), ...requestedMarket])];

  // ── Puntaje ───────────────────────────────────────────────────────────────
  let total = 0;
  let gain = 0;
  for (const { weight, inTitle } of matched) {
    total += weight;
    gain += weight * (inTitle ? 1.5 : 1);
  }
  // ↑ `total` = peso de las skills que pide la oferta y tenemos. `gain` = lo
  //   mismo, con el bonus de título. El cociente de los dos es la cobertura real.
  const coverage = total > 0 ? gain / total : 0;
  const roleAffinity = roles.length;

  let score = 0;
  score += coverage * 55;
  // ↑ 55% del puntaje es cobertura de skills. Es el componente que más pesa y el
  //   que mejor discrimina: dice "de lo que piden, cuánto cubro".
  score += roleAffinity * 12;
  // ↑ 12 por cada keyword del usuario que sale en el TÍTULO.
  //   En el origen esto era `roles.filter(rol QA).length`, o sea contaba
  //   CATEGORÍAS de una lista fija. Acá cuenta los keywords del perfil: la
  //   diferencia es que el techo lo pone el perfil del usuario y no una tabla.
  //   Si una persona tiene 8 keywords que salen en el título, el componente da
  //   96 y el clamp del final lo deja en 100. Es lo correcto: si TODO lo que pedía
  //   el puesto es lo que la persona pidió para el puesto, el match es total.
  score += Math.min(matched.length, 8) * 2;
  // ↑ Bonus por cantidad de skills coincidentes, con tope en 8 skills (16
  //   puntos). El tope existe para que un perfil con 40 skills no sature el
  //   puntaje por volumen en vez de por ajuste.
  score -= Math.min(missing.length, 5) * 3;
  // ↑ 3 puntos por cada skill pedida que NO tenemos, con tope en 5 skills (-15).
  //   El tope evita que una oferta con 15 requisitos inalcancables hunda el score
  //   de una persona que cubre bien los primeros: un puesto es inalcanzable en su
  //   conjunto, no por cada requisito suelto.
  score = Math.min(Math.max(score, 0), 100);

  // ── inTitle: ¿la oferta tiene alguna señal de MI búsqueda en el título? ────
  const inTitle = roles.length > 0 || matched.some((m) => m.inTitle);
  // ↑ Es un superconjunto del `inTitle` del origen (que era "alguna BASE_KEYWORD
  //   en el título"). Ahora también cuenta que una SKILL tuya esté en el título.
  //   El motivo concreto: hoy `keywords` está vacío para todos los perfiles
  //   (el LLM del CV todavía no se implementó, es el paso 7), así que si el campo
  //   fuera solo `roles.length > 0`, `inTitle` sería SIEMPRE false hasta el paso
  //   7 y el badge "esto es lo que pedís" desaparecería de la UI sin aviso. Con el
  //   superconjunto, el badge funciona desde el primer día y después también.
  //   Es el mismo criterio que usaba la UI para el resaltado, sin duplicar la
  //   definición en dos lugares.

  return {
    score: Math.round(score),
    matched: matched.map((m) => m.skill),
    // ↑ `matched` son STRINGS, como en el origen. Que en el interior sean objetos
    //   es un detalle de esta función: lo que sale es lo que la UI y la carta
    //   consumen, y eso es una lista de nombres.
    missed: missing.slice(0, 8),
    requested: requested.slice(0, 12),
    roles,
    inTitle,
  };
}

/**
 * Peso de una skill como número, con default 1.
 *
 * El peso ya viene normalizado de `profile.js`, pero el matcher no puede
 * depender de eso: `computeMatch` es una función PÚBLICA y el paso 7 la va a
 * llamar con el array que devuelve el LLM sin pasar por `normalizeSkills`. Un
 * `undefined` acá hace `NaN`, un `NaN` en `total` arruina `coverage`, y el score
 * sale `NaN` (que al pasar por el clamp queda `NaN`, y el orden por score del
 * ranking pone los NaN al principio: los mejores ofertas al final de la pantalla).
 *
 * @param {unknown} weight El peso tal como vino.
 * @returns {number} Un número, nunca NaN.
 */
function toWeight(weight) {
  const w = Number(weight);
  // ↑ `Number(undefined)` es NaN y `Number(null)` es 0. El `weight == null` previo
  //   manda null/undefined al default 1, que es "no lo sé, lo tomo como skill
  //   completa" (la misma decisión de `normalizeSkills`).
  if (weight === null || weight === undefined || weight === '') return 1;
  return Number.isFinite(w) ? w : 1;
}

/**
 * La fecha de publicación de una oferta, en el orden de campos que usan las
 * fuentes reales.
 *
 * Existe como función y no como `a.date || a.postedAt` en línea por dos motivos:
 * el orden de campos NO es el mismo en todas las fuentes (`jobSources.js` escribe
 * `date`, Apify escribe `postedAtTimestamp` y `postedAt`) y, sobre todo, porque
 * `date` puede ser `''` — el caso real de Remotive cuando la API no trae fecha.
 * Un `''` en el primer campo es *falsy*, así que `a.date || a.postedAt` sí cae
 * al segundo campo, pero `String(a.date ?? a.postedAt)` no: `??` solo salta
 * `null`/`undefined`. Es la misma trampa de `null` vs `''` que
 * `db.js` documenta para el `NUMERIC` (§2.4 de MEMORIA.md): ausente y vacío son
 * cosas distintas.
 *
 * @param {object} job Oferta ya enriquecida.
 * @returns {string} Fecha ISO, o `''` si la oferta no trae ninguna.
 */
function publishedAt(job) {
  return job.date || job.postedAtTimestamp || job.postedAt || '';
}

// ════════════════════════════════════════════════════════════════════════════
// EL RANKING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Ranking maestro: `{ regionKey: [ofertas con match > 0, ordenadas por score] }`.
 *
 * Tres cosas que el origen no tenía o tenía mal:
 *
 *  1. PASA EL PERFIL. El origen llamaba `computeMatch(job)` sin argumento, así
 *     que el segundo parámetro caía en su default y TODAS las ofertas se rankeaban
 *     contra el perfil global de Ali. Era invisible en desarrollo (funcionaba,
 *     porque el global era el único perfil) y era un error de datos en
 *     multiusuario. Acá el perfil es un parámetro obligatorio de la función.
 *
 *  2. NO HAY `assignRegion`. La detección de región vive en `regions.js`
 *     (`matchRegion`), que es el único lugar del proyecto donde se decide qué
 *     países existen y cómo se reconocen. Agregar un país es agregar UNA entrada
 *     ahí; el origen tenía la cadena de `if` duplicada entre `matcher.js`,
 *     `jobSources.js` y `cvProfile.js`, y las tres se desincronizaban.
 *
 *  3. UN BUCKET POR REGIÓN CONFIGURADA, aunque no tenga ofertas. `emptyBuckets()`
 *     arma los buckets desde la configuración, así que la UI siempre ve la misma
 *     forma de respuesta: si el país nuevo tiene cero ofertas, aparece vacío y
 *     no desaparece de las pestañas.
 *
 * @param {object[]} jobs Ofertas (de cualquier fuente).
 * @param {object} profile Perfil del contrato. Va a TODOS los `computeMatch`.
 * @param {number} [topN] Si es > 0, recorta cada región a esa cantidad. Por
 *   defecto 0 = sin recorte: la paginación la hace el frontend.
 * @returns {Record<string, object[]>} Un array de ofertas por región.
 */
export function rankByRegion(jobs, profile, topN = 0) {
  const buckets = emptyBuckets();
  const list = Array.isArray(jobs) ? jobs : [];

  for (const job of list) {
    if (!job || typeof job !== 'object') continue;
    // 1) ¿De qué región es? `matchRegion` normaliza y devuelve null si la oferta
    //    es explícitamente de otro país (regla 1 de regions.js). Se pasa la
    //    ubicación DECLARADA y la `regionGuess` que hayan calculado antes: las dos
    //    son texto de ubicación y el origen las concatenaba exactamente así.
    const loc = `${job.location || ''} ${job.regionGuess || ''}`;
    const hit = matchRegion(loc);
    if (!hit) continue;
    // ↑ Sin región no hay bucket al que ir: la oferta no es alcanzable para
    //   este usuario y se descarta. No entra "en la primera región" como defecto,
    //   que es lo que hacía el origen con su `return 'eeuu'` de último recurso.
    if (!buckets[hit.region]) continue;
    // ↑ La protección de "región no conocida en la lista": sigue valiendo aunque
    //   hoy `matchRegion` solo puede devolver claves de `REGIONS`. Es barata y
    //   evita que un cambio futuro en regions.js contamine el ranking.

    // 2) El match, CONTRA EL PERFIL DE ESTE USUARIO (el fix del punto 1).
    const match = computeMatch(job, profile);
    if (match.score <= 0) continue;
    // 3) Las ofertas sin match no entran al ranking. Un 0 acá no es "irrelevante
    //    para todos", es "no le sirve a ESTE usuario", que es el filtrado real.
    //    OJO: el 0 de `computeMatch` no puede ser NaN (ver `toWeight`): un NaN
    //    comparado con `<= 0` da false y entraría al ranking sin orden.

    // 4) La oferta enriquecida: datos originales (con portal y sourceUrl, que los
    //    puso `withPortal`) más el resultado del match. Es una COPIA, nunca una
    //    mutación: los objetos de `jobs` los comparten `withPortal` y el historial.
    buckets[hit.region].push({ ...job, ...match });
  }

  for (const [region, entries] of Object.entries(buckets)) {
    // ↑ Orden por score descendente. El desempate es por fecha de publicación
    //   cuando hay dos ofertas con el mismo score: sin desempate, dos ofertas con
    //   80% pueden intercambiarse de posición entre una request y la siguiente
    //   (Array.sort no es estable para todo motor, y aunque lo fuera, el orden de
    //   llegada cambia), y el usuario ve que "las mismas ofertas" se mueven solas.
    entries.sort(
      (a, b) =>
        (b.score - a.score) ||
        // ↑ El desempate tiene que leer `date` y NO `postedAt`: las 5 bolsas de
        //   `jobSources.js` normalizan a `date` (publication_date, created_at,
        //   pubDate...) y `postedAt` solo existe en Apify. Con `postedAt` el
        //   desempate comparaba '' contra '' en toda la ruta gratuita, o sea que
        //   no desempata: dos ofertas con el mismo score quedan en orden de
        //   llegada. El mismo orden de campos usa `history.js:45`.
        String(publishedAt(b) || '').localeCompare(String(publishedAt(a) || '')),
    );
    buckets[region] = topN > 0 ? entries.slice(0, topN) : entries;
  }
  return buckets;
}
