// ============================================================================
// TEXTO DEL CV: validar el archivo que sube el usuario y sacarle el texto.
//
// Este módulo es la mitad "mecánica" del alta en DOS ETAPAS (ver `auth.js` y
// MEMORIA.md §4.1): el usuario se registra con correo y clave, y el perfil sale
// de subir un CV. Acá está todo lo que pasa entre el `POST` con el archivo y el
// texto que después se le manda al LLM.
//
// ── EL ARCHIVO NO SE GUARDA NUNCA ────────────────────────────────────────────
// Ni a disco, ni en Vercel Blob, ni en la base. Sale de la request, se lee en
// memoria y se tira. Lo que se persiste es el PERFIL DERIVADO, y nada más.
// Tres razones, y las tres importan:
//
//   1. `/tmp` en Vercel es efímero por diseño (es el mismo filesystem de la
//      invocación, y en Node 20 es memoria con decepción de nombre). Guardar el
//      CV para "revisarlo después" es guardarlo para nada.
//   2. Un CV es el dato personal MÁS SENSIBLE que maneja esta app: nombre,
//      dirección, teléfono, DNIT, experiencia, sueldo anterior. Que la app no
//      lo tenga es la decisión de privacidad más barata que hay.
//   3. Si alguna vez hay que conservarlo, es una decisión consciente: un bucket
//      con control de acceso, una tabla con expiración, y una definición de qué
//      pasa con la FOTO. Eso no se decide en un comentario de un `import`.
//
// O sea: este módulo es PURO. No importa `db.js`, no toca disco, no hace red, y
// no puede dejar nada detrás aunque se caiga a mitad de la invocación.
//
// ── LAS TRES EJES DE LA VALIDACIÓN, Y POR QUÉ SON TRES ────────────────────────
// Un `Content-Type` que manda el navegador es DECLARATIVO: lo elige el cliente y
// se puede falsar con una línea de código, así que no prueba nada. Por eso acá
// se mira en tres ejes independientes, del más barato al más caro:
//
//   1. LO DECLARADO: MIME + extensión. Barato, y sirve para rechazar de entrada
//      el 99% de los equivocados con un mensaje útil.
//   2. EL TAMAÑO: lo declarado Y el Buffer real (ver `validateCvFile`).
//   3. EL CONTENIDO REAL: los primeros bytes del archivo. Esto es lo único que
//      no lo controla el cliente, y por eso es el que decide.
//
// Y el que decide es `looksLikePdf`, que mira 5 bytes. Barato, y es la diferencia
// entre "el usuario subió un Word renombrado a .pdf" y "el usuario subió un PDF
// y el parser lo abrió".
//
// ── LO QUE ESTE MÓDULO NO HACE ───────────────────────────────────────────────
//   · NO parsea el multipart. Eso es del endpoint (`api/cv.js`), y este módulo
//     recibe el objeto `{ mimetype, filename, size, buffer }` YA parseado.
//   · NO llama al LLM ni arma el prompt. Solo saca texto limpio.
//   · NO escribe el perfil. Eso es `profile.js`, y lo hace el endpoint.
//   · NO autentica. `auth.js` va antes, en el handler.
//
// ── LA POLÍTICA DE ERRORES ───────────────────────────────────────────────────
// Los tres códigos NO son sinónimos, y la diferencia es de a quién le pertenece
// el problema: el 400 es una petición que no tiene sentido, el 413 es una
// petición correcta en la forma pero grande, y el 415 es una petición con un
// contenido que el sistema no sabe leer. Ver el detalle en cada validación.
//
// Y una regla que no se negocia, la misma de `http.js`: el `message` de un
// error que NO es nuestro NUNCA sale del servidor. Un parser puede tirar
// `Error: no /Root/Users/pepita/cv.pdf, not a PDF` y eso revela el nombre de un
// archivo, un path o la versión de una librería. Al log, sí. Al cliente, no.
// ============================================================================

import { HttpError } from './http.js';

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════════════════════════

// Tope del archivo, en BYTES (no en MB) porque es lo que se puede comparar contra
// `buffer.length` sin convertir unidades en el medio.
//
// 5 MB es el número que corta en el lugar justo: un CV escaneado (que es solo una
// imagen) suele pesar entre 1 y 2 MB, y uno generado desde Word con algunas
// imágenes llega fácil a 3-4 MB. 5 deja margen real para el caso legítimo sin
// abrir la puerta a que alguien suba un libro entero —que además es la forma más
// barata de agotar la memoria de una función serverless, porque el Buffer ya
// está cargado cuando este módulo lo ve.
//
// OJO: este NO es el límite del body. Es el del ARCHIVO. Si el endpoint acepta
// multipart, tiene que cortar antes (ver `readJsonBody` en `http.js`, que corta a
// los 64 KB y es para JSON, no para esto). Este número es la última línea, no la
// primera.
export const MAX_CV_BYTES = 5 * 1024 * 1024;

