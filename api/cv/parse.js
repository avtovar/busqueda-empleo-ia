// ============================================================================
// POST /api/cv/parse — ETAPA 2 DEL ALTA, PRIMERA MITAD: el CV entra, el perfil
// derivado sale. **NO SE GUARDA NADA.**
//
// Es la primera mitad del paso 5 del alta en dos etapas (auth.js:8-16):
//
//   1. POST /api/register (correo + clave) ──► fila en `users` + cookie
//   2. el usuario YA está adentro, pero NO tiene perfil todavía
//   3. sube el CV ──► ESTE endpoint ──► LLM ──► devuelve el perfil JSON ◄──┐
//   4. formulario de REVISIÓN/EDICIÓN (nada se guarda todavía)              │
//   5. PUT /api/profile ──► escribe `profiles` + `skills` ◄────────────────┘
//
// ── POR QUÉ UN ENDPOINT LLAMADO `/cv/parse` NO PERSISTE NADA ─────────────────
// Esto es lo contraintuitivo de este archivo, y está escrito arriba a propósito
// porque es el error que alguien va a "arreglar":
//
// Un endpoint que se llama `parse` y no escribe en la base parece un error.
// La respuesta correcta es: ES SU TRABAJO. El usuario va a ver lo que salió del
// LLM en un formulario y a corregirlo (el LLM no sabe cuántos años tiene nadie,
// se inventa una foto, se equivoca en el título). Si este endpoint guardara el
// perfil, la revisión escribiría ENCIMA de una fila correcta y el usuario no
// tendría forma de volver atrás sin volver a subir el CV.
//
// O sea: `/cv/parse` es una FUNCIÓN PURA de "texto → perfil" con una compuerta
// de sesión, y `/api/profile` es la que escribe. Si alguna vez hay que guardar
// el resultado del parseo sin revisión, se agrega un parámetro explícito
// (`?save=1`) y NO se cambia esta función en silencio.
//
// ── POR QUÉ `requireSession` Y NO `requireProfile` ─────────────────────────────
// Porque el usuario que llega acá es, por definición, uno SIN perfil: está en
// medio de la etapa 2. `requireProfile` devolvería 403 —"te falta completar tu
// perfil: subí tu CV"— a alguien que está haciendo exactamente lo que hay que
// hacer para dejar de tener ese error. Sería un bucle sin salida: el frontend
// manda al onboarding porque hay 403, y el onboarding da 403.
//
// Lo que este endpoint SÍ usa de `auth.js` es `requireSession`: 401 si no hay
// cookie. La tabla de compuertas de AGENTS.md dice 401 = "no sé quién sos" y
// 403 = "sé quién sos pero te falta el CV"; acá el segundo caso es imposible
// por construcción, así que este endpoint solo puede devolver 401.
//
// ── EL CV NO SE GUARDA NUNCA ─────────────────────────────────────────────────
// Ni a disco, ni en Vercel Blob, ni en la base. El Buffer se lee, se le saca el
// texto, se manda al LLM y se tira. Las razones están en `cvText.js:9-25` y son
// las mismas: el disco de Vercel es efímero, y un CV es el dato personal más
// sensible que maneja esta app.
//
// Lo que sale del archivo es el TEXTO, y el texto también se tira: no va a la
// base, no va a un log y no vuelve en la respuesta. Lo único que sale de acá es
// el PERFIL DERIVADO, que es lo único que el usuario autorizó a guardar (y ni
// siquiera eso todavía: se guarda después de que lo revise).
//
// Por eso acá no hay NINGÚN `console.log` del texto, ni del nombre del archivo,
// ni del `Buffer`. Un nombre de archivo de CV es "Juan Perez CV.pdf", o sea el
// nombre de la persona, y los logs sobreviven más que las instancias. Los únicos
// números que salen de este archivo son longitudes.
//
// ── EL LLM SE PAGA POR TOKEN, Y ESTE ES EL ÚNICO ENDPOINT QUE LO LLAMA ───────
// Por eso tiene su propio `maxDuration` (60, no 30), por eso recorta el texto
// antes de mandarlo, y por eso hay un rate limit por usuario contra la tabla
// `cv_parses` justo antes de llamar (paso 6 del handler). Ver el bloque del rate
// limit más abajo: lo que acota el costo POR llamada y lo que acota el costo
// POR CUENTA son dos cosas distintas, y este endpoint tiene las dos.
//
// ── ESTE ARCHIVO NO LLAMA A APIFY, NI DE VERDAD NI DE ADELANTE ────────────────
// `/api/linkedin-search` ejecuta un actor de Apify y SE COBRA por ejecución
// (AGENTS.md tiene una sección entera sobre eso). `/api/cv/parse` es otro
// servicio pagado (el LLM), y mezclar los dos sería la forma más fácil de que
// un cambio futuro copie de acá un `fetch` al actor. No hay forma de que este
// archivo llame a Apify: ni el token, ni la URL del actor, ni el nombre
// `apifyLinkedin` aparecen en él.
// ============================================================================

