// ============================================================================
// PERFIL DEL USUARIO: la lectura del perfil derivado del CV.
//
// Este módulo reemplaza al `cvProfile.js` del proyecto origen, que exportaba un
// `const PROFILE` global con los datos hardcodeados de UNA persona. Acá el perfil
// es una fila de la tabla `profiles` más las filas de `skills`, y se busca SIEMPRE
// por `user_id`.
//
// LA REGLA DEL ARCHIVO, y es una sola: todo lo que sale de acá tiene la forma
// exacta del contrato de la API, con la lista de skills SIEMPRE como array
// `[{ name, weight }]`.
//
// Por qué importa tanto la forma: `skills` como array no es una preferencia
// estética, es la forma canónica (decisión 1 de MEMORIA.md §4). El modo de
// falla de esto es SILENCIOSO. Un consumidor que haga `Object.entries(skills)`
// sobre el array no tira error: recibe `[['0', {name, weight}], ...]` y cree que
// tiene un objeto. Y el `.filter(s => s.weight >= 0.9)` sobre la forma mapa lee
// `undefined` en cada skill, así que la lista sale VACÍA sin un error en consola.
// La UI muestra cero skills y todo lo demás anda normal. Por eso la normalización
// vive ACÁ, en un solo lugar, y no repartida en cada endpoint.
//
// NADA se cachea entre llamadas. En serverless no hay estado entre invocaciones
// (ver AGENTS.md), y aunque lo hubiera, este archivo no lo necesita: cada lectura
// va a la base y el costo es el de una consulta.
// ============================================================================

import { query, withTransaction } from './db.js';
import { DEFAULT_REGION } from './regions.js';
import { toNumber } from './text.js';

// ↑ `db.js` es el ÚNICO módulo del proyecto que abre conexiones (AGENTS.md). Nadie
//   más importa `pg`; todos pasan por acá. Y nada se abre al importar este
//   archivo: el pool se crea en la primera consulta de verdad, que es lo que
//   permite que `/api/health` responda sin base de datos. Por eso acá se importan
//   las DOS cosas: `query()` para leer (que toma y suelta un cliente sola) y
//   `withTransaction()` para `saveProfile`, que necesita un cliente FIJO durante
//   varias queries.

// Mismo regex de auth.js:147. No se importa desde allá porque es una decisión
// local (qué hago con un id inválido) y no una pieza de auth; copiar el patrón es
// menos acoplado que importar una constante que no tiene nada que ver con sesiones.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ¿Es un uuid EN FORMA DE STRING?
 *
 * Existe porque `UUID_RE.test(String(x))` NO alcanza, y se verificó contra Postgres
 * que no: `String()` de las cosas que no son strings las convierte igual. Un array
 * de UN elemento hace `String([uuid])` → `'uuid'`, un `new String(uuid)` hace lo
 * mismo, y un objeto con `toString` también. Los tres PASAN el regex y los tres
 * llegan a Postgres, donde `pg` los serializa como ARRAY y la columna `uuid` los
 * rechaza con `22P02 invalid input syntax for type uuid: "{"…"}"` — o sea, un 500
 * por un dato que no puede existir, que es justo lo que el corte tenía que evitar.
 * Un array de DOS elementos sí se delata solo (`'uuid,uuid'` no matchea), lo que
 * hace el agujero más fácil de no ver.
 *
 * Por qué importa igual, siendo que hoy `userId` viene de `requireSession` (que
 * lee el id de la fila de `users`, o sea que siempre es un string de la base): es
 * una función EXPORTADA. El día que alguien la llame con `req.body.userId`, con
 * el resultado de un `split`, o con un `find(...)` que devolvió un array, este
 * chequeo es lo único que separa un 400 de un 500. Y ahora es el mismo corte para
 * las tres funciones del archivo, en vez de dos criterios que se van pareciendo.
 *
 * @param {unknown} value Lo que sea.
 * @returns {boolean} Si es un string con la forma de un uuid.
 */
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}


/** Peso por defecto de una skill si el dato no se puede interpretar. */
const DEFAULT_SKILL_WEIGHT = 1;

// ════════════════════════════════════════════════════════════════════════════
// EL PERFIL VACÍO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Perfil vacío: la forma completa del contrato con todos sus campos en su valor
 * "no hay dato". Existe para dos cosas: que los consumidores no tengan que
 * hacer `if (!profile) return null` en cada campo, y que el matcher pueda
 * devolver `score: 0` con una forma válida en vez de romper.
 *
 * Es una FUNCIÓN y no una constante por una razón concreta: sus arrays y sus
 * objetos son anidados, y si fuera una constante compartida, cualquier consumidor
 * que le hace `push` al `keywords` estaría escribiendo en el perfil de otro
 * usuario (o, en serverless, en el de la invocación anterior). Con una función,
 * cada llamada devuelve objetos nuevos. El costo es despreciable.
 *
 * @returns {object} Perfil nuevo, con la forma del contrato.
 */