// Los dos MIME, en constantes con nombre, porque aparecen en tres lugares y
// escribirlos a mano en un string de 60 caracteres es la forma más fácil de que
// uno se equivoque con un guion y el otro no. OJO con el de DOCX: es el MIME de
// un paquete de Office y tiene un guion en `openxmlformats`, sin él el navegador
// no lo manda nunca.
const MIME_PDF = 'application/pdf';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Los tipos que se aceptan. UN Set y no un array con `includes`, porque la
// pregunta es "¿está en la lista?" y un Set responde eso en O(1) y no con una
// búsqueda lineal. Con dos elementos la diferencia es de nanosegundos: la
// diferencia real es que el TIPO del dato dice que es una lista de membresía y no
// una lista de prioridades, y eso evita el `ACCEPTED_MIME_TYPES.push(...)` que
// alguien agrega un día para "aceptar el odt también" sin darse cuenta de que
// mutable es justamente lo que no debía ser.
//
// ── POR QUÉ NO SE ACEPTA EL `.doc` VIEJO (`application/msword`) ───────────────
// Porque `mammoth` NO lo puede leer, y aceptarlo sería prometer algo que después
// falla. `.docx` es un ZIP con XML adentro: es un formato que se inventó para
// poder ser leído por una máquina. El `.doc` de Word 97 es un formato binario
// propietario de hace casi treinta años, y la única forma de sacarle texto es con
// un conversor binario (LibreOffice headless, antiword) que este proyecto no va a
// depender. O sea: un `Content-Type` de `.doc` llegaría, pasaría la validación de
// tipo, y se caería en el parseo con un error que el usuario no puede arreglar.
// Peor que un 415 honesto.
//
// ── Y POR QUÉ NO SE ACEPTA TEXTO PLANO (`.txt`, sin MIME, etc.) ───────────────
// Dos razones. La primera es práctica: un `.txt` no tiene estructura, así que
// "líneas de texto" y "párrafos" no se distinguen, y un CV necesita al menos esa
// separación para que el LLM no mezcle el nombre con la experiencia anterior.
// La segunda es de seguridad: si el endpoint acepta "cualquier texto", el
// parseo de un CV deja de ser un problema de formato y pasa a ser un
// `readFile` disfrazado, y el camino más obvio para colar algo que no es un CV.
export const ACCEPTED_MIME_TYPES = new Set([MIME_PDF, MIME_DOCX]);

// Las extensiones, EN MINÚSCULAS. Van aparte del MIME a propósito, y no es
// redundancia: el MIME lo manda el cliente y la extensión también, y son DOS
// entradas independientes. La comparación de las dos es lo que hace que el
// chequeo sirva (ver `detectKind`).
export const ACCEPTED_EXTENSIONS = new Set(['.pdf', '.docx']);

// Los primeros 5 bytes de TODO PDF del mundo: `%PDF-`. Buffer y no string
// porque el chequeo es byte a byte sobre un Buffer: comparar con `.toString()` y
// después con `startsWith` reserva una cadena nueva del tamaño del archivo
// entero, y acá el archivo puede pesar 5 MB. `subarray` no copia: es una vista.
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

// El mínimo de TEXTO que se acepta como CV.
//
// 200 caracteres es un número, no un capricho: es más o menos la mitad de una
// página. Por debajo de eso NO HAY un CV — y lo que hay, en la práctica, siempre
// es una de estas tres cosas:
//
//   · un PDF ESCANEADO (foto del CV): las páginas son imágenes y no tienen capa
//     de texto, así que el parser devuelve `''`. Es el caso más COMÚN y el que
//     más confunde, porque el archivo es un PDF perfectamente válido y pesa bien.
//   · un PDF protegido o corrupto: el parser no tira, devuelve texto parcial o
//     vacío.
//   · un documento que no es un CV.
//
// El número va acá y no en el endpoint porque el chequeo es del MÓDULO: si el
// mínimo fuera del endpoint, un endpoint nuevo que se olvide de él dejaría pasar
// un escaneo sin que nada se entere.
export const MIN_CV_TEXT_CHARS = 200;

// ════════════════════════════════════════════════════════════════════════════
// CARGA DE LOS PARSERS
// ════════════════════════════════════════════════════════════════════════════

