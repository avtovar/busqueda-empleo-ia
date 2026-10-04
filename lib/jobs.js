// ============================================================================
// EL ORQUESTADOR DE OFERTAS: LA CACHÉ QUE EN SERVERLESS ES LA BASE DE DATOS.
//
// Este archivo reemplaza a `getRanked()` del origen (`F:\busqueda_trabajo\server\
// index.js:97-134`) y a las TRES variables de memoria que lo sostenían.
//
// ── EL ORIGEN: UNA FUNCIÓN CENTRAL Y TRES VARIABLES DE MÓDULO ─────────────────
//
//   let cache = { data: null, at: 0, online: false };   ← 30 min de TTL
//   const TTL = 30 * 60 * 1000;
//   let refreshing = null;                              ← promesa compartida
//   let lastApifyJobs = [];                             ← ofertas de LinkedIn
//
// Las tres existen porque el proceso era uno solo y lancaba. `cache` guardaba el
// resultado de la última búsqueda para no pegarle otra vez a las APIs; `refreshing`
// hacía que dos requests simultáneos compartieran UNA sola búsqueda en curso; y
// `lastApifyJobs` era el respaldo para que `/api/job` encontrara por id una oferta
// que no estaba en `cache.regions`.
//
// ── POR QUÉ LAS TRES SON IMPOSIBLES ACÁ ───────────────────────────────────────
//
// En Vercel cada invocación es un proceso DISTINTO, que arranca, resuelve y
// muere. `let cache` arranca en `null` SIEMPRE. O sea que:
//
//   · `cache` no cachea nada. La primera lectura después de cada arranque paga las
//     cinco bolsas enteras, y con `maxDuration: 30` eso es tiempo real de usuario.
//   · `refreshing` no deduplica nada: dos requests concurrentes están en dos
//     procesos, cada uno con su `refreshing = null`. El "click dos veces" del
//     botón "Actualizar" pega DOS veces a las bolsas.
//   · `lastApifyJobs` arranca vacío, así que `/api/job?q=linkedin-...` daría 404
//     siempre (esto se resuelve distinto: `apifyLinkedin.js` es el paso 10 y va a
//     ESCRIBIR en `job_history`, que es donde este archivo no tiene que saber nada).
//
// ── LA RESPUESTA: LA CACHÉ ES LA TABLA `searches` + `job_history` ─────────────
//
// La fila más reciente de `searches` ES la marca de la última corrida: el
// `created_at` dice cuándo y el `online` si las fuentes contestaron. Y las ofertas
// de esa corrida son las filas de `job_history` con `last_seen` posterior a ese
// `created_at`. O sea que la caché no hay que inventarla: hay que LEERLA.
//
// Y esto no es una degradación, es una mejora, por tres razones concretas:
//
//   1. La caché pasa a ser POR USUARIO y no global. `cache` era un solo objeto
//      para todos: el usuario B pisaba el resultado del usuario A. Con la tabla,
//      cada uno tiene su historial y su última corrida.
//   2. La invalidación EXISTE de verdad. `POST /api/refresh` es un endpoint cuyo
//      trabajo es "borra la caché y buscá de nuevo". Con una variable de módulo,
//      "borrar la caché" era poner `cache.data = null`, que en el siguiente cold
//      start ya estaba vacío igual; acá la invalidación es escribir una corrida
//      nueva, que es un hecho que la base puede contar y auditar.
//   3. Un despliegue nuevo ya no arranca con la app entera en modo demo.
//
// ── POR QUÉ NO SE DERIVA EL MATCH DE LO GUARDADO ─────────────────────────────
//
// El `jsonb` de `job_history` NO tiene `score`, ni `matched`, ni `missed`
// (`history.js:457`, `CAMPOS_DEL_MATCH`), y por eso TODO lo que sale de acá se
// vuelve a rankear contra el perfil de HOY. La razón es que el perfil se edita:
// el usuario sube otro CV, cambia los pesos de las skills, y los puntajes que
// quedaron guardados son RANCIOS.
//
// O sea que la caché guarda las OFERTAS (un hecho del mundo) y el puntaje se
// recalcula siempre (un hecho del perfil). Si se guardara el `score`, `GET /api/
// jobs` y `/api/history` mostrarían porcentajes que no corresponden al perfil con
// el que el usuario está mirando, sin ninguna señal visible.
//
// ── POR QUÉ UNA COLUMNA `searches.online` Y NO DERIVARLO DE `jobs.length` ─────
//
// Porque son dos preguntas distintas y el usuario las vive distinto:
//
//   · "Las cinco bolsas respondieron y no hay nada que te sirva"
//   · "No pudimos contactar a ninguna bolsa"
//
// Con `jobs.length` las dos dan CERO y el frontend no puede distinguirlas
// (`App.jsx:607` elige el texto con `_online`). Peor: una bolsa que responde 200
// con cero resultados se reportaría como caída, y se le diría al usuario que las
// bolsas están rotas cuando en realidad le contestaron "no hay nada". La migración
// `011_searches_online.sql` lo desarrolla entero; acá lo que importa es que el
// valor viene de `fetchJobs`, que ya lo calculó fuente por fuente.
//
// ── POR QUÉ NO HAY `refreshing`, Y QUÉ LO REEMPLAZA ───────────────────────────
//
// No se puede portar: la deduplicación de llamadas en curso necesita memoria
// compartida entre requests, y en serverless dos requests son dos procesos. No hay
// variable de módulo que los una.
//
// Lo que SÍ evita el trabajo duplicado es la base, y para cada cosa hay una:
//   · `unique (user_id, key)` en `job_history` (`005_job_history.sql`): dos
//     corridas simultáneas del MISMO usuario no crean dos juegos de filas, la
//     segunda hace `on conflict do update`. Esto reemplaza al `withLock` del
//     origen, que también es inportable, y por el mismo motivo.
//   · `searches` NO tiene unicidad y es correcto: dos corridas son dos hechos
//     distintos, y el historial de búsquedas tiene que poder contar las dos.
//
// Y la doble corrida se acepta con su costo medido: son unos segundos de red a
// cinco bolsas GRATUITAS, duplicados solo si el usuario aprieta "Actualizar" dos
// veces en el mismo segundo. No cuesta plata (a diferencia de Apify) ni degrada a
// los demás usuarios (a diferencia de un servicio compartido).
//
// SI ALGÚN DÍA MOLESTA, LA SOLUCIÓN ES UN ADVISORY LOCK DE POSTGRES, no una
// variable de módulo: `pg_advisory_xact_lock(hash(user_id))` adentro de la misma
// transacción de `recordSearch` es exactamente el patrón de `cvParseLimit.js`. La
// forma de arreglarlo NO es volver a una variable de memoria, porque eso ya se
// probó: no funciona en el entorno donde vive.
//
// ── POR QUÉ ESTE MÓDULO NO ES UN ENDPOINT ─────────────────────────────────────
//
// `getRanked` es el ÚNICO que sabe cómo se decide si hay que pegarle a las bolsas
// o no. `/api/jobs`, `/api/refresh` y `/api/analytics` lo llaman y arman su
// respuesta; ninguno de los tres reimplementa el TTL ni las reglas. Si el criterio
// viviera en los endpoints, habría tres copias que se desincronizan, que es
// exactamente lo que pasó con las regiones (punto 9 del plan) y lo que este
// proyecto se está desarmando archivo por archivo.
// ============================================================================