export function emptyProfile() {
  return {
    // ▲ Se declara SIEMPRE, aunque hoy valga siempre null: si mañana se usa la
    //   columna, el contrato no cambia y ningún consumidor se rompe. Ver la nota
    //   de `photo` más abajo.
    userId: null,
    fullName: null,
    title: null,
    headline: null,
    location: null,
    // ▲ null, NO 0: "no sé cuántos años tiene" y "tiene 0 años" son cosas
    //   distintas, y la carta de presentación usa el dato para decir "5 años de
    //   experiencia". Un 0 inventaría experiencia a alguien que no la tiene.
    yearsExperience: null,
    summary: null,
    photo: null,
    // ▲ `keywords` y `market_skills` vienen del LLM del CV (migración 002). El
    //   filtro por regex de QA del origen se ELIMINÓ: acá va lo que devolvió el
    //   LLM para ESTE usuario, sin filtrar por profesión.
    keywords: [],
    marketSkills: [],
    projects: [],
    // ▲ Los tres enlaces, duplicados en la raíz. Ver `normalizeProfile`: el
    //   frontend heredado los lee de `profile.linkedin` y los escribe de a uno,
    //   y los nuevos consumidores los leen de `profile.links.github`.
    links: { github: null, portfolio: null, linkedin: null },
    linkedin: null,
    github: null,
    portfolio: null,
    // ▲ SIEMPRE array [{ name, weight }], nunca un objeto. Es el contrato.
    skills: [],
    // ▲ La región por defecto de la app, no un dato del usuario: el scope del
    //   proyecto es Argentina y el perfil no tiene columna de región (la región
    //   es un parámetro de cada búsqueda). Va en el perfil para que los
    //   consumidores que necesitan "una región" no tengan que importarla.
    region: DEFAULT_REGION,
    createdAt: null,
    updatedAt: null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// NORMALIZACIÓN: de fila de la base a contrato de la API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convierte UNA fila de `skills` en el contrato `[{ name, weight }]`.
 *
 * El peso es lo importante acá:
 *   · `numeric(4,3)` ya llega como number por el type parser de `db.js`, pero el
 *     dato también pasa por el LLM del onboarding, que a veces responde `85` en
 *     lugar de `0.85` (por eso la migración NO tiene un check de rango).
 *   · `toNumber(..., 1)` con default 1 (y no 0) porque una skill sin peso
 *     legible tiene que seguir contando como algo que la persona tiene: un peso
 *     0 significa "no la tengo" y un default 0 sacaría la skill del perfil.
 *   · Un peso de 0 real se respeta: "peso ausente" y "peso 0" son cosas distintas
 *     y la fórmula del score las trata distinto.
 *
 * @param {object[]} [rows] Filas de la tabla `skills`.
 * @returns {Array<{name: string, weight: number}>} Skills normalizadas.
 */
export function normalizeSkills(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    // ↑ Se acepta el array de filas de la tabla Y, por comodidad, la forma
    //   [{name, weight}] directa: el LLM devuelve esa forma y quien escriba el
    //   endpoint del onboarding (paso 7) va a tener la fila de skills en la mano
    //   antes de guardarla. Normalizar las dos acá evita dos normalizadores.
    if (!row || typeof row !== 'object') continue;
    const name = String(row.name ?? '').trim();
    if (!name) continue;
    // El nombre YA viene normalizado por la app (migración 003_skills.sql): en
    // minúsculas y sin espacios al borde. No se re-normaliza a mano, porque
    // `normalize()` también saca acentos y un nombre de skill puede ser
    // "atención" o "analítica": mostrarlas sin tilde sería una pérdida.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    // ↑ La unique (user_id, name) de la base ya impide duplicados exactos, pero
    //   esta es la segunda línea: `computeMatch` SUMA los pesos de las skills, así
    //   que un duplicado (aunque solo sea por mayúscula) deformaría el score en
    //   silencio. Detenerlo acá es barato y el costo del error es invisible.
    seen.add(key);
    out.push({ name, weight: clampWeight(toNumber(row.weight, DEFAULT_SKILL_WEIGHT)) });
  }
  // Orden por peso descendente (y por nombre para desempatar, así el orden es
  // estable entre llamadas). El orden de arrival no significa nada para el
  // usuario, y la UI muestra las skills en este orden: las que pesan más arriba.
  out.sort((a, b) => (b.weight - a.weight) || a.name.localeCompare(b.name));
  return out;
}

/**
 * Deja el peso en la escala 0–1 sin romper los casos rarejos del LLM.
 *
 * Si el LLM devolvió `85` en lugar de `0.85`, la migración lo permite a
 * propósito (preferimos un peso raro a un insert que falla y deja al usuario sin
 * perfil), así que se corrige acá: si el número es mayor a 1, se interpreta como
 * porcentaje. Un `1` exacto NO se divide (1 es 1, no 1%). Un 0 se respeta.
 *
 * @param {number} weight El peso tal como vino.
 * @returns {number} Un peso entre 0 y 1.
 */
function clampWeight(weight) {
  const w = toNumber(weight, DEFAULT_SKILL_WEIGHT);
  if (Number.isFinite(w) && w > 0) {
    if (w <= 1) return w;      // ya está en escala 0–1
    if (w <= 100) return w / 100;  // venía en porcentaje (85 → 0.85)
    return 1;                  // valor sin sentido: tope
  }
  return 0; // 0 real, negativo o NaN (ya cubierto por el default de toNumber)
}

/**
 * Normaliza el array de `market_skills` (jsonb) al contrato de la API.
 *
 * El detalle que importa: **`aliases` nunca sale vacío**. El matcher del origen
 * hacía `ms.aliases.some(...)` sin comparar nada, así que un `{name, has}` sin
 * aliases (que es lo que devuelve el LLM si no lo pidió explícitamente) lo
 * reventaba con un TypeError. Acá, si no hay aliases, se usa el nombre: el
 * matcher tiene que poder comparar SIEMPRE.
 *
 * @param {object[]} rows El jsonb `market_skills`.
 * @returns {Array<{name: string, has: boolean, aliases: string[]}>}
 */
function normalizeMarketSkills(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = String(row.name ?? '').trim();
    if (!name) continue;
    const aliases = Array.isArray(row.aliases)
      ? row.aliases.map((a) => String(a ?? '').trim()).filter(Boolean)
      : [];
    out.push({
      name,
      // ↑ `!!` a propósito: el LLM puede mandar `"false"` (string) o `0`. Cualquier
      //   valor que no sea exactamente `true` es "no la tengo". Es una decisión
      //   conservadora: mandar a alguien a estudiar algo que ya tiene es peor que
      //   no sugerírselo.
      has: row.has === true,
      // ↑ `aliases.length ? aliases : [name]` es el arreglo de seguridad del
      //   TypeError del matcher. Ver el comentario de arriba.
      aliases: aliases.length ? aliases : [name],
    });
  }
  return out;
}

