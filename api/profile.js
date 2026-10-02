// ============================================================================
// /api/profile — EL PERFIL DEL USUARIO, EN LAS DOS DIRECCIONES
//
// Este archivo es la segunda mitad del alta en dos etapas: donde el CV del que
// habla `cv/parse.js` SE PERSISTE, y donde se lee.
//
// ── EL FLUJO COMPLETO, QUE ES LO QUE HACE ENTENDER LAS DOS COMPUERTAS ─────────
//
//   POST /api/register     correo + clave ──► `users` + cookie      (paso 5)
//   POST /api/cv/parse     el CV ──► LLM ──► perfil DERIVADO, `saved: false`
//        │                                                              (paso 7)
//        │  el usuario revisa y corrige el formulario (nada guardado todavía)
//        ▼
//   PUT  /api/profile      ◄── ACÁ SE ESCRIBE `profiles` + `skills`
//        │
//        ▼
//   GET  /api/profile      ◄── ACÁ SE LEE
//
// La fila de `profiles` es la que decide si el usuario "completó el alta":
// `auth.hasProfile()` hace `select 1 from profiles where user_id = $1`, y
// `GET /api/me` devuelve eso como `profileComplete`. No hay un campo "alta
// completa" en `users`, y no debe haberlo: el perfil ES la segunda etapa.
//
// ── POR QUÉ GET USA `requireProfile` Y PUT USA `requireSession` ───────────────
// Son las dos compuertas de `auth.js` (ver la tabla de AGENTS.md) y cada una va
// en el método donde corresponde. Lo que NO se puede es usar la misma en los dos:
//
//   · GET es una LECTURA. Si el usuario no tiene perfil, un 200 con un perfil
//     vacío sería una respuesta que no es cierta: la fila no existe. Y un 401
//     mandaría a /login a alguien que YA está logueado (el bucle sin salida que
//     `me.js` explica). Entonces: 401 sin cookie, 403 con cookie y sin CV.
//     Eso es exactamente lo que hace `requireProfile`.
//
//   · PUT es la ESCRITURA que CREA el perfil. Si usara `requireProfile`, el
//     primer guardado de todo usuario fallaría con un 403 que dice "subí tu
//     CV", cuando el único propósito de la llamada es subirlo. El 403 de "te falta
//     CV" es correcto en un endpoint que CONSUME el perfil y es un bug en el que
//     lo produce.
//
// ── POR QUÉ GET DEVUELVE EL PERFIL PLANO Y NO UN ENVOLTORIO ───────────────────
// `GET /api/me` devuelve `{ user, profileComplete }` porque tiene DOS datos que
// devolver y un shape propio. Este devuelve UN perfil, y lo devuelve DESNUUDO. La
// razón es que el consumidor ya existe y no se puede cambiar:
//
//   · `frontend/src/api.js:48-60` hace `return await res.json()` y lo usa como si
//     fuera el perfil entero.
//   · `CvPanel.jsx:11-70` lee `profile.skills`, `profile.fullName`,
//     `profile.headline`, `profile.title`, `profile.linkedin`.
//   · `utils.js:linkedinProfileKeywords()` lee `profile.linkedin`.
//
// Envolverlo en `{ ok, profile }` haría que la pantalla de perfil mostrara un
// perfil vacío con CERO errores en la consola: `profile.skills` sería undefined
// sobre el objeto envoltorio, `Array.isArray(undefined)` es false, y el panel
// cae en su rama de "sin skills". Es el modo de falla silencioso del frontend
// heredado, así que la decisión es: si algún día hay que cambiar el shape, se
// cambia `api.js` Y sus consumidores en el mismo commit, no el endpoint solo.
//
// PUT sí devuelve un envoltorio, y no por capricho de simetría: devuelve el
// resultado de una operación (`ok`), la bandera que el frontend ya conoce para
// rutear (`profileComplete`) y el perfil guardado. Son tres cosas, no una.
//
// ── POR QUÉ PUT ES UN REEMPLAZO Y NO UN PARCHE ────────────────────────────────
// `profile.saveProfile` borra las skills y las reescribe, así que la fuente del
// perfil es el CV ENTERO, no un diff: "esta persona ya no tiene esta skill" no
// es un evento que alguien reporte, es la consecuencia de haber analizado un CV
// nuevo. Por eso el verbo es PUT (reemplazo del recurso entero) y no PATCH
// parcial, que además esta API no tiene. La consecuencia para el cliente está
// escrita en el JSDoc de `saveProfile`: para cambiar UN campo hay que mandar el
// perfil entero, que es lo natural en el onboarding, donde el frontend tiene el
// perfil completo en la mano.
//
// ── `user_id`: SIEMPRE DE LA SESIÓN, NUNCA DEL BODY ───────────────────────────
// `saveProfile` vuelve a aplicar esta regla en SQL (`profile.js:594-604`), pero
// el endpoint la aplica antes, al no leer NADA de identidad del body. El body
// puede traer `userId`, `id`, `email` o lo que sea: se ignoran en silencio. No
// son un error porque un cliente razonable manda el perfil entero, y el perfil
// que devuelve `/api/cv/parse` (y luego `GET`) tiene `userId` adentro; rechazar
// la llamada obligaría al frontend a tener que BORRAR un campo antes de mandar.
//
// ── ESTE ARCHIVO NO ES DONDE SE NORMALIZA ─────────────────────────────────────
// Los normalizadores (skills, keywords, market skills, projects, links) viven en
// `profile.js`, que es el que lee y el que escribe, y por eso el guardado es
// idempotente de verdad. Acá lo que hay es una VALIDACIÓN de lo que llega de un
// formulario: tipos, topes de longitud, topes de cantidad y URLs http(s). El
// motivo de que los dos capas estén separadas es que `profile.js` no puede
// tirar `HttpError` (sus functions devuelven `null` o la excepción de `pg`), y un
// endpoint necesita decir "el nombre es obligatorio" con un 400, no con un 500.
// ============================================================================