import { query } from './db.js';
import { expiresAtFor, recordSearch } from './history.js';
import { fetchJobs } from './jobSources.js';
import { rankByRegion } from './matcher.js';
import { enrichJobs } from './portal.js';
import { DEFAULT_REGION, REGIONS, emptyBuckets, isValidRegion } from './regions.js';
import { searchTerms } from './searchTerms.js';

// ↑ `enrichJobs` y NO `enrichRegions`: la forma que se devuelve es un objeto de
//   buckets `{region: [...]}` para que `/api/analytics` y `/api/refresh` puedan
//   usar TODOS, y el enriquecimiento se hace UNA vez sobre la lista plana, antes
//   de rankear. `rankByRegion` arma los buckets después, así que no hay doble
//   trabajo: `enrichRegions` solo serviría para un mapa que todavía no existe.
//
// ↑ `isValidRegion`, `DEFAULT_REGION` y `REGIONS` (y `emptyBuckets`) se usan para
//   la normalización de la región y para el resultado degenerado. Ver las dos
//   funciones de abajo.

/**
 * Cuánto vive una corrida antes de que se vuelva a consultar las bolsas.
 *
 * EL MISMO NÚMERO DEL ORIGEN (`index.js:97`, `const TTL = 30 * 60 * 1000`) y por
 * el mismo motivo: es el tiempo que las bolsas gratuitas demoran en rearmar sus
 * respuestas sin que la lista se sienta vieja. Treinta minutos es un balance entre
 * "no pegarle a las APIs en cada F5" y "no mostrar una lista que cambió hace media
 * hora".
 *
 * Y la diferencia con el origen no es el número, es que acá este TTL se mide
 * contra la fila de `searches`: el reloj es el de la corrida, no el del proceso.
 *
 * @type {number}
 */
export const CACHE_TTL_MS = 30 * 60 * 1000;