import { requireSession } from '../lib/auth.js';
import { MAX_CV_BYTES, extractCvText, validateCvFile } from '../lib/cvText.js';
import { assertCvParseAllowed } from '../lib/cvParseLimit.js';
import { HttpError, sendJson, withErrorHandling } from '../lib/http.js';
import { parseCvToProfile } from '../lib/llm.js';

// ↑ `readJsonBody` NO se usa acá, y no es un olvido: corta a 64 KB y existe para
//   un body JSON. Un CV va por multipart y pesa hasta 5 MB; usarlo sería un 413
//   instantáneo para todos. El body de este endpoint se lee abajo, a mano, con el
//   tope que corresponde.
// ↑ `parseCvToProfile` es el ÚNICO módulo del proyecto que habla con el LLM.
//   `requireCvText` (la red de seguridad que tira el 400 del texto corto) NO se
//   llama explícitamente acá porque ya es la PRIMERA línea de `parseCvToProfile`:
//   llamarla dos veces sería código muerto. El 400 por escaneo o PDF sin capa de
//   texto llega igual, y con el mismo mensaje que en `cvText.js`.
// ↑ `assertCvParseAllowed` es el rate limit por usuario, contra la tabla
//   `cv_parses`. Va llamado justo antes del LLM (paso 6 del handler) y NO antes:
//   lo que se rechaza antes de esa línea no costó tokens. Ver el bloque del rate
//   limit más abajo para el porqué de ese orden.

// ── Configuración ────────────────────────────────────────────────────────────

// ▲ ESTE NÚMERO ES 60 Y NO 30 COMO EL DE LOS OTROS ENDPOINTS, y hay que entender
//   por qué antes de bajarlo.
//
//   Lo que pasa por debajo, en orden: leer hasta 5 MB del body (con un cold start
//   de Vercel encima), parsear el PDF (pdf.js con un documento complejo puede
//   tardar varios segundos), llamar al LLM con un timeout de 25 s
//   (`llm.js:DEFAULT_LLM_TIMEOUT_MS`) y mandar la respuesta. La llamada al LLM se
//   queda con los 25 s más largos del camino, y a eso hay que sumarle el resto.
//
//   Con 30 s el margen es de 5 s para todo lo demás, y el peor caso (un PDF de
//   5 MB en un cold start) se lo come. Con 60 hay aire de sobra.
//
//   60 es además el techo del plan Hobby de Vercel, así que es el número más
//   grande que se puede pedir sin pagar.
//   ▲ OJO: `vercel.json` tiene `functions: { "api/**/*.js": { maxDuration: 30 } }`,
//   que aplica a TODAS las funciones con un glob. Si el config del archivo no
//   tiene prioridad sobre el glob, el valor efectivo sigue siendo 30 y este
//   `export const config` es decorativo. Hay que verificarlo en un deploy (con un
//   CV de 5 MB, que es el caso que lo distingue) antes de confiar en el 60.
//
//   La RESTRICCIÓN DE `llm.js` se cumple igual: el timeout del LLM (25 s) tiene
//   que ser MENOR que la vida de la función, y 25 < 60. Si algún día se sube el
//   timeout del LLM, hay que subir esto Y el de `llm.js:MAX_LLM_TIMEOUT_MS`.
export const config = { maxDuration: 60 };

// Nombre del campo del multipart donde va el archivo. Lo fija este archivo y no
// el frontend, así que si algún día cambia hay que cambiar los dos lados: el
// nombre del campo es parte del contrato, como cualquier otro.
const FIELD_NAME = 'cv';

// ── EL LÍMITE DEL BODY ───────────────────────────────────────────────────────

// Margen sobre `MAX_CV_BYTES` para el ENVOLTORIO multipart.
//
// El cuerpo de la petición NO es el archivo: es el archivo más las cabeceras de
// cada parte, el `Content-Disposition`, el `Content-Type`, los CRLF y los dos
// delimitadores. Con un boundary de 60 caracteres y una cabecera de medio kilo
// (nombres de archivo largos, `filename*` en UTF-8), el envelope de un CV de 5 MB
// anda alrededor de 5 MB + 1 KB. 64 KB de margen es un orden de magnitud entero
// de sobra y sigue siendo chico comparado con el archivo.
//
// El número importa por una razón práctica: este es el ÚNICO tope que se aplica
// ANTES de que los bytes estén en memoria. Un límite que se chequea después de
// tener el body cargado no es un límite, es una queja (mismo criterio que el 413
// de `cvText.js:411-426`).
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_MULTIPART_BYTES = MAX_CV_BYTES + MULTIPART_OVERHEAD_BYTES;

// ── EL RECORTE DE TEXTO ANTES DEL LLM ────────────────────────────────────────