import { requireProfile, requireSession } from './lib/auth.js';
import { HttpError, readJsonBody, sendJson, withErrorHandling } from './lib/http.js';
import { loadProfileSkills, normalizeProfile, normalizeSkills, saveProfile } from './lib/profile.js';
import { asText, toNumber } from './lib/text.js';

// ↑ `loadProfile` NO se usa, y no es un olvido: `requireProfile` ya hizo el select
//   de `profiles` y devuelve la fila cruda, así que volver a consultar la tabla
//   para después convertirla sería una segunda ida y vuelta a la base por un dato
//   que ya está en la mano. Por eso se usan las DOS piezas sueltas
//   (`normalizeProfile` + `loadProfileSkills`): una consulta en vez de dos. Es el
//   motivo por el que `profile.js:345` exporta `normalizeProfile` separado.
//
// ↑ `normalizeSkills` SÍ se usa, y no para normalizar (eso lo hace `saveProfile`)
//   sino para VALIDAR y deduplicar antes de escribir: si el formulario mandó la
//   misma skill dos veces con distinta capitalización, se detecta acá y se
//   responde con 400 en vez de guardar un perfil que el `matcher` va a sumar dos
//   veces. `normalizeSkills` ya trae el recorte de peso (`clampWeight`), que es la
//   defensa contra el LLM que responde `85` en lugar de `0.85`.
export const config = { maxDuration: 30 };

// ════════════════════════════════════════════════════════════════════════════
// TOPES
// ════════════════════════════════════════════════════════════════════════════

// Los topes de LONGITUD son de la base y de la UI, no del gusto: los caracteres
// de más no se truncan en el medio de una palabra, se recortan en el borde, y lo
// que se descarta es texto que el usuario escribió y no va a volver a ver.
const MAX_NAME_CHARS = 120;
const MAX_TITLE_CHARS = 160;
const MAX_LOCATION_CHARS = 160;
const MAX_SUMMARY_CHARS = 2000;
const MAX_SKILL_CHARS = 80;
const MAX_KEYWORD_CHARS = 120;
const MAX_URL_CHARS = 300;
const MAX_PROJECT_NAME_CHARS = 160;
const MAX_PROJECT_DESC_CHARS = 1000;
const MAX_PROJECT_LANG_CHARS = 80;