// Los dos parsers se cargan PEREZOSOS, adentro de la función que los necesita, y
// no arriba del archivo con un `import` normal. El motivo es concreto: las dos
// librerías son enormes (`pdf-parse` arrastra pdf.js adentro, y son megabytes de
// código), y `validateCvFile` —que es lo que se corre en el camino caliente de
// RECHAZAR una subida— no las necesita para nada. Con `import` normal, cada
// intento de subir un `.doc` que el sistema no soporta paga la carga completa de
// pdf.js para después recibir un 415.
//
// OJO: esto NO es "estado entre requests" (lo que el proyecto prohíbe, y está
// escrito en AGENTS.md). No hay ningún resultado cacheado, ningún "último CV",
// nada de lo que una respuesta dependa. Es la MISMA promesa del módulo, guardada
// para no repetir la resolución. Y el motor de ESM de Node ya cachea el módulo
// por proceso, así que después de la primera vez esto es una lectura de una
// variable: si la instancia se apaga y lo pierde, el `import` lo vuelve a
// cargar y da exactamente el mismo módulo.
//
// Sobre el ESPECIFICADOR: va `'pdf-parse'` y NO `'pdf-parse.js'`. El `.js` es la
// forma en que CommonJS resuelve (`require('./index.js')` encuentra el archivo),
// pero ESM no hace esa búsqueda: en un import de paquete SIN campo `exports` (que
// es el caso de `pdf-parse`) Node resuelve por el campo `main` y nada más.
// `import 'pdf-parse.js'` tira `ERR_MODULE_NOT_FOUND` en el primer request, y
// como es un import dinámico el error llega DENTRO del `try/catch` del parseo —
// o sea que se vería como "el CV está corrupto" cuando en realidad el código está
// roto. La forma correcta de un CJS en ESM es la interop del default: el
// `module.exports = PDF` del paquete llega como `mod.default`.
let pdfParsePromise = null;

/**
 * Carga `pdf-parse` y devuelve su función de parseo.
 * @returns {Promise<(buffer: Buffer) => Promise<{text: string}>>} `pdfParse`.
 */
function loadPdfParse() {
  if (!pdfParsePromise) {
    pdfParsePromise = import('pdf-parse')
      .then((mod) => mod.default)
      .catch((err) => {
        // ↑ No se cachea el FALLO. Si la carga se cachea rechazada, todas las
        //   requests siguientes de esta instancia fallan al instante con el mismo
        //   error, para siempre, y un problema que era transitorio se convierte
        //   en un deploy roto que se explica solo. Reloadando, el próximo
        //   request reintenta de verdad.
        pdfParsePromise = null;
        throw err;
      });
  }
  return pdfParsePromise;
}

let mammothPromise = null;

/**
 * Carga `mammoth` y devuelve el módulo.
 * @returns {Promise<{extractRawText: (opts: object) => Promise<{value: string}>}>} `mammoth`.
 */
function loadMammoth() {
  if (!mammothPromise) {
    mammothPromise = import('mammoth')
      .then((mod) => mod.default)
      .catch((err) => {
        // ↑ El mismo criterio que en `loadPdfParse`, y por la misma razón.
        mammothPromise = null;
        throw err;
      });
  }
  return mammothPromise;
}

// ════════════════════════════════════════════════════════════════════════════
// LOS MENSAJES
// ════════════════════════════════════════════════════════════════════════════

// Los mensajes están en constantes y NO se arman en el medio de la función, por
// una razón que va más allá de la prolijidad: el mismo error tiene que decir
// siempre lo mismo, y si el texto estuviera partido entre dos lugares, cambiarlo
// un día deja una rama con la versión vieja. Además los mensajes son la respuesta
// al usuario, y son la parte de este archivo que más se lee: el 415 es lo que
// alguien ve cuando su `.doc` no entra, y ese mensaje explica por qué y qué
// hacer. Que valga la pena.

// Un `Set` de los aceptados, escrito para el mensaje. Se arma acá y no con un
// `[...set].join()` en el medio de la validación: es una vez por proceso y el
// texto tiene que ser el mismo siempre, sí, pero sobre todo tiene que LEERSE
// bien, y "PDF y DOCX" se lee mejor que un listado de MIME de 60 caracteres.
const TIPOS_ACEPTADOS = 'un PDF o un Word .docx';

// El mensaje del 415, uno solo para las TRES formas de fallar el chequeo de tipo
// (MIME desconocido, extensión desconocida, y las dos que se contradicen).
//
// Que sea el MISMO para las tres es una decisión, no una comodidad. Si el 415
// dijera "tu MIME no es válido" en un caso y "tu extensión no es válida" en el
// otro, el mensaje se convierte en un oráculo: le dice a quien está probando qué
// chequeo tiene que falsar. Y para el usuario es peor también, porque un mismo
// error tendría dos textos distintos y no sabría cuál mirar.
const TIPO_INVALIDO = `El CV tiene que ser ${TIPOS_ACEPTADOS}. El .doc viejo de Word, los archivos de texto y las imágenes no se pueden leer.`;

const TIPO_CONFLICTO = `El tipo del archivo y su extensión no coinciden. Guardalo con su extensión correcta (${TIPOS_ACEPTADOS}) y volvé a subirlo.`;

// El mismo mensaje para "no vino un archivo" y para "vino pero vacío", porque
// para quien lo ve desde afuera es la misma situación y la misma solución. Se
// comparten porque el endpoint no puede distinguirlas: `multipart` no te dice por
// qué no hay archivo, y no vale la pena fingir que sí.
const CV_VACIO = 'No se recibió el contenido del CV. Volvé a subir el archivo.';

