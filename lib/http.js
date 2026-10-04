// ============================================================================
// PLUMILLA HTTP DE LAS FUNCIONES SERVERLESS.
//
// Lo que hay acá NO es de la autenticación: es el marco en el que corren todos
// los handlers de `api/*.js`. Vive aparte de `auth.js` a propósito, porque
// `auth.js` importa la base de datos y este archivo no la importa nunca. Esa
// separación es lo que permite que `api/health.js` responda SIN base de datos y
// que un error de configuración de `SESSION_SECRET` no tumbe el smoke test.
//
// NO se usa `@vercel/node` ni ningún otro helper del SDK de Vercel: `req` y
// `res` ya llegan con la forma de Node (`IncomingMessage`/`ServerResponse` de
// `node:http`) y eso alcanza para todo lo que hace falta. Agregar el SDK sería
// una dependencia que no está en el `package.json` y rompe el build.
//
// Lo que exporta:
//   · HttpError / ConfigError  — errores que se traducen a una respuesta con código
//   · withErrorHandling(handler)— envuelve un handler y traduce cualquier throw
//   · sendJson(res, status, x)  — respuesta JSON, siempre con no-store
//   · readJsonBody(req, opts)   — body JSON parseado, o 400 si no se puede
//   · getCookieValue(req, name) — una cookie del request, o null
//   · clientIp(req)             — la IP del cliente, para el rate limit
// ============================================================================

// El cuerpo más grande que se acepta en un endpoint de JSON. 64 KB son
// desbordados para un login o un perfil, y el único endpoint que manda algo
// grande es el del CV (paso 6), que va por otro camino: multipart, con su propio
// límite y su validación de MIME. Poner el límite acá evita que un `POST` con
// un body de 50 MB lo lea entero en memoria antes de que nadie lo mire.
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

// ── Errores tipados ──────────────────────────────────────────────────────────

/**
 * Un error que se puede mostrar al cliente tal cual, con su código HTTP.
 *
 * Existe para que los handlers tiren `throw new HttpError(403, '...')` en vez de
 * tener que montar la respuesta a mano y acordarse del `return` en cada rama.
 * El mensaje es siempre algo escrito por nosotros: nunca se manda el `message` de
 * un error ajeno (ver `withErrorHandling`), así que no hay riesgo de filtrar un
 * detalle interno por accidente.
 */
export class HttpError extends Error {
  /**
   * @param {number} status Código HTTP (400, 401, 403, 409, 413, 429...).
   * @param {string} message Mensaje para el cliente, en español y en segunda persona.
   * @param {object} [extra] Campos extra del JSON de respuesta (`profileComplete`,
   *   `retryAfter`, etc.). Se copia plano: no se anida.
   * @param {object} [headers] Headers HTTP extra de la respuesta. Existe para el
   *   `Retry-After` del 429: es el único caso del proyecto que necesita un header,
   *   y va aparte de `extra` a propósito, porque un campo del JSON no es lo mismo
   *   que un header (ver el comentario de `withErrorHandling`).
   */
  constructor(status, message, extra = {}, headers = {}) {
    super(message);
    this.name = 'HttpError';
    // ↑ ESTE CHEQUEO EXISTE POR UN BUG REAL. `new HttpError('La clave es corta')`
    //   con un solo argumento no tira nada: el string del mensaje se guarda como
    //   `status`, y la respuesta sale con un status que es una frase en español.
    //   Se vio en la verificación de este mismo paso (la respuesta literal fue
    //   `status: La clave tiene que tener al menos 8 caracteres.`) y es la clase
    //   de defecto más silenciosa posible: el endpoint "responde", el cuerpo trae
    //   el mensaje correcto, y lo único raro es un status que ningún cliente
    //   entiende. Acá se vuelve un error de desarrollo ruidoso y localizado.
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new TypeError(
        `HttpError necesita un código HTTP como primer argumento, y recibió ${JSON.stringify(status)}. `
        + 'El mensaje va segundo: new HttpError(400, "...").',
      );
    }
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}

/**
 * Error de CONFIGURACIÓN: falta una variable de entorno, o es demasiado corta.
 *
 * Es una clase aparte y no un `HttpError` porque la respuesta NO es la misma: un
 * `HttpError` es una decisión de negocio (el correo no existe), y esto es el
 * deploy roto. El mensaje se manda igual al cliente porque no contiene ningún
 * secreto —solo dice qué variable falta y cómo generarla— y mandarlo es lo que
 * convierte un `TypeError: undefined is not a valid key length` en algo que se
 * arregla en treinta segundos.
 */
