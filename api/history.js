// ============================================================================
// GET /api/history?region=<key> — LAS OFERTAS QUE EL USUARIO YA VIÓ
//
// Reemplaza al `getHistoryForRegion(region)` del origen (`index.js:358-366`), que
// leía el archivo JSON. Acá la lectura ya la hace `lib/history.js` sobre
// `job_history`, con la deduplicación garantizada por el `unique (user_id, key)` y la
// retención de 6 meses hecha en SQL.
//
// ── EL CONTRATO ES EL DEL ORIGEN ─────────────────────────────────────────────
//
//   sendJSON(res, 200, { region, jobs })
//
// (`index.js:363`). El `frontend/src/api.js:89-96` lo usa tal cual, y `App.jsx:466`
// mete el objeto entero en `jobsData`, así que los dos campos tienen que estar.
// `jobs` es un array PLANO de ofertas con tres campos extra: `active`, `firstSeen`
// y `lastSeen`, que es lo que devuelve `getHistoryForRegion` y lo que
// `JobList.jsx` lee para el badge de "activa" y la fecha.
//
// ── `user_id`: DE LA COOKIE, SIEMPRE ─────────────────────────────────────────
//
// Sale de `requireProfile(req)`, o sea del HMAC de la sesión. NO hay ni una
// lectura de identidad en el query string ni en el body (este endpoint ni siquiera
// tiene body). Y el `user_id` viaja como `$1` en el SQL de `getHistoryForRegion`:
// es la regla del proyecto y en ESTA tabla es donde un `where` olvidado sería una
// fuga de datos entre usuarios, porque `job_history` tiene las ofertas de todos.
//
// ── LO QUE ESTE ARCHIVO NO HACE, Y POR QUÉ ───────────────────────────────────
//
// NO vuelve a enriquecer. Es tentador, porque el origen sí lo hacía
// (`index.js:362`: `{ region, jobs: enrichJobs(jobs) }`) y el comentario que lo
// justificaba ("si el portal no estuviera ahí, las guardadas no lo tendrían") es
// FALSO hoy, por la razón exacta que invierte el comentario:
//
//   · En el origen, `recordSearch` guardaba las ofertas y lo que terminó en el
//     archivo pasó por `withPortal` solo en el camino de SALIDA de `/api/jobs`. El
//     historial se armaba aparte, así que podía no tener `portal`. Por eso el
//     endpoint lo tapaba.
//   · Acá el orden es el inverso: `lib/jobs.js` llama a `enrichJobs(jobs)` ANTES de
//     `rankByRegion` y de `recordSearch`, así que lo que está en el `jsonb` YA trae
//     `portal` y `sourceUrl`.
//
// Volver a enriquecer sería un `.map` de 300 objetos copiando campos para obtener
// el mismo resultado. Si algún día una fila guardada aparece sin `portal`, el
// problema NO es de este endpoint: es que se escribió por un camino que no pasó por
// `enrichJobs`, y hay que arreglar ESE camino.
//
// ── POR QUÉ NO SE RE-RANKEA EL HISTORIAL ─────────────────────────────────────
//
// El origen tampoco lo hacía, y con razón: el historial es la lista de lo que el
// usuario VIO, con el `active` que dice si siguió apareciendo. El `score` de cada
// fila ni siquiera está —`recordSearch` borra los campos del match antes de
// serializar (`history.js:457`)— así que no hay puntaje rancio que mostrar: no hay
// puntaje. Agregar el match sería una versión de `/api/job` para 300 ofertas, y
// `/api/job` ya existe para el caso de querer ver UNA en detalle.
//
// ── POR QUÉ UN ERROR DE HISTORIAL NO SE COME CON UN 200 Y LISTA VACÍA ─────────
//
// El origen lo hacía (`index.js:364-366`):
//
//   } catch {
//     sendJSON(res, 200, { region, jobs: [] });   // "si algo falla, lista vacía"
//   }
//
// Y es un error, por una razón que se ve en la pantalla: la respuesta vacía es
// INDISTINGUIBLE de "todavía no tenés historial". `App.jsx` muestra el mensaje de
// "todavía no hay historial", que es una afirmación FALSA para alguien que tiene
// tres meses de búsquedas registradas, y el problema real —la tabla no está, la
// conexión se cayó, una migración no corrió— queda oculto detrás de una pantalla
// que parece normal. Sin el `catch`, el error sube a `withErrorHandling`, que
// responde 500 con un mensaje genérico y deja el detalle real en el log del
// servidor. Un 500 visible es infinitamente más útil que un 200 que miente.
//
// ── POR QUÉ `requireProfile` ─────────────────────────────────────────────────
//
// El historial es POR USUARIO y sin perfil no hay contra qué rankear nada, así que
// la segunda compuerta va acá también. `requireProfile` devuelve 403 con
// `profileComplete: false`, que es lo que manda al onboarding del CV.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { sendJson, withErrorHandling } from './lib/http.js';
import { getHistoryForRegion } from './lib/history.js';
import { readParam, resolveRegion } from './lib/jobs.js';
import { loadProfileSkills, normalizeProfile } from './lib/profile.js';

export const config = { maxDuration: 30 };

/**
 * Las ofertas vistas de una región, con cuáles siguen activas.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► la pantalla de acceso
 *   403  con cookie pero SIN perfil, con `profileComplete: false`
 *   200  { region, jobs }
 *   500  cualquier error de la base
 *
 * Un `jobs: []` con 200 es un estado REAL y no un error: el usuario todavía no
 * corrió ninguna búsqueda, o la corrió y no le matcheó ninguna oferta, o la
 * retención ya se llevó todo lo que tenía. Los tres se muestran como "no hay
 * historial" y está bien. Lo que NO puede ser un `[]` con 200 es el fallback de un
 * error (ver el bloque de arriba).
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas (401 / 403).
  const { user, profile } = await requireProfile(req);

  // 2) El perfil del contrato. Acá NO se usa para nada más: el historial no se
  //    re-ranquea (ver el bloque de arriba). Se normaliza igual, y no por
  //    prolijidad: es el mismo paso de `api/jobs.js` y `api/job.js`, y que tres
  //    endpoints distintos hagan la sesión con la misma forma es más fácil de
  //    leer que tres variantes de la misma línea.
  normalizeProfile(profile, await loadProfileSkills(user.id));

  // 3) La región, validada contra `REGIONS`: un `?region=` desconocido cae a la
  //    región por defecto y devuelve SU historial, no un error (ver
    //    `lib/jobs.js:resolveRegion`).
  const region = resolveRegion(readParam(req, 'region'));

  // 4) La lectura, filtrada por `user.id` — el de la cookie, no el de la URL.
  const jobs = await getHistoryForRegion(user.id, region);

  // 5) `jobs` sale de `getHistoryForRegion` tal cual: cada item es el `job` del
  //    `jsonb` más `active`, `firstSeen` y `lastSeen`, y ya viene con `portal` y
  //    `sourceUrl` (ver el bloque de arriba sobre por qué no se re-enriquece).
  sendJson(res, 200, { region, jobs });
});