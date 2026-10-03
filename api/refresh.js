// ============================================================================
// POST /api/refresh — "BORRÁ LA CACHÉ Y BUSCÁ DE NUEVO"
//
// El endpoint más chico de los seis y el que más se explica.
//
// ── ES UN DISPARADOR, NO UN COMANDO CON PARÁMETROS ───────────────────────────
//
// El frontend lo llama sin body (`frontend/src/api.js:105-112`):
// `fetch('/api/refresh', { method: 'POST' })`. Por eso este handler NO lee el body
// y no hay nada que leer: no hay región, ni límite, ni keywords.
//
// Y hay una razón de fondo para que no los tenga, que es la misma que hace que
// este endpoint exista. `POST /api/refresh` es el "disparador" del `CACHE_TTL_MS`
// de `lib/jobs.js`: el frontend heredado tenía un botón "Actualizar búsqueda"
// (`App.jsx`, `handleRefresh`) cuya ÚNICA función era saltear la caché de 30
// minutos. Sin `force`, este POST sería un no-op: leería la caché que escribió la
// corrida anterior y devolvería lo mismo con otro `checkedAt`.
//
// ── POR QUÉ NO HAY `refreshing`, Y POR QUÉ ESO ESTÁ BIEN ──────────────────────
//
// El origen tenía una promesa compartida en memoria (`index.js:99`,
// `let refreshing = null`) y una lógica de dos ramas: sin `force` esperaba el
// refresh en curso, y con `force` lo esperaba y arrancaba el suyo después, para que
// el botón no fuera un no-op si había una carga automática corriendo.
//
// Ninguna de las dos ramas se puede portar: en Vercel dos requests son dos
// procesos y no comparten nada. Lo que queda es lo que está escrito en el bloque de
// `lib/jobs.js`: la doble corrida cuesta unos segundos de red a cinco bolsas
// GRATUITAS, el `unique (user_id, key)` de `job_history` evita que se dupliquen las
// filas, y si algún día molesta la solución es un `pg_advisory_xact_lock` en la
// transacción de `recordSearch`, no una variable de módulo.
//
// ── EL POR QUÉ DE LA RESPUESTA: `ok: true` EXPLÍCITO ─────────────────────────
//
// El frontend solo mira `result.ok === false` para mostrar un error
// (`App.jsx:376-378`, el `refreshNote` que dice "No se pudo actualizar"). O sea que
// `ok: true` no es decorativo: es lo que mantiene callado al camino feliz. Un
// `{ ok: undefined }` sería un `undefined === false`, o sea `false`, y el usuario
// vería el aviso de error después de una actualización que sí funcionó.
//
// `at` y `total` tampoco los usa el frontend hoy (el `App.jsx` recarga la región y
// vuelve a pedir la lista). Se mandan porque son los dos datos que hacen falta para
// diagnosticar "el refresh no hizo nada": qué instante terminó la corrida y cuántas
// ofertas salieron. Un endpoint que no se puede observar es un endpoint que no se
// puede arreglar.
//
// ── POR QUÉ `requireProfile` ─────────────────────────────────────────────────
//
// Es el endpoint más caro del proyecto en tiempo de red (cinco bolsas, hasta 20 s)
// y el único que permite que cualquiera lo dispare sin límite. Que sea de un
// usuario con sesión Y perfil es lo que impide que un bot lo llame en loop: sin
// cookie es un 401 en vez de una llamada a las bolsas. El rate limit por usuario de
// Apify no aplica acá (esto no llama a Apify) y no hace falta inventar uno para las
// bolsas gratuitas.
//
// ── POR QUÉ NO SE USA `DEFAULT_REGION` A MANO ─────────────────────────────────
//
// El `region` que se le pasa a `getRanked` es el de la región POR LA QUE SE PIDIÓ
// la corrida, y es lo que va a la columna `searches.region`. Como este endpoint no
// recibe región (no hay body), va el default del proyecto. NO es lo mismo que el
// bucketeo de las ofertas: eso lo decide `matchRegion` sobre el texto de cada
// oferta, así que la corrida alimenta los buckets de TODAS las regiones
// configuradas, no solo la del default.
// ============================================================================

import { requireProfile } from './lib/auth.js';
import { sendJson, withErrorHandling } from './lib/http.js';
import { bucketOf, getRanked } from './lib/jobs.js';
import { loadProfileSkills, normalizeProfile } from './lib/profile.js';
import { DEFAULT_REGION } from './lib/regions.js';

export const config = { maxDuration: 30 };

/**
 * Fuerza una corrida nueva y responde el resumen de lo que salió.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► la pantalla de acceso
 *   403  con cookie pero SIN perfil, con `profileComplete: false`
 *   200  { ok: true, _online, at, total, source }
 *   500  cualquier error de la base
 *
 * NUNCA hay un 4xx "no había nada que refrescar": una corrida sin resultados es un
 * 200 con `total: 0`, porque las bolsas pueden no tener nada para este perfil y eso
 * no es un error del endpoint (es el mismo criterio de `_online`: son hechos
 * distintos, y acá solo se reporta).
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const POST = withErrorHandling(async (req, res) => {
  // 1) Las dos compuertas. Esto corre antes de tocar la red: un 401 sale en
  //    milisegundos y sin pegarle a ninguna bolsa.
  const { user, profile } = await requireProfile(req);
  const contract = normalizeProfile(profile, await loadProfileSkills(user.id));

  // 2) La búsqueda, con `force: true`. Es el argumento que le da sentido a todo el
  //    endpoint: sin él, esto leería la caché que acaba de escribir la corrida
  //    anterior y devolvería exactamente lo mismo.
  const { regions, _online, source, checkedAt } = await getRanked(user.id, contract, {
    force: true,
    region: DEFAULT_REGION,
  });

  // 3) El total. Se cuenta el bucket del default porque es la región que el
  //    frontend va a recargar después (`App.jsx:handleRefresh` llama a
  //    `loadJobs(region)` con la pestaña activa, que con el alcance actual es
  //    Argentina). El `region` que se le pasó a `getRanked` y la pestaña activa
  //    coinciden mientras haya una sola región configurada; con más de una, este
  //    `total` es el de la del default y el frontend igual va a pedir su lista.
  const jobs = bucketOf(regions, DEFAULT_REGION);

  sendJson(res, 200, {
    // ↑ SIEMPRE `true` en un 200. El frontend decide el aviso con este campo, así
    //   que mandarlo es lo que hace que el camino feliz no muestre un error.
    ok: true,
    _online,
    at: checkedAt,
    // ↑ El `checkedAt` de la CORRIDA (el reloj de la base en caché, el de este
    //   proceso en vivo), no un `Date.now()` del momento de responder. Con una
    //   corrida de varios segundos la diferencia es de segundos, y "actualizado
    //   hace 4 s" cuando la bolsa respondió hace 9 no es un detalle: es la hora
    //   real de los datos.
    total: jobs.length,
    // ↑ `'live'` SIEMPRE, y se manda igual. Existe para que se pueda comprobar que
    //   este endpoint de verdad ignoró la caché: si algún día devuelve `'cache'`,
    //   el `force` dejó de pasar y el botón "Actualizar" es un no-op silencioso.
    source,
  });
});