const CV_MUY_CORTO = 'El CV parece un escaneo o una foto, no un documento con texto. Subilo exportado desde el original (PDF con texto seleccionable) o en .docx.';

const CV_ILEGIBLE = 'No se pudo leer el contenido del CV. Volvé a guardarlo como PDF o .docx desde el documento original y probá de nuevo.';

// ════════════════════════════════════════════════════════════════════════════
// LA EXTENSIÓN Y EL TIPO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Saca la extensión de un nombre de archivo, en minúsculas.
 *
 * `lastIndexOf('.')` y no `split`: en un nombre de archivo puede haber puntos en
 * el medio (`cv.2024.final.pdf`) y solo importa el último. Y `cut > 0` y no
 * `cut >= 0` a propósito: un archivo que se llama `.pdf` (punto al principio,
 * sin nombre antes) es un archivo OCULTO en Unix, no un PDF, y aceptarlo sería
 * abrir la puerta a que un nombre sin extensión real pase por la validación.
 *
 * @param {unknown} filename Lo que venga en el campo del multipart.
 * @returns {string} La extensión con el punto, en minúsculas, o `''` si no hay.
 */
function extensionOf(filename) {
  if (typeof filename !== 'string') return '';
  const name = filename.trim().toLowerCase();
  const cut = name.lastIndexOf('.');
  return cut > 0 ? name.slice(cut) : '';
}

/**
 * Decide qué tipo de documento es el archivo, o falla con 415.
 *
 * ── POR QUÉ SE EXIGEN LAS DOS COSAS ───────────────────────────────────────────
 * El `Content-Type` de un archivo en un multipart lo pone el cliente. El cliente
 * elige. `curl` lo pone, un script lo pone, y un navegador lo pone pero también
 * se puede falsar. NO es evidencia de nada, es una DECLARACIÓN, y por eso la
 * extensión no es redundante: es la segunda declaración, y dos declaraciones
 * que se contradicen son una señal de alarma.
 *
 * Y hay un detalle de la realidad que hace que la extensión sea la que más
 * engaña: `.pdf` es la extensión que TODO EL MUNDO pone. Renombrar `cv.docx` a
 * `cv.pdf` es el truco viejo para pasar un filtro de subida, y con la extensión
 * sola uno se creería que está protegido. Por eso el tipo que se devuelve acá es
 * el que dice el MIME (la declaración menos manipulable de las dos, porque el
 * navegador la saca del archivo real) y la extensión tiene que coincidir con él.
 *
 * ── EL CONFLICTO ES UN 415 Y NO UN 400 ────────────────────────────────────────
 * El caso "MIME dice PDF y la extensión dice docx" no es un archivo roto: es un
 * archivo que se contradice a sí mismo, y el sistema no tiene forma de saber
 * cuál de las dos frases es la verdadera. Elegir una de las dos y parsearla sería
 * adivinar. Es el mismo problema del usuario que un tipo no soportado, y por eso
 * comparte código con el resto de los 415 — y el mensaje lo dice, que es lo que lo
 * convierte en algo arreglable en lugar de un error que el usuario no entiende.
 *
 * @param {object} file El archivo del multipart, con `mimetype` y `filename`.
 * @returns {'pdf'|'docx'} De qué hay que parsearlo.
 * @throws {HttpError} 415 si el MIME o la extensión no son aceptados, o si se
 *   contradicen entre sí.
 */
function detectKind(file) {
  // El `split(';')` es por si algún proxy metería un `; charset=...` atrás del
  // MIME. Cuesta una línea y evita un 415 fantasma en una arquitectura donde hoy
  // no pasa nada.
  const mime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
  const ext = extensionOf(file.filename);

  if (!ACCEPTED_MIME_TYPES.has(mime) || !ACCEPTED_EXTENSIONS.has(ext)) {
    // ↑ `||` y no `&&` en la condición, y el mensaje es uno solo para las dos
    //   mitades (ver `TIPO_INVALIDO`): basta con que FALTE una de las dos
    //   declaraciones para rechazar, y no se le dice al cliente cuál fue. El 415
    //   es por un tipo de contenido que el sistema no sabe leer, no por un archivo
    //   "dañado": el archivo puede estar perfectamente bien y ser un `.odt` que no
    //   soportamos. Por eso no es 400.
    throw new HttpError(415, TIPO_INVALIDO);
  }

  // Con los dos chequeos pasados, solo hay dos tipos posibles, así que el mapa
  // es una línea. Se hace explícito y no con un `includes` para que el día que
  // se acepte un tercer tipo haya que tocar ESTE lugar y no uno que esté
  // escondido en una expresión.
  const porMime = mime === MIME_PDF ? 'pdf' : 'docx';
  const porExt = ext === '.pdf' ? 'pdf' : 'docx';

  if (porMime !== porExt) throw new HttpError(415, TIPO_CONFLICTO);

  return porMime;
}