// ↑ `const` con nombre propio y NO un literal en la comparación: es un valor de
//   política del producto (el origen lo tenía en `TTL`), y un `1800000` suelto en
//   una línea de `if` no dice nada de por sí. Además `export` para que un test o un
//   endpoint pueda razonar sobre el mismo número sin copiarlo.

/**
 * Cuántas ofertas trae como máximo la LECTURA de la caché.
 *
 * 300, el mismo número y el mismo motivo que `MAX_HISTORY_ROWS` en
 * `history.js:429`: una corrida de las cinco bolsas da del orden de las centenas,
 * y el `limit` corta por `last_seen desc`, o sea que lo que se queda son las más
 * recientes. El ranking se vuelve a hacer igual (`rankByRegion`), así que perder
 * las más viejas de UNA corrida no cambia la calidad de la respuesta: la página
 * muestra una fracción de lo que ya mostraba.
 *
 * @type {number}
 */
const MAX_CACHED_ROWS = 300;

/**
 * El predicado de "esta fila NO está vencida", como fragmento de SQL.
 *
 * ES EL MISMO QUE `vigente()` DE `history.js:353-355`, y está DUPLICADO a
 * propósito, por la misma razón que el `UUID_RE` de `history.js:86`: es una
 * decisión LOCAL de este archivo, no una pieza compartida. Importarlo ataría la
 * caché al módulo de historial (que es de escritura y retención) para copiar tres
 * líneas.
 *
 * Y el motivo por el que la duplicación es RIESGOSA —y por eso está escrito acá
 * con el mismo texto— es concreto: la lectura de la caché y la lectura de
 * `/api/history` muestran LAS MISMAS OFERTAS en dos pantallas de la misma app. Si
 * una dice que una oferta está vigente y la otra que no, el usuario ve una lista
 * y después "no aparece en la última búsqueda" sobre una oferta que estaba en
 * pantalla hace un segundo. Los dos fallos posibles (una oferta que se muestra y
 * después no, o una que nunca aparece) son listas que mienten.
 *
 * `$1` es el mes de retención, igual que en `history.js`.
 */
const VIGENTE_SQL = `not ((jh.expires_at is not null and jh.expires_at < now())
    or (jh.expires_at is null and jh.first_seen + make_interval(months => $4::int) < now()))`;

/**
 * ¿Es un uuid EN FORMA DE STRING?
 *
 * Tercer lugar del proyecto que decide lo mismo (`profile.js:47`, `history.js:86`,
 * `auth.js:147`) y por el mismo motivo: es una decisión de BORDE ("qué hago con un
 * id que no puede existir"), no una pieza compartida. `UUID_RE.test(String(x))` no
 * alcanza porque `String()` de un array de un elemento, de un `new String` o de un
 * objeto con `toString` da el mismo string que el uuid, y los tres pasan el regex y
 * llegan a Postgres, que los rechaza con `22P02`.
 *
 * @param {unknown} value Lo que sea.
 * @returns {boolean} Si es un string con la forma de un uuid.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {unknown} value Lo que sea. @returns {boolean} Si es un uuid en forma. */
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// ════════════════════════════════════════════════════════════════════════════
// EL BORDE: LEER PARÁMETROS DE LA URL Y RESOLVER LA REGIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Un parámetro del query string, o `null`.
 *
 * Vercel arma `req.query` antes de llamar al handler, así que el camino normal es
 * ese. El segundo camino —parsear `req.url`— existe porque el proyecto verifica
 * los endpoints con un `node:http` mínimo que NO arma `req.query`, y un helper que
 * solo leyera `req.query` haría imposible ejercitar de verdad los endpoints sin
 * pagar por `vercel dev`. Los dos caminos dan el MISMO valor en producción: es el
 * mismo `URLSearchParams`, y el que decide es el runtime, no este archivo.
 *
 * Un parámetro repetido (`?id=a&id=b`) llega como ARRAY de Vercel, y se toma el
 * primero. No es un caso del contrato: es que el tipo del que llega no está
 * garantizado y hay que elegir uno.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @param {string} name Nombre del parámetro.
 * @returns {string|null} El valor recortado, o `null` si no vino o vino vacío.
 */
export function readParam(req, name) {
  const deQuery = req && req.query ? req.query[name] : undefined;
  const crudo = Array.isArray(deQuery) ? deQuery[0] : deQuery;
  if (typeof crudo === 'string') return crudo.trim() || null;

  const url = req && typeof req.url === 'string' ? req.url : '';
  if (!url) return null;
  // ↑ Un `req` falso en un test puede no tener `url`: `new URL(undefined)` tiraría
  //   un TypeError y el 500 sería por el test, no por el endpoint.
  try {
    const valor = new URL(url, 'http://localhost').searchParams.get(name);
    return valor === null ? null : valor.trim() || null;
  } catch {
    return null;
  }
}

