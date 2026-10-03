// ============================================================================
// EL HISTORIAL DE OFERTAS: lo que el usuario vio, deduplicado y con retención.
//
// Este módulo reemplaza a `F:\busqueda_trabajo\server\history.js` (485 líneas).
// La LÓGICA se conserva TAL CUAL —la deduplicación, la unión de regiones y la
// retención de 6 meses son buenas y están probadas por el uso— y lo único que
// cambia es el backend: de un `data/history.json` con un mutex en memoria a
// dos tablas de Postgres.
//
// ── POR QUÉ NO HAY MUTEX ────────────────────────────────────────────────────
// El origen serializaba TODO el ciclo leer→mutar→guardar con una cadena de
// promesas (`withLock`), porque dos búsquedas simultáneas(load + mutar + save
// del archivo entero) se pisaban y una se perdía. Ese mutex NO SE PUEDE PORTAR:
// en Vercel cada invocación es un proceso distinto, así que no hay nada que
// serializar (una cola a nivel de módulo dying con el proceso).
//
// Lo que lo reemplaza es `unique (user_id, key)` + `on conflict do update`
// (`005_job_history.sql:100-117`): la deduplicación pasa a ser una restricción
// que la base garantiza, y el upsert hace el leer-modificar-escribir sin ventana
// entre las dos operaciones. O sea que el UNIQUE no es solo integridad: es el
// reemplazo del lock que no se puede portar.
//
// ── LO QUE NO SE PORTÓ, Y POR QUÉ ──────────────────────────────────────────
// Todo esto era infraestructura del archivo JSON y desaparece con el archivo:
//   · `withLock`/`queue`, `writeAtomic`, `readBak`, `bakWatermark`, `.bak`,
//     `.tmp`, `recoverCorrupt`, `hasValidShape`, `emptyHistory`,
//     `DATA_DIR`/`HISTORY_DATA_DIR`.
//     Eran la respuesta a "el archivo se puede corromper a mitad de escritura" y
//     a "el archivo no existe". Una transacción de Postgres no se corrompe a
//     mitad: o committea o no pasa, y la tabla existe desde que corrió la
//     migración. Los reintentos del `.bak` eran el mecanismo para el estado
//     "PARCIALMENTE ESCRITO", que acá no existe.
//   · `legacyKeyOf` + la migración en caliente de las claves viejas.
//     Era un artefacto de un archivo que tenía 117 entradas con la clave
//     "título::empresa" (sin el link). Contra una tabla vacía no hay nada que
//     migrar, y contra una tabla llena el `on conflict` resuelve cada fila de a
//     una sin una pasada de migración.
//   · `regionsOf()`: leía el esquema viejo (`region` de texto) y el nuevo
//     (`regions` de array). En SQL la columna es `text[]` desde el día cero
//     (`005_job_history.sql:63-68`), así que no hay dos esquemas que leer.
//   · `countEntries`, `rememberLoaded`, `load`, `save`: el leer-todo-y-guardar-
//     todo. Acá cada fila va por su cuenta.
//
// ── LO QUE SÍ SE MANTUVE TAL CUAL ───────────────────────────────────────────
// `normalizeKey`, `linkSlug` y `keyOf` (incluido el comentario de por qué el
// link va en la clave), el ORDEN de los campos de fecha de publicación
// (`date` → `postedAtTimestamp` → `postedAt`, el mismo que usa `publishedAt` en
// `matcher.js:281-283`) y los 6 meses de retención. Esos son los tres lugares
// donde un "detalle" cambia una clave o una fecha y por eso están portados
// carácter por carácter, no parafraseados.
// ============================================================================

import { query, withTransaction } from './db.js';
import { DEFAULT_REGION } from './regions.js';

// ↑ `db.js` es el ÚNICO módulo del proyecto que abre conexiones (AGENTS.md) y acá
//   NO se importa `pg`: `query()` para las lecturas (toma y suelta un cliente del
//   pool sola) y `withTransaction()` para `recordSearch`, que necesita un cliente
//   FIJO durante la fila de `searches`, los upserts y la purga. Usar `query()`
//   adentro de la transacción haría que cada statement cayera en una conexión
//   distinta y el `begin`/`commit` no envolvería nada (`profile.js:592-600`).
//
// ↑ `DEFAULT_REGION` y NO una lista de regiones: acá se guarda la región POR LA
//   QUE SE PIDIÓ la corrida, y la configuración de qué países existen vive en
//   `regions.js` (el punto 9 del plan). No se valida contra `REGIONS` en este
//   archivo: el endpoint ya valida el `?region=` con `isValidRegion` antes de
//   llegar acá, y si este módulo "corrigiera" una región desconocida escribiría en
//   el historial algo que nadie pidió.

/**
 * ¿Es un uuid EN FORMA DE STRING?
 *
 * Copia del patrón de `profile.js:47` y del mismo criterio de `auth.js:147`, y
 * está duplicado a propósito por la misma razón: es una decisión LOCAL de este
 * archivo (qué hago con un id que no puede existir), no una pieza compartida.
 * Importarlo de `profile.js` ataría el historial a un módulo que no tiene nada
 * que ver con él. `profile.js:44-66` tiene el desarrollo completo del agujero:
 * `UUID_RE.test(String(x))` NO alcanza porque `String()` de un array de un
 * elemento, de un `new String` o de un objeto con `toString` da el mismo string
 * que el uuid, y los tres pasan el regex y llegan a Postgres, que los rechaza
 * con `22P02` y convierte un dato imposible en un 500.
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
// LA CLAVE DE DEDUPLICACIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Normaliza una clave: minúsculas y solo `[a-z0-9:]`, cualquier otra cosa pasa
 * a ser un espacio.
 *
 * Es lo que hace comparables `"QA Engineer :: Acme"` y `"qa-engineer::acme"`. En
 * el origen estaba共享 con `legacyKeyOf()` (para que la clave nueva y la clave
 * vieja se normalizaran con la MISMA regla); acá hay una sola clave, así que
 * queda con el nombre que tenía.
 *
 * @param {unknown} value Lo que sea.
 * @returns {string} La clave normalizada.
 */
function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9:]+/g, ' ').trim();
}

/**
 * El "apellido" de la oferta para la clave: sale del `id`, y si no hay id del
 * link.
 *
 * Se limpian el protocolo y todo lo que va después del `?` o del `#` porque esas
 * partes cambian entre publicaciones de la misma oferta (`utm_source` y compañía)
 * y justamente por eso dos URLs de la MISMA oferta tienen que dar la MISMA
 * clave. El `slice(0, 80)` pone un techo al largo de la fila (`005_job_history.sql:
 * 38-47` lo menciona).
 *
 * @param {object} [job] Oferta ya enriquecida.
 * @returns {string} El slug, o `''` si la oferta no trae ni id ni link.
 */