// Los topes de CANTIDAD son la mitad "cantidad" del rate limit del body. El
// `readJsonBody` corta el body entero en 64 KB, así que un body enorme no llega;
// lo que sí llega es un body de 64 KB con 300 skills de 80 caracteres, que es
// legal para Postgres pero es basura: nadie tiene 300 skills, y `matcher` las
// recorre todas contra el texto de cada oferta. El costo del recorte es cero
// (nadie tiene 60 skills) y el beneficio es que el peor caso está acotado.
const MAX_SKILLS = 60;
const MAX_KEYWORDS = 30;
const MAX_MARKET_SKILLS = 60;
const MAX_PROJECTS = 30;
const MAX_ALIASES = 8;

// `numeric(3,1)` de `profiles.years_experience`: 99.9 es su máximo. El mismo
// número y el mismo motivo que `profile.js:MAX_YEARS_EXPERIENCE`; se repite acá
// porque el endpoint es quien decide si el dato es creíble, y un 120 (que el LLM
// ya recorta) sería un `numeric field overflow`: un 500 por un dato del
// formulario, que es el peor lugar para un 500.
const MAX_YEARS = 99.9;

/** Un string limpio, recortado al tope, o null. Un string vacío es "no hay dato". */
function cleanText(value, maxChars) {
  if (value === null || value === undefined) return null;
  const s = asText(value).trim();
  if (!s) return null;
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

/**
 * Años de experiencia, o null.
 *
 * null y no 0 (mismo criterio que `llm.js` y `profile.js`): "no lo declaraste" y
 * "tiene cero años" son datos distintos, y la carta de presentación usa este
 * número para decir "5 años de experiencia". Un negativo es null: "-3 años" es un
 * dato roto, no un dato.
 */
function cleanYears(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = toNumber(value, Number.NaN);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MAX_YEARS);
}

/**
 * Una URL http(s), o null.
 *
 * TRES decisiones, y las tres importan:
 *
 *   · Se COMPLETA el esquema si falta. El LLM no normaliza los links
 *     (`llm.js:1082-1086` lo dice: no valida el formato entero), así que el
 *     formulario de revisión puede traer `"github.com/fulana"` tal cual, y un
 *     `<a href="github.com/fulana">` es un link RELATIVO: lleva a la propia app.
 *     Agregarle `https://` es devolver el link que el usuario quiso escribir.
 *
 *   · Se EXIGE http o https, y se descarta el resto. `javascript:` en un `href`
 *     es un XSS guardado en la base y ejecutado por el frontend heredado, que
 *     hace `<a href={profile.linkedin}>`. Con este filtro, lo que llega a la
 *     columna `links` no puede ejecutar nada.
 *
 *   · Se recorta ANTES de validar, y se vuelve a validar. Recortar después
 *     dejaría una URL partida por la mitad (`https://github.com/f`), que sigue
 *     siendo una URL válida para `new URL` y sigue llevando a la nada.
 */