// Tope de caracteres del CV que se mandan al LLM.
//
// 20 000 es un número, no un capricho: son unas 5 000 tokens, y un CV real de dos
// a cuatro páginas anda entre 3 000 y 8 000 caracteres. 20 000 no recorta NINGÚN
// CV que valga la pena; lo que recorta es el caso raro de "subí el libro entero",
// que por lo demás tampoco entra por `MAX_CV_BYTES`.
//
// Por qué recortarlo y no mandarlo entero: el costo de esta llamada es de
// (tokens de entrada + tokens de salida) y la entrada es el CV. Acotarla acota el
// costo POR llamada, que es la mitad del problema (la otra mitad está más abajo,
// en el rate limit).
//
// Y el recorte es por LÍNEA, no a la mitad de una palabra: se corta en el último
// salto de línea antes del tope. Es la diferencia entre "el modelo leyó un CV
// entero" y "el modelo leyó un CV entero y una frase que se corta a la mitad",
// que es una frase que el modelo puede atribuirle a la persona.
const MAX_CV_TEXT_CHARS = 20_000;

// ════════════════════════════════════════════════════════════════════════════
// EL RATE LIMIT: LAS DOS MITADES DEL COSTO
// ════════════════════════════════════════════════════════════════════════════

// Un LLM se paga por token con la clave del DUEÑO de la app, así que el costo de
// este endpoint hay que acotarlo por los DOS lados. Son dos problemas distintos
// con dos soluciones distintas, y el que se implementa primero sin el otro deja un
// agujero:
//
//   · COSTO POR LLAMADA ──► un pedido de arriba. Acota lo que puede costar UNA
//     llamada. Esto ya estaba:
//
//       1. `MAX_CV_BYTES` (5 MB) ──► 413. Heredado de `cvText.js`, y es un 413 de
//          verdad: corta antes de que los bytes estén en memoria.
//       2. `MAX_MULTIPART_BYTES` ──► 413, chequeado contra `Content-Length` ANTES
//          de leer un solo byte y otra vez mientras se acumula (ver `readRawBody`).
//       3. `MAX_CV_TEXT_CHARS` (20 000) ──► lo que se paga, como mucho, por
//          llamada: ~5 000 tokens de entrada, y `llm.js:MAX_LLM_TOKENS` (2 000) de
//          salida. El techo de una llamada es ~7 000 tokens.
//
//   · COSTO POR CUENTA ──► cuántos CVs analiza una misma persona por hora. Esto es
//     lo que agregaron `migrations/010_cv_parses.sql` y
//     `assertCvParseAllowed()` (paso 6 del handler). Con 5 por hora, el peor caso
//     de un usuario es de unas 35 000 tokens.
//
// Los dos importan. El primero sin el segundo deja el agujero que se iba a
// cerrar acá: un usuario podía subir su CV en loop y cada llamada le costaba una
// fracción de centavo, cinco mil veces. Y el segundo sin el primero sería un
// límite de 5 que se llena con cinco PDFs de 5 MB cada uno.
//
// ── POR QUÉ `assertCvParseAllowed` Y NO `assertLoginAllowed` ──────────────────
// Ya está escrito el WHY en `cvParseLimit.js:1-60`, y es largo, pero la versión
// corta es: `rateLimit.js` cuenta INTENTOS FALLIDOS de login, contra una tabla
// con `email`, `ip` y `attempted_at`. Reusarlo de las dos formas que se podrían
// hacer es peor que no hacerlo:
//
//   · ESCRIBIENDO una fila de intento fallido por cada parseo: después de 10
//     parseos el usuario no puede ENTRAR durante 15 minutos. Un denial of service
//     contra usuarios reales, hecho por un endpoint que no debería tocar el login.
//     Peor que el gasto que estaba intentando acotar.
//   · CONSULTÁNDOLO sin escribir: el contador queda en cero para cualquiera que no
//     falle un login, o sea para exactamente el atacante que se está tratando de
//     frenar. Sería un límite que no limita.
//
// ── POR QUÉ EL LÍMITE ESTÁ DESPUÉS DE VALIDAR EL ARCHIVO Y ANTES DEL LLM ─────
// El orden de los pasos 1 a 7 del handler es la decisión:
//
//   · DESPUÉS de `requireSession`: sin `user_id` real no hay contador que armar.
//     Un 401 no cuesta tokens.
//   · DESPUÉS de `validateCvFile` y de `extractCvText`: un 415 (tipo malo), un
//     413 (demasiado grande), un 400 (escaneo sin texto) o un MIME que se
//     contradice con la extensión NO llegan al LLM, así que no tienen por qué
//     consumir cuota. Cobrándole al usuario un parseo por un PDF que la app
//     rechazó por el nombre sería cobrarle por un error de la app.
//   · ANTES de `parseCvToProfile`: después ya se pagó.
//
// El precio de que el paso 6 vaya antes del LLM es que un 502, un 504 o un
// `finish_reason: 'length'` CUENTAN igual (los tokens se facturaron aunque la
// respuesta no llegara). Es un falso positivo acotado y es la única opción
// sensata: contar después dejaría el límite sin efecto contra un atacante que
// dispara llamadas que dan timeout y nunca paga ninguna.

