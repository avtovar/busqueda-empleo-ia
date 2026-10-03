// ============================================================================
// GET /api/analytics — LA PROPUESTA DE INTERÉS (el análisis de mercado)
//
// Reemplaza al `buildAnalytics(data.regions)` del origen (`index.js:369-373`), que
// además leía el resultado de `getRanked()` en memoria. Acá el análisis se arma
// sobre lo mismo que `/api/jobs` muestra, con el perfil de ESTE usuario.
//
// ── SIN PARÁMETROS, Y POR QUÉ ────────────────────────────────────────────────
//
// El origen no leía ninguno, y sigue igual. La página de análisis no tiene
// selector de región: `App.jsx` la abre con `region === 'analisis'` y la analítica
// es el agregado de TODO. El único "parámetro" sería la región, y mandarla sería
// peor: la respuesta tiene un `byRegion` con el desglose, así que un filtro por
// región obligaría al frontend a recortar y el backend a duplicar la lógica.
//
// ── POR QUÉ VA SIN `force` — Y POR QUÉ ESO ES LO IMPORTANTE ──────────────────
//
// La tentación es pegar `force: true` para que la página muestre datos frescos. Es
// un error de costo: cada apertura de la pestaña golpearía las CINCO bolsas (hasta
// 20 s de red), y la analítica no gana NADA con eso. Es un agregado de lo que el
// usuario ya vio, y con `CACHE_TTL_MS` de 30 minutos ya está al día.
//
// Además hay un detalle de coherencia: `buildAnalytics` recalcula el `score` de cada
// oferta contra un perfil PROYECTADO (`analytics.js:334-354`), o sea que depende de
// las ofertas de la última corrida y del perfil de hoy. Con la caché, las dos
// mitades son coherentes entre sí: la misma corrida que `/api/jobs` muestra. Con
// `force`, cada apertura traería un juego de ofertas nuevo y el análisis hablaría de
// vacantes que la lista de al lado no tiene.
//
// ── POR QUÉ TODOS LOS BUCKETS Y NO UNO ───────────────────────────────────────
//
// `buildAnalytics` arma el `byRegion` recorriendo todos los buckets que le pasan, y
// su `total`/`avgScore` son sobre la unión. Pasarle un solo bucket produciría una
// analítica correcta pero incompleta: "demanda por región" con una sola región es
// un caso degenerado, y el día que se agregue un país la página no se entera. Con
// el alcance actual (Argentina) los dos son el mismo array, y es por eso que el
// detalle NO se nota — o sea que es exactamente el tipo de error que se descubre
// cuando ya está en producción.
//
// ── EL GUARD DE `githubEvidence.projects` ────────────────────────────────────
//
// `frontend/src/AnalysisPage.jsx:186` hace `skill.projects.map(...)` SIN un `|| []`
// adentro, o sea que un item sin `projects` no muestra una fila vacía: tira la
// excepción de render y se CAE LA PESTAÑA DE ANÁLISIS ENTERA.
//
// ¿Puede pasar hoy? NO. `buildAnalytics` arma `githubEvidence` con
// `githubSkillEvidence` (`analytics.js:106-123`), que mapea `{ name, projects }` y
// después filtra por `skill.projects.length > 0`: todo item sale con un array, y de
// hecho no vacío. Se verificó contra un perfil real.
//
// El guard se pone igual, y la razón de pagarlo es una relación de costos, no una
// duda sobre el normalizador:
//
//   · El guard cuesta un `.map` sobre una lista que casi siempre tiene 0, 1 o 2
//     elementos (es "skills que el mercado pide, el CV no tiene, y un proyecto
//     menciona"). O sea: nada.
//   · La consecuencia de no tenerlo, si algún día `githubSkillEvidence` cambia (por
//     ejemplo, para distinguir "sin evidencia" de "con evidencia" con un
//     `projects: null`), no es una fila menos: es una pestaña entera en blanco con
//     un error en la consola que no apunta a la causa.
//
// Y el lugar del guard es ESTE, no `AnalysisPage.jsx`: el endpoint es la frontera
// donde se DECLARA el contrato de la respuesta, y el frontend heredado no se toca
// (AGENTS.md). El mismo razonamiento que aplica al `_online` de `/api/jobs`.
//
// ── POR QUÉ `requireProfile` Y NO `requireSession` ───────────────────────────
//
// `buildAnalytics(regions, profile)` con `profile` ausente devuelve la analítica
// vacía pero BIEN FORMADA (`profileOrEmpty`): KPIs en 0, `candidato` con todo en
// `null`. Es un 200 que no dice nada y es indistinguible de "no hay ofertas". Con
// perfil obligatorio, un usuario sin CV recibe el 403 que lo manda al onboarding,
// que es el mismo camino que todos los demás endpoints de datos.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { buildAnalytics } from './lib/analytics.js';
import { sendJson, withErrorHandling } from './lib/http.js';
import { getRanked } from './lib/jobs.js';
import { loadProfileSkills, normalizeProfile } from './lib/profile.js';

export const config = { maxDuration: 30 };

/**
 * La analítica de mercado para el perfil de este usuario.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► la pantalla de acceso
 *   403  con cookie pero SIN perfil, con `profileComplete: false`
 *   200  el paquete de `buildAnalytics`: `generatedAt`, `candidato`,
 *        `githubEvidence`, `matchProjection`, `total`, `avgScore`, `byRegion`,
 *        `skillStats`, `strongSkills`, `missingSkills`, `englishPct`,
 *        `recommendations`
 *   500  cualquier error de la base
 *
 * OJO con el 200: puede venir con `total: 0`. Es un estado REAL —"todavía no
 * buscaste nada" o "las bolsas no tienen nada para tu perfil"— y `AnalysisPage.jsx:28`
 * lo maneja con su propio mensaje. No es un error del endpoint y no se transforma en
 * uno.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas (401 / 403).
  const { user, profile } = await requireProfile(req);
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  // 2) Las ofertas. SIN `force`: la analítica es un agregado de lo ya buscado, y
  //    pegarle a las cinco bolsas en cada apertura de la pestaña sería una forma
  //    cara de no agregar información (ver el bloque de arriba).
  const { regions } = await getRanked(user.id, contract);

  // 3) El agregado, sobre TODOS los buckets. `_online` y `checkedAt` no se usan
  //    acá: `buildAnalytics` no los tiene en su contrato y la página no los lee.
  const data = buildAnalytics(regions, contract);

  // 4) El guard de `githubEvidence`. Se hace sobre una COPIA del array del paquete
  //    (`buildAnalytics` arma uno nuevo en cada llamada, así que mutarlo no afecta a
  //    nada) y por item, así que un item raro no borra la lista entera.
  data.githubEvidence = (Array.isArray(data.githubEvidence) ? data.githubEvidence : []).map((skill) => (
    // ↑ El `Array.isArray` del array entero también: si `githubEvidence` no fuera un
    //   array, el `.map` tiraría acá y no en la página del cliente, que es un lugar
    //   infinitamente mejor para descubrir que el contrato se rompió.
    skill && typeof skill === 'object' && !Array.isArray(skill)
      ? { ...skill, projects: Array.isArray(skill.projects) ? skill.projects : [] }
      : skill
  ));

  sendJson(res, 200, data);
});