/**
 * Normaliza el array de `projects` (jsonb).
 *
 * Las claves van en ESPAÑOL (`nombre`, `descripcion`, `url`, `home`, `lenguaje`)
 * y NO se traducen: es la forma que el frontend heredado ya consume
 * (`AnalysisPage.jsx` lee `p.nombre`, `p.url` y `p.lenguaje`), y traducirlas
 * obligaría a tocar tres consumidores para cambiar un nombre. El resto del
 * contrato es camelCase; esta excepción es deliberada y está anotada acá para que
 * el próximo que lea el código no la "arregle" y rompa la UI.
 *
 * @param {object[]} rows El jsonb `projects`.
 * @returns {object[]} Proyectos con todos sus campos presentes.
 */
function normalizeProjects(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const nombre = String(row.nombre ?? '').trim();
    if (!nombre) continue;
    out.push({
      nombre,
      descripcion: row.descripcion ? String(row.descripcion).trim() : null,
      url: row.url ? String(row.url).trim() : null,
      home: !!row.home,
      lenguaje: row.lenguaje ? String(row.lenguaje).trim() : null,
    });
  }
  return out;
}

/**
 * Normaliza `keywords` (jsonb) a un array de strings no vacíos y sin repetidos.
 *
 * NO se pasan por `normalize()` (que saca acentos y baja a minúsculas): estos
 * keywords se usan además para armar la query de búsqueda de LinkedIn
 * (`apifyLinkedin.js`) y para mostrarlos en la UI. "Inglés" escrito así es mejor
 * que "ingles" escrito así, y la comparación de skills usa su propia
 * normalización, así que acá no se pierde nada por conservar el texto.
 *
 * @param {unknown} rows El jsonb `keywords`.
 * @returns {string[]} Keywords limpios, en el orden en que los dio el LLM.
 */
function normalizeKeywords(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const kw = String(row ?? '').trim();
    if (!kw) continue;
    // ↑ `String()` y no un filtro de `typeof`: un keyword numérico del LLM ("5
    //   años de experiencia") es texto válido, no basura.
    const key = kw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
  }
  return out;
}

/**
 * Deriva el `headline` (la línea de una línea que muestra el CV) cuando no viene.
 *
 * El perfil del origen lo traía hardcodeado: "QA Engineer | Manual &
 * Automation Web y Mobile | ...". Para cualquier usuario hay que derivarlo. La
 * receta es la misma que se ve en ese string: el título, y después las skills que
 * más pesan (que para eso están ordenadas por peso). Si no hay título, se usa la
 * primera oración del resumen, recortada a 120 caracteres para que no se rompa la
 * línea en la UI.
 *
 * @param {object} profile El perfil YA normalizado (skills incluidas).
 * @returns {string|null} El headline, o null si no hay nada de qué derivarlo.
 */
function deriveHeadline(profile) {
  if (profile.title) {
    const top = profile.skills.slice(0, 3).map((s) => s.name);
    return top.length ? `${profile.title} | ${top.join(' | ')}` : profile.title;
  }
  if (profile.summary) {
    // ↑ Sin lookbehind: se parte por un punto seguido de espacio, que es como
    //   separa frases un resumen escrito en prosa.
    const first = String(profile.summary).split(/\.\s+/)[0].trim();
    if (!first) return null;
    return first.length > 120 ? `${first.slice(0, 117)}…` : first;
  }
  return null;
}

/**
 * Convierte la fila CRUDO de `profiles` (más sus skills) al contrato de la API.
 *
 * Se exporta separado de `loadProfile` a propósito: `auth.requireProfile()` ya
 * hizo un `select` de `profiles` y devuelve esa fila, así que un endpoint que lo
 * llama NO debería volver a consultar la tabla para después convertirla. Con esta
 * función, ese endpoint hace `normalizeProfile(profile, await loadProfileSkills(user.id))`:
 * una sola consulta en vez de dos.
 *
 * @param {object|null} row Fila de `profiles` (snake_case), o null.
 * @param {object[]} [skillRows] Filas de la tabla `skills`.
 * @returns {object|null} El perfil del contrato, o null si no hay fila.
 */