// ── LO QUE EL LÍMITE ES Y LO QUE NO ES ───────────────────────────────────────
//
//   · Es POR USUARIO, no global ni por IP. La identidad sale de la cookie
//     firmada y `requireSession` ya la validó contra la base, así que es la
//     identidad real y no una que el cliente pueda cambiar. Una cuota global
//     dejaría sin CV a los demás por culpa de uno; una por IP frenaría a gente
//     detrás de un NAT compartido (oficinas, universidades,iphonxs).
//   · Es CONFIGURABLE por variable de entorno (`CV_PARSE_LIMIT`,
//     `CV_PARSE_LIMIT_WINDOW_MINUTES`, `CV_PARSE_RETENTION_HOURS`), no una
//     constante. Bajarlo tiene que ser cambiar una variable y redesplegar, no una
//     migración sobre datos que deja a los usuarios trabados a mitad de cuota.
//     Lo mismo que `APIFY_DAILY_LIMIT` en el otro servicio pago del proyecto.
//   · NO es un límite de DROGAJE de requests: los 401, 413, 415 y 400 no
//     cuentan, y el propio 429 tampoco (el `throw` cae dentro de la transacción y
//     la hace ROLLBACK). Si el rechazo contara, cada intento rechazado extendería
//     la ventana y el bloqueo sería permanente sin que nadie pudiera
//     desbloquearse.
//   · NO sirve para proteger la clave de un adversario que se registra cuentas
//     nuevas: el registro es abierto y no hay verificación de correo. Acota el
//     gasto de UNA cuenta; el número de cuentas lo limita el costo del alta, que
//     es cero. Es la misma limitación que tiene el login y es aceptable en una
//     app en etapa de arranque.


// ════════════════════════════════════════════════════════════════════════════
// LEER EL BODY MULTIPART
// ════════════════════════════════════════════════════════════════════════════

// El separador entre las cabeceras de una parte y su contenido. Se busca como
// bytes y no como string: el body es un Buffer de hasta 5 MB de datos binarios, y
// buscar una cadena implica convertirlo entero.
const HEADER_SEP = Buffer.from('\r\n\r\n', 'latin1');

/**
 * Un valor cualquiera como texto, sin romper.
 * @param {unknown} value Lo que venga.
 * @returns {string} El valor como texto; `''` si era null/undefined.
 */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * ¿Este valor ya viene con la forma de un archivo?
 *
 * @param {unknown} value Un valor de `req.body`.
 * @returns {boolean} Si tiene un Buffer adentro.
 */
function looksLikeFile(value) {
  if (!value || typeof value !== 'object') return false;
  // ↑ Un array aparece cuando el parser del runtime agrupa los archivos del
  //   mismo campo en una lista (`cv: [file]`). Se acepta el primero: el frontend
  //   manda un archivo, y si algún día fueran varios, el primero es el que se
  //   pidió.
  if (Array.isArray(value)) return looksLikeFile(value[0]);
  return Buffer.isBuffer(value.buffer) || Buffer.isBuffer(value.data);
}

/**
 * Convierte el objeto de un archivo ya parseado a la forma de `cvText.js`.
 *
 * Acepta los tres nombres de campo con los que llegan según el runtime
 * (`buffer`/`data`, `mimetype`/`type`/`contentType`, `filename`/`name`) porque
 * no hay un parser de multipart en las dependencias del proyecto y por lo tanto
 * no hay UN contrato de runtime: hay que tolerar los que existen.
 *
 * @param {unknown} value El valor del campo.
 * @returns {{mimetype: string, filename: string, size: number, buffer: Buffer}|null}
 *   El archivo, o null si no hay un Buffer.
 */
function toFile(value) {
  const f = Array.isArray(value) ? value[0] : value;
  if (!f || typeof f !== 'object') return null;
  const buffer = Buffer.isBuffer(f.buffer) ? f.buffer
    : (Buffer.isBuffer(f.data) ? f.data : null);
  if (!buffer) return null;

  // ↑ Se saca la ruta del nombre. Algunos navegadores (y varias librerías de
  //   upload) mandan `C:\Users\pepita\cv.pdf` en vez de `cv.pdf`, y `cvText.js`
  //   saca la extensión con `lastIndexOf('.')`: con la ruta puesta, un nombre
  //   como "CV 2024 (final).pdf.txt" pasa por extensión `.txt` y da un 415
  //   correcto, pero un "cv.pdf" con carpeta no da ningún problema. Queda el
  //   último segmento, que es lo que el usuario reconoce como su archivo.
  const filename = text(f.filename || f.name).replace(/^.*[\\/]/, '');

  // El `size` declarado se respeta si es un número (así `validateCvFile` puede
  // comparar los dos tamaños, que es lo que hace a propósito), y si no es, se
  // pone el MEDIDO: un `size` que no existe no es un motivo para descartar el
  // archivo, y el que decide es `buffer.length`.
  const declarado = Number(f.size);
  return {
    // ↑ El MIME no se inventa desde la extensión. Si la parte no trae
    //   `Content-Type` va vacío, y `cvText.js:detectKind` responde 415 con el
    //   mensaje de los tipos aceptados. Fabricar el MIME desde la extensión
    //   desactivaría justamente el cruce de las dos declaraciones (415
    //   TIPO_CONFLICTO), que es lo que frena el "renombro el .docx a .pdf".
    mimetype: text(f.mimetype || f.type || f.contentType).toLowerCase(),
    filename,
    size: Number.isFinite(declarado) && declarado >= 0 ? declarado : buffer.length,
    buffer,
  };
}

