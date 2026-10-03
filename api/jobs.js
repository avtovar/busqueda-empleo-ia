// ============================================================================
// GET /api/jobs — LAS OFERTAS RANKEADAS DE UNA REGIÓN
//
// Este es EL endpoint que la app abre. Es el primero que ve ofertas reales: antes
// de este paso el frontend consumía el `FALLBACK.jobs` de `api.js` y showed dos
// ofertas escritas a mano.
//
// ── EL CONTRATO NO SE CAMBIA: LO USA EL FRONTEND HEREDADO ────────────────────
//
// El consumidor ya existe y no se puede tocar (AGENTS.md). Por eso el shape de la
// respuesta es EXACTAMENTE el del origen (`index.js:250-256`):
//
//   sendJSON(res, 200, { region, jobs, total, _online })
//
// y por eso hay dos campos que parecen opcionales y NO lo son:
//
//   · `region`   `frontend/src/api.js:72-79` lo devuelve tal cual y
//                `App.jsx` lo usa para saber qué pestaña está activa. Tiene que
//                ser la RESUELTA (la que se usó de verdad), no la que pedía la URL.
//
//   · `_online`  `frontend/src/App.jsx:607` lo lee para elegir el texto de arriba:
//                "Conexión exitosa con las fuentes de empleo" o "Modo demo: no se
//                pudo contactar las fuentes en línea". Lo tiene que mandar el
//                BACKEND y nadie lo inyecta del cliente: `api.js:76` hace
//                `return await res.json()`, o sea que devuelve el JSON crudo y lo
//                único que el navegador puede agregar es su propio `FALLBACK`.
//                Si este endpoint no lo manda, un backend SANO se anuncia como
//                caído — el rótulo de demo se decide con `jobsData._online`, y el
//                `useState` inicial de `App.jsx:198` es `{ jobs: [], _online:
//                false }`.
//
// Se agregan `source` y `checkedAt` (el origen no los mandaba en este endpoint),
// y es ADITIVO: ningún consumidor los rechaza, `App.jsx` los lee en el camino de
// Apify (`App.jsx:441-442`) y sirven para que se pueda VERIFICAR que la caché
// funciona, que es la única forma de probar el `CACHE_TTL_MS` de `lib/jobs.js`.
//
// ── LAS DOS COMPUERTAS, Y POR QUÉ ESTE ES EL ENDPOINT DONDE IMPORTAN ─────────
//
//   401  sin cookie válida      → el frontend va a la pantalla de acceso
//   403  con cookie y SIN CV    → el frontend va al onboarding del CV
//   200  con cookie y con CV
//
// Se usa `requireProfile` y no `requireSession` porque TODAS las ofertas que
// devuelve este endpoint están rankeadas contra el perfil de la persona: sin perfil
// el `matcher` no tiene contra qué calcular y devolvería cero ofertas con un 200,
// que es la peor respuesta posible (una lista vacía que no parece un error). La
// fila de `profiles` decide, y el 403 sale con su `profileComplete: false` porque
// eso es lo que rutea el frontend.
//
// Y 401 y 403 TIENEN QUE SER DISTINTOS. Con un 401 para el caso "no tengo CV",
// el frontend mandaría a alguien que ya se logueó a la pantalla de acceso, en un
// bucle del que no sale: entra, ve 401, vuelve a entrar, ve 401. Ese es el error
// que `me.js` explica y el que la tabla de AGENTS.md fija para todo el proyecto.
//
// ── POR QUÉ UNA REGIÓN QUE NO EXISTE NO ES UN 400 ────────────────────────────
//
// Es el comportamiento del origen y la razón de que sea el correcto acá está en
// `lib/jobs.js:resolveRegion()`. Corto: un `?region=` desconocido no puede venir
// de la UI (las pestañas se generan con `Object.keys(REGIONS)`), así que viene de un
// link viejo o de una región borrada, y en los dos casos lo que hay que hacer es
// contestarle con la región por defecto en vez de una pantalla de error.
//
// ── POR QUÉ `requireProfile` DEVUELVE LA FILA CRUDA Y HAY QUE NORMALIZAR ──────
//
// `auth.js` devuelve `profiles` tal como la lee `pg`: `full_name`,
// `years_experience`, etc. El contrato de la API es camelCase con `skills` como
// array, y eso lo hace `normalizeProfile` de `lib/profile.js`. Se usan las dos
// piezas sueltas (`normalizeProfile` + `loadProfileSkills`) y no `loadProfile`, que
// volvería a consultar `profiles`: es una consulta en vez de dos, y es exactamente
// lo que hace `api/profile.js:396-405`.
//
// El error que se evita es el MODO DE FALLA SILENCIOSO de AGENTS.md: un perfil en
// snake_case sin `skills` hace que `computeMatch` devuelva `score: 0` para todas
// las ofertas, `rankByRegion` las descarte (`matcher.js:340`) y la app responda
// "no encontramos ofertas" con un perfil perfectamente cargado. Sin un error en
// ninguna parte.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { sendJson, withErrorHandling } from './lib/http.js';
import { bucketOf, getRanked, readParam, resolveRegion } from './lib/jobs.js';
import { loadProfileSkills, normalizeProfile } from './lib/profile.js';

export const config = { maxDuration: 30 };

/**
 * Las ofertas de una región, ordenadas por match.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► la pantalla de acceso
 *   403  con cookie pero SIN perfil, con `profileComplete: false` ──► al CV
 *   200  { region, jobs, total, _online, source, checkedAt }
 *   500  cualquier error de la base
 *
 * NUNCA 400: lo único que podría ser "inválido" en la URL es el `?region=`, y ese
 * cae a la región por defecto (ver el bloque de arriba). Y nunca 503: una bolsa
 * caída no es un error de este endpoint, es un `_online: false` con la lista que
 * haya salido.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas. Tiran 401 o 403 antes de que exista una línea más acá,
  //    y los dos errores salen con su mensaje por el `withErrorHandling` de
  //    `http.js`: no hace falta un try/catch en este archivo.
  const { user, profile } = await requireProfile(req);

  // 2) El perfil del CONTRATO. `requireProfile` ya hizo el `select` de `profiles`
  //    y devuelve la fila cruda; lo que falta son las `skills`, que viven en otra
  //    tabla. Por eso se usan `normalizeProfile` + `loadProfileSkills` sueltos: una
  //    consulta en vez de dos.
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  // 3) La región, ya validada contra `REGIONS`.
  const region = resolveRegion(readParam(req, 'region'));

  // 4) El ranking. SIN `force`: el botón "Actualizar" es `/api/refresh`, y esta
  //    lectura es la que tiene que pegarle a la caché de 30 minutos.
  const { regions, _online, source, checkedAt } = await getRanked(user.id, contract, { region });

  // 5) El bucket pedido. `bucketOf` pone el `|| []` en un solo lugar y no confía en
  //    que `regions` tenga la clave: `rankByRegion` la garantiza para toda región
  //    configurada, pero un `regions` de otro camino no tiene por qué.
  const jobs = bucketOf(regions, region);

  sendJson(res, 200, {
    region,
    jobs,
    total: jobs.length,
    // ↑ `_online` SIEMPRE presente, aunque sea `false`. El frontend decide con el
    //   valor y no con la ausencia del campo: una clave que a veces está y a veces
    //   no obliga a un `if (_online === undefined)` que alguien va a invertir.
    _online,
    source,
    // ↑ `'cache'` o `'live'`. No lo consume la UI en este camino; existe para poder
    //   comprobar que el TTL funciona y para diagnosticar un 5xx lento.
    checkedAt,
  });
});