export class ConfigError extends Error {
  /**
   * @param {string} message Qué falta y qué hacer al respecto.
   */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ── Respuesta ────────────────────────────────────────────────────────────────

/**
 * Manda una respuesta JSON.
 *
 * `Cache-Control: no-store` va SIEMPRE, no solo en las respuestas con datos
 * personales. La razón es que `/api/me` devuelve algo distinto según la cookie,
 * y cualquier caché en el medio —el CDN de Vercel incluido— que guarde un 200
 * lo publicaría a cualquiera. `no-store` le dice que no guarde nada, y `no-cache`
 * solo no alcanza: obliga a revalidar, y un 200 revalidado sin `ETag` igual se
 * sirve desde caché.
 *
 * @param {import('node:http').ServerResponse} res Respuesta.
 * @param {number} status Código HTTP.
 * @param {object} payload Cuerpo; se serializa con JSON.stringify.
 * @param {Record<string, string|number|string[]>} [headers] Cabeceras extra.
 * @returns {import('node:http').ServerResponse} La misma `res`, para encadenar.
 */
export function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload === undefined ? {} : payload);
  // ↑ `JSON.stringify` devuelve `undefined` si le pasás `undefined`, y `res.end(undefined)`
  //   manda un body vacío con un Content-Type que dice que hay JSON. Un body
  //   vacío con `application/json` hace que `res.json()` del otro lado reviente.

  // Vercel's ServerResponse puede no tener writeHead. Usamos la API estándar
  // de Node.js http.ServerResponse: statusCode + setHeader + end.
  // Esto funciona tanto en Node nativo como en Vercel.
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(body);
  return res;
}

// ── Body ─────────────────────────────────────────────────────────────────────

/**
 * Convierte texto a objeto, o falla con un 400 entendible.
 * @param {string} raw Texto que debería ser JSON.
 * @returns {object} El objeto parseado.
 * @throws {HttpError} 400 si no es JSON válido o si no es un objeto.
 */
function parseJsonObject(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // ↑ 400 y no 500: un body roto es un error DEL CLIENTE, y responderle con un
    //   500 hace que cualquier monitoreo lo cuente como caída del backend. El
    //   caso real es un `fetch` que se cortó a mitad o un proxy que mandó HTML.
    throw new HttpError(400, 'El cuerpo de la petición no es JSON válido.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // ↑ Un array o un `"hola"` parsean bien pero no es el contrato de ningún
    //   endpoint: lo que viene después sería `body.email` sobre un array (undefined)
    //   o sobre un string (undefined), y el error real ("falta el correo") se
    //   pierde detrás de un mensaje de JSON.
    throw new HttpError(400, 'El cuerpo de la petición tiene que ser un objeto JSON.');
  }
  return parsed;
}

/**
 * Lee el body de la petición como objeto JSON.
 *
 * Hay TRES caminos y existen los tres porque el runtime no es siempre el mismo:
 *   1. `req.body` ya viene parseado —es lo que hace el runtime de Vercel para
 *      `Content-Type: application/json`— y es el camino normal.
 *   2. `req.body` viene como string o Buffer, que es lo que pasa con otros
 *      `Content-Type` y con algunos proxies.
 *   3. No hay body todavía y hay que leer el stream, que es lo que pasa con un
 *      servidor `node:http` pelado (los tests de este repo lo usan).
 *
 * Los tres terminan en el mismo `parseJsonObject`, así que el cuerpo inválido
 * produce el mismo 400 sin importar por dónde haya entrado.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @param {object} [opts]
 * @param {number} [opts.limitBytes] Tope del body. Default 64 KB.
 * @returns {Promise<object>} El body parseado. `{}` si no vino nada.
 * @throws {HttpError} 400 por JSON inválido o cuerpo que no es objeto, 413 si
 *   el body supera el tope.
 */
export async function readJsonBody(req, { limitBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  // Camino 1 y 2: el body ya está en memoria.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (!raw.trim()) return {};
    return parseJsonObject(raw);
  }

  // Camino 3: leer el stream. Se corta apenas se pasa del tope, sin Buffer.concat
  // de todo lo que vino: el objetivo es no gastar 50 MB de memoria por un body
  // de 50 MB que además vamos a rechazar.
  if (typeof req[Symbol.asyncIterator] !== 'function') return {};
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new HttpError(413, 'El cuerpo de la petición es demasiado grande.');
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return parseJsonObject(raw);
}

// ── Cookies ──────────────────────────────────────────────────────────────────

/**
 * Parsea el header `Cookie` en un objeto plano.
 *
 * Se escribe a mano y no se usa el paquete `cookie` a propósito: son ocho
 * líneas, y `cookie` sería una dependencia de runtime para algo que no se va a
 * usar en ningún otro lado del proyecto.
 *
 * Dos detalles que hacen que un parser ingenuo falle:
 *   · `decodeURIComponent` puede tirar `URIError` con un valor mal escapado. Con
 *     `try/catch` el valor crudo se usa igual: una cookie corrupta tiene que ser
 *     "no hay cookie" (401), no un 500.
 *   · El `split('=')` tiene que ser de a DOS: un token firmado de esta app
 *     contiene puntos y puede llegar a contener un `=` al final (padding de
 *     base64). Un `split('=')` sin límite parte el valor en dos y la firma nunca
 *     va a coincidir — un 401 eterno que parece un problema de `SESSION_SECRET`.
 * @param {string|undefined|null} header Valor del header `Cookie`.
 * @returns {Record<string, string>} Nombre → valor, sin decodificar espacios extra.
 */