/**
 * Elige el archivo dentro de un body ya parseado en objeto.
 * @param {object} body El body parseado.
 * @returns {object|null} El archivo, o null.
 */
function pickFile(body) {
  const directo = toFile(body[FIELD_NAME]);
  if (directo) return directo;
  // ↑ Sin archivo en el campo `cv` se busca el primer valor que parezca un
  //   archivo. Es tolerancia, no lógica: el frontend manda un solo archivo, así
  //   que cualquier otro nombre de campo es un frontend viejo o una prueba, y
  //   devolver un 400 ahí le cobraría al usuario una recarga por una diferencia
  //   de detalle que no puede ver.
  for (const valor of Object.values(body)) {
    const f = toFile(valor);
    if (f) return f;
  }
  return null;
}

/**
 * Saca el boundary del header `Content-Type`.
 *
 * Se acepta con y sin comillas porque los dos aparecen en la realidad: los
 * navegadores lo mandan sin comillas y algunos proxies lo re-citan.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {string} El boundary.
 * @throws {HttpError} 400 si el request no es multipart o no tiene boundary.
 */
function boundaryOf(req) {
  const type = text((req && req.headers || {})['content-type']);
  const esMultipart = /^\s*multipart\/form-data\s*(;|$)/i.test(type);
  const match = esMultipart ? type.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i) : null;
  if (!match || (!match[1] && !match[2])) {
    // ↑ El mensaje dice qué hay que mandar, no qué se esperaba: un 400 que dice
    //   "boundary inválido" no le dice a nadie qué hacer. `cvText.js` responde el
    //   415 del tipo y el 400 del archivo vacío; este es el 400 del formato de la
    //   petición, que es un problema distinto y con una solución distinta.
    throw new HttpError(
      400,
      'El CV tiene que enviarse como archivo: un formulario multipart con el campo "cv".',
    );
  }
  return (match[1] || match[2]).trim();
}

/**
 * Parte un body multipart crudo en sus partes.
 *
 * El algoritmo es el de siempre —buscar el delimitador, y lo que hay entre un
 * delimitador y el siguiente es una parte— y es correcto en el caso normal.
 *
 * ── EL RIESGO CONOCIDO, ESCRITO ──────────────────────────────────────────────
 * Un boundary puede aparecer DENTRO de los datos binarios del archivo, y si
 * aparece la parte se parte al revés y el archivo sale corrupto. No se mitiga con
 * un boundary más largo: el cliente lo elige y casi siempre son 60 caracteres
 * hex, que es espacio suficiente para que la colisión sea estadísticamente
 * imposible. La alternativa (buscar el delimitador más LARGO posible, que es lo
 * que hacen los parsers serios) exige recorrer el body dos veces para nada en el
 * caso real. Se acepta la limitación y se anota: si algún día se rompe, el
 * síntoma es un `cvText.js` que dice "el CV parece un escaneo" con un PDF que
 * tiene texto, y la causa es esto.
 *
 * @param {Buffer} raw El body crudo.
 * @param {string} boundary El separador.
 * @returns {Buffer[]} Cada parte, con sus cabeceras y su contenido.
 */
function splitParts(raw, boundary) {
  const marca = Buffer.from(`--${boundary}`, 'latin1');
  const partes = [];
  let inicio = raw.indexOf(marca);
  // ↑ El preámbulo que puede venir antes del primer delimitador (es legal en la
  //   RFC) se salta solo: `indexOf` empieza a buscar desde el boundary.
  while (inicio !== -1) {
    const siguiente = raw.indexOf(marca, inicio + marca.length);
    // ↑ El `--boundary--` final TAMBIÉN matchea `--boundary`, así que la última
    //   parte real se cierra bien. Lo que queda después es el epílogo, que no
    //   interesa.
    if (siguiente === -1) break;
    let desde = inicio + marca.length;
    // Cada parte empieza después del CRLF que sigue al delimitador...
    if (raw[desde] === 0x0d && raw[desde + 1] === 0x0a) desde += 2;
    // ...y termina antes del CRLF que antecede al delimitador siguiente. Sacar
    // ese CRLF es lo que hace que el PDF no tenga dos bytes de basura al final:
    // un PDF toleraría el sobrante, pero el `size` que se calcula abajo sería
    // incorrecto y `mammoth` no.
    let hasta = siguiente;
    if (raw[hasta - 2] === 0x0d && raw[hasta - 1] === 0x0a) hasta -= 2;
    if (hasta > desde) partes.push(raw.subarray(desde, hasta));
    inicio = siguiente;
  }
  return partes;
}