export function normalizeProfile(row, skillRows) {
  if (!row || typeof row !== 'object') return null;

  const base = emptyProfile();
  const skills = normalizeSkills(skillRows);
  const links = row.links && typeof row.links === 'object' && !Array.isArray(row.links) ? row.links : {};

  const profile = {
    ...base,
    userId: row.user_id ?? null,
    fullName: trimOrNull(row.full_name),
    title: trimOrNull(row.title),
    location: trimOrNull(row.location),
    yearsExperience: toNumberOrNull(row.years_experience),
    summary: trimOrNull(row.summary),
    // ▲ `photo` SIEMPRE null, aunque la columna exista y tenga algo.
    //   Razón (002_profiles.sql:43-49): la columna está reservada a propósito,
    //   porque una foto real obligaría a decidir el almacenamiento (Vercel Blob,
    //   con su cuenta, su costo y su limpieza) y a decidir qué pasa con la foto
    //   al borrar la cuenta. Devolver `null` explícito es más honesto que
    //   devolver un string que ningún consumidor sabe qué hacer. Si algún día se
    //   implementa el almacenamiento, se cambia UNA línea, acá.
    photo: null,
    keywords: normalizeKeywords(row.keywords),
    marketSkills: normalizeMarketSkills(row.market_skills),
    projects: normalizeProjects(row.projects),
    links: {
      github: trimOrNull(links.github),
      portfolio: trimOrNull(links.portfolio),
      linkedin: trimOrNull(links.linkedin),
    },
    skills,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };

  // ▲ Los tres enlaces, además de en `links`, en la raíz del perfil.
  //   Por qué: `CvPanel.jsx` (frontend heredado) lee `profile.linkedin` y
  //   `profile.github` directamente, y `utils.js:linkedinProfileKeywords()` usa
  //   `profile.linkedin`. Duplicarlos es lo que permite que el frontend que se
  //   está migrando no se rompa hoy, sin esperar a que se migre. Cuando el
  //   frontend pase a leer `links`, se BORRAN las tres líneas de la raíz (y con
  //   ellas, esta nota).
  profile.linkedin = profile.links.linkedin;
  profile.github = profile.links.github;
  profile.portfolio = profile.links.portfolio;

  // El headline NO viene de la base: se deriva del título y de las skills que
  // más pesan (ver `deriveHeadline`). Por eso va al final, después de que las
  // skills estén normalizadas y ordenadas por peso.
  profile.headline = deriveHeadline(profile);

  return profile;
}

// ════════════════════════════════════════════════════════════════════════════
// LECTURA DE LA BASE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Carga el perfil COMPLETO de un usuario: la fila de `profiles` y sus skills.
 *
 * Devuelve `null` si el usuario todavía no subió su CV. Eso NO es un error: es el
 * estado normal de la app, porque el alta es en dos etapas (correo y clave
 * primero, CV después). Por eso los endpoints que necesitan perfil responden 403
 * y no 401 (ver la tabla de compuertas en AGENTS.md), y por eso esta función no
 * tira `HttpError` nunca: decide qué hacer con el null es del endpoint.
 *
 * Las dos consultas van en paralelo (no secuenciales) a propósito: en serverless
 * cada ida y vuelta a la base tiene su costo en milisegundos de Cold Start y de
 * red, y el caso normal es que el perfil EXISTE, así que las dos se necesitan
 * siempre. El precio es una consulta de `skills` de más para un usuario sin
 * perfil, que es un estado transitorio (dura hasta que sube el CV) y una sola vez
 * por usuario.
 *
 * @param {string} userId UUID del usuario.
 * @returns {Promise<object|null>} El perfil del contrato, o null si no hay CV.
 */
export async function loadProfile(userId) {
  if (!isUuid(userId)) return null;
  // ↑ Un id que no es uuid no puede estar en la base. Sin este corte, Postgres
  //   responde con el error de tipo `22P02` y el endpoint devuelve un 500 por un
  //   dato que no puede existir. Se devuelve null, que es la verdad.
  //   El `typeof` lo hace `isUuid`, no el `String()` que había antes: ver la nota
  //   de `isUuid`, es un agujero que se verificó contra Postgres.

  const [profileRes, skillsRes] = await Promise.all([
    query(
      // ↑ Las columnas se listan una por una y NO se usa `select *`: el select
      //   tiene que seguir funcionando cuando se agregue una columna, y sobre
      //   todo tiene que refrainar de exponer lo que aparezca después (misma
      //   decisión que auth.js:652).
      `select user_id, full_name, title, years_experience, summary, location,
              keywords, market_skills, projects, links, created_at, updated_at
         from profiles
        where user_id = $1`,
      [userId],
    ),
    query('select name, weight from skills where user_id = $1 order by weight desc, name asc', [userId]),
  ]);

  const row = profileRes.rows[0];
  // ↑ Se mira el perfil y no las skills para decidir si hay perfil: la fila de
  //   `profiles` es la que define si el CV se subió. Un usuario con perfil y cero
  //   skills es un caso real (CV sin skills reconocibles) y NO es "sin perfil":
  //   tiene que recibir un perfil con `skills: []`, no null.
  if (!row) return null;

  return normalizeProfile(row, skillsRes.rows);
}

/**
 * Carga SOLO las skills de un usuario, ya en el contrato `[{ name, weight }]`.
 *
 * Existe para los endpoints que ya tienen la fila de `profiles` en la mano (los
 * que usan `requireProfile`) y solo necesitan las skills: evita una segunda
 * consulta a `profiles` para convertir una fila que ya tienen.
 *
 * @param {string} userId UUID del usuario.
 * @returns {Promise<Array<{name: string, weight: number}>>} Las skills, o `[]`.
 */
export async function loadProfileSkills(userId) {
  if (!isUuid(userId)) return [];
  const { rows } = await query(
    'select name, weight from skills where user_id = $1 order by weight desc, name asc',
    [userId],
  );
  return normalizeSkills(rows);
}

