// ============================================================================
// GET /api/job?q=<id> — EL DETALLE DE UNA OFERTA
//
// Este endpoint reemplaza al `findById(data, id)` del origen (`index.js:138-151`),
// que buscaba un objeto EN MEMORIA dentro de `cache.regions` (y de `lastApifyJobs`).
// Acá no hay memoria: la oferta sale de `job_history`, que es donde la dejó la
// corrida que la trajo.
//
// ── POR QUÉ EL PARÁMETRO SE LLAMA `q` Y NO `id` ──────────────────────────────
//
// Porque es lo que manda el frontend: `frontend/src/api.js:157` hace
// `fetch('/api/job?q=' + encodeURIComponent(id))`. El nombre del parámetro y el
// nombre del parámetro no coinciden, y eso es del origen: `q` es el "query" de la
// búsqueda puntual.
//
// Se acepta `id` como ALIAS por robustez, no por simetría con
// `/api/cover-letter` (que sí usa `id` porque `api.js:170` lo manda así). Si
// alguien llama a mano o cambia el frontend, el endpoint no devuelve 404 por un
// detalle del nombre. El orden de preferencia es `q` primero, que es el que manda
// el consumidor real.
//
// ── POR QUÉ `requireProfile` Y NO `requireSession` ───────────────────────────
//
// Porque el detalle se RE-RANKEA contra el perfil (abajo) y sin perfil el score no
// se puede calcular. Y el 403 es el que manda al onboarding del CV en vez de
// mandarle a /login a alguien que ya se logueó.
//
// ── POR QUÉ SE RE-RANKEA LA OFERTA, Y NO SE DEVUELVE LA GUARDADA ─────────────
//
// Es la misma razón por la que `history.js` borra los campos del match antes de
// guardar (`history.js:457`, `CAMPOS_DEL_MATCH`): el perfil se edita. El usuario
// sube otro CV, cambia los pesos de las skills, y el `score` guardado es RANCIOS.
//
// Si se devolviera la fila tal como salió de la base, el modal mostraría un
// porcentaje que no corresponde al perfil con el que la persona está mirando, sin
// ninguna señal visible de que sea viejo. Y hay un detalle peor: el `score` de la
// base NI SIQUIEMPRE EXISTE, porque `recordSearch` lo borra antes de serializar, así
// que el `undefined` se vería en la barra de porcentaje del modal.
//
// ── POR QUÉ `computeMatch` DIRECTO Y NO `rankByRegion([job], profile)` ───────
//
// Porque `rankByRegion` es un agrupador: mete la oferta en un bucket según
// `matchRegion`, y con `score: 0` NO LA PONE EN NINGUNO (`matcher.js:340`). O sea
// que el detalle de una oferta sin match (justo el caso que el usuario acaba de
// pedir, la que estaba mirando antes de tocarla) se perdería.
//
// `computeMatch` es la MISMA función que usa `rankByRegion` por dentro
// (`matcher.js:339`), así que no hay dos criterios de puntaje: hay uno, y se llama
// de las dos formas. Y el agrupador además haría trabajo de más —regex de
// exclusión de países, orden de un bucket entero— para devolver una sola lista de
// un elemento.
//
// ── POR QUÉ NO SE USA `withPortal` ACA ───────────────────────────────────────
//
// Porque la oferta sale de `job_history`, y lo que se guardó ahí YA pasó por
// `enrichJobs` en `lib/jobs.js` ANTES de que `recordSearch` la serializara. Volver
// a enriquecer sería hacer el trabajo dos veces para obtener el mismo objeto.
// `withPortal` es idempotente, así que no rompería nada: sería una copia
// wasteful de cientos de ofertas para cambiar el resultado en cero bytes.
//
// Es también la razón por la que `/api/history` no vuelve a enriquecer: lo que
// está en la base ya tiene `portal` y `sourceUrl`.
//
// ── POR QUÉ `summary` PUEDE SER `null` Y NO ES UN ERROR ──────────────────────
//
// `summarize` devuelve `null` si no puede armar un resumen, y el frontend tiene un
// default completo (`JobDetailModal.jsx:59-62`): `const s = summary || { companySummary:
// `${job.company} busca "${job.title}".`, requiredSkills: job.matched || [] }`.
// O sea que `null` es un caso previsto por el consumidor y no hace falta inventar
// un resumen vacío en el servidor: el texto que arma el cliente es mejor que uno
// vacío.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { summarize } from './lib/coverLetter.js';
import { sendJson, withErrorHandling } from './lib/http.js';
import { findJobById } from './lib/history.js';
import { readParam } from './lib/jobs.js';
import { computeMatch } from './lib/matcher.js';
import { loadProfileSkills, normalizeProfile } from './lib/profile.js';

export const config = { maxDuration: 30 };

/**
 * El detalle de una oferta, con su match recalculado y el resumen de la empresa.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► la pantalla de acceso
 *   403  con cookie pero SIN perfil, con `profileComplete: false`
 *   404  la oferta no está en el historial de ESTE usuario. OJO con lo que
 *        significa: es la misma respuesta para "no existe esa oferta", "existe pero
 *        es de otro usuario" y "existe pero venció". Las tres son la misma cosa
 *        desde afuera, y distinguirlas sería un oráculo de qué ofertas existen.
 *   200  { job, summary }
 *   500  cualquier error de la base
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas (401 / 403).
  const { user, profile } = await requireProfile(req);
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  // 2) El id. `q` primero (es el que manda `api.js:157`), `id` de alias.
  //    `readParam` ya devuelve `null` si no vino o vino vacío, así que el `||` de
  //    abajo solo está para el caso del alias.
  const id = readParam(req, 'q') || readParam(req, 'id');

  // 3) La oferta, del historial de ESTE usuario. El `user_id` sale de la cookie
  //    firmada y viaja como `$1`: una oferta de otro usuario es indistinguible de
  //    una que no existe, que es lo correcto.
  const found = id ? await findJobById(user.id, id) : null;

  if (!found) {
    // ↑ `sendJson` con 404 y NO `HttpError`: el origen hacía exactamente esto
    //   (`sendJSON(res, 404, { error: 'not found' })`). La diferencia es que acá el
    //   mensaje está escrito para la persona, y el `frontend/src/api.js:161` no
    //   muestra nada cuando la respuesta no es `ok`: el 404 es la señal de "usá la
    //   oferta del listado", que es lo que `App.jsx:487` hace.
    sendJson(res, 404, { error: 'No encontramos esa oferta.' });
    return;
  }

  // 4) El score de HOY. `found.job` es el jsonb crudo (con `portal` y
  //    `sourceUrl`, sin los campos del match), y `computeMatch` devuelve
  //    exactamente el objeto que `rankByRegion` pone en sus buckets. El `|| {}`
  //    del perfil es de `profileOrEmpty`: con perfil nunca se llega sin perfil, pero
  //    el matcher banca `null` y no tiene sentido que el endpoint sea más estricto
  //    que él.
  const job = { ...found.job, ...computeMatch(found.job, contract) };

  // 5) El resumen de empresa y skills. Va SIN la oferta adentro: el modal ya la
  //    tiene en `job`, y mandarla dos veces en la respuesta es el doble de JSON.
  sendJson(res, 200, { job, summary: summarize(job, contract) });
});