/**
 * Saca un parámetro de un header `Content-Disposition`.
 *
 * Se maneja `filename*` (RFC 5987, `UTF-8''nombre%20con%20espacios.pdf`) que es
 * lo que mandan los navegadores modernos con acentos en el nombre del archivo, y
 * con y sin comillas.
 *
 * El `\b` del patrón importa: sin él, buscar `name` matchearía el `name=` de
 * `filename=`. Con `\b`, `name` sólo matchea donde empieza un nombre de
 * parámetro, porque la `n` de `filename` está pegada a una letra.
 *
 * @param {string} disposition El valor del header.
 * @param {string} key `name` o `filename`.
 * @returns {string|null} El valor, o null si no está.
 */
function dispositionParam(disposition, key) {
  const estrella = disposition.match(new RegExp(`(?:^|;)\\s*\\b${key}\\*\\s*=\\s*([^;]+)`, 'i'));
  if (estrella) {
    const bruto = estrella[1].trim();
    // `charset'idioma'valor` → el valor es lo que viene después del segundo `''`.
    const partido = bruto.split("''");
    const codificado = partido.length > 1 ? partido.slice(1).join("''") : bruto;
    try {
      return decodeURIComponent(codificado.replace(/^"|"$/g, '')).trim();
    } catch {
      // ↑ Un nombre con un `%` roto no es un error que valga un 500: se usa el
      //   valor crudo, que para `cvText.js` es lo mismo (solo mira la extensión).
      return codificado.trim();
    }
  }
  const conComillas = disposition.match(new RegExp(`(?:^|;)\\s*\\b${key}\\s*=\\s*"([^"]*)"`, 'i'));
  if (conComillas) return conComillas[1].trim();
  const simple = disposition.match(new RegExp(`(?:^|;)\\s*\\b${key}\\s*=\\s*([^;]+)`, 'i'));
  return simple ? simple[1].trim().replace(/^"|"$/g, '') : null;
}

/**
 * Parte una parte del multipart en cabeceras + contenido.
 * @param {Buffer} parte La parte cruda.
 * @returns {{name: string, filename: string, file: object}|null} La parte, o null.
 */
function parsePart(parte) {
  const corte = parte.indexOf(HEADER_SEP);
  if (corte === -1) return null;
  // ↑ Una parte sin separación cabeceras/contenido no es una parte válida. Se
  //   ignora en vez de tirar: un multipart roto puede tener basura entre partes
  //   y el 400 que importa es el del archivo que no llegó, no este.

  const headers = {};
  for (const linea of parte.subarray(0, corte).toString('latin1').split('\r\n')) {
    const dos = linea.indexOf(':');
    if (dos < 1) continue;
    headers[linea.slice(0, dos).trim().toLowerCase()] = linea.slice(dos + 1).trim();
  }

  const disposition = headers['content-disposition'] || '';
  const filename = dispositionParam(disposition, 'filename') || '';
  const contenido = parte.subarray(corte + HEADER_SEP.length);

  return {
    name: dispositionParam(disposition, 'name') || '',
    filename,
    file: {
      mimetype: (headers['content-type'] || '').toLowerCase(),
      filename: filename.replace(/^.*[\\/]/, ''),
      // ↑ El tamaño es el MEDIDO, no el declarado. El `Content-Length` de la
      //   parte lo escribe el cliente y no prueba nada (mismo motivo por el que
      //   `validateCvFile` mira los dos tamaños y se queda con el del Buffer).
      size: contenido.length,
      // ↑ `subarray` es una VISTA, no una copia: el contenido del archivo sigue
      //   apuntando al body crudo. No se copia por dos razones: nadie muta estos
      //   bytes (los leen `pdf-parse`, `mammoth` y `looksLikePdf`, todos de
      //   lectura) y una copia de 5 MB por request dejaría los dos buffers
      //   vivos al mismo tiempo.
      buffer: contenido,
    },
  };
}

/**
 * Busca el archivo del CV dentro de un body multipart crudo.
 * @param {import('node:http').IncomingMessage} req Petición (solo por el header).
 * @param {Buffer} raw El body crudo.
 * @returns {object|null} El archivo, o null si no vino el campo.
 * @throws {HttpError} 400 si el request no es multipart.
 */
function fileFromRaw(req, raw) {
  const partes = splitParts(raw, boundaryOf(req));
  let conNombre = null;
  for (const parte of partes) {
    const p = parsePart(parte);
    if (!p) continue;
    // `cv[]` es lo que mandan los parsers que agrupan archivos en lista.
    if (p.name.replace(/\[\]$/, '').trim().toLowerCase() === FIELD_NAME) return p.file;
    if (p.filename && !conNombre) conNombre = p.file;
  }
  return conNombre;
}

/**
 * Lee el body crudo del request con un tope, sin acumular de más.
 *
 * Es el mismo criterio que `readJsonBody` (http.js:187-200), copiado a mano
 * porque acá el límite es otro y el body no es JSON: se corta APENAS se pasa del
 * tope, sin `Buffer.concat` de lo que vino. El objetivo es no gastar 50 MB de
 * memoria por un body de 50 MB que además vamos a rechazar.
 *
 * No se destruye el socket al cortar la lectura a mitad de camino (igual que en
 * `readJsonBody`): la conexión la cierra la plataforma cuando termina la
 * respuesta, y cortar el stream a mano dejaría al cliente esperando un cuerpo
 * que no llega.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {Promise<Buffer|null>} El body, o null si no había.
 * @throws {HttpError} 413 si se pasa del tope.
 */