function cleanUrl(value) {
  const raw = asText(value).trim();
  if (!raw) return null;
  const corta = raw.length > MAX_URL_CHARS ? raw.slice(0, MAX_URL_CHARS) : raw;
  const conEsquema = /^[a-z][a-z0-9+.-]*:/i.test(corta) ? corta : `https://${corta}`;
  let url;
  try {
    url = new URL(conEsquema);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/**
 * Una lista de strings, recortada en cantidad y en longitud, sin repetidos.
 *
 * Los repetidos se sacan por minúsculas y NO con `normalize()` de `text.js`:
 * `normalize()` además de bajar a minúsculas borra la tilde (`atención` →
 * `atencion`), y estas listas son texto que la persona ve en pantalla y que se
 * usa tal cual para armar la query de búsqueda. Y no se borran acentos porque
 * el nombre es texto que la persona ve en pantalla.
 *
 * Un objeto o un array dentro de la lista se DESCARTAN en vez de convertirse:
 * `asText({})` es `'[object Object]'`, que es un dato falso que se vería en la
 * interfaz como una keyword rara. Un número sí se acepta, porque el LLM devuelve
 * cosas como `5` para "5 años de experiencia" y eso es texto válido.
 */
function cleanList(value, { maxItems, maxChars }) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (item !== null && typeof item === 'object') continue;
    const s = cleanText(item, maxChars);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * `marketSkills` al contrato `[{ name, has, aliases }]`.
 *
 * NO se usan los normalizadores de `profile.js` para esto: aquellos se ocupan de
 * que `aliases` nunca quede vacío (el arreglo de seguridad del TypeError del
 * matcher) y lo hacen al LEER. Acá se arma el draft, y la forma que se valida es
 * la que el formulario manda: `aliases` es opcional y `profile.js` se encarga de
 * completarlo al guardar. Lo que sí se hace es el corte de cantidad y de
 * longitud, y el `has` estrictamente booleano (el LLM manda `"false"` como texto
 * y eso es "no la tengo", no "sí").
 */
function cleanMarketSkills(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = cleanText(item.name, MAX_SKILL_CHARS);
    if (!name) continue;
    out.push({
      name,
      has: item.has === true,
      aliases: cleanList(item.aliases, { maxItems: MAX_ALIASES, maxChars: MAX_SKILL_CHARS }),
    });
    if (out.length >= MAX_MARKET_SKILLS) break;
  }
  return out;
}

/**
 * `projects` al contrato con las claves en ESPAÑOL (`nombre`, `descripcion`,
 * `lenguaje`), que es la forma que consume `AnalysisPage.jsx`.
 *
 * `url` pasa por `cleanUrl` y `home` por un `=== true`. `home` es lo que
 * `analytics.js` usa para separar un proyecto propio de uno del mercado, así que
 * un `"true"` textual tiene que ser false antes de llegar ahí.
 */
function cleanProjects(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    // ▲ Se acepta el `name` en inglés como fallback porque el LLM lo manda así y
    //   el formulario de revisión copia lo que recibió sin renombrar la clave.
    const nombre = cleanText(item.nombre ?? item.name, MAX_PROJECT_NAME_CHARS);
    if (!nombre) continue;
    out.push({
      nombre,
      descripcion: cleanText(item.descripcion ?? item.description, MAX_PROJECT_DESC_CHARS),
      url: cleanUrl(item.url),
      home: item.home === true,
      lenguaje: cleanText(item.lenguaje ?? item.language, MAX_PROJECT_LANG_CHARS),
    });
    if (out.length >= MAX_PROJECTS) break;
  }
  return out;
}

/**
 * El body del PUT, validado y con la forma EXACTA que espera `saveProfile`.
 *
 * Lo que hace, en orden: mete los topes, saca la identidad del body, y deja el
 * draft en el contrato. Lo que NO hace es decidir qué se guarda: `saveProfile`
 * vuelve a normalizar con los mismos criterios antes de escribir, así que
 * guardar dos veces el mismo draft da el mismo perfil (ver `profile.js:536-543`).
 *
 * @param {object} body El body ya parseado.
 * @returns {object} El draft.
 * @throws {HttpError} 400 si falta el nombre, si falta el título o si no hay
 *   ninguna skill.
 */
