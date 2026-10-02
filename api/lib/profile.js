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

import { query } from './db.js';
import { DEFAULT_REGION } from './regions.js';
import { toNumber } from './text.js';

// ↑ `db.js` es el ÚNICO módulo del proyecto que abre conexiones (AGENTS.md). Nadie
//   más importa `pg`; todos pasan por acá. Y nada se abre al importar este
//   archivo: el pool se crea en la primera consulta de verdad, que es lo que
//   permite que `/api/health` responda sin base de datos.

// Mismo regex de auth.js:147. No se importa desde allá porque es una decisión
// local (qué hago con un id inválido) y no una pieza de auth; copiar el patrón es
// menos acoplado que importar una constante que no tiene nada que ver con sesiones.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(String(userId || ''))) return null;
  // ↑ Un id que no es uuid no puede estar en la base. Sin este corte, Postgres
  //   responde con el error de tipo `22P02` y el endpoint devuelve un 500 por un
  //   dato que no puede existir. Se devuelve null, que es la verdad.

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
  if (!UUID_RE.test(String(userId || ''))) return [];
  const { rows } = await query(
    'select name, weight from skills where user_id = $1 order by weight desc, name asc',
    [userId],
  );
  return normalizeSkills(rows);
}

// ════════════════════════════════════════════════════════════════════════════
// Ayudantes de campo
// ════════════════════════════════════════════════════════════════════════════

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