export function parseCookies(header) {
  const out = {};
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;                    // sin `=` (o con `=` en la posición 0): no es una cookie
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Una cookie del request, o `null` si no está.
 * @param {import('node:http').IncomingMessage} req Petición.
 * @param {string} name Nombre de la cookie.
 * @returns {string|null} El valor crudo (ya decodificado) o `null`.
 */
export function getCookieValue(req, name) {
  const headers = (req && req.headers) || {};
  // ↑ `req.headers` se lee con `||` porque un `req` falso de un test, o el req de
  //   un 404 de Vercel, pueden no tenerlos. Tirar acá sería un 500 por un detalle.
  const jar = parseCookies(headers.cookie);
  const value = jar[name];
  return value === undefined || value === '' ? null : value;
}

// ── IP ───────────────────────────────────────────────────────────────────────

/**
 * La IP del cliente, para el rate limit del login.
 *
 * El orden de los headers NO es arbitrario: `x-vercel-forwarded-for` y
 * `x-real-ip` los pone el edge de Vercel y no los toca el cliente;
 * `x-forwarded-for` es el último recurso y es el ÚNICO que un cliente puede
 * mandar por su cuenta. El de la izquierda del `x-forwarded-for` es el que
 * ve el primer proxy de la cadena, así que si algún día se pone un CDN adelante
 * sin que sobreescriba el header, el atacante elige su propia IP y se lleva por
 * delante la capa "por IP" del rate limit (la de "correo + IP" sigue valiendo).
 * Está anotado en `migrations/009_login_attempts.sql` y en el rate limit.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {string} La IP, o `'desconocida'` si no hay ninguna.
 */
export function clientIp(req) {
  const headers = (req && req.headers) || {};
  const candidatos = [
    headers['x-vercel-forwarded-for'],
    headers['x-real-ip'],
    headers['x-forwarded-for'],
  ];
  for (const raw of candidatos) {
    const primero = String(raw || '').split(',')[0].trim();
    if (primero) return primero;
  }
  // ↑ Un centinela y no `''`: con `''` todos los clientes sin IP caerían en el
  //   MISMO bucket y se bloquearían entre ellos, que es un denial of service
  //   caused por no tener un dato. En Vercel siempre hay alguno de los tres.
  return 'desconocida';
}

// ── El wrapper de los handlers ───────────────────────────────────────────────

/**
 * Envuelve un handler y traduce cualquier `throw` a una respuesta HTTP.
 *
 * Es lo que evita que cada endpoint repita el mismo `try/catch` y, más
 * importante, lo que garantiza la regla de oro de este archivo: **el `message`
 * de un error que NO es nuestro nunca sale del servidor**. Un `HttpError` y un
 * `ConfigError` tienen mensajes escritos a mano y salen; cualquier otra cosa
 * (un error de `pg`, un `TypeError`) se responde con un 500 genérico y el
 * detalle real va al log. Al revés, la función tiene que poder decir algo.
 *
 * @template {import('node:http').IncomingMessage} Req
 * @template {import('node:http').ServerResponse} Res
 * @param {(req: Req, res: Res) => Promise<void>|void} handler El handler.
 * @returns {(req: Req, res: Res) => Promise<void>} El handler con manejo de errores.
 */
export function withErrorHandling(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        // ↑ `err.headers` va aparte del cuerpo a propósito. El `Retry-After` del
        //   429 (RFC 6585) lo leen clientes y proxies que no parsean el JSON: si
        //   solo estuviera en el body, un cliente que sí lo respeta vería un 429
        //   sin ningún header y reintentaría a ciegas. El `retryAfterSeconds` del
        //   body se mantiene porque es lo que consume el frontend.
        sendJson(res, err.status, { error: err.message, ...err.extra }, err.headers);
        return;
      }
      if (err instanceof ConfigError) {
        // 500 a propósito: es el deploy roto, y un 4xx haría que un test de humo
        // que solo mira "no es 5xx" lo diera por bueno.
        console.error('[config] %s', err.message);
        sendJson(res, 500, { error: err.message });
        return;
      }
      // ↑ El error crudo SOLO al log. Mandarlo en la respuesta sirve para darle
      //   al atacante el nombre de la tabla, la columna o la versión de Node.
      console.error('[error] %s', (err && err.stack) || err);
      sendJson(res, 500, { error: 'Error interno del servidor.' });
    }
  };
}