// ════════════════════════════════════════════════════════════════════════════
// ESCRITURA DEL PERFIL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Guarda el perfil de un usuario y devuelve lo que quedó guardado.
 *
 * ES UN REEMPLAZO, NO UN PARCHE, y esa es la decisión más importante de esta
 * función: lo que se pasa es el perfil COMPLETO y lo que se escribe es
 * exactamente eso. Un campo que no viene en el `draft` se borra, y en particular
 * `skills` se BORRA y se reescribe entera. La razón es que la fuente del perfil
 * es el CV entero, no un diff: "este usuario ya no tiene esta skill" no es un
 * evento que alguien nos reporte, es la consecuencia de haber analizado un CV
 * nuevo. Un `upsert` por skill (`on conflict (user_id, name) do update`) resolvería
 * el problema del peso repetido y dejaría vivas para siempre las skills que el
 * usuario ya no tiene, y eso no se puede detectar leyendo el resultado: el
 * `matcher` sumaría las dos.
 *
 * La consecuencia para quien llama: si quiere cambiar UN campo, tiene que mandar
 * el perfil entero (que es lo natural: el endpoint de onboarding tiene el perfil
 * completo en la mano, y un `PATCH` parcial es una API distinta que este proyecto
 * todavía no tiene).
 *
 * Lo que se devuelve es el perfil LEÍDO de vuelta de la base, pasado por
 * `normalizeProfile`, y no una mezcla del input con lo escrito. Es lo que
 * garantiza que lo que el endpoint responda y lo que el próximo `loadProfile`
 * devuelva sean idénticos, incluido el `headline` derivado y el orden de las
 * skills por peso. Normalizar el input y devolver eso sería casi lo mismo, pero
 * "casi": el `numeric(3,1)` de los años redondea, y un perfil armado en memoria
 * diría `7.55` donde la base dice `7.6`.
 *
 * @param {string} userId UUID del usuario. Sale de `requireSession(req)` en el
 *   endpoint, NUNCA del cuerpo del request (ver la nota del filtro).
 * @param {object} [draft] Perfil completo con la forma del contrato de la API
 *   (`fullName`, `title`, `yearsExperience`, `summary`, `location`, `keywords`,
 *   `marketSkills`, `projects`, `links`, `skills`). Ausente o `null` es un perfil
 *   vacío, que es un estado válido.
 * @returns {Promise<object|null>} El perfil guardado, ya normalizado y leído de la
 *   base, o `null` si el `userId` no es un uuid (mismo criterio que `loadProfile`).
 * @throws {Error} Lo que tire `pg` (una restricción de la base, o la conexión).
 *   `withTransaction` ya hizo el ROLLBACK: nunca queda medio perfil.
 */