// ════════════════════════════════════════════════════════════════════════════
// EL CONTENIDO REAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * ¿El Buffer empieza con la firma de un PDF?
 *
 * Esto es la DEFENSA contra el MIME declarado falso, y es la única parte de la
 * validación que el cliente no puede falsar: son cinco bytes del archivo, no un
 * header. Todo lo otro (el MIME, la extensión, el `size`) lo escribe el cliente
 * y se puede escribir mentiroso; estos cinco bytes no.
 *
 * CUESTA CINCO BYTES. Es la operación más barata de todo el módulo y es la que
 * convierte "aceptamos PDF" en "aceptamos PDF DE VERDAD". Un `.docx` renombrado
 * a `.pdf` pasa los dos chequeos declarados sin problema —porque `mimetype` y
 * `filename` los pone el cliente, y el cliente quiere que pase— y se frena acá.
 *
* ── POR QUÉ SOLO EN LA POSICIÓN 0 Y NO EN LOS PRIMEROS 1024 ───────────────────
 * La especificación del PDF dice que la cabecera puede estar precedida de basura
 * y que un lector tiene que tolerarlo, así que un `indexOf` en los primeros 1024
 * bytes sería más tolerante. No se hizo, y es una decisión: entre los dos lados
 * del trade-off, el falso POSITIVO (un archivo que no es PDF y tiene `%PDF-` en
 * los primeros 1024, construido a propósito) es el que importa, porque el parser
 * después también lo rechaza y el resultado es el mismo 400. En cambio el falso
 * NEGATIVO (un PDF de verdad con basura antes de la cabecera) prácticamente no
 * existe: ni Word, ni Google Docs, ni el escáner de un celular, ni una impresora
 * producen eso.
 *
 * @param {unknown} buffer El contenido del archivo.
 * @returns {boolean} Si arranca con `%PDF-`.
 */
export function looksLikePdf(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  // ↑ `Buffer.isBuffer` y no un try/catch: `Buffer.isBuffer('texto')` es `false`
  //   sin costo, y un string tiene `.subarray` undefined, que sería un TypeError
  //   con mensaje de Node en el log. Chequear antes es más barato y más claro.
  //
  // `subarray` NO COPIA: es una vista del Buffer original. Por eso el chequeo son
  // 5 bytes leídos, no 5 MB.
  return buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
}

// ════════════════════════════════════════════════════════════════════════════
// VALIDACIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Valida el archivo del CV y lo devuelve si está bien.
 *
 * Es SÍNCRONA a propósito, y es la diferencia entre esta función y un
 * `await` de cualquier cosa: acá no hay nada que esperar. Solo hay comparaciones
 * de strings, de números y una `subarray`. El `await` viene después, en
 * `extractCvText`, que sí habla con un parser.
 *
 * ── EL ORDEN DE LOS CHEQUEOS ES EL ORDEN DEL "QUÉ LE PASÓ" ─────────────────────
 * No es arbitrario y cambiarlo cambia los mensajes que ve la gente:
 *
 *   1. ¿Hay archivo?         400  — no hay nada que validar todavía.
 *   2. ¿Hay contenido?       400  — sin Buffer no hay archivo, hay un campo de
 *                                   texto. Y recién a partir de acá se puede
 *                                   decir algo del tamaño o del tipo.
 *   3. ¿Es un tipo que leo?  415  — es la pregunta más barata y la que más
 *                                   probable es que falle, así que va antes de
 *                                   tocar el tamaño: un `.odt` de 40 MB tiene que
 *                                   decir "no lo leo" y no "es muy grande".
 *   4. ¿Entra en el tope?     413  — recién con el tipo confirmado tiene sentido
 *                                   hablar de cuánto pesa.
 *   5. ¿Traía algo?          400  — un Buffer de 0 bytes no puede haber pasado
 *                                   el paso 4, así que este caso no pisa al 413.
 *
 * ── POR QUÉ EL 413 Y POR QUÉ SE MIRA EL BUFFER Y NO SOLO EL `size` ─────────────
 * `413` y no `400` porque la petición es CORRECTA: el usuario está subiendo un CV
 * de verdad, solo que más grande de lo que este sistema procesa. Con un 400 el
 * frontend lo muestra como "algo hiciste mal" y no deja reintentar; con un 413 la
 * lectura correcta es "es demasiado grande, achicalo", y es la que corresponde a
 * un límite de recurso del servidor. (Es también el código que usa `readJsonBody`
 * en `http.js` para el body, y por el mismo motivo.)
 *
 * Y se miran LOS DOS tamaños porque son DOS datos y uno de los dos es del
 * cliente: `file.size` lo escribe el cliente en la cabecera del multipart. Nadie
 * lo verificó. `buffer.length` es lo que REALMENTE llegó, medido por el runtime
 * después de copiar los bytes. Si uno valida solo `file.size`, el chequeo entero
 * es controlable por el atacante —basta con mandar `size: 1000` con 200 MB
 * adentro— y un límite de tamaño que se puede falsar no es un límite: es una
 * sugerencia. El 413 sale si CUALQUIERA de los dos pasa el tope, así que
 * falsar el declarado solo sirve para rechazar antes, nunca para admitir de más.
 *
 * @param {object} file Archivo del multipart: `{ mimetype, filename, size, buffer }`.
 * @returns {object} El MISMO objeto que se le pasó, si todo está bien.
 * @throws {HttpError} 400 si no hay archivo o no hay contenido, 415 si el tipo no
 *   es uno de los aceptados, 413 si supera el tamaño.
 */