function linkSlug(job) {
  const raw = job?.id || job?.applyUrl || '';
  return String(raw)
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[?#].*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * La clave única de una oferta: `"título::empresa::<slug del id o del link>"`.
 *
 * ANTES era solo `"título::empresa"`, y eso era un bug de PÉRDIDA DE DATOS: dos
 * ofertas DISTINTAS del mismo puesto en la misma empresa (dos vacantes del mismo
 * cargo, o la misma vacante publicada en dos ciudades) se pisaban entre sí. La
 * segunda reescribía `entry.job` entero y de la primera solo sobrevivían
 * `firstSeen` y la unión de regiones: una oferta desaparecía del historial sin
 * dejar rastro. Con 200 ofertas de LinkedIn por corrida eso pasaba todo el rato.
 * Poner el link al final de la clave separa las dos sin romper nada.
 *
 * EXPORTADA como `jobHistoryKey` (más abajo) porque es la pieza que otra
 * persona va a querer testear y la que va a necesitar `/api/job` si algún día
 * busca por clave y no por `job.id`.
 *
 * @param {object} job Oferta ya enriquecida, con `title` y `company`.
 * @returns {string} La clave normalizada.
 */
function keyOf(job) {
  const base = `${job.title}::${job.company}`;
  const slug = linkSlug(job);
  // ↓ Si la oferta no tiene ni id ni link (no debería pasar, pero no se depende de
  //   eso), se degrada a la clave de siempre: es peor repetir una clave que tirar
  //   la oferta.
  return normalizeKey(slug ? `${base}::${slug}` : base);
}

/**
 * La clave de deduplicación de una oferta, en forma pública.
 *
 * @param {object} job Oferta ya enriquecida, con `title` y `company`.
 * @returns {string} La misma clave que usa el `upsert` de `recordSearch`.
 */
export function jobHistoryKey(job) {
  return keyOf(job);
}

// ════════════════════════════════════════════════════════════════════════════
// LAS FECHAS: CUÁNDO EMPIEZA LA RETENCIÓN Y CUÁNDO VENCE UNA OFERTA
// ════════════════════════════════════════════════════════════════════════════

/** Cuánto se conserva una oferta en el historial. Seis meses, como en el origen. */
const RETENTION_MONTHS = 6;

/**
 * El instante de corte de la retención: seis meses antes de `now`.
 *
 * Portado del origen tal cual, incluido el `new Date(now)` de adentro (que es
 * lo que evita mutar el `Date` que le pasó el que llama).
 *
 * Un detalle que viene bien saberlo: `setMonth` de JavaScript RECORTA el día
 * cuando el mes destino no tiene ese día (`setMonth` sobre el 31 de marzo con
 * `getMonth() - 6` cae en septiembre 31, que es el 1° de octubre). Postgres hace
 * lo mismo con `make_interval(months => 6)`, así que la versión JS y la versión
 * SQL de esta retención no se contradicen: las dos se van un día. Si algún día
 * se nota, es un día, y en seis meses de retención no es nada.
 *
 * @param {number|Date|string} [now] Referencia. Default: ahora.
 * @returns {number} Epoch en milisegundos.
 */
export function retentionCutoff(now = Date.now()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  return cutoff.getTime();
}

/**
 * La fecha de publicación de una oferta, en epoch en milisegundos, o `null`.
 *
 * EL ORDEN DE LOS CAMPOS ES `date`, `postedAtTimestamp`, `postedAt`, y es el
 * mismo que usa `publishedAt()` en `matcher.js:281-283`. No es un detalle: las
 * cinco bolsas de `jobSources.js` normalizan a `date`, y `postedAt` solo existe
 * en Apify. Y `date` puede ser `''` (Remotive sin fecha), que es *falsy*, así
 * que tiene que ser `??` en este orden y no una mezcla de `||` y `??`: con `||`
 * el `''` de Remotive caería al campo siguiente y con `??` no.
 *
 * La heurística de `/^\d{10,13}$/` es del origen y está bien: 10 dígitos son
 * segundos y 13 son milisegundos, y hay bolsas que mandan una cosa y otras la
 * otra. El umbral es `< 1e12`, o sea "es menor que un billón", que es
 * exactamente donde está el salto entre segundos (1.7e9 hoy) y milisegundos
 * (1.7e12 hoy).
 *
 * @param {object} [job] Oferta.
 * @returns {number|null} Epoch en ms, o null si no hay fecha legible.
 */
function publicationTime(job) {
  const raw = job?.date ?? job?.postedAtTimestamp ?? job?.postedAt;
  if (raw === undefined || raw === null || raw === '') return null;
  const numeric = Number(raw);
  const timestamp = /^\d{10,13}$/.test(String(raw))
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(raw).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Un instante cualquiera (número, `Date` o ISO) a epoch en milisegundos.
 *
 * Existe porque en el origen `firstSeen` era SIEMPRE `Date.now()`, un número, y
 * acá `firstSeen` viene de la base, donde `pg` devuelve un `timestamptz` como
 * `Date`. Sin esta conversión, `effectiveStart` devolvería un `Date` en el caso
 * "no hay fecha de publicación" y `Number.isFinite(Date)` es `false`: el
 * `expiresAtFor` devolvería `null` para toda oferta sin fecha de publicación,
 * que es exactamente el caso (las bolsas que no la mandan) para el que el
 * fallback a `first_seen + 6 meses` importa.
 *
 * @param {unknown} value Epoch en ms, `Date`, ISO, o cualquier cosa.
 * @returns {number|null} Epoch en ms, o null si no se puede leer.
 */
function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Desde cuándo corre la ventana de retención de una oferta.
 *
 * Es la fecha de PUBLICACIÓN si la oferta la trae, si no el `firstSeen`, si no
 * ahora. O sea que la retención se cuenta desde cuándo se publicó el puesto, no
 * desde cuándo lo vio esta app: con una bolsa que publica y nunca actualiza, una
 * oferta de hace ocho meses tiene que caer, y si la ventana corriera desde el
 * `firstSeen` se quedaría para siempre.
 *
 * @param {object} [job] Oferta.
 * @param {number|Date|string|null} [firstSeen] Cuándo se vio por primera vez.
 * @param {number} [now] Referencia, para el caso sin ninguno de los dos.
 * @returns {number} Epoch en milisegundos. Nunca null: `now` siempre está.
 */
function effectiveStart(job, firstSeen, now) {
  return publicationTime(job) ?? toMillis(firstSeen) ?? now;
}

/**
 * Cuándo VENCE una oferta: seis meses después de que empezó su ventana.
 *
 * Devuelve un STRING ISO y no un `Date`, y la elección es deliberada: el valor
 * estáURES a una columna `timestamptz`, así que las dos formas le sirven a
 * `pg`, pero el string sobrevive un `JSON.stringify` (en un log, en un test) sin
 * volverse una fecha en zona local ambigua, y es lo que hace comparables dos
 * fechas en una aserción sin mirar el huso.
 *
 * OJO, y es lo importante: esta función es el ESPEJO EN JS de la regla que
 * aplica el SQL de `recordSearch`. Quien manda el `expires_at` a la base NO es
 * esta función: es `make_interval(months => 6)` adentro del `upsert`, y está
 * escrito en SQL por una razón que acá no se puede hacer — el `do update` tiene
 * que volver a calcular el vencimiento usando el `first_seen` DE LA FILA QUE YA
 * EXISTÍA, y ese dato solo está del lado de Postgres (ver el comentario del
 * `UPSERT_JOB`). Calcularlo acá para el `do update` reiniciaría el reloj de la
 * retención en cada corrida y las ofertas vistas seguido no vencerían nunca.
 *
 * Se exporta igual, y por el mismo motivo que `countRecentCvParses` en
 * `cvParseLimit.js`: es la forma testeable de la regla, sin base de datos.
 *
 * @param {object} [job] Oferta.
 * @param {number|Date|string|null} [firstSeen] `firstSeen` de la fila existente.
 * @param {number} [now] Referencia.
 * @returns {string|null} ISO 8601, o null si no hay ningún instante legible.
 */
export function expiresAtFor(job, firstSeen = null, now = Date.now()) {
  const start = effectiveStart(job, firstSeen, now);
  if (!Number.isFinite(start)) return null;
  // ↑ OJO con el signo, porque esta línea estuvo mal y el síntoma era invisible:
  //   usaba `retentionCutoff(start)`, que RESTA seis meses, así que devolvía la
  //   fecha en que la oferta EMPEZÓ su ventana en vez de la fecha en que VENCE.
  //   Como `retentionCutoff` está al lado y hace justo lo contrario, el error se
  //   leía como correcto. No rompía la app —el que escribe el `expires_at` es el
  //   SQL con `make_interval(months => 6)`, que suma— pero dejaba esta función,
  //   que existe PARA SER TESTEABLE, diciendo lo contrario de lo que hace la base.
  //   Un espejo que no refleja no sirve: por eso la suma es explícita acá y no
  //   una función compartida con el cutoff, que es el otro sentido.
  const expires = new Date(start);
  expires.setMonth(expires.getMonth() + RETENTION_MONTHS);
  // ↑ `setMonth` y no `+ 6 * 30 * 864e5`: el mismo recorte de fin de mes que
  //   documenta `retentionCutoff` y que hace Postgres, para que las dos medidas
  //   no se separen ni por un día.
  return expires.toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// EL SQL COMPARTIDO
// ════════════════════════════════════════════════════════════════════════════

/**
 * El predicado de "esta fila está VENCIDA", como fragmento de SQL.
 *
 * Existe como función y no como constante porque el número del placeholder del
 * número de meses cambia según la query: `$2` en la purga, `$4` en la lectura.
 *
 * Y el motivo de que sea UNA sola definición, usada por las cuatro consultas que
 * necesitan la respuesta, es concreto: la lectura y la purga tienen que coincidir
 * en qué es "vencida". Si difieren, aparecen los dos symmetricalsfallos de
 * siempre —filas que se muestran y que la búsqueda siguiente borra (la oferta
 * desaparece de la pantalla sin aviso), o filas que nunca se borran porque la
 * purga mira un criterio más estricto que la lectura—. Ninguno de los dos tira un
 * error: son listas que mienten.
 *
 * El `expires_at is null` es el fallback que la migración 005 pide textualmente
 * (`005_job_history.sql:79-88`): si el vencimiento no se pudo calcular, se cuenta
 * desde `first_seen + 6 meses`, que es MÁS CONSERVADOR (mantiene un poco más) y
 * nunca más agresivo. Con el `upsert` de este archivo la columna se escribe
 * siempre, así que la rama es defensiva: sirve para una fila cargada a mano o
 * por un futuro camino de escritura que no pase por acá, y evita que esa fila
 * sea la que nunca vence.
 *
 * @param {string} mesesPlaceholder El placeholder (`$n`) de los meses.
 * @returns {string} El predicado, para pegar en un `where`.
 */
function vencido(mesesPlaceholder) {
  return `(jh.expires_at is not null and jh.expires_at < now())
    or (jh.expires_at is null and jh.first_seen + make_interval(months => ${mesesPlaceholder}::int) < now())`;
}

/** El predicado de "esta fila NO está vencida". El complemento del de arriba. */
function vigente(mesesPlaceholder) {
  return `not (${vencido(mesesPlaceholder)})`;
}

/**
 * El UPSERT de una oferta en `job_history`.
 *
 * Las cuatro decisiones de este bloque, y las cuatro importan:
 *
 * 1. `first_seen` NO está en el `do update`. Es "desde cuándo conozco esta
 *    oferta" y nunca se pisa (`005_job_history.sql:70-72`, y el origen tampoco lo
 *    pisaba). Va explícito en la lista de columnas del `insert` con `now()`
 *    porque recién ahí, en la fila que no existía, "ahora" es la respuesta
 *    correcta.
 *
 * 2. `regions` se UNEN y no se pisan. La segunda región pisaba a la primera en el
 *    origen y la oferta desaparecía de un historial (`history.js:120-123` del
 *    proyecto anterior, y `005_job_history.sql:63-68`). `unnest(jh.regions ||
 *    excluded.regions)` + `array_agg(distinct ...)` es el "existente + el nuevo,
 *    sin repetir". El `distinct` no es decorativo: sin él, una oferta que vuelve a
 *    aparecer en la misma región que ya tenía guardaría `'argentina'` dos veces y
 *    el `regions` se infla en cada corrida. El `order by` hace que el resultado no
 *    dependa del orden de lectura de los arrays. Y el `coalesce(..., '{}')`
 *    cubre el caso de los dos arrays vacíos, donde `array_agg` sobre cero filas
 *    devuelve NULL en vez de un array vacío.
 *
 * 3. `expires_at` se recalcula en las DOS ramas, pero con referencias DISTINTAS.
 *    En el `insert` es `coalesce(<publicación>, now()) + 6 meses`, y en el `do
 *    update` es `coalesce(<publicación>, jh.first_seen) + 6 meses`: la fila que ya
 *    existía conserva su `first_seen` y la ventana sigue corriendo desde ahí.
 *    Por eso esto NO puede ser `expires_at = excluded.expires_at`, que fue la
 *    primera forma en que se escribió y está mal: el `excluded` se calcula con el
 *    `now()` de ESTA corrida, así que cada corrida que volviera a ver la oferta
 *    le reiniciaba los 6 meses. El resultado sería que las ofertas que el usuario
 *    sigue viendo nunca vencen, es decir, la retención de 6 meses no retiene
 *    nada para el usuario activo. Y como la columna no tiene trigger y la purga
 *    usa la columna, el fallo es invisible: la lista de la UI seguiría growing
 *    para siempre.
 *
 * 4. `job` se pisa entero con el nuevo. Es el comportamiento del origen (la
 *    segunda publicación de la misma oferta actualiza `entry.job`) y la razón de
 *    que `key` lleve el link adentro es justamente esta: la clave identifica la
 *    MISMA oferta, así que su contenido cambia sin que haya que crear otra fila.
 */
const UPSERT_JOB = `insert into job_history as jh (
     user_id, key, job, regions, first_seen, last_seen, expires_at
   ) values (
     $1, $2, $3::jsonb, $4::text[], now(), now(),
     coalesce($5::timestamptz, now()) + make_interval(months => $6::int)
   )
   on conflict (user_id, key) do update set
     job        = excluded.job,
     regions    = coalesce(
       (select array_agg(distinct r order by r)
          from unnest(jh.regions || excluded.regions) as t(r)),
       '{}'::text[]
     ),
     last_seen  = now(),
     expires_at = coalesce($5::timestamptz, jh.first_seen) + make_interval(months => $6::int)`;

/**
 * Cuántas ofertas trae como máximo la lectura del historial.
 *
 * 300 y no "todas" por un motivo concreto: la retención es de 6 meses y el
 * `limit` es lo que corta el response, no el tiempo. Un usuario que lleva medio
 * año usando la app con las 5 bolsas gratuitas puede tener del orden de las
 * decenas de miles de filas (cada corrida re-upserta las quematchean y el
 * historial acumula todas); mandarlas todas son varios MB de JSON y, con
 * `maxDuration: 30`, la función se muere antes de responder.
 *
 * Y el número tiene una lectura de negocio además de la de performance: 300 son
 * más ofertas de las que la UI muestra (que pagina), y como el corte es por
 * `last_seen desc` lo que se queda son SIEMPRE las más recientes, que son las
 * que el usuario está mirando. Perder las viejas es la misma política que la
 * retención de 6 meses ya announced.
 */
const MAX_HISTORY_ROWS = 300;

/**
 * Los campos que `computeMatch` agrega a una oferta y que NO se persisten.
 *
 * La decisión es "el historial guarda la OFERTA, no el MATCH": todos estos campos
 * son función del PERFIL de este usuario, y el perfil lo puede editar (es el
 * botón de guardar el CV). Un `score` guardado es un `score` rancio: volvería en
 * la lectura, donde `rankByRegion` vuelve a calcularlo contra el perfil de hoy,
 * y el endpoint no puede distinguir "el 80% que dice la base" del "el 80% que
 * dice el perfil nuevo". O sea: guardar el score es guardar un dato viejo con
 * aspecto de dato nuevo, que es el peor modo de falla posible.
 *
 * Se quitan TODOS y no solo el `score` por el mismo motivo: `missed` dice qué
 * skills le faltaron a ESTE perfil, y con el perfil editado eso también es
 * mentira. Y se quitan acá, en el borde, en vez de pedirle al endpoint que
 * haga `computeMatch` después de `rankByRegion` para tener algo limpio: es un
 * detalle que se olvida la primera vez que alguien pasa las ofertas por otro
 * camino.
 *
 * OJO: esta lista tiene que estar al día con el `return` de `computeMatch`
 * (`matcher.js:229-239` y el `score: 0` de `matcher.js:160-173`). Si mañana
 * `computeMatch` agrega un campo derivado del perfil, hay que agregarlo acá.
 *
 * Lo que NO está en la lista y sí se guarda: `portal` y `sourceUrl` (los puso
 * `withPortal`, que es obligatorio en todo lo que devuelva ofertas según
 * AGENTS.md) y `regionGuess`, que viene de la fuente y no del perfil.
 */
const CAMPOS_DEL_MATCH = ['score', 'matched', 'missed', 'requested', 'roles', 'inTitle', 'comment'];

// ════════════════════════════════════════════════════════════════════════════
// ESCRITURA: LA ÚNICA QUE PERSISTE EL HISTORIAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Registra una corrida: escribe la fila de `searches` y actualiza el historial.
 *
 * ES EL ÚNICO LUGAR DEL PROYECTO QUE PERSISTE HISTORIAL (AGENTS.md lo dice como
 * regla). Si alguna fuente nueva o algún endpoint escribe en `job_history` por su
 * cuenta, hay dos reglas que se rompen a la vez: la deduplicación (que solo la
 * garantiza el `on conflict`) y el `last_seen`, que es lo que define si una
 * oferta sigue activa. Nada más del proyecto inserta en `job_history`.
 *
 * TODO va en UNA transacción, y el motivo es que las dos mitades tienen que ser
 * consistentes entre sí: la fila de `searches` ES la "última corrida" de la que
 * `getHistoryForRegion` deriva `active` (`005_job_history.sql:143-147`). Si los
 * upserts se committearan y la fila de `searches` no —o al revés—, una lectura
 * que caiga en el medio marcaría como inactivas ofertas que sí son de la última
 * corrida, y el usuario vería "no aparece en la última búsqueda" sobre ofertas
 * que acaba de ver.
 *
 * @param {string} userId UUID del usuario. Sale de `requireSession(req)` en el
 *   endpoint, NUNCA del cuerpo del request.
 * @param {Record<string, object[]>} rankedByRegion Lo que devuelve
 *   `rankByRegion(jobs, profile)`: un array de ofertas por clave de región.
 *   `recordSearch` no rankea, no filtra y no agrupa: solo registra lo que le
 *   pasaron.
 * @param {object} [opts]
 * @param {string} [opts.region] La región POR LA QUE SE PIDIÓ la corrida, una
 *   clave de `regions.js`. Default: `DEFAULT_REGION`.
 *   OJO con lo que NO es: no es una afirmación sobre qué regiones traen ofertas.
 *   Una sola corrida alimenta los buckets de TODAS las regiones (por eso
 *   `rankedByRegion` es un objeto), así que leer esta columna como "las regiones
 *   que salieron en la última búsqueda" es una reinterpretación equivocada de un
 *   dato que está bien escrito. Si alguna vez se quiere eso, es otra columna.
 * @param {string[]} [opts.keywords] Los términos de la búsqueda. Default `[]`.
 * @param {boolean} [opts.online] Si las fuentes contestaron. Default `true`, el
 *   mismo default que la columna (`011_searches_online.sql`): SOLO un `false`
 *   explícito significa "no pudimos contactar a nadie". Un `undefined` NO es un
 *   offline, porque el endpoint que llama todavía puede no saberlo.
 * @returns {Promise<{searchId: string, searchAt: Date, region: string,
 *   online: boolean, keywords: string[], recorded: number, expired: number}|null>}
 *   Un resumen de lo que se escribió, o `null` si el `userId` no es un uuid
 *   (mismo criterio que `saveProfile`: un id que no puede existir no produce un
 *   500 de Postgres). NO devuelve el historial entero, que es lo que hacía el
 *   origen y lo que en serverless no significaría nada: leerlo es una consulta.
 * @throws {Error} Lo que tire `pg`. `withTransaction` ya hizo el ROLLBACK: nunca
 *   queda una corrida a medio registrar.
 */
export async function recordSearch(userId, rankedByRegion, { region, keywords, online } = {}) {
  if (!isUuid(userId)) return null;
  // ↑ Mismo corte y mismo valor de vuelta que `saveProfile` (`profile.js:518-526`):
  //   un id que no es un uuid no puede estar en la base, así que mandarlo produce
  //   el error de tipo `22P02` y el endpoint termina devolviendo un 500 por un
  //   dato imposible. Y se corta ACÁ, antes de abrir la transacción, para no pedir
  //   un cliente del pool (y un `begin`) por una llamada que no va a escribir nada.

  const regionKey = String(region || '').trim() || DEFAULT_REGION;
  const listaKeywords = normalizeKeywords(keywords);
  const corridaOnline = online !== false;
  // ↑ `online !== false` y no `online === true`. La diferencia no es de estilo: el
  //   endpoint que llama hoy NO pasa `online` (todavía no está escrito), y con
  //   `=== true` toda corrida quedaría en `false` y el frontend mostraría "Modo
  //   demo" con las cinco fuentes respondiendo bien. Es el mismo bug que el
  //   default `true` de la migración evita desde el lado del esquema, aplicado acá
  //   desde el lado del código. Un `0` o un `'false'` cuentan como online: el
  //   endpoint decide, y un valor raro tiene que ser "no sé", que es lo que la
  //   columna guarda por default.

  const entradas = collectEntries(rankedByRegion);
  // ↑ Se arman ANTES de abrir la transacción, y no después. Son cosas puras de
  //   memoria: si acá tirara una excepción (una oferta con un `toJSON` que no
  //   existe, un `regions` con algo raro), lo que se pierde es tiempo, no datos.
  //   Adentro de la transacción cualquier error tira el ROLLBACK de un trabajo que
  //   ya se estaba por hacer igual.

  return withTransaction(async (client) => {
    // ── 1) La fila de la CORRIDA ──────────────────────────────────────────────

    const corrida = await client.query(
      // ↑ `user_id` va como `$1` y en la lista de columnas, y NO se lee de
      //   `rankedByRegion`. Es la regla del proyecto: cada query filtra por
      //   `user_id`, y el `user_id` sale de `requireSession`, o sea de la cookie
      //   firmada. El body no tiene ninguna autoridad sobre a quién se le escribe.
      //
      //   `region` va explícito y NO se deja el default de la columna, aunque los
      //   dos sean 'argentina': el default es para el caso de que nadie escriba,
      //   y acá siempre se escribe. Si mañana `DEFAULT_REGION` cambia en
      //   `regions.js` sin que haya una migración, el default viejo de `004`
      //   seguiría siendo 'argentina' para el INSERT que se olvidara el
      //   parámetro, y el historial registraría una región que el proyecto ya no
      //   tiene. Escribiéndolo siempre, la fuente de verdad es una sola.
      //
      //   `online` va explícito por lo mismo: si el default de la columna cambiara
      //   algún día, el código que decide el valor real del endpoint no se vería
      //   afectado.
      //
      //   `extra_keywords` NO se escribe: es la columna de la ampliación de búsqueda
      //   (004_searches.sql:44-49) y esta corrida no es una ampliación. Que quede
      //   en `{}` es lo correcto, no un olvido.
      `insert into searches (user_id, region, keywords, online)
       values ($1, $2, $3::text[], $4)
       returning id, created_at, online`,
      [userId, regionKey, listaKeywords, corridaOnline],
    );

    // ── 2) Una fila de historial por oferta ────────────────────────────────────

    let recorded = 0;
    for (const entrada of entradas) {
      await client.query(UPSERT_JOB, [
        userId,
        entrada.key,
        entrada.json,
        entrada.regions,
        entrada.published,
        RETENTION_MONTHS,
      ]);
      recorded += 1;
    }
    // ↑ Un statement por oferta, TODOS por el `client` de la transacción y en
    //   orden. Las tres cosas son deliberadas:
    //   · Por el `client`: con `query()` cada uno caería en una conexión DISTINTA
    //     del pool y el `begin`/`commit` no envolvería nada.
    //   · En orden, y no en paralelo: con `Promise.all` los `do update` de filas
    //     distintas no se pisan (cada uno tiene su `key`), así que el resultado
    //     sería el mismo. Lo que cambia es la presión sobre la conexión y la
    //     claridad del log: con `PG_POOL_MAX` chico, unleash de N queries
    //     paralelas sobre UN solo cliente las pone en cola igual, y el código
    //     parecería concurrente sin serlo.
    //   · Secuencial porque el volumen es el que es: las bolsas gratuitas traen
    //     decenas de ofertas y `rankByRegion` recorta por `topN` antes de llegar
    //     acá. Con los ~300 que es el tope de la lectura, son unos 300 round trips
    //     de ida y vuelta por el pooler, que es del orden de 200–300 ms: entra de
    //     sobra en los 30 s de `maxDuration`. Un solo INSERT con `unnest` sería más
    //     rápido, pero obliga a llevar las 300 ofertas como un solo JSONB (no se
    //     puede pasar un array de objetos a un parámetro de `pg`) y tiene una
    //     trampa seria: DOS filas con la misma `key` en el mismo statement hacen
    //     fallar el `on conflict do update` con "command cannot affect row a
    //     second time". Con el agrupado de `collectEntries` eso no puede pasar, pero
    //     el salto de complejidad no se paga hoy.
    //
    //   El `expires_at` es `$5::timestamptz` o NULL según tenga fecha de
    //   publicación la oferta. OJO con lo que hace el SQL cuando es NULL: usa
    //   `now()` (fila nueva) o `jh.first_seen` (fila que ya existía), que es
    //   justamente el fallback a `first_seen + 6 meses` de `005_job_history.sql:79-88`.

    // ── 3) La purga de lo vencido, SIEMPRE ─────────────────────────────────────

    const purga = await client.query(
      // ↑ Sin condición: el origen la hacía SIEMPRE dentro de `recordSearch`, no
      //   solo cuando algo había vencido. Y tiene sentido: el costo es un DELETE
      //   por usuario que casi siempre no borra nada (las filas que vencen son las
      //   de hace 6 meses, y se enteran de que vencen al volver a aparecer en una
      //   búsqueda), y el precio de esperar a que haya algo que purgar es que la
      //   tabla crezca sin control entre corridas. Además es lo que hace que
      //   `expireOldJobs()` no tenga que correr desde el endpoint: acá ya está.
      `delete from job_history as jh
        where jh.user_id = $1 and ${vencido('$2')}`,
      [userId, RETENTION_MONTHS],
    );

    // ── 4) El resumen ──────────────────────────────────────────────────────────

    const fila = corrida.rows[0] || {};
    return {
      // ↑ `searchAt` es el `created_at` LEÍDO de la base, no un `Date.now()` del
      //   runtime: es el mismo reloj con el que se va a derivar `active`, así que
      //   devolverlo garantiza que lo que ve el endpoint en la respuesta y lo que
      //   va a leer `getHistoryForRegion` no puedan diferir. Con dos relojes (el de
      //   Vercel y el de Postgres) la diferencia es de milisegundos, pero la
      //   diferencia no cuesta nada de evitar y hace que la fila sea la fuente.
      searchId: fila.id || null,
      searchAt: fila.created_at || null,
      region: regionKey,
      online: corridaOnline,
      keywords: listaKeywords,
      recorded,
      expired: purga.rowCount || 0,
    };
  });
}

/**
 * Aplana `rankedByRegion` en la lista de ofertas a escribir, agrupando por clave.
 *
 * El agrupado no es una optimización de estilo: la MISMA oferta puede caer en
 * varias regiones en una corrida, y sin agrupar se harían dos statements para la
 * misma `key` (el segundo solo aportaría la región repetida al union). Con el
 * `Map`, una vuelta y un statement por oferta.
 *
 * Cuando dos ofertas distintas dan la misma clave —que por definición son "la
 * misma oferta"— gana la ÚLTIMA, que es lo que hacía el origen (el `do update`
 * pisa `job` con el último escrito). Las regiones se acumulan todas.
 *
 * @param {Record<string, object[]>} rankedByRegion Buckets del ranking.
 * @returns {Array<{key: string, json: string, regions: string[],
 *   published: string|null}>} Una entrada por clave, con el `job` ya serializado.
 */
function collectEntries(rankedByRegion) {
  const porClave = new Map();
  if (!rankedByRegion || typeof rankedByRegion !== 'object') return [];

  for (const [regionKey, jobs] of Object.entries(rankedByRegion)) {
    if (!Array.isArray(jobs)) continue;
    for (const job of jobs) {
      // ↑ El `typeof`: `Object.entries` de algo que no es un objeto da `[]` y
      //   listo, pero un bucket cuyo valor es un objeto en vez de un array (que
      //   es lo que pasaría si alguien pasa el resultado de `Object.values` mal
      //   armado) entraría al `for...of` y `keyOf` reventaría con un TypeError
      //   en `job.title`. Un `continue` es más barato que un try.
      if (!job || typeof job !== 'object' || Array.isArray(job)) continue;
      const key = keyOf(job);
      const previa = porClave.get(key);
      if (previa) {
        previa.regions.push(regionKey);
        previa.job = job; // la última gana, como en el `do update` del origen
        continue;
      }
      porClave.set(key, { key, job, regions: [regionKey], published: null });
    }
  }

  const salida = [];
  for (const entrada of porClave.values()) {
    // ▲ `sinCamposDeMatch` devuelve una COPIA: las ofertas que van en
    //   `rankedByRegion` las comparte `withPortal` entre todos los que las
    //   enriched, así que borrarle un campo en el lugar mutaría un objeto que
    //   otro está mirando (misma regla que `withPortal`: nunca se muta).
    const job = sinCamposDeMatch(entrada.job);
    const published = publicationTime(entrada.job);
    salida.push({
      key: entrada.key,
      json: toJsonb(job),
      // ↑ Sin `Set`: no puede haber repetidos, porque una región aparece una sola
      //   vez como clave de `Object.entries` y por lo tanto una sola vez en el
      //   bucle. El `distinct` del `upsert` es para lo que ya estaba en la base.
      regions: entrada.regions,
      // ↑ OJO con el `??` y no un `||`: `publicationTime` devuelve `null` (y no
      //   `0`) cuando no hay fecha, así que acá los dos andan. Se usa `??` para
      //   dejar escrito que `null` significa "no hay fecha de publicación" y que el
      //   que decide qué hacer con eso es el SQL (`coalesce(..., first_seen)`),
      //   no este archivo. Y lo que viaja es un ISO, que es lo que acepta el
      //   `$5::timestamptz`.
      published: published === null ? null : new Date(published).toISOString(),
    });
  }
  return salida;
}

/**
 * Una copia de la oferta SIN los campos que dependen del perfil.
 *
 * @param {object} job Oferta de `rankedByRegion`.
 * @returns {object} Copia sin `score`, `matched`, `missed`, `requested`, `roles`,
 *   `inTitle` ni `comment`.
 */
function sinCamposDeMatch(job) {
  const copia = { ...job };
  for (const campo of CAMPOS_DEL_MATCH) delete copia[campo];
  return copia;
}

// ════════════════════════════════════════════════════════════════════════════
// LECTURA DEL HISTORIAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Las ofertas que este usuario vio en una región, marcando cuáles siguen activas.
 *
 * Devuelve un array PLANO de ofertas: cada item es el `job` del jsonb más tres
 * campos (`active`, `firstSeen`, `lastSeen`), igual que hacía el origen. No se
 * agrupa por región porque la región ya se usó para filtrar, y el endpoint la
 * pasa tal cual a `rankByRegion`.
 *
 * ── CÓMO SE DERIVA `active` ─────────────────────────────────────────────────
 * Es el `lastRun` del usuario, y NO se guarda en ninguna columna: una oferta está
 * activa si su `last_seen` no es anterior a la última corrida, y la última corrida
 * es `select max(created_at) from searches where user_id = $1`
 * (`005_job_history.sql:143-147`, que explica largo por qué no se agregó una
 * columna `active`).
 *
 * La comparación es `>=` y no `=`. Con `=` el predicado sería "el instante
 * exacto de la última corrida", que depende de que `searches.created_at` y
 * `job_history.last_seen` salgan del MISMO `now()`: hoy es verdad (se escriben en
 * la misma transacción de `recordSearch`), así que un `=` andaría. Pero es una
 * coincidencia de implementación, no una propiedad: cualquier cambio futuro (un
 * `clock_timestamp()`, un cron que registre una corrida, un endpoint que actualice
 * una oferta sola) convierte el `=` en "todo inactivo" sin que nada falle de
 * forma visible. `>=` es la forma MONOTÓNICA de la misma pregunta —"¿no es
 * anterior a la última corrida?"— y no depende de que los dos relojes coincidan
 * al microsegundo. Se hace en SQL y no trayendo el `max` a JavaScript para
 * compararlo acá: es una subconsulta sobre una tabla indexada por
 * `(user_id, created_at desc)` que Postgres resuelve sin planear nada, y traerla
 * a JS para hacer `new Date(...) >= ...` sería重工 la comparación a mano para
 * obtener lo mismo con dos fuentes de reloj.
 *
 * ── LOS TRES CAMPOS QUE SE AGREGAN ──────────────────────────────────────────
 * `firstSeen` y `lastSeen` van CRUDOS, tal como los devuelve `pg`, que para un
 * `timestamptz` es un `Date` de JavaScript. No se formatean ni se pasan a epoch
 * acá. OJO con el consumidor: `JobList.jsx:110-112` los pasa a `daysAgo()` y a
 * `formatDisplayDate()`. La segunda acepta cualquier cosa (hace `String(value)` y
 * después `new Date`), pero la PRIMERA hace `Math.floor((Date.now() - ts) / ...)`,
 * que con un `Date` da `NaN` (un `Date` no se resta con `-`) y con un ISO
 * también. O sea que el endpoint que arme la respuesta tiene que decidir qué
 * forma le manda, y la decisión no es de este archivo. Lo que SÍ es de este
 * archivo es que no se invente un tercer formato: sale de la fila.
 *
 * @param {string} userId UUID del usuario, de `requireSession(req)`.
 * @param {string} region Clave de región. Una sola: el origen tampoco tenía un
 *   "historial de todas las regiones" y la UI llama una vez por pestaña.
 * @returns {Promise<object[]>} Las ofertas, más recientes primero. `[]` si no hay
 *   historial, si la región no existe en la configuración o si el `userId` no es
 *   un uuid. Nunca `null`: la lista vacía es un estado válido y el endpoint la
 *   muestra tal cual.
 */
export async function getHistoryForRegion(userId, region) {
  if (!isUuid(userId)) return [];
  // ↑ `[]` y no `null`: una lista vacía y "no sé who sos" se verían igual en la
  //   UI, y un `null` haría que cada consumidor secubra con un `||`. El corte real
  //   —401/403— lo pone el endpoint antes de llegar acá (`requireProfile`).

  const regionKey = String(region || '').trim();
  if (!regionKey) return [];

  const { rows } = await query(
    // ↑ `$2 = any(jh.regions)`: el predicado es el que espera `005_job_history.sql`
    //   y `region = any(regions)` es lo que una columna `text[]` sabe hacer. La
    //   alternativa `'$2 = any(...)'` con el valor interpolado NO se puede hacer
    //   (el parámetro ya está); lo que NO se hace es `jh.regions @> array[$2]`, que
    //   también funciona pero necesita un cast explícito del parámetro a `text[]`
    //   para que el planner no se queje.
    //
    //   El `order by last_seen desc, first_seen desc` es el del origen. El
    //   segundo término viene de `history.js:483`, que desempata por `firstSeen`.
    //   Y es un desempate que casi nunca decide nada, y conviene saberlo: como
    //   `last_seen` y `first_seen` se escriben con el `now()` de la transacción,
    //   todas las ofertas de UNA MISMA corrida tienen EXACTAMENTE el mismo
    //   `last_seen` y las nuevas el mismo `first_seen`. O sea que dentro de una
    //   corrida el orden lo termina poniendo `rankByRegion` en el endpoint (por
    //   score y, a igual score, por fecha de publicación). El desempate sirve para
    //   las corridas viejas, que sí tienen fechas distintas.
    //
    //   El `limit` con `MAX_HISTORY_ROWS` corta por `last_seen desc`, o sea que lo
    //   que se queda son las más recientes. Ver el porqué del 300 arriba.
    `select jh.job,
            jh.regions,
            jh.first_seen,
            jh.last_seen,
            coalesce(
              jh.last_seen >= (select max(s.created_at) from searches s where s.user_id = $1),
              false
            ) as active
       from job_history as jh
      where jh.user_id = $1
        and $2 = any(jh.regions)
        and ${vigente('$4')}
      order by jh.last_seen desc, jh.first_seen desc
      limit $3`,
    [userId, regionKey, MAX_HISTORY_ROWS, RETENTION_MONTHS],
  );

  return rows.map((row) => ({
    // ▲ El spread PRIMERO y los tres campos DESPUÉS, en ese orden, por una razón
    //   concreta: el origen hacía `{ ...e.job, active, firstSeen, lastSeen }`, y el
    //   `job` del jsonb puede tener un campo `active` adentro si alguna fuente lo
    //   manda. Con los tres campos DESPUÉS, ganan los nuestros. Al revés, el
    //   `active` del jsonb pisaría el derivado y la UI mostraría un badge
    //   equivocado sin ningún error en ninguna parte.
    ...row.job,
    active: row.active === true,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));
}

// ════════════════════════════════════════════════════════════════════════════
// PURGA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Borra las ofertas vencidas de UN usuario.
 *
 * ── POR QUÉ LA FIRMA ES `(userId)` Y NO `(rankedByRegion)` ──────────────────
// El origen era `expireOldJobs(rankedByRegion)` y hacía DOS cosas: filtraba de las
// ofertas de la búsqueda actual las que ya estaban vencidas (para que la respuesta
// no las mostrara) Y borraba las vencidas del archivo. La segunda queda entera acá;
// la PRIMERA no desaparece: se mudó a `dentroDeRetencion` (`jobs.js:417`), que es el
// espejo en JS de `expiresAtFor` y lo aplica sobre la lista enrichida, justo antes
// de rankearla.
//
// OJO con por qué no puede quedar acá adentro. Una versión anterior de este
// comentario afirmaba que "el filtrado ya lo hizo `rankByRegion`/`matchRegion`",
// y es FALSO: los dos filtran por REGIÓN y por `score > 0`, y ninguno de los dos
// criterios sabe de antigüedad. Una oferta publicada hace ocho meses que la bolsa
// sigue listando entra al ranking, su `expires_at` queda en el pasado, `recordSearch`
// la upserta igual (el `on conflict` no mira el vencimiento) y la purga que va en
// la misma transacción la borra de nuevo: el resultado es una oferta que `/api/jobs`
// muestra y `/api/history` nunca muestra. Por eso el filtro vive en el módulo que
// ARMA la lista visible, y no en el que la purga.
//
// La lectura (el camino de caché de `getRanked`) sí queda cubierta sin filtro
// propio, pero no porque rankee: porque la purga de `recordSearch` corre en la
// misma transacción y por lo tanto las filas vencidas ya no están para cuando se
// lea. Eso es una consecuencia del orden de las operaciones, no una garantía de
// esta función.
 *
 * Y no es una función inútil: `recordSearch` ya purga al final de su transacción,
 * así que ésta es para llamarla sin registrar nada. El caso real es el endpoint
 * que quiera liberar espacio (o un script de mantenimiento) sin ensuciar el
 * historial de búsquedas.
 *
 * No toma candado ni transacción: es UN `delete`, que en Postgres ya es atómico.
 *
 * @param {string} userId UUID del usuario. Todo filtrado por `user_id`, siempre.
 * @returns {Promise<number>} Cuántas filas borró (0 casi siempre).
 */
export async function expireOldJobs(userId) {
  if (!isUuid(userId)) return 0;
  const { rowCount } = await query(
    // ↑ El predicado es el de `vencido()`, el MISMO que usan la lectura y la purga
    //   de `recordSearch`, y por el motivo de siempre: si la lectura y la purga
    //   no coinciden en qué es "vencida", aparecen filas que se muestran y se
    //   borran al rato, o filas que nunca se borran.
    `delete from job_history as jh
      where jh.user_id = $1 and ${vencido('$2')}`,
    [userId, RETENTION_MONTHS],
  );
  return rowCount || 0;
}

// ════════════════════════════════════════════════════════════════════════════
// BÚSQUEDA DE UNA OFERTA PUNTUAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Una oferta del historial del usuario, buscada por su `job.id`.
 *
 * Es NUEVA y es obligatoria porque reemplaza al `findById` del origen, que
 * buscaba en el diccionario en memoria. Sin esto, `/api/job?q=` y
 * `/api/cover-letter?id=` (que reciben el `job.id` de la oferta —`remotive-12345`,
 * NO la `key` de deduplicación—) no tienen nada contra qué trabajar.
 *
 * Se busca `job->>'id'` y no la `key` a propósito, porque el id es lo que viaja
 * por la URL y lo que el frontend ya tiene en la mano (`favorites`, el link de
 * postulación, el botón de la carta). La `key` es un interno.
 *
 * ── POR QUÉ NO HAY ÍNDICE PARA ESTA BÚSQUEDA ────────────────────────────────
 * `job->>'id' = $2` sobre una columna `jsonb` no lo puede servir ningún índice
 * btree de `job_history`, y no se agrega uno. El razonamiento es el mismo que el
 * de los índices de `005_job_history.sql:119-131`: el acceso es POR USUARIO, es un
 * lookup puntual y la tabla de un usuario está acotada por la retención. O sea que
 * lo que hace la consulta es caminar el índice `(user_id, last_seen desc)` de ese
 * usuario y descartar lo que no tiene ese id, y `limit 1` corta en la primera
 * coincidencia. Un índice GIN por expresión sobre `job->>'id'` costaría
 * maintained en cada uno de los cientos de upserts de cada búsqueda para
 * acelerar un lookup que se hace una vez por cada carta de presentación que el
 * usuario pide. Es exactamente el cálculo de "índice solo donde hay query".
 *
 * ── POR QUÉ DEVUELVE `null` Y NO TIRA `HttpError` ───────────────────────────
// Porque decidir el 404 es del endpoint: este módulo no sabe si la oferta no
// existe, si está vencida o si el usuario la está pidiendo con un id inventado, y
// esas tres cosas pueden querer respuestas distintas. La convención es la misma
// que `loadProfile` (devuelve `null` si no hay perfil) y la que usa `profile.js`
// en general: este módulo devuelve datos o `null`, y el endpoint arma la
// respuesta.
 *
 * @param {string} userId UUID del usuario, de `requireSession(req)`.
 * @param {string} jobId El `job.id` de la oferta (`remotive-12345`).
 * @returns {Promise<{job: object, key: string, regions: string[],
 *   firstSeen: Date, lastSeen: Date}|null>} La fila del historial, o null si no
 *   está, si está vencida o si el `userId` no es un uuid.
 */
export async function findJobById(userId, jobId) {
  if (!isUuid(userId)) return null;
  const id = String(jobId ?? '').trim();
  // ↑ `String(...)` y no solo un chequeo de truthiness: un id que viene de
  //   `req.query` es siempre string, pero un id que venga de un `parseInt` o de
  //   un `.find()` que devolvió un array puede ser cualquier cosa, y
  //   `job->>'id' = 12345` castea el parámetro a jsonb-text y compara `'12345'`.
  //   Normalizarlo acá deja UNA forma de comparar.
  if (!id) return null;

  const { rows } = await query(
    `select jh.key, jh.job, jh.regions, jh.first_seen, jh.last_seen
       from job_history as jh
      where jh.user_id = $1
        and jh.job->>'id' = $2
        and ${vigente('$3')}
      order by jh.last_seen desc
      limit 1`,
    [userId, id, RETENTION_MONTHS],
  );

  const row = rows[0];
  if (!row) return null;

  // ↑ Se devuelve el `job` CRUDO, sin `active`, y con la `key` al lado. La forma es
  //   la que le sirve al endpoint para RE-RANKEAR: la oferta sale de la base con
  //   `portal` y `sourceUrl` (los puso `withPortal` antes de guardarse) y el
  //   endpoint le pasa `computeMatch(job, profile)` con el perfil de HOY, que es el
  //   punto de guardar sin score: el score que importa es el de ahora.
  //
  //   `active` NO se agrega. No tiene sentido acá: `/api/job` y
  //   `/api/cover-letter` son de UNA oferta puntual, no de una lista contra la que
  //   comparar, y agregar un campo que el endpoint no usa es ruido. Si algún día
  //   hace falta, la misma expresión de `getHistoryForRegion` la da.
  return {
    job: row.job,
    key: row.key,
    regions: row.regions || [],
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Ayudantes de borde
// ════════════════════════════════════════════════════════════════════════════

/**
 * Una lista de strings limpia, o `[]`.
 *
 * Copia del criterio de `normalizeKeywords` en `profile.js:287-302` (y del mismo
 * criterio de `llm.js:919`), y está duplicado por la misma razón que el regex de
 * uuid: es una normalización de BORDE, y el borde de la tabla `searches` es
 * `keywords` de `text[]` (004_searches.sql:32-42). `004` dice que las keywords
 * "ya normalizadas por la app" y este es el lugar donde se cumple eso.
 *
 * No se baja con `String.normalize()`, que además de minúsculas borra los acentos:
 * "Inglés" escrito así es mejor que "ingles" escrito así, y acá estas palabras se
 * muestran en el historial de la UI y se usan para armar la búsqueda.
 *
 * @param {unknown} values Lo que venga.
 * @returns {string[]} Strings sin vacíos ni repetidos, en orden de llegada.
 */
function normalizeKeywords(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    // ↑ `String()` y no un filtro de `typeof`: un término numérico ("5 años de
    //   experiencia") es texto válido, no basura.
    const kw = String(value ?? '').trim();
    if (!kw) continue;
    const clave = kw.toLowerCase();
    if (seen.has(clave)) continue;
    seen.add(clave);
    out.push(kw);
  }
  return out;
}

/**
 * El TEXTO JSON de un valor, para mandarlo a una columna `jsonb`.
 *
 * Mismo criterio y misma razón que `toJsonb` en `profile.js:839-842`: el `\u0000`
 * se borra porque es el ÚNICO carácter de control que `jsonb` rechaza
 * (`22P05 unsupported Unicode escape sequence`), y se busca el ESCAPE de seis
 * caracteres que emite `JSON.stringify` y no el byte crudo. El resto de los
 * escapes son válidos en `jsonb` y no se tocan. Una descripción de oferta con un
 * byte raro se guarda sin él, en vez de devolver un 500 por una sola fila de un
 * `insert` de trescientos.
 *
 * @param {object} value El objeto a serializar.
 * @returns {string} JSON listo para `::jsonb`.
 */
function toJsonb(value) {
  const json = JSON.stringify(value);
  // ↑ El `||` es una red de seguridad y no una decisión: `JSON.stringify` de un
  //   objeto plano siempre devuelve un string. Si algún día `job` viniera con un
  //   ciclo, mandaría `'null'` en vez de `undefined` (que `pg` mandaría como
  //   NULL y rompería el `not null` de la columna con un error que no dice qué
  //   fila fue).
  return (json === undefined ? 'null' : json).replace(/\\u0000/g, '');
}