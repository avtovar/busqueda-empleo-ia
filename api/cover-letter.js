// ============================================================================
// GET /api/cover-letter?region=<key>&id=<id> — LA CARTA DE PRESENTACIÓN
//
// Reemplaza al `generateCoverLetter(enrichJob(found), region)` del origen
// (`index.js:271-281`) y conserva su contrato: lo que devuelve es el objeto que
// arma `lib/coverLetter.js`, sin envoltorio.
//
// ── POR QUÉ ACEPTA `id` Y `q` ────────────────────────────────────────────────
//
// Porque el origen aceptaba los dos (`index.js:278`:
// `url.searchParams.get('id') || url.searchParams.get('q')`) y hay que mantenerlo.
//
// El que manda el frontend es `id` (`frontend/src/api.js:170`:
// `/api/cover-letter?region=${region}&id=${id}`), OJO con la asimetría con
// `/api/job`, que usa `q` (`api.js:157`) para la MISMA oferta. Dos nombres para el
// mismo dato en dos endpoints del mismo archivo: es del proyecto heredado, y
// cambiar cualquiera de los dos rompería un consumidor que existe. Por eso acá se
// acepta `id` primero y `q` de alias, al revés que en `/api/job`.
//
// ── POR QUÉ NO SE USA `withPortal` (Y POR QUÉ EL ORIGEN SÍ) ───────────────────
//
// El origen pasaba `enrichJob(found)` porque `found` venía de `findById`, que
// buscaba en `cache.regions` y en `lastApifyJobs`: los objetos que esa función
// devolvía NO tenían `portal` porque el `cache` se armaba con `fetchJobs` CRUDO, y
// el enriquecimiento pasaba solamente en el camino de salida de cada endpoint.
//
// Acá el orden es otro: `lib/jobs.js` llama a `enrichJobs(jobs)` antes de rankear y
// antes de `recordSearch`, así que lo que sale de `job_history` YA viene con
// `portal` y `sourceUrl`. Volver a enriquecer sería una copia de un objeto que ya
// está bien. Y si alguna vez una fila guardada aparece sin `portal`, el problema
// está en el camino de escritura, no acá.
//
// ── LA REGIÓN SÍ IMPORTA, Y ES LO ÚNICO QUE SE USA DE EL ────────────────────
//
// `generateCoverLetter(job, regionKey, profile)` usa la región para decidir el
// IDIOMA de la carta (`regions.js:lang`: 'es' para Argentina, 'en' para el
// resto). No es un dato decorativo: el mismo endpoint produce una carta en español
// o en inglés según la pestaña desde la que se pidió.
//
// Y una región que no existe NO es un error: `generateCoverLetter` la resuelve
// adentro con su propio `resolveRegion` (`coverLetter.js:339`) y devuelve la
// región RESUELTA en el campo `region`. Por eso este endpoint resuelve la región
// con la misma función que los demás y no tiene que reinventar ese criterio: la
// carta y la lista de ofertas van a hablar de la misma región pase lo que pase.
//
// ── POR QUÉ `requireProfile` Y NO `requireSession` ───────────────────────────
//
// Porque la carta se firma con los datos del perfil: `generateCoverLetter` usa
// `fullName`, las skills y los links para el saludo, el cuerpo y la firma. Sin
// perfil la carta sale sin firma (`coverLetter.js` lo dice: "nunca con datos
// inventados"), y una carta sin firma es peor que un 403 con el motivo.
//
// ── POR QUÉ `subject` Y `body` NO PUEDEN SALIR VACÍOS ────────────────────────
//
// El frontend los imprime tal cual (`App.jsx:handleGenerateLetter` arma el objeto
// del modal con `data.subject` y `data.body`, y hay un botón de "copiar"). Si
// alguno falta, la pantalla muestra el literal `"undefined"`: es un fallo visible,
// no un detalle. Por eso el payload es el de `generateCoverLetter` tal cual y sin
// defaults agregados acá: si algo va a faltar, el lugar de arreglarlo es
// `coverLetter.js`, que es donde se escribe la carta.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { generateCoverLetter } from './lib/coverLetter.js';
import { sendJson, withErrorHandling } from './lib/http.js';
import { findJobById } from './lib/history.js';
import { readParam, resolveRegion } from './lib/jobs.js';
import { loadProfileSkills, normalizeProfile } from './lib/profile.js';

export const config = { maxDuration: 30 };

/**
 * La carta de presentación para una oferta.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► la pantalla de acceso
 *   403  con cookie pero SIN perfil, con `profileComplete: false`
 *   404  la oferta no está en el historial de ESTE usuario
 *   200  { lang, region, subject, body }
 *   500  cualquier error de la base
 *
 * El 200 va DESNUDO, sin envoltorio `{ letter: ... }`: el consumidor usa
 * `data.subject` y `data.body` directamente (`App.jsx:handleGenerateLetter`), y
 * envolverlo haría que ambos fueran `undefined` sin un error en la consola.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas (401 / 403).
  const { user, profile } = await requireProfile(req);
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  // 2) Los dos parámetros. `id` primero porque es el que manda `api.js:170`, y `q`
  //    de alias por la asimetría con `/api/job` (ver el bloque de arriba).
  const region = resolveRegion(readParam(req, 'region'));
  const id = readParam(req, 'id') || readParam(req, 'q');

  // 3) La oferta del historial de ESTE usuario. `user.id` es el de la cookie
  //    firmada; el `id` de la oferta es el que viaja por la URL y no tiene nada
  //    que ver con la identidad.
  const found = id ? await findJobById(user.id, id) : null;
  if (!found) {
    sendJson(res, 404, { error: 'No encontramos esa oferta.' });
    return;
  }

  // 4) La carta. `found.job` sale del `jsonb` con `portal` y `sourceUrl` pero SIN
  //    los campos del match (los borra `recordSearch`), y eso está bien: la carta
  //    habla del puesto, la empresa y las skills que PIDE la oferta, no del
  //    porcentaje que le calcule a esta persona. `generateCoverLetter` llama a
  //    `summarize` adentro, así que el `requiredSkills` que usa es el del resumen.
  sendJson(res, 200, generateCoverLetter(found.job, region, contract));
});