async function readRawBody(req) {
  // Un `req` de test puede no ser un stream. Sin body y sin stream no hay nada
  // que leer, y `validateCvFile` responde el 400 de "no se recibió el contenido".
  if (typeof req[Symbol.asyncIterator] !== 'function') return null;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_MULTIPART_BYTES) {
      throw new HttpError(
        413,
        `El CV es demasiado grande. El máximo son ${MAX_CV_BYTES / (1024 * 1024)} MB.`,
      );
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

/**
 * Saca el archivo del CV de dondequiera que haya llegado.
 *
 * HAY TRES CAMINOS Y EXISTEN LOS TRES porque el runtime no es siempre el mismo.
 * El mismo criterio de `readJsonBody` (http.js:158-176), con un camino más:
 *
 *   1. `req.body` ya parseado en objeto con el archivo adentro.
 *   2. `req.body` es un string o un Buffer con el multipart crudo.
 *   3. No hay body todavía y hay que leer el stream.
 *
 * El 3 es el camino real en Vercel: el runtime de Node no parsea multipart, así
 * que `req.body` viene `undefined` y el body hay que leerlo del `req`. Los otros
 * dos existen para `vercel dev` con middleware, para un `node:http` pelado en
 * pruebas y para el futuro runtime que parsee el cuerpo.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {Promise<object|null>} El archivo, o null si no vino.
 * @throws {HttpError} 400 si no es multipart, 413 si el body es demasiado grande.
 */
async function readCvFile(req) {
  const body = req.body;

  if (body !== undefined && body !== null) {
    if (typeof body === 'object' && !Buffer.isBuffer(body)) {
      // Camino 1.
      const archivo = pickFile(body);
      if (archivo) return archivo;
    } else {
      // Camino 2. `latin1` y no `utf8`: el body es un montón de bytes, y `utf8`
      // reemplaza cada byte que no es UTF-8 válido por U+FFFD, con lo cual un PDF
      // con un solo byte raro deja de ser el PDF que se recibió.
      const crudo = Buffer.isBuffer(body) ? body : Buffer.from(text(body), 'latin1');
      return fileFromRaw(req, crudo);
    }
    // ↑ Si era un objeto parseado y no tenía ningún archivo, NO se intenta leer
    //   el stream: con `req.body` presente, el body ya se consumió y del stream
    //   no va a salir nada.
    return null;
  }

  // Camino 3.
  const crudo = await readRawBody(req);
  return crudo ? fileFromRaw(req, crudo) : null;
}

// ════════════════════════════════════════════════════════════════════════════
// EL RECORTE PARA EL LLM
// ════════════════════════════════════════════════════════════════════════════

/**
 * Recorta el texto del CV al tope que se le manda al LLM.
 *
 * Corta en el último salto de línea antes del tope, no a la mitad de una palabra.
 * El `> MAX / 2` es por si el texto es un bloque largo sin una sola quebra de
 * línea (un CV pegado como un párrafo): en ese caso no hay nada que respetar y
 * se corta duro, porque antes de dejar pasar 20 000 caracteres de una línea se
 * debe cortar en algún lado.
 *
 * @param {string} texto El texto del CV, ya normalizado por `cvText.js`.
 * @returns {string} El texto para el LLM.
 */
function textForLlm(texto) {
  if (texto.length <= MAX_CV_TEXT_CHARS) return texto;
  const ultimoSalto = texto.lastIndexOf('\n', MAX_CV_TEXT_CHARS);
  const recorte = ultimoSalto > MAX_CV_TEXT_CHARS / 2 ? texto.slice(0, ultimoSalto) : texto.slice(0, MAX_CV_TEXT_CHARS);
  // ↑ Solo LARGOS al log. El texto del CV es el dato personal de alguien y un
  //   log es más accesible que la base. Con los dos números alcanza para
  //   diagnosticar (el log dice "el CV era más largo de lo que procesamos").
  console.warn(
    '[cv] el texto del CV era de %d caracteres y se recortó a %d antes del LLM.',
    texto.length,
    recorte.length,
  );
  return recorte;
}

// ════════════════════════════════════════════════════════════════════════════
// EL ENDPOINT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Lee el CV, lo pasa por el LLM y devuelve el perfil derivado SIN GUARDARLO.
 *
 * ── LOS CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────────
 *
 *   401  sin cookie válida ──► el frontend va a /login
 *
 *   413  el body supera `MAX_MULTIPART_BYTES` (5 MB + 64 KB), o el archivo
 *        supera `MAX_CV_BYTES` ──► "achicalo"
 *
 *   415  el MIME o la extensión no son PDF/DOCX, o se contradicen entre sí,
 *        o los primeros bytes no son un PDF de verdad ──► "guardalo bien"
 *
 *   400  no vino el archivo, no vino en multipart, no se pudo parsear, el texto
 *        sale vacío o demasiado corto ──► "volvé a subirlo"
 *
 *   429  el usuario ya agotó su cuota de la hora, con `retryAfter` en el body y
 *        `Retry-After` en el header
 *
 *   500  falta `LLM_API_KEY` (ConfigError, es el deploy roto)
 *   502  el proveedor falló, no respondió, o devolvió algo que no es JSON
 *   504  el proveedor no respondió a tiempo
 *
 *   200  { ok, profile, kind, saved: false }
 *
 * El 400 y el 413 no se mezclan: `cvText.js` tiene el criterio escrito y es el
 * mismo (una petición correcta en la forma pero grande es 413; una petición que
 * no tiene sentido es 400).
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const POST = withErrorHandling(async (req, res) => {
  // 1) Sesión. `requireSession` y NADA más: ver el bloque de arriba. El 401 sale
  //    con su mensaje a través del `withErrorHandling` de `http.js`, sin try/catch.
  const { user } = await requireSession(req);
  // ↑ `user` se destructura porque el rate limit del paso 6 lo necesita, y no
  //   porque haya algo que guardar: sigue sin haber ninguna escritura de perfil en
  //   esta función. El `user_id` sale de acá y del body no se lee ninguno.

  // 2) `Content-Length` contra el tope, antes de leer un byte. Es la única
  //    validación que no necesita el body en memoria, y por eso va primera: un
  //    body de 200 MB se rechaza con un 413 sin haber consumido ni un chunk.
  const declarado = Number(text((req.headers || {})['content-length']));
  if (Number.isFinite(declarado) && declarado > MAX_MULTIPART_BYTES) {
    throw new HttpError(
      413,
      `El CV es demasiado grande. El máximo son ${MAX_CV_BYTES / (1024 * 1024)} MB.`,
    );
  }
  // ↑ `Number.isFinite` primero: `Number('')` es 0 y `Number(undefined)` es NaN,
  //   y los dos son "no hay Content-Length", no "pesa cero".

  // 3) El archivo. Los tres caminos de `readCvFile`, con el tope en el stream.
  const file = await readCvFile(req);

  // 4) `validateCvFile` y después `extractCvText`. Los dos, aunque
  //    `extractCvText` vuelve a validar (cvText.js:596): el primero deja claro
  //    el orden de los chequeos en el endpoint y hace que el 415 del tipo salga
  //    ANTES de cargar `pdf-parse` (que pesa megabytes y se importa al vuelo).
  //    El segundo es el que saca el texto y el que hereda los 400.
  validateCvFile(file);
  const { text: cvText, kind } = await extractCvText(file);
  // ↑ A partir de acá existe el texto del CV en memoria. Vive en ESTA constante
  //   local y en el `file.buffer`, que se van cuando termina la invocación. No se
  //   pone en ninguna variable de módulo, no se manda a la base y no se loguea.
  //   Es lo único que se le manda al LLM y lo único que se pierde después.

  // 5) El rate limit por usuario. Va ACÁ y no antes, y no después: lo que llega
  //    hasta este punto ya está validado y no costó tokens, así que todavía se
  //    puede rechazar gratis; lo que viene después, se paga.
  await assertCvParseAllowed(user.id);
  // ↑ Su return se descarta a propósito. No se manda en la respuesta: `remaining`
  //   y `used` son números de configuración interna y no le sirven de nada a
  //   quien está subiendo su CV. Lo que sí vuelve al cliente, si hubo 429, es el
  //   mensaje y el `Retry-After` (que va en el body y en el header).
  //   Este `await` NO contiene la llamada al LLM: la transacción del contador se
  //   committea acá, antes de que empiece a esperar el proveedor. Un serializador
  //   por usuario (el advisory lock de `cvParseLimit.js`) durante los 25 segundos
  //   del `fetch` haría que dos requests del mismo usuario se pusieran en fila, y
  //   el segundo pagaría su parseo para recibir un 429 que no le corresponde.

  // 6) El LLM. `parseCvToProfile` ya normaliza la salida al contrato de la API
  //    (`llm.js:normalizeLlmProfile`), así que lo que vuelve ya se puede mostrar
  //    en el formulario de revisión tal cual.
  const profile = await parseCvToProfile(textForLlm(cvText));

  sendJson(res, 200, {
    ok: true,
    profile,
    // ↑ 'pdf' o 'docx'. Va en la respuesta para que el frontend pueda decir
    //   "Leímos tu PDF" sin tener que deducirlo de una extensión.
    kind,
    // ▲ `saved: false` SIEMPRE, y no un default: es la respuesta a la pregunta más
    //   importante de este endpoint. El frontend tiene que saber que NO quedó
    //   guardado, porque hasta que el usuario mande un `PUT /api/profile`, este
    //   perfil no existe en ningún lado. Sin este campo, un `saved` ausente se
    //   lee como falso y el frontend se hace la idea de que sí se guardó; y un
    //   `true` acá mandaría al usuario a una app que no tiene contra qué
    //   matchear ofertas. Ver el bloque de arriba sobre por qué no se persiste.
    saved: false,
  });
});