export function validateCvFile(file) {
  if (!file || typeof file !== 'object') {
    // ↑ `typeof` y no Array.isArray: un array es un `object` y un multipart mal
    //   armado puede mandar cualquier cosa. Lo que importa es que no haya un
    //   archivo, y el mensaje es el mismo en todos los casos de "no hay".
    throw new HttpError(400, CV_VACIO);
  }
  if (!Buffer.isBuffer(file.buffer)) {
    // ↑ Distinto del paso 5 a propósito: acá hay un archivo DECLARADO (con su
    //   nombre y su MIME) pero su contenido no llegó. El paso 5 es un archivo que
    //   llegó de 0 bytes; los dos son "no hay contenido" para el usuario y
    //   comparten el mensaje, porque para quien lo ve un Buffer de 0 bytes y un
    //   `null` significan exactamente lo mismo.
    throw new HttpError(400, CV_VACIO);
  }

  // El tipo va antes que el tamaño, y no al revés: es el chequeo más barato y el
  // que más falla. Un archivo de 40 MB con un tipo que no soportamos tiene que
  // decir "no lo leo" (415), no "es muy grande" (413), porque si el tipo no
  // entra, el tamaño no tiene nada que ver.
  detectKind(file);
  // ↑ Se descarta el valor a propósito, y no es un descuido: esta función devuelve
  //   el ARCHIVO, no el tipo, porque es lo que el endpoint ya tiene en la mano y
  //   quiere guardar. El `kind` lo recalcula `extractCvText`, que es donde decide
  //   qué parser se usa. O sea que `detectKind` queda con UN solo lugar donde vive
  //   la regla, y lo que se tira desde acá es el 415: si el chequeo de tipo
  //   estuviera escrito dos veces (una acá y otra en `extractCvText`), cada nueva
  //   rama del módulo que lo use se olvidaría de una de las dos.

  const declarado = Number(file.size);
  if (Number.isFinite(declarado) && declarado > MAX_CV_BYTES) {
    // ↑ `Number.isFinite` primero porque `file.size` puede ser `undefined` (y
    //   `Number(undefined)` es `NaN`, no un error) o `'5000000'` (y
    //   `Number('5000000')` es el número, no un string). Un `size` que no se
    //   puede convertir NO es un motivo de rechazo: es un dato que no está, y el
    //   que decide es el Buffer del paso siguiente.
    throw new HttpError(
      413,
      `El CV es demasiado grande. El máximo son ${MAX_CV_BYTES / (1024 * 1024)} MB.`,
    );
  }
  if (file.buffer.length > MAX_CV_BYTES) {
    // ↑ ESTE es el que manda. Ver el bloque de arriba: `size` lo declara el
    //   cliente, `buffer.length` se mide acá. Un límite que se puede falsar
    //   declarando un `size` chico no es un límite.
    throw new HttpError(
      413,
      `El CV es demasiado grande. El máximo son ${MAX_CV_BYTES / (1024 * 1024)} MB.`,
    );
  }
  if (file.buffer.length === 0) {
    // ↑ Al final y no al principio, y no por gusto: un Buffer de 0 bytes no
    //   puede estar "demasiado grande", así que este camino no le pisa al 413.
    //   Va después para que el orden de los mensajes sea el del problema real
    //   (tipo, después tamaño, después contenido) y no el de la longitud del
    //   código.
    throw new HttpError(400, CV_VACIO);
  }

  return file;
}

// ════════════════════════════════════════════════════════════════════════════
// NORMALIZACIÓN DEL TEXTO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Limpia el texto que salió del parser.
 *
 * ── POR QUÉ LIMPIARLO, Y POR QUÉ ACÁ Y NO EN EL PROMPT ────────────────────────
 * Porque el CV va a un modelo que se PAGA POR TOKEN. Cada espacio repetido, cada
 * línea en blanco de más y cada `\r` suelto es un token que se factura dos veces:
 * una porque entra en el prompt, y otra porque el modelo responde peor cuando el
 * prompt vino hecho de ruido con relleno. El CV "normalizado" de un PDF escaneado
 * con OCR suele traer entre un 20% y un 40% de su volumen en caracteres de
 * espaciado. Eso es plata que se queda en la mesa, y se nota justo en el momento
 * en que varios usuarios están subiendo su CV a la vez.
 *
 * Y el motivo de que sea una función y no tres `.replace()` sueltos en el caller:
 * es el mismo texto para todos los que llamen, y un caller que se olvide de
 * normalizar paga el costo sin enterarse de por qué. Normaliza el módulo, no el
 * que llama a `extractCvText`.
 *
 * ── LO QUE HACE, Y POR QUÉ CADA COSA ─────────────────────────────────────────
 *
 * @param {unknown} raw Lo que devolvió el parser.
 * @returns {string} El texto limpio.
 */