/**
 * La región pedida, o la del proyecto.
 *
 * ── POR QUÉ UNA REGIÓN DESCONOCIDA NO ES UN 400 ──────────────────────────────
 * Es el comportamiento del origen (`index.js:246`: `url.searchParams.get('region')
 * || 'argentina'`) y la razón de que sea el correcto acá es de contrato, no de
 * comodidad: el frontend manda la región de la pestaña activa, y la lista de
 * pestañas sale de `REGIONS` (`RegionTabs.jsx`), así que un `?region=` desconocido
 * no puede venir de la UI. Puede venir de un link viejo, de un marcador, o de una
 * región que se borró de `regions.js` en un deploy. En los tres casos lo que hay
 * que hacer es contestarle con algo, y "la región por defecto" es lo que el
 * usuario esperaba al hacer click. Un 400 lo deja con una pantalla de error por un
 * detalle que él no puede arreglar.
 *
 * OJO con lo que NO se hace: no se "limpia" ni se registra la región desconocida.
 * Lo que se guarda (`searches.region`) es la RESUELTA, que es la que existe en la
 * configuración, y escribir una clave inventada en el historial sería guardar un
 * dato que `REGIONS` no conoce y que `regionLabel` no sabe pintar.
 *
 * @param {unknown} value Lo que vino del query string (o `null`).
 * @returns {string} Una clave de `REGIONS`. Siempre.
 */
export function resolveRegion(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  return key && isValidRegion(key) ? key : DEFAULT_REGION;
}

// ════════════════════════════════════════════════════════════════════════════
// LA CACHÉ: LEER LA ÚLTIMA CORRIDA
// ════════════════════════════════════════════════════════════════════════════

/**
 * La última corrida del usuario, o `null` si nunca corrió una.
 *
 * La query es la MISMA que dice la migración `011_searches_online.sql:92`, y usa
 * el índice `(user_id, created_at desc)` de la migración `008`. Dos filas (o
 * cero) en vez de una: `online` y `created_at`.
 *
 * ── POR QUÉ `order by created_at desc limit 1` Y NO "la última por id" ────────
 * Porque `created_at` es lo que define "la última corrida" en el resto del
 * proyecto: `getHistoryForRegion` deriva `active` de `max(created_at)`
 * (`005_job_history.sql:143-147`). Si esta función usara otro criterio y aquella
 * usara otro, la caché y la vista de historial podrían mirar corridas distintas en
 * el mismo instante.
 *
 * @param {string} userId UUID del usuario.
 * @returns {Promise<{checkedAt: Date, online: boolean}|null>} La corrida, o null.
 */
async function lastRun(userId) {
  const { rows } = await query(
    // ↑ Se piden las columnas una por una y no `select *`: la fila de `searches`
    //   tiene `keywords` (un `text[]`) y `id`, y acá no se usa ninguna de las dos.
    //   Es el mismo criterio que `requireSession` con `users`.
    `select s.created_at, s.online
       from searches as s
      where s.user_id = $1
      order by s.created_at desc
      limit 1`,
    [userId],
  );
  const fila = rows[0];
  if (!fila || !fila.created_at) return null;
  return {
    checkedAt: fila.created_at,
    // ↑ `!== false`: la columna es `not null default true`, así que el valor real
    //   nunca es otro, pero un `Boolean(...)` sobre `undefined` daría `false` y
    //   diría "no pudimos contactar las bolsas" en una corrida que sí lo hizo. Con
    //   el mismo criterio que `recordSearch` (`history.js:518`): solo un `false`
    //   explícito significa offline.
    online: fila.online !== false,
  };
}

/**
 * Las ofertas de la última corrida de este usuario, leídas del historial.
 *
 * ── POR QUÉ `last_seen >= $2` Y NO "todas las filas del historial" ────────────
 * Porque el historial es de SEIS MESES y la caché es de 30 MINUTOS. Sin este
 * predicado, la "caché" devolvería el historial entero, que para un usuario activo
 * son miles de ofertas que la app nunca mostró en la última corrida: ofertas
 * relevantes que la bolsa ya no lista, y que volverían a pantalla como si fueran
 * nuevas.
 *
 * `>=` y no `=` por el mismo motivo que en `history.js:739`: las dos fechas salen
 * del mismo `now()` de la transacción de `recordSearch`, así que hoy `=` andaría,
 * pero eso es una coincidencia de implementación. `>=` es la forma monótona de la
 * misma pregunta y no depende de que los dos relojes coincidan al microsegundo.
 *
 * ── POR QUÉ `$3::text[] && jh.regions` Y NO "sin filtro de región" ───────────
 * Porque el bucketeo lo hace `rankByRegion` después, y `matchRegion` vuelve a
 * decidir a qué región pertenece cada oferta. Traer la fila entera sin filtrar
 * funcionaría con el scope actual (Argentina), pero con dos países una oferta
 * cargada a mano con `regions = ['españa']` entraría al buckete de Argentina si su
 * texto no la delata. El filtro deja la decisión de región en un solo lugar.
 *
 * @param {string} userId UUID del usuario.
 * @param {Date} desde El `created_at` de la última corrida.
 * @returns {Promise<object[]>} Las ofertas crudas del jsonb. `[]` si no hay.
 */
