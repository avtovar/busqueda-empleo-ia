// ============================================================================
// GET /api/directorio — A DÓNDE BUSCAR EMPLEO EN ARGENTINA, CON EL OFICIO PUESTO
//
// Punto 11 del pedido original. El catálogo vive en `lib/directorio.js`, que es
// lógica pura: este endpoint es el que carga el perfil y el que decide el código
// de la respuesta, nada más.
//
// ── POR QUÉ `requireProfile` Y NO `requireSession` ───────────────────────────
//
// Las direcciones del catálogo se arman con las keywords del perfil del usuario:
// sin perfil no hay `primaryTerm`, y sin término las trece entradas caen a su
// `home` con `searchKind: 'ninguno'`. O sea que un `requireSession` devolvería un
// 200 que parece un catálogo y en realidad son trece links sin filtrar, que es
// justo el estado que la interfaz no sabe distinguir de "te faltan los datos".
// Con `requireProfile` el usuario sin CV recibe el 403 + `profileComplete: false`
// que lo manda al onboarding, que es el mismo camino que los seis endpoints de
// ofertas.
//
// El 403 y no un 401 importa (ver `me.js`): la sesión existe, lo que falta es el
// CV. Con un 401 el frontend mandaría a alguien que ya se logueó a la pantalla de
// acceso, en un bucle del que no sale.
//
// ── POR QUÉ NO HAY NINGÚN 400 ─────────────────────────────────────────────────
//
// Lo único que podría ser "inválido" en la URL es el `?region=`, y ese lo resuelve
// `lib/directorio.js` con la misma regla que el resto de la app (`resolveRegionKey`,
// que replica `resolveRegion` de `lib/jobs.js`): región desconocida → la región por
// defecto. Es a propósito que la resolución viva ADENTRO de `directorio.js` y no
// acá: es una regla del catálogo, no de este endpoint, y escrita una sola vez no
// puede quedar desincronizada entre dos endpoints que lo llamen mañana.
//
// ── POR QUÉ UNA SOLA LECTURA DE LA BASE ───────────────────────────────────────
//
// Dos consultas y ni una más: `requireProfile` ya hizo el `select` de `profiles` y
// devuelve la fila CRUDA, así que lo único que falta son las `skills`, que viven en
// otra tabla. Por eso se usan `normalizeProfile` + `loadProfileSkills` sueltos, que
// es lo que hacen `api/jobs.js` y `api/analytics.js`: es una consulta en vez de
// dos. Y el error que se evita es el MODO DE FALLA SILENCIOSO de AGENTS.md — un
// perfil en snake_case sin `skills` hace que `searchTerms` no encuentre ni un
// término, y el endpoint devolvería las trece entradas a `home` con un 200 de
// aspecto normal.
//
// ── LO QUE ESTE ENDPOINT NO HACE ─────────────────────────────────────────────
//
// No abre ni una sola conexión de red a un portal de empleo. El directorio arma
// links, no scrapea: la diferencia entre "la búsqueda ya viene filtrada" y "traigo
// las ofertas de verdad" es la de `/api/jobs`, que sí pega a las bolsas gratuitas.
// Acá no hay ni LLM ni Apify, y por lo tanto no hay nada que facturar: por eso
// `maxDuration` es 30 como en todos los demás, y no hace falta ni un segundo más:
// lo único que tarda es la lectura del perfil.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { buildDirectory } from './lib/directorio.js';
import { sendJson, withErrorHandling } from './lib/http.js';
import { readParam } from './lib/jobs.js';
import { loadProfileSkills, normalizeProfile } from './lib/profile.js';

export const config = { maxDuration: 30 };

/**
 * El catálogo de bolsas y consultoras de una región, con las búsquedas ya
 * prellenadas con la profesión del usuario.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► la pantalla de acceso
 *   403  con cookie pero SIN perfil, con `profileComplete: false` ──► al CV
 *   200  { region, keyword, terms, bolsas, consultoras }
 *   500  cualquier error de la base
 *
 * NUNCA 400 (ver el bloque de arriba) y nunca 503: no hay ningún servicio externo
 * que pueda estar caído, porque a ninguno se le pega.
 *
 * El 200 puede venir con `keyword: ''` y las trece entradas con
 * `searchKind: 'ninguno'` si el perfil existe pero no tiene con qué armar un
 * término (sin `title`, sin `keywords` y sin skills con peso). Es un estado REAL y
 * la interfaz lo tiene que poder mostrar; no se disfraza de búsqueda filtrada.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas. Tiran 401 o 403 antes de que exista una línea más acá, y
  //    los dos errores salen con su mensaje por el `withErrorHandling` de `http.js`:
  //    no hace falta un try/catch en este archivo (ver `api/jobs.js`).
  const { user, profile } = await requireProfile(req);

  // 2) El perfil del CONTRATO, no la fila cruda: es lo que `searchTerms` espera
  //    (`title`, `keywords` y `skills` como array `[{name, weight}]`).
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  // 3) El `?region=`. Se lo pasa crudo a propósito: lo resuelve
  //    `buildDirectory`, y `region` sale en la respuesta con el mismo criterio que
  //    en `/api/jobs` (la región RESUELTA, no la que pedía la URL).
  sendJson(res, 200, buildDirectory(contract, readParam(req, 'region')));
});