function normalizeCvText(raw) {
  const text = typeof raw === 'string' ? raw : '';
  if (!text) return '';

  return text
    // 1. Los fines de línea. Primero el de Windows (`\r\n`), que es lo que sale
    //    de un `.docx` hecho en Word, y después el `\r` SOLO, que es lo que deja
    //    un PDF: muchos PDF con capa de texto traen cada salto como un `\r` sin
    //    su `\n`, y si no se lo convierte, el LLM recibe un archivo con CR sin LF
    //    y algunas librerías de parsing lo tratan como un carácter de texto
    //    cualquiera en vez de un salto de línea.
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // 2. Espacios y fines de línea HUECOS. `[^\S\n]+` es "cualquier carácter de
    //    espacio que NO sea el salto de línea": matchea los espacios corridos, los
    //    tabuladores, los espacios duros (U+00A0, que es un `¿` al revés y sale
    //    mucho de un PDF), y los saltos verticales. `\S` y no una lista de
    //    caracteres a mano porque el conjunto de "espacios" de Unicode es más
    //    grande que los cinco que uno se acuerda.
    //
    //    El `+` es lo que colapsa la corrida. Y el salto de línea NO se toca acá:
    //    colapsar los espacios es limpiar, borrar los saltos sería pegar todas
    //    las líneas en un párrafo y ahí sí se pierde la estructura del CV.
    .split('\n')
    .map((linea) => linea.replace(/[^\S\n]+/g, ' ').trim())
    // 3. El `trim()` por línea saca los espacios del FINAL de cada línea, que
    //    son los que peor se ven y los que más se pagan: no aportan nada al
    //    significado y en un PDF con columnas son la mitad del archivo.
    .join('\n')
    // 4. Las líneas en blanco de más. Un CV bien extraído separa con DOS `\n`
    //    (una línea en blanco entre párrafos). Con TRES o más ya no es separación:
    //    es el hueco de una tabla o de una columna que el parser no supo leer, y
    //    se le está pagando al modelo cada hueco. A dos: sigue siendo legible y
    //    el párrafo se sigue distinguiendo.
    .replace(/\n{3,}/g, '\n\n')
    // 5. El `trim()` final, porque un texto que empieza con seis líneas en blanco
    //    y termina con dos es el mismo documento, y acá no interesa de dónde vino.
    .trim();
}