async function jobsOfLastRun(userId, desde) {
  const { rows } = await query(
    `select jh.job
       from job_history as jh
      where jh.user_id = $1
        and jh.last_seen >= $2::timestamptz
        and $3::text[] && jh.regions
        and ${VIGENTE_SQL}
      order by jh.last_seen desc
      limit $5`,
    // ↑ Los huecos en los números de los placeholders son lo normal: `$4` es el
    //   mes de retención que usa el predicado y `$5` es el tope de filas. Podrían
    //   renumerarse, pero `VIGENTE_SQL` está escrito una vez con `$4`, y duplicarlo
    //   con un número distinto en cada query es la forma de que un día se mezclen.
    //   Postgres no exige que se usen todos los parámetros.
    [userId, desde, Object.keys(REGIONS), 6, MAX_CACHED_ROWS],
  );
  // ↑ `pg` devuelve un `jsonb` YA parseado como objeto, no como string: por eso
  //   acá no hay `JSON.parse` (a diferencia de `recordSearch`, que lo serializa
  //   antes de mandarlo).
  return rows.map((row) => row.job).filter((job) => job && typeof job === 'object');
}

// ════════════════════════════════════════════════════════════════════════════
// LA RETENCIÓN EN EL CAMINO DE BÚSQUEDA REAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Las ofertas que ya están fuera de la ventana de retención.
 *
 * ── POR QUÉ HAY QUE FILTRAR ACÁ, Y NO SOLO EN LA LECTURA ──────────────────────
 * El origen lo hacía: en `index.js:141` el `rankByRegion(jobs)` venía envuelto en
 * un `expireOldJobs(...)`, y esa función del origen FILTRABA la lista que le
 * pasabas además de borrar del archivo (el `history.js:421-452` del proyecto
 * anterior, línea 431: `filtered[region] = jobs.filter((job) => { const keep = ... })`).
 *
 * El `expireOldJobs` de este proyecto ya NO filtra: devuelve la cantidad de filas
 * que borró (`history.js:840-856` dice que "acá el filtrado ya lo hizo
 * `rankByRegion`/`matchRegion` antes de que existiera una fila de historial"). Esa
 * afirmación es incorrecta para este caso, y conviene dejar por qué: `rankByRegion`
 * filtra por REGIÓN y por `score > 0`, y ninguno de los dos criterios sabe de
 * antigüedad. Una oferta publicada hace ocho meses que la bolsa sigue listando
 * entra al ranking, y su `expires_at` queda en el pasado: `recordSearch` la
 * upserta igual (el `on conflict` no mira el vencimiento), la purga que va en la
 * misma transacción la borra de nuevo, y el resultado en pantalla es una oferta
 * que `/api/jobs` muestra y `/api/history` no muestra nunca.
 *
 * NO se corrigió `history.js` porque es un módulo verificado de este plan y su
 * cambio de firma no corresponde a este paso: se compensa acá, que es el único
 * lugar que arma la lista que se muestra.
 *
 * ── POR QUÉ ES `expiresAtFor` Y NO UN CÁLCULO PROPIO ──────────────────────────
 * Porque `expiresAtFor` (`history.js:298`) es el ESPEJO EN JS de la misma regla que
 * aplica el SQL del `upsert` (`coalesce(pub, first_seen) + make_interval(months
 * => 6)`), está exportada para ser testeada, y usa el mismo `setMonth` que
 * `retentionCutoff`: los dos meses de fin de mes se recortan igual. Reescribirlo
 * acá sería una tercera definición de "seis meses" en el proyecto.
 *
 * ── POR QUÉ SOLO SE DESCARTA SI HAY UNA FECHA LEGIBLE ─────────────────────────
 * Fallo ABIERTO y a propósito. Sin fecha de publicación, `expiresAtFor` cuenta
 * desde `now()` y no hay nada que descartar; si la fecha viniera corrupta y
 * devolviera un `NaN`, se descarta con `Number.isFinite` y no se tira la función
 * entera por una bolsa que mandó basura. Es el mismo criterio que el SQL, donde
 * `expires_at is null` con `first_seen` reciente es una fila vigente.
 *
 * @param {object[]} enriched Ofertas ya enriquecidas.
 * @param {number} now Epoch en ms.
 * @returns {object[]} Las que siguen dentro de la ventana.
 */
function dentroDeRetencion(enriched, now) {
  return enriched.filter((job) => {
    const iso = expiresAtFor(job, null, now);
    if (!iso) return true;
    const ms = Date.parse(iso);
    return !Number.isFinite(ms) || ms >= now;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// LA FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Las ofertas rankeadas de este usuario, de la caché o de las bolsas.
 *
 * ── LO QUE DEVUELVE, Y POR QUÉ ESTOS CAMPOS ──────────────────────────────────
 *
 *   regions   Los buckets de `rankByRegion`: un array por región CONFIGURADA,
 *             aunque esté vacío. `/api/analytics` usa TODOS y `/api/jobs` usa uno.
 *   _online   Si las fuentes respondieron. Lo decide `fetchJobs` fuente por fuente
 *             y en el camino de caché sale de la fila de la corrida. El frontend
 *             lo lee en `App.jsx:607`.
 *   source    `'cache'` o `'live'`. NO lo pide ningún consumidor: existe para que
 *             se pueda VERIFICAR que la caché funciona (que es lo único que se
 *             puede hacer con una variable que no existe), y para el diagnóstico de
 *             un 5xx lento. Agregarlo es aditivo: el contrato del origen no lo
 *             traía y ningún consumidor lo rechaza.
 *   checkedAt Cuándo se hizo la corrida, NO cuándo se armó la respuesta. En caché
 *             sale del `created_at` de la fila, que es el reloj de la corrida.
 *
 * ── EL ORDEN DE LOS DOS CAMINOS ──────────────────────────────────────────────
 * Primero la caché y después las bolsas, y no al revés, por una razón de costo y
 * no de lógica: el camino de la caché son DOS queries de milisegundos y el de las
 * bolsas son cinco requests de red cuyo peor caso son 20 segundos. Preguntar
 * "¿hay algo guardado?" antes de ir a buscar es lo que hace el origen también
 * (el `if (!force && cache.data && now - cache.at < TTL)` es la primera línea).
 *
 * ── POR QUÉ `force` ES EL ARGUMENTO QUE LE DA SENTIDO A `/api/refresh` ───────
 * Sin `force`, ese endpoint sería un no-op: leería la caché que acaba de escribir
 * la corrida anterior y devolvería lo mismo con otro `checkedAt`. Con `force` va
 * SIEMPRE al camino de las bolsas, escribe una corrida nueva, y deja esa corrida
 * como la caché para los próximos 30 minutos.
 *
 * ── `userId`: SIEMPRE DE LA COOKIE ───────────────────────────────────────────
 * Sale de `requireProfile(req)` en el endpoint, o sea del HMAC de la sesión. Nunca
 * del query string ni del body. Es la regla número uno del esquema y la razón por
 * la que dos usuarios con perfiles distintos nunca ven las ofertas del otro.
 *
 * @param {string} userId UUID del usuario, de `requireProfile(req)`.
 * @param {object} profile Perfil del CONTRATO (`normalizeProfile`), no la fila
 *   cruda. `rankByRegion` y `fetchJobs` lo necesitan en esa forma, y pasarlo mal
 *   es el modo de falla silencioso de AGENTS.md: sin `skills` array el match da 0
 *   en todas las ofertas y la app parece vacía.
 * @param {object} [options]
 * @param {boolean} [options.force] Ignorar la caché y buscar de nuevo.
 * @param {string} [options.region] Región POR LA QUE SE PIDIÓ la corrida. Va a la
 *   columna `searches.region`; NO decide el bucketeo (eso es de `matchRegion`).
 * @param {string[]} [options.keywords] Términos de búsqueda. Si viene vacío se
 *   derivan del perfil con `searchTerms`, que es lo que `fetchJobs` va a usar, y
 *   así la columna `searches.keywords` dice la verdad sobre lo que se buscó.
 * @returns {Promise<{regions: Record<string, object[]>, _online: boolean,
 *   source: 'cache'|'live', checkedAt: Date}>}
 */
export async function getRanked(userId, profile, { force = false, region = DEFAULT_REGION, keywords = [] } = {}) {
  const now = Date.now();

  if (!isUuid(userId)) {
    // ↑ No puede pasar: `userId` sale de la fila de `users` que leyó
    //   `requireProfile`. Está el corte igual porque esta función es la que abre
    //   SQL con el valor, y mandar un id que no puede existir convierte un dato
    //   imposible en un 500 de Postgres (`22P02`). Es el mismo criterio que
    //   `recordSearch` (`history.js:509`) y que `saveProfile`.
    //
    //   `_online: false` y no `true`: no se consultó a nadie, así que lo único que
    //   se puede afirmar es que no hay respuesta. Con `true` el frontend anunciaría
    //   "conexión exitosa con las fuentes" y eso sería falso.
    return { regions: emptyBuckets(), _online: false, source: 'live', checkedAt: new Date(now) };
  }

  // ── Camino 1: la caché ──────────────────────────────────────────────────────
  if (!force) {
    const corrida = await lastRun(userId);
    const edad = corrida ? now - new Date(corrida.checkedAt).getTime() : Infinity;
    // ↑ `Infinity` y no un `if` anidado: "no hay fila" y "la fila es vieja" son el
    //   MISMO caso —no hay caché— y el valor los unifica sin una rama extra. La
    //   comparación es `> TTL` y no `>=`: con exactamente 30 minutos la corrida es
    //   todavía la última, y el origen usaba `now - cache.at < TTL`, que también
    //   incluye el borde.
    if (corrida && edad <= CACHE_TTL_MS) {
      const crudas = await jobsOfLastRun(userId, corrida.checkedAt);
      // ↑ Se vuelve a rankear SIEMPRE, contra el perfil de HOY. Ver el bloque de
      //   arriba: el `jsonb` no tiene score y el perfil se puede editar.
      return {
        regions: rankByRegion(crudas, profile),
        _online: corrida.online,
        source: 'cache',
        checkedAt: new Date(corrida.checkedAt),
        // ↑ El `new Date(...)` y no el `Date` que dio `pg`: se devuelve el MISMO
        //   tipo en los dos caminos (`live` devuelve `new Date(now)`), así que el
        //   endpoint que lo mande no tiene que preguntar de dónde salió.
      };
    }
  }

  // ── Camino 2: las bolsas ────────────────────────────────────────────────────
  const { jobs, online } = await fetchJobs(profile);
  // ↑ NUNCA tira (`fetchJobs` usa `allSettled` y cada fuente tiene su `try/catch`).
  //   Es lo que hace que `/api/jobs` no devuelva 500 por culpa de la API de una
  //   bolsa, que es el modo de falla que el `catch` del origen tapaba con un
  //   `jobs = []` mudo.

  const enriched = enrichJobs(jobs);
  // ↑ OBLIGATORIO antes de rankear, no después. `rankByRegion` arma sus buckets
  //   con COPIAS (`{...job, ...match}`) que ya no van a pasar por `withPortal`, así
  //   que enriquecer después del rankeo no funciona. Y el motivo de fondo es la
  //   regla de AGENTS.md: TODO lo que devuelva ofertas pasa por `withPortal`, o el
  //   frontend recibe ofertas sin `portal` ni link de origen. Además es lo que
  //   hace que lo que se GUARDE en el historial ya venga con `portal`, que es la
  //   razón por la que `/api/history` no vuelve a enriquecer.

  const viable = dentroDeRetencion(enriched, now);
  const ranked = rankByRegion(viable, profile);
  const hayOfertas = Object.values(ranked).some((lista) => lista.length > 0);
  // ↑ `some` sobre TODOS los buckets y no `ranked[region].length`: la corrida
  //   alimenta los buckets de todas las regiones configuradas (`matchRegion` decide
  //   bucket por oferta), así que "no hay ofertas" tiene que significar "no hay
  //   ofertas en ninguna región". Con el alcance actual (una sola región) los dos
  //   criterios coinciden, y por eso el detalle NO se vería: es un bug que solo
  //   aparece el día que se agrega un país.

  // ── La escritura del historial ──────────────────────────────────────────────
  //
  // SE PASA `ranked` Y NO UN ARRAY PLANO DE `enriched`, y la diferencia NO es de
  // estilo: `recordSearch` espera `{ region: [ofertas] }` (`history.js:508`,
  // `collectEntries` itera `Object.entries` y descarta todo lo que no sea un array:
  // `history.js:665`). Un array plano de ofertas recorre `Object.entries` como
  // `[['0', oferta], ['1', oferta]]`, ninguna de esas "listas" es un array, y el
  // resultado es que se escribe la fila de `searches` con CERO filas de historial:
  // `/api/job` daría 404 para toda oferta y `/api/history` quedaría vacío, sin un
  // error en ninguna parte. O sea que "pasale enriched" no es lo que dice el
  // comentario del llamador, es lo que haría perder el historial entero.
  //
  // Lo que SÍ se cumple es lo que el comentario quiere decir: lo que se guarda es
  // la OFERTA y no el MATCH. Lo garantiza `recordSearch` adentro, no el endpoint:
  // `sinCamposDeMatch` (`history.js:716`) borra `score`, `matched`, `missed`,
  // `requested`, `roles`, `inTitle` y `comment` de una COPIA antes de serializar.
  // Por eso se puede pasar el resultado del rankeo sin miedo: los bytes que
  // terminan en el `jsonb` son los mismos que si se pasara el array plano.
  //
  // ── Y POR QUÉ EL `{}` CUANDO NO HAY OFERTAS ─────────────────────────────────
  // `recordSearch` con `{}` escribe CERO filas en `job_history` (`collectEntries`
  // itera `Object.entries({})` y no encuentra ningún array), así que "si no hay
  // ofertas no se escribe historial de ofertas" se cumple exactamente: no queda ni
  // una fila, ni un `key`, ni un `first_seen`.
  //
  // PERO IGUAL SE ESCRIBE UNA FILA EN `searches`, y es a propósito. `recordSearch`
  // registra la corrida siempre, y el `{}` solo le dice "no hay ofertas que
  // upsertar". La fila de `searches` no es historial de ofertas: es el REGISTRO DE
  // QUE SE CORRIÓ UNA BÚSQUEDA, y es lo único que puede cachear dos hechos que de
  // otro modo se pierden:
  //
  //   1. `_online`. Sin fila, `lastRun` devuelve `null` y el próximo request vuelve a
  //      pegarle a las cinco bolsas. Con el caso MÁS IMPORTANTE de todos —las
  //      bolsas caído, `_online: false`— eso significa que cada request del usuario
  //      paga los 20 s de red completos, para siempre. La columna `online` de la
  //      migración 011 existe para esto y no para otra cosa.
  //   2. `keywords` y `region` de la corrida, que son datos de la búsqueda, no de
  //      sus resultados. Una búsqueda sin resultados es un hecho que registrar: sin
  //      esto no se podría ni contar cuántas veces buscó alguien.
  //
  // O sea: "no escribas historial" se cumple sobre `job_history`, que es el
  // historial de OFERTAS. Lo que se escribe acá es la fila de la CORRIDA, que es la
  // caché. Son dos cosas distintas, y confundirlas rompe justo el caso que más las
  // necesita.
  try {
    await recordSearch(userId, hayOfertas ? ranked : {}, {
      region: resolveRegion(region),
      keywords: Array.isArray(keywords) && keywords.length ? keywords : searchTerms(profile),
      online,
    });
  } catch (err) {
    // ↑ El `catch` NO es vacío y el registro NO es un detalle opcional: es el
    //   comportamiento del ORIGEN (`index.js:174-181`), que también seguía
    //   respondiendo y dejaba el error en la consola. La razón es que la búsqueda
    //   ya costó cinco requests de red y varios segundos: tirar todo eso por un
    //   error de escritura al historial sería tirar el trabajo del usuario. Y sin
    //   el log, la primera vez que el historial deje de guardarse no hay forma de
    //   enterarse (el síntoma sería "no me aparecen ofertas en el historial", que
    //   se parece a un bug de la lista y no a un error de base).
    console.error('[jobs] No se pudo guardar el historial:', (err && err.message) || err);
  }

  return {
    regions: ranked,
    // ↑ `_online` es SIEMPRE el de `fetchJobs`, nunca `hayOfertas`. Son dos
    //   hechos distintos (ver el bloque de arriba y la migración 011) y confusing
    //   el segundo con el primero hace que "las bolsas respondieron y no hay nada
    //   para vos" se muestre como "no pudimos contactar las bolsas".
    _online: online,
    source: 'live',
    checkedAt: new Date(now),
  };
}

/**
 * Las ofertas de un bucket, o `[]`.
 *
 * Existe para que los tres endpoints que toman un bucket (`/api/jobs`,
 * `/api/refresh`, y el `total` de `/api/refresh`) no repitan el
 * `(regions?.[region] || [])`. Y para que el `|| []` esté en UN lugar: `regions` es
 * siempre un objeto con todas las claves de `REGIONS`, pero un `regions` que venga
 * de otro camino (un test, un futuro endpoint) no tiene por qué tenerlo.
 *
 * @param {Record<string, object[]>} regions Buckets del ranking.
 * @param {string} region Clave de región ya resuelta con `resolveRegion`.
 * @returns {object[]} El bucket, o una lista vacía.
 */
export function bucketOf(regions, region) {
  const lista = regions && typeof regions === 'object' ? regions[region] : null;
  return Array.isArray(lista) ? lista : [];
}