export async function saveProfile(userId, draft) {
  if (!isUuid(userId)) return null;
  // ↑ Mismo corte y mismo valor de vuelta que `loadProfile` (`profile.js:423-428`),
  //   y por el mismo motivo: un id que no es un uuid no puede existir, así que
  //   mandarlo a Postgres produce el error de tipo `22P02` y el endpoint termina
  //   devolviendo un 500 por un dato imposible. No es un `HttpError` porque el
  //   endpoint ya validó la sesión antes de llegar acá: si se llega con un id
  //   inválido, el problema no es del usuario y no se le responde con un 400.
  //   Y se corta ACÁ, antes de abrir la transacción, para no pedir un cliente del
  //   pool (y un `begin`) por una llamada que no va a escribir nada.

  // ── El draft, con la forma del contrato ──────────────────────────────────────

  const src = draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
  // ↑ Un `draft` ausente, `null`, un string o un array se tratan como "un perfil
  //   sin nada". Es deliberado y NO es un atajo: `null` es un estado VÁLIDO de la
  //   app (el usuario existe sin CV todavía) y el endpoint tiene que poder guardar
  //   un perfil a medio completar sin que eso sea un error de programación.

  // ── Todo se NORMALIZA ANTES de escribir, no después ─────────────────────────
  //
  // Se usan los MISMOS normalizadores que van a leer estas columnas después, y
  // esa es la parte que no es obvia: es lo que hace que guardar sea idempotente
  // de verdad. `normalizeProfile(normalizeProfile(x))` da `x` otra vez, así que
  // si se escribe la forma normalizada, el segundo guardado del mismo perfil deja
  // exactamente lo mismo y la respuesta del endpoint nunca difiere de lo que
  // devuelve la lectura siguiente.
  //
  // Y hay una segunda razón, que es la que justifica NO confiar en el draft:
  // `profiles` tiene cuatro checks `jsonb_typeof(...)` (`002_profiles.sql:97-100`)
  // y Postgres los hace cumplir con `23514`. Se comprobó contra la base que un
  // objeto en `keywords` revienta con `profiles_keywords_array`, un array en
  // `links` con `profiles_links_object`, y así con las otras dos. O sea que el
  // normalizador no es solo una cuestión de prolijidad: es lo que evita un 500
  // con un mensaje de Postgres que no dice nada del campo del body que vino mal.

  const fullName = trimOrNull(src.fullName);
  const title = trimOrNull(src.title);
  const location = trimOrNull(src.location);
  const summary = trimOrNull(src.summary);
  const yearsExperience = clampYears(src.yearsExperience);
  const keywords = normalizeKeywords(src.keywords);
  const marketSkills = normalizeMarketSkills(src.marketSkills);
  const projects = normalizeProjects(src.projects);
  const links = normalizeLinks(src.links, src);

  const skills = normalizeSkills(src.skills).map((skill) => ({
    // ↑ `normalizeSkills` se REUTILIZA tal cual y por lo que ya sabe hacer:
    //   descarta las entradas sin nombre, deduplica por nombre en minúsculas
    //   (la `unique (user_id, name)` no alcanza para eso, porque también compara
    //   mayúsculas y espacios) y RECORTA EL PESO con `clampWeight`. Ese recorte es
    //   la defensa contra el peso que manda el LLM: el modelo a veces responde
    //   "85" en lugar de "0.85", la columna `numeric(4,3)` lo aceptaría (hasta
    //   9.999) y NO tiene check a propósito (`003_skills.sql:42-47`), así que sin
    //   este recorte la app guardaría un peso de 85 y `matcher.js` lo sumaría como
    //   si fuera un 8500% de dominio. Acá queda entre 0 y 1 antes de tocar la base.
    //
    //   Lo que `normalizeSkills` NO hace, a propósito, es bajar el nombre a
    //   minúsculas: no lo hace porque no quiere perder acentos ni capitalización
    //   en lo que el usuario declaró (`profile.js:135-138`). Para ESCRIBIR sí hace
    //   falta, porque `003_skills.sql:31-34` dice que el nombre se guarda ya
    //   normalizado y sin espacios al borde.
    name: skill.name.toLowerCase(),
    weight: skill.weight,
  }));
  // ↑ Y NO se usa `normalize()` de `regions.js`/`text.js` para sacar acentos:
  //   `String.normalize()` además de bajar a minúsculas DESCOMPONE y borra la tilde
  //   (`atención` → `atencion`), y una skill es texto que la persona ve en la
  //   pantalla. Perder la tilde es una pérdida visible que no compra nada: la
  //   comparación de skills contra el texto de las ofertas usa su propia
  //   normalización (`textHasSkill`, que normaliza los DOS lados), así que el
  //   nombre guardado puede llevar acentos sin que el match cambie.

  // ── Las dos escrituras, en UNA transacción ───────────────────────────────────

  return withTransaction(async (client) => {
    // ↑ `withTransaction` y NO `query()` para cada paso. El motivo es concreto:
    //   `query()` toma un cliente DEL POOL por llamada, así que las cuatro queries
    //   de abajo caerían en cuatro conexiones distintas y el `begin`/`commit` no
    //   envolvería nada. Usando el `client` que da la transacción, las cuatro van
    //   por la misma conexión. (También evita el modo de starve que `db.js:85-93`
    //   menciona: si alguien bajara `PG_POOL_MAX` a 1, un `query()` adentro del
    //   callback se quedaría esperando el único cliente que esta transacción tiene
    //   tomado.)

    const { rows } = await client.query(
      // ↑ `user_id` va como `$1` y en la lista de columnas, y NO se lee del draft.
      //   Esta es LA regla del archivo: cada query filtra por `user_id`, siempre.
      //   Es el error más probable al pasar de un JSON global a SQL, y la única
      //   forma de que pase es que el `user_id` venga del body —entonces cualquiera
      //   que mande un draft con el `userId` de otro le pisa el perfil. El
      //   endpoint lo saca de `requireSession(req)`, que ya verificó la cookie
      //   firmada; el body no tiene ninguna autoridad sobre a quién se escribe.
      //
      //   `on conflict (user_id)`: `user_id` es la PRIMARY KEY de `profiles`
      //   (`002_profiles.sql:22`), o sea que la unicidad la impone la base y
      //   re-subir el CV actualiza la fila que ya existe. Nunca inserta una
      //   duplicada, y nunca borra y reinserta (que tiraría la fila y su
      //   `created_at` con ella).
      //
      //   La lista de columnas es EXPRESA y `photo` NO está: esa columna está
      //   reservada y siempre tiene que quedar en NULL, y la migración dice
      //   explícitamente que escribirla es un error de desarrollo
      //   (`002_profiles.sql:43-49`). Como no tiene default, omitarla la deja en
      //   NULL; y al no estar tampoco en el `do update`, un guardado nunca pisa lo
      //   que hubiera. `normalizeProfile` además fuerza `photo: null` al leer
      //   (`profile.js:329-336`), así que ni siquiera se filtra.
      //
      //   `created_at` NO está en el `do update` por la misma lógica: tiene que
      //   seguir diciendo cuándo se creó el perfil, no cuándo se re-subió el CV.
      //   Para eso está `updated_at`.
      //
      //   `updated_at = now()` lo escribe el backend a propósito: la tabla NO tiene
      //   trigger (`002_profiles.sql:104-108`, que explica por qué), así que si no
      //   se pone acá la columna nunca cambia y nadie puede responder "¿este
      //   usuario volvió a subir el CV?".
      `insert into profiles (
         user_id, full_name, title, years_experience, summary, location,
         keywords, market_skills, projects, links, updated_at
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, now()
       )
       on conflict (user_id) do update set
         full_name        = excluded.full_name,
         title            = excluded.title,
         years_experience = excluded.years_experience,
         summary          = excluded.summary,
         location         = excluded.location,
         keywords         = excluded.keywords,
         market_skills    = excluded.market_skills,
         projects         = excluded.projects,
         links            = excluded.links,
         updated_at       = now()
       returning user_id, full_name, title, years_experience, summary, location,
                 keywords, market_skills, projects, links, created_at, updated_at`,
      // ↑ Los cuatro `::jsonb` son EXPLICITOS, y OJO: se verificó contra Postgres
      //   que NO son estrictamente necesarios en este INSERT. Sin ellos el guardado
      //   funciona igual, porque Postgres deduce el tipo del parámetro a partir de
      //   la columna destino de la lista de `values` y castea el texto solo (se
      //   probó con y sin, con el mismo resultado). O sea que el casteo no está
      //   arreglando un error: está para que la intención esté escrita en el SQL y
      //   no dependa de una inferencia que es implícita. La inferencia se rompe
      //   sola en cuanto el mismo parámetro se usa en otro contexto (un CTE, un
      //   `select jsonb_array_length($2)`, una firma ambigua) y ahí sí el error es
      //   "columna keywords es de tipo jsonb pero la expresión es de tipo text",
      //   que no dice nada de qué parámetro era. También evita el caso raro de que
      //   `pg` mande el string como `unknown` y la conversión quede en manos del
      //   cliente en vez del servidor.
      [
        userId,
        fullName,
        title,
        yearsExperience,
        summary,
        location,
        toJsonb(keywords, '[]'),
        toJsonb(marketSkills, '[]'),
        toJsonb(projects, '[]'),
        toJsonb(links, '{}'),
      ],
    );
    // ↑ `returning` en vez de un `select` después: la fila que se acaba de escribir
    //   y la que se devuelve son la MISMA, con el `keywords` ya parseado en objeto
    //   por el driver y los `numeric` ya convertidos a number por el type parser de
    //   `db.js`. La lista de columnas es la misma que usa `loadProfile`, a
    //   propósito: es lo que hace que el valor devuelto y el valor leído después
    //   no puedan divergir.
    const row = rows[0];
    // ↑ Si el `user_id` no existiera en `users`, el INSERT falla por la FK y no
    //   hay `row` que mirar. No hace falta un chequeo: nunca se llega acá.

    // ── Las skills: se borran y se reinsertan, en la misma transacción ─────────

    await client.query('delete from skills where user_id = $1', [userId]);
    // ↑ Borra SOLO las de este usuario, y por qué borrar en vez de upsert: el
    //   `unique (user_id, name)` permite `on conflict (user_id, name) do update set
    //   weight = excluded.weight`, pero eso deja viva para siempre la skill que el
    //   usuario ya no tiene, y no hay forma de distinguirlas de las que sí. Con el
    //   perfil viniendo del CV entero (no de un diff), la lista correcta de skills
    //   es exactamente la que se pasó: reescribirla es más honesto que intentar
    //   calcular la diferencia que nadie nos pidió.
    //
    //   Y va DENTRO de la transacción a propósito: si el `insert` de skills fallara
    //   después de este delete, el ROLLBACK devuelve las viejas. Fuera de la
    //   transacción, este es el modo de falla silencioso del proyecto: perfil
    //   guardado y cero skills, `matcher.js` matchea contra un array vacío y la app
    //   le muestra cero ofertas SIN NINGÚN ERROR en ninguna parte.

    if (skills.length) {
      await client.query(
        // ↑ Un solo INSERT para todas las skills, con `unnest` de dos arrays: el
        //   texto del SQL es el SIEMPRE IGUAL (importa para el log y para leerlo)
        //   y no hay que concatenar placeholders en un loop. Las columnas de
        //   `skills` NO son jsonb: son filas, y por eso esto no usa `toJsonb`.
        `insert into skills (user_id, name, weight)
         select $1, name, weight
           from unnest($2::text[], $3::numeric[]) as t(name, weight)`,
        [
          userId,
          skills.map((skill) => skill.name),
          // ↑ Números, no strings: el type parser de `db.js` convierte el NUMERIC a
          //   number AL LEER; al escribir lo que viaja es un número en el array y
          //   el `::numeric[]` lo castea. Los pesos ya vienen recortados a [0,1]
          //   por `clampWeight`, así que nunca pueden exceder el `numeric(4,3)`
          //   (que llega hasta 9.999) ni dar un overflow silencioso.
          skills.map((skill) => skill.weight),
        ],
      );
    }
    // ↑ El `if` evita el INSERT vacío, que no haría nada: `unnest` de dos arrays
    //   vacíos devuelve cero filas. Está por claridad, no por corrección, y porque
    //   un "perfil sin skills" es un caso REAL (un CV que no tiene nada
    //   reconocible) que va a aparecer seguido.

    // ── Se lee de vuelta lo que quedó, y se devuelve normalizado ───────────────

    const { rows: skillRows } = await client.query(
      'select name, weight from skills where user_id = $1 order by weight desc, name asc',
      [userId],
    );
    // ↑ La MISMA query y el MISMO orden que `loadProfileSkills`, y se corre DENTRO
    //   de la transacción para que vea estos inserts y no los de otro. Trae filas
    //   crudas de la tabla a propósito: `normalizeProfile` es el que las pasa por
    //   `normalizeSkills`, y así lo que se devuelve es literalmente lo que va a
    //   devolver la próxima lectura, no una copia en memoria de lo que se cree que
    //   se escribió.

    return normalizeProfile(row, skillRows);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Ayudantes de campo
// ════════════════════════════════════════════════════════════════════════════

/**
 * Años de experiencia listos para una columna `numeric(3,1)`.
 *
 * `toNumberOrNull` alcanza para leer (y por eso se usa tal cual adentro), pero
 * NO recorta: sin este recorte, un `draft.yearsExperience` de 120 (que el LLM ya
 * recorta en `llm.js:yearsOrNull`, pero que un endpoint que arma el draft a mano
 * no) es un `numeric field overflow` y el guardado entero falla. Es el mismo
 * criterio que el peso: un dato raro se recorta, no se tira abajo el perfil.
 *
 * Un NEGATIVO es `null` y no `0`, igual que en `llm.js:868`: "-3 años de
 * experiencia" no es "tiene cero años de experiencia", es un dato roto, y
 * convertirlo en cero sería inventarle un dato al usuario.
 *
 * @param {unknown} value Lo que venga en el draft.
 * @returns {number|null} Entre 0 y 99.9 con decimales, o null.
 */
function clampYears(value) {
  const n = toNumberOrNull(value);
  if (n === null || n < 0) return null;
  return Math.min(n, MAX_YEARS_EXPERIENCE);
}

// Tope de años de experiencia. Es el máximo de `numeric(3,1)` en
// `002_profiles.sql:38`. El mismo número, y por el mismo motivo, que el
// `MAX_YEARS_EXPERIENCE` de `llm.js:874`.
const MAX_YEARS_EXPERIENCE = 99.9;

/**
 * Los tres links del contrato, listos para la columna `links` (un OBJETO jsonb).
 *
 * Existe por una asimetría entre los dos lados del archivo: el LECTOR
 * (`normalizeProfile`) arma `links` FIJO con las tres claves y lee de la fila, y el
 * que tiene que ASCERCIARSE de que la fila tenga un objeto jsonb es el que escribe.
 * Sin esta función habría que confiar en que el `draft` vino bien formado, y el precio
 * de que no venga es un INSERT que revienta con el check
 * `profiles_links_object` — un 500 por un dato que se podía normalizar.
 *
 * El `src` de atrás es el fallback a las claves de la raíz (`src.linkedin`), y es
 * el mismo criterio que `llm.js:normalizeLinks`: `normalizeProfile` duplica los
 * tres links en la raíz del perfil, así que un `draft` que venga de un
 * `loadProfile()` los tiene en los dos lugares y hay que leerlos de los dos.
 *
 * `||` y no `??`: un `links.github` vacío tiene que caer al de la raíz, y `''` es
 * "no hay dato" en todo este archivo (`trimOrNull`).
 *
 * @param {unknown} links El `links` del draft.
 * @param {object} [src] El draft completo, para buscar los links en la raíz.
 * @returns {{github: string|null, portfolio: string|null, linkedin: string|null}}
 */
function normalizeLinks(links, src = {}) {
  const obj = links && typeof links === 'object' && !Array.isArray(links) ? links : {};
  // ↑ Un `links` que sea un ARRAY o un string (que es lo que el LLM a veces manda,
  //   ver `llm.js:1053-1056`) se trata como objeto vacío: acá no hay nada que
  //   adivinar, y un objeto vacío siempre pasa el check de la base.
  return {
    github: trimOrNull(obj.github) || trimOrNull(src.github),
    portfolio: trimOrNull(obj.portfolio) || trimOrNull(src.portfolio),
    linkedin: trimOrNull(obj.linkedin) || trimOrNull(src.linkedin),
  };
}

/**
 * El TEXTO JSON de un valor, para mandarlo a una columna jsonb.
 *
 * Vive en un helper y no inline en el `insert` por una razón práctica: el valor
 * y su casteo `::jsonb` tienen que viajar JUNTOS. Si el `JSON.stringify` se
 * escribiera en un lado y el `::jsonb` en otro, tarde o temprano alguien agrega
 * una quinta columna jsonb y se olvida de uno de los dos, y el error es un 500
 * con un mensaje de Postgres que no dice nada del código.
 *
 * El `\u0000` se borra porque es el ÚNICO carácter de control que `jsonb` rechaza:
 * Postgres responde `22P05 unsupported Unicode escape sequence`. Se comprobó uno
 * por uno contra Postgres 16, y el resto entra sin problema — `\u0007` (BEL),
 * `\u0009` (TAB), `\u000a` (LF), `\u007f` (DEL) y hasta el BOM `\ufeff` se
 * guardan bien—, así que este es el único que hay que sacar. `JSON.stringify` lo
 * emite como el escape de 6 caracteres `\u0000`, y por eso lo que se busca en el
 * texto es esa secuencia y no el byte crudo. Con esto, un draft con un byte raro
 * se guarda sin él en vez de devolver un 500. No hay ninguna otra cosa que quitar:
 * el resto de los escapes de `JSON.stringify` son válidos en `jsonb`.
 *
 * @param {unknown} value El array u objeto a serializar.
 * @param {string} [fallback] Texto a devolver si `JSON.stringify` no puede
 *   serializar (ciclo, `undefined`). Con los normalizadores de arriba nunca pasa:
 *   siempre devuelven un array o un objeto planos.
 * @returns {string} JSON listo para `::jsonb`.
 */
function toJsonb(value, fallback = '[]') {
  const json = JSON.stringify(value);
  return (json === undefined ? fallback : json).replace(/\\u0000/g, '');
}

/** Un string limpio, o null. Un string vacío es "no hay dato", no un dato. */
function trimOrNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * Años de experiencia como number, o null.
 *
 * null y no 0, como en `emptyProfile`: la carta de presentación no tiene que
 * poder decir "0 años de experiencia" sobre alguien que no declaró el dato.
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fecha a ISO 8601, o null.
 *
 * `pg` devuelve `timestamptz` como un `Date` de JavaScript, así que `toISOString`
 * funciona. El `instanceof Date` está porque una fila constructed a mano (en un
 * test, o si algún día el perfil se arma sin base) puede traer un string.
 */
function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const s = String(value);
  return s || null;
}