// ════════════════════════════════════════════════════════════════════════════
// EXTRACCIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Saca el texto del CV.
 *
 * Recibe lo mismo que `validateCvFile` y devuelve el texto ya normalizado, más
 * de qué tipo se extrajo (que el endpoint puede querer para mostrar "Leímos tu
 * PDF" o para decidir si tiene que avisar algo).
 *
 * VUELVE A VALIDAR, y es a propósito aunque el endpoint ya haya llamado a
 * `validateCvFile`. Es barato (comparaciones y una `subarray`) y evita el modo de
 * falla más caro de todos: un endpoint futuro que se olvide de validar y le pase
 * cualquier cosa. Con el chequeo adentro, lo peor que puede pasar es un 415
 * duplicado, que es un mensaje repetido. Sin el chequeo adentro, lo peor que
 * puede pasar es que un `.exe` de 3 MB llegue al parser.
 *
 * ── POR QUÉ UN 400 Y NO UN 500 CUANDO EL PARSER FALLA ────────────────────────
 * Porque un parser que tira lo está tirando por el ARCHIVO, no por el servidor.
 * El PDF está cifrado, tiene el xref roto, es un ZIP con otro nombre o tiene una
 * versión de pdf.js que no lo entiende. En todos esos casos la respuesta correcta
 * es "volvé a guardarlo de otra manera", y un 500 le diría al usuario que la
 * aplicación está rota y a cualquier monitoreo que la app se cayó.
 *
 * Y el `err.message` crudo va SOLO al log. Ese mensaje puede traer el nombre del
 * archivo, un path, el nombre interno del objeto que falló o la versión de la
 * librería: es información del servidor que no le sirve de nada a quien está
 * del otro lado y que después se cita en un reporte de bug. El usuario recibe un
 * mensaje escrito por nosotros, que además le dice qué hacer.
 *
 * ── POR QUÉ EL 400 DEL TEXTO CORTO DICE LO DEL ESCANEO ───────────────────────
 * Porque es el caso más COMÚN de todos y el mensaje genérico ("no se pudo leer")
 * manda a la gente a un loop de "probá de nuevo" con el mismo archivo. Si el
 * parser no encontró texto, el archivo es casi siempre un escaneo o una foto, y
 * eso tiene arreglo: hay que subir el PDF hecho desde el documento original, no
 * una foto. Decirlo convierte un error sin explicación en una instrucción.
 *
 * @param {object} file Archivo del multipart: `{ mimetype, filename, size, buffer }`.
 * @returns {Promise<{text: string, kind: 'pdf'|'docx'}>} El texto normalizado y
 *   de qué tipo se sacó.
 * @throws {HttpError} 400 si el archivo no se puede parsear, si los bytes no son
 *   los del tipo declarado, o si el texto sale vacío o demasiado corto. Hereda
 *   de `validateCvFile` los 415 y los 413.
 */
export async function extractCvText(file) {
  validateCvFile(file);
  const kind = detectKind(file);
  // ↑ Se vuelve a calcular porque es el dato que decide el parseo, y porque el
  //   `validateCvFile` que se acaba de llamar devuelve el objeto, no el tipo.
  //   `detectKind` es puro y barato: dos comparaciones sobre un Set.

  if (kind === 'pdf' && !looksLikePdf(file.buffer)) {
    // ↑ SOLO para el PDF, y por una razón que no es capricho: el PDF tiene una
    //   firma de 5 bytes que se puede COMPARAR (`%PDF-`), así que verificar que el
    //   archivo es del tipo que dice es gratis. El DOCX no tiene nada comparable:
    //   es un ZIP, y su firma (`PK\x03\x04`) la comparte con el .xlsx, el .pptx, el
    //   .odt y el .jar, así que un chequeo de firma no distinguiría "un Word" de
    //   "cualquier otro ZIP". Para el DOCX el tipo lo pone el `mammoth`: si el
    //   archivo no es un ZIP que se parece a un Word, el `mammoth` tira y cae en
    //   el mismo 400 de más abajo, con el mismo mensaje. Agregar un chequeo de
    //   firma para el DOCX no agrega seguridad real, solo una condición más.
    throw new HttpError(
      400,
      'El archivo no es un PDF de verdad aunque tenga la extensión .pdf. Volvé a exportarlo desde el documento original.',
    );
  }

  let crudo = '';
  try {
    if (kind === 'pdf') {
      const pdfParse = await loadPdfParse();
      // ↑ `pdfParse(buffer)` devuelve una promesa con `{ text, numpages, info }`.
      //   El `.text` es lo único que se usa: lo demás son metadatos del PDF que no
      //   le interesa a nadie acá. Y el `typeof data.text === 'string'` es por si
      //   la librería devuelve el objeto sin `text` en un PDF raro: sin ese chequeo,
      //   `crudo` sería `undefined` y el `typeof` de la normalización cortaría
      //   todo, y el 400 de "texto muy corto" se cobraría un caso que en realidad
      //   es otro error distinto.
      const data = await pdfParse(file.buffer);
      crudo = data && typeof data.text === 'string' ? data.text : '';
    } else {
      const mammoth = await loadMammoth();
      // ↑ `extractRawText` y no `convertToHtml` ni `convertToMarkdown`: lo que
      //   se quiere es TEXTO, y las dos otras devuelven markup que después hay
      //   que sacar con una regexp. Ir a `convertToHtml` y después parsear el HTML
      //   es hacer dos veces el trabajo y equivocarse en el medio. La `value` que
      //   devuelve es el mismo texto plano, sin las etiquetas.
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      crudo = result && typeof result.value === 'string' ? result.value : '';
    }
  } catch (err) {
    // ↑ El `err` crudo SOLO al log (ver el bloque de arriba). El `kind` va en el
    //   log y no en la respuesta: sirve para que quien esté leyendo el log sepa
    //   si el problema es del motor de PDF o del de DOCX, y no le dice nada al
    //   cliente que no sea "volvé a subirlo".
    console.error('[cv] no se pudo parsear el %s: %s', kind, (err && err.message) || err);
    throw new HttpError(400, CV_ILEGIBLE);
  }

  const text = normalizeCvText(crudo);
  if (text.length < MIN_CV_TEXT_CHARS) {
    // ↑ El mensaje del escaneo, y no "el texto es muy corto". Ver el bloque de
    //   arriba: este es el fallo más frecuente y el que más confunde, así que el
    //   mensaje tiene que atacar ÉSE, no el síntoma.
    //   La comparación es `< MIN_CV_TEXT_CHARS` y no `<=`: un texto de EXACTAMENTE
    //   200 caracteres es un CV (muy corto) y se deja pasar. Un `<=` rechazaría
    //   un archivo que llegó al borde del umbral, que es el peor lugar para
    //   poner un borde.
    throw new HttpError(400, CV_MUY_CORTO);
  }

  return { text, kind };
}