function buildDraft(body) {
  // ── Los strings ────────────────────────────────────────────────────────────
  const fullName = cleanText(body.fullName, MAX_NAME_CHARS);
  const title = cleanText(body.title, MAX_TITLE_CHARS);

  // ── Las skills ─────────────────────────────────────────────────────────────
  // Se acepta la forma CON OBJETO (`{ name, weight }`, la del contrato y la que
  // devuelve el LLM) y la forma CON STRING (`'react'`), porque un formulario de
  // revisión edita una lista de skills como texto y es el caso más probable de
  // que llegue un string suelto. Un string sin peso NO es peso 0: `normalizeSkills`
  // usa default 1, y 0 significaría "no la tengo".
  const crudas = Array.isArray(body.skills) ? body.skills : [];
  const skills = normalizeSkills(
    crudas
      .slice(0, MAX_SKILLS)
      .map((s) => (typeof s === 'string' ? { name: s } : s)),
  ).filter((s) => s.name.length <= MAX_SKILL_CHARS);

  // ▲ El `.filter` de longitud va DESPUÉS de `normalizeSkills` a propósito: es el
  //   normalizador el que descarta las entradas sin nombre y deduplica, y el
  //   filtro es el que aplica el tope de longitud de la tabla. Al revés, un
  //   nombre de 400 caracteres entraría en `seen` y bloquearía el nombre corto
  //   legítimo que venía después en la lista.

  // ── La validación de fondo ──────────────────────────────────────────────────
  // Estas TRES son las únicas condiciones que hacen que un perfil no sirva para
  // nada, y por eso son 400 y no una advertencia: sin nombre no hay a quién
  // escribirle una carta de presentación, sin título `deriveHeadline` no tiene
  // de qué armarse y la UI muestra un perfil en blanco, y sin skills el
  // `matcher` devuelve `score: 0` para TODAS las ofertas, lo que se ve como "la
  // app no encuentra nada" en vez de como "tu perfil está incompleto".
  if (!fullName) throw new HttpError(400, 'Falta tu nombre.');
  if (!title) throw new HttpError(400, 'Falta el puesto al que te postulás.');
  if (!skills.length) throw new HttpError(400, 'Cargá al menos una skill.');

  return {
    // ▲ Solo lo que `saveProfile` lee. `photo` NO está y es a propósito: la columna
    //   está reservada (`002_profiles.sql:43-49`) y `normalizeProfile` fuerza
    //   `photo: null` al leer, así que mandarla no guardaría nada. `headline` tampoco
    //   está porque es DERIVADO del título y de las skills, no un dato que el
    //   usuario escriba: mandarlo sería guardar un texto que se recalcula en cada
    //   lectura. Y `region` tampoco: el scope del proyecto es Argentina y la
    //   región es un parámetro de cada búsqueda, no del perfil.
    fullName,
    title,
    location: cleanText(body.location, MAX_LOCATION_CHARS),
    summary: cleanText(body.summary, MAX_SUMMARY_CHARS),
    yearsExperience: cleanYears(body.yearsExperience),
    keywords: cleanList(body.keywords, { maxItems: MAX_KEYWORDS, maxChars: MAX_KEYWORD_CHARS }),
    skills,
    marketSkills: cleanMarketSkills(body.marketSkills),
    projects: cleanProjects(body.projects),
    // ▲ Los tres links se leen de `links` Y de la raíz (`body.linkedin`), con el
    //   `links` ganando si está. Es el mismo criterio que `llm.js:normalizeLinks` y
    //   que `profile.js:normalizeLinks`: `normalizeProfile` duplica los links en la
    //   raíz del perfil, así que un draft que venga de un `GET` los tiene en los dos
    //   lugares y hay que leer de los dos.
    links: {
      github: cleanUrl(body.links?.github) || cleanUrl(body.github),
      portfolio: cleanUrl(body.links?.portfolio) || cleanUrl(body.portfolio),
      linkedin: cleanUrl(body.links?.linkedin) || cleanUrl(body.linkedin),
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// GET — LEER EL PERFIL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Devuelve el perfil del usuario, ya en el contrato de la API.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► el frontend va a /login
 *   403  con cookie pero SIN perfil, con `profileComplete: false` ──► al
 *        onboarding del CV
 *   200  el perfil del contrato (skills SIEMPRE como array `[{name, weight}]`)
 *   500  cualquier error de la base
 *
 * NUNCA 401 para el caso "no tengo CV": la sesión existe, lo que falta es el
 * perfil, y mandarle a /login a alguien que ya se logueó es el bucle que
 * `me.js` describe. El 403 sale con su `profileComplete: false` porque el frontend
 * rutea mirando ESA bandera.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // `requireProfile` tira 401 o 403 antes de que exista una línea más acá. Los
  // dos errores salen con su mensaje por el `withErrorHandling` de `http.js`.
  const { user, profile } = await requireProfile(req);

  // Una sola consulta de sobra: `requireProfile` ya trajo la fila de `profiles`,
  // y lo que falta son las skills, que viven en otra tabla. Por eso
  // `normalizeProfile` está exportado suelto.
  const skills = await loadProfileSkills(user.id);

  // El perfil se manda DESNUUDO. Ver el bloque de arriba: los consumidores del
  // frontend heredado lo leen como si fuera el perfil entero.
  sendJson(res, 200, normalizeProfile(profile, skills));
});

// ════════════════════════════════════════════════════════════════════════════
// PUT — GUARDAR EL PERFIL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Guarda el perfil completo del usuario (reemplazo, no parche).
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► el frontend va a /login
 *   400  el body no es un objeto JSON, o falta el nombre, el título o hay cero
 *        skills
 *   413  el body supera los 64 KB del `readJsonBody`
 *   200  { ok: true, profileComplete: true, profile: <lo que quedó guardado> }
 *   500  cualquier error de la base (una restricción, la conexión)
 *
 * NO hay 403 acá, y es la parte que hay que entender: este endpoint es el que
 * CREA el perfil, así que un 403 de "te falta el CV" sería un bug (ver el bloque
 * de arriba de las dos compuertas).
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const PUT = withErrorHandling(async (req, res) => {
  // 1) Sesión. `requireSession` y NADA más: `requireProfile` devolvería 403 al
  //    primer usuario que guarde su perfil, que es todos.
  const { user } = await requireSession(req);

  // 2) El body. `readJsonBody` con su tope default de 64 KB: un perfil son unos
  //    pocos KB de JSON, así que el corte nunca se ve. Un body vacío llega como
  //    `{}` y `buildDraft` responde el 400 del nombre faltante, que es el mensaje
  //    útil; no hace falta un chequeo de "body vacío" que daría el mismo 400 con
  //    menos información.
  const body = await readJsonBody(req);

  // 3) Validación y armado del draft. Todo 400 posible sale de acá.
  const draft = buildDraft(body);

  // 4) La escritura. `user.id` viene de la cookie firmada y NUNCA del body:
  //    `buildDraft` ni siquiera mira `body.userId`. La escritura borra y
  //    reescribe las skills dentro de una transacción (`profile.js:584`), así que
  //    nunca queda un perfil guardado con cero skills.
  const profile = await saveProfile(user.id, draft);
  // ↑ Devuelve `null` SOLO si el `userId` no es un uuid (`profile.js:517-518`), y
  //   acá no puede serlo: `user.id` viene de la fila de `users` que leyó
  //   `requireSession`. O sea que `profile` no es null en este punto, y por eso no
  //   hay un chequeo que "no puede pasar": agregarlo sería un 500 en un path que
  //   nadie puede recorrer, y un chequeo que no se puede probar es un chequeo que
  //   nadie sabe si está bien.

  // 5) Se devuelve lo que quedó LEÍDO de la base, no el draft: así lo que ve el
  //    frontend es idéntico a lo que va a devolver el próximo `GET`, incluido el
  //    `headline` derivado y el redondeo de los años a `numeric(3,1)`.
  sendJson(res, 200, {
    ok: true,
    // ▲ Siempre `true`, y nunca condicional: la fila se acaba de escribir, así que
    //   una bandera que acá pudiera ser false le diría al frontend "seguí en el
    //   onboarding" con un perfil recién guardado. Y `/api/me` va a contestar lo
    //   mismo, porque decide con un `select 1` sobre `profiles`.
    profileComplete: true,
    profile,
  });
});