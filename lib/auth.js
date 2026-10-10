// Build timestamp: 2026-10-04T22:00:00Z
// ============================================================================
// AUTENTICACIÓN: hash de contraseñas, cookie de sesión y las DOS compuertas.
//
// Este archivo responde a la pregunta "¿quién es el que está llamando?" y es la
// mitad de la historia del paso 5. La otra mitad son los endpoints de `api/`.
//
// ── POR QUÉ SON DOS COMPUERTAS Y NO UNA ───────────────────────────────────────
// El alta de este proyecto es en DOS ETAPAS (MEMORIA.md §4.1):
//
//   1. POST /api/register (correo + clave) ──► fila en `users` + cookie
//   2. el usuario YA está adentro, pero NO tiene perfil todavía
//   3. sube el CV ──► POST /api/cv/parse ──► LLM          (paso 6)
//   4. formulario de revisión/edición
//   5. POST /api/profile ──► escribe `profiles` + `skills`  (paso 7)
//   6. recién acá se habilita el resto de la app
//
// O sea que `users` tiene que poder existir SIN fila en `profiles`, y por eso el
// código de respuesta NO es uno sino tres:
//
//   | Situación                 | Código | Qué tiene que pasar          |
//   |---------------------------|--------|------------------------------|
//   | Sin cookie válida         |  401   | redirigir a /login           |
//   | Con cookie, SIN perfil    |  403   | redirigir al onboarding del CV|
//   | Con cookie y perfil       |  200   | la app normal                |
//
// Que los endpoints que necesitan perfil devuelvan **403 y no 401** no es un
// detalle: la SESIÓN existe, lo que falta es el CV. Un 401 ahí manda al usuario
// a la pantalla de login, el login lo devuelve a la app, la app le pide el
// CV... y el usuario queda dando vueltas en un bucle que no termina nunca. El
// frontend decide a dónde mandarlo mirando `profileComplete` del 403, no el
// código 401.
//
// La única excepción es `GET /api/me`: devuelve 200 con `profileComplete: false`
// cuando no hay perfil, porque `/api/me` es el que CONSULTA el estado, no el que
// lo exige. Si devolviera 403, el frontend no tendría forma de preguntarle a la
// app "¿a dónde me mandás?".
//
// ── POR QUÉ NO HAY TABLA DE SESIONES ──────────────────────────────────────────
// El esquema no tiene `sessions` y no se agrega. La cookie es un token firmado y
// autocontenido: `v1.<user_id>.<expiración>.<HMAC-SHA256>`. Es lo correcto en
// serverless, donde una tabla de sesiones obliga a escribir en CADA request (un
// `UPDATE` de "último uso" por request) y a que la fila sobreviva al modelo de
// invocaciones, que no comparte memoria ni disco entre requests. Con el token
// firmado, verificar la sesión es una operación de CPU: cero queries, cero
// escrituras, y sobrevive a que la función se apague.
//
// El precio de esa decisión, que queda escrito para que nadie lo descubra
// después: **no hay logout en el servidor**. `POST /api/logout` borra la cookie
// del navegador, pero si alguien copió el valor del token, ese token sigue
// valiendo hasta que expire. Por eso la duración por defecto son 7 días y no 30
// (ver `SESSION_TTL_DAYS`). Cuando haga falta revocar de verdad, la respuesta
// NO es una tabla de sesiones ni un `session_version` en `users`: es que la fila
// de `users` deje de existir o de servir, porque `requireSession` la consulta en
// CADA request. Ese select es lo que hace que una cookie de un usuario dado de
// baja (`DELETE /api/account`, paso 11) dé 401 sin tocar ningún otro estado.
//
// ── LO QUE ESTE MÓDULO NO HACE ───────────────────────────────────────────────
// No crea el perfil. El perfil se escribe en el paso 6/7, después de que el
// usuario suba el CV. Cualquier cosa que contemple lo contrario rompe el diseño
// del alta en dos etapas.
// Build timestamp: 2026-10-04T22:00:00Z`n// ============================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';

import { query } from './db.js';
import { ConfigError, HttpError, clientIp, getCookieValue } from './http.js';

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ════════════════════════════════════════════════════════════════════════════

// Nombre de la cookie. El prefijo evita colisiones con cookies del mismo dominio
// si algún día el proyecto comparte host con otra app.
export const SESSION_COOKIE = 'bei_session';

// Versión del formato del token, adelante de todo.
//
// Existe por un motivo concreto: cuando haya que cambiar el formato (agregar un
// campo, cambiar el algoritmo) NO se cambia la función sino que se sube la
// versión. Los tokens viejos siguen validando con la versión vieja hasta que
// expiren, y el despliegue no rompe las sesiones abiertas. Sin la versión,
// cambiar el formato dejaría en 401 a todo el mundo de golpe.
const TOKEN_VERSION = 'v1';

// Largo mínimo de `SESSION_SECRET`, en caracteres.
//
// 32 es el número que sale de `randomBytes(32).toString('hex')`, que es lo que
// dice `.env.example`. Menos de eso no es "menos seguro": es que la clave se
// puede adivinar, y una `SESSION_SECRET` adivinada permite FORJAR la cookie de
// cualquier usuario sin tocar la base (no hace falta robarle la clave a nadie,
// alcanza con inventarse un `user_id`). Es el peor fallo posible de este módulo,
// así que se verifica antes de firmar nada y no con un warning.
const MIN_SECRET_LENGTH = 32;

// Días que dura una sesión si no se configura otra cosa. Ver la nota de arriba
// sobre por qué no hay tabla de sesiones: sin revocación, el TTL ES la ventana
// de exposición de un token robado. 7 días es un compromiso entre hacer que el
// usuario entre una vez por semana y dejar un token vivo lo más corto posible.
const DEFAULT_TTL_DAYS = 7;

// Costo de bcrypt.
//
// 10 es el default a propósito y NO es el de OWASP: `bcryptjs` es JS puro
// (elegido en MEMORIA.md §2.2 porque los binarios nativos fallan en runtime en
// Vercel) y calcula entre 3 y 4 veces más lento que el bcrypt nativo, así que el
// 12 recomendado costaría más del doble de tiempo de CPU por login. Con 10,
// un login anda cómodo dentro de `maxDuration: 30` y el costo sigue siendo
// suficiente para que un ataque offline contra los hashes sea caro. Si algún día
// se cambia a `@node-rs/argon2` (nativo), el número a subir es otro.
const DEFAULT_BCRYPT_ROUNDS = 10;
const MIN_BCRYPT_ROUNDS = 10;
const MAX_BCRYPT_ROUNDS = 14;

// Largo mínimo y máximo de la clave, en BYTES.
//
// El máximo NO es un capricho: bcrypt trunca la clave en 72 bytes y lo hace en
// silencio. Sin este chequeo, "mi clave larga con un sufijo" y "la misma clave
// sin el sufijo" serían EL MISMO hash, y nadie se enteraría nunca. Rechazar es
// más honesto que aceptar un límite invisible.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_BYTES = 72;

// Hash bcrypt de costo 10 que NO corresponde a ninguna cuenta. Se usa para
// comparar cuando el correo no existe, y el motivo está en `dummyHash()`: si el
// login sin usuario saliera 10 veces más rápido que el login con usuario,
// cualquiera podría enumerar las cuentas midiendo cuánto tarda la respuesta.
//
// ▲ ESTE ES EL ÚNICO LUGAR DEL PROYECTO DONDE EL COSTO DE BCRYPT ESTÁ ESCRITO
//   DOS VECES. Si algún día se sube `BCRYPT_ROUNDS` a 12, este hash tiene que
//   regenerarse con ese costo o el timing del caso "correo inexistente" va a
//   delatar que la cuenta no existe otra vez, pero al revés. No es un detalle
//   teórico: es exactamente el agujero que este archivo existe para tapar.
const DUMMY_HASH = '$2a$10$yYX5hFuhzuEdasrhnYybgewhpIAVMda2WKgR/QtpG84f3Mo8uC4yq';

// Forma de un correo. NO es RFC 5322 y no pretende serlo: es un chequeo de
// sentido que separa "se olvidó el campo" de "escribió cualquier cosa" y que
// evita guardar basura en `users.email`. La validación de verdad es que el
// correo llegue, y eso no lo verifica un regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Un uuid v4 tal como lo genera Postgres. `requireSession` lo valida ANTES de
// mandar el valor a la base: si por lo que fuera un token bien firmado viniera
// con un `user_id` que no es un uuid, la query revienta con `22P02 invalid input
// syntax for type uuid`, que es un 500. Con el chequeo, es un 401. La cookie
// sigue sin poder falsearse sin el secreto, pero no hace falta que la
// robustez dependa de eso.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Mensajes ─────────────────────────────────────────────────────────────────

// Lo que se responde cuando no hay cookie, cuando la cookie no valió o cuando la
// cookie es de un usuario que ya no existe. UN SOLO mensaje para los tres casos
// a propósito: si "tu sesión venció" y "tu sesión no existe" tuvieran textos
// distintos, un atacante que fabricó un token al azar sabría qué probó.
const UNAUTHORIZED = 'Necesitás iniciar sesión.';

// Lo que se responde cuando hay sesión pero todavía no hay perfil. Dice
// explícitamente que la sesión está bien: el frontend usa esto para llevar al
// onboarding del CV y NO para el login.
const PROFILE_MISSING = 'Te falta completar tu perfil: subí tu CV para empezar.';

// ════════════════════════════════════════════════════════════════════════════
// VARIABLES DE ENTORNO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Lee un entero de una variable de entorno con default y rango.
 * @param {string} name Nombre de la variable.
 * @param {number} fallback Default si no está o no es válida.
 * @param {number} min Mínimo aceptable.
 * @param {number} max Máximo aceptable.
 * @returns {number} El valor usable.
 */
function intFromEnv(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(raw) || raw < min || raw > max) return fallback;
  return raw;
}

/**
 * El secreto de firma, verificado.
 *
 * Se verifica en CADA llamada y no una vez al importar el módulo, por dos
 * razones: (1) `SESSION_SECRET` es lo primero que cambia cuando alguien rota
 * secretos, y cachearlo haría que el cambio no se viera hasta el cold start
 * siguiente; (2) si la validación fuera al importar el módulo, `login.js` y
 * `me.js` reventarían AL CARGAR, que en Vercel es un 502 con página de error y
 * no el mensaje que dice qué hacer.
 *
 * @returns {string} El secreto.
 * @throws {ConfigError} Si falta o es demasiado corto.
 */
function secret() {
  const raw = process.env.SESSION_SECRET || '';
  if (!raw.trim()) {
    throw new ConfigError(
      'Falta SESSION_SECRET: sin ella no se puede firmar la cookie de sesión.\n'
      + '  · Local: copiá .env.example a .env y pegá el valor.\n'
      + '    Generalo con:\n'
      + '      node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n'
      + '  · Vercel: Settings > Environment Variables > SESSION_SECRET.\n'
      + 'OJO: rotarla invalida TODAS las sesiones abiertas de todos los usuarios.\n'
      + 'Nunca la mandes desde el cliente ni la commitees: es una credencial.',
    );
  }
  if (raw.length < MIN_SECRET_LENGTH) {
    throw new ConfigError(
      `SESSION_SECRET es demasiado corta: ${raw.length} caracteres, y hacen falta ${MIN_SECRET_LENGTH}.\n`
      + '  Con una clave corta, alguien que la adivine puede FORJAR la cookie de\n'
      + '  cualquier usuario sin necesitar la contraseña de nadie. No es un\n'
      + '  problema de robustez, es un agujero.\n'
      + '  Generá una de 32 bytes (64 caracteres hex) con:\n'
      + '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return raw;
}

/**
 * Cuántos segundos dura una sesión recién creada.
 * @returns {number} Segundos, siempre > 0.
 */
function ttlSeconds() {
  const days = intFromEnv('SESSION_TTL_DAYS', DEFAULT_TTL_DAYS, 1, 365);
  return days * 24 * 60 * 60;
}

/**
 * El costo de bcrypt de esta corrida.
 * @returns {number} Rounds, entre MIN_BCRYPT_ROUNDS y MAX_BCRYPT_ROUNDS.
 */
function rounds() {
  return intFromEnv('BCRYPT_ROUNDS', DEFAULT_BCRYPT_ROUNDS, MIN_BCRYPT_ROUNDS, MAX_BCRYPT_ROUNDS);
}

// ════════════════════════════════════════════════════════════════════════════
// CORREO Y CONTRASEÑA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Normaliza un correo a minúsculas.
 *
 * `users.email` es `text` con UNIQUE y **no hay extensión `citext`**: la
 * comparación de Postgres distingue mayúsculas, así que `Ada@x.com` y
 * `ada@x.com` serían dos cuentas distintas con la misma casilla. Bajar a
 * minúsculas es responsabilidad de la aplicación y se hace SIEMPRE en el borde,
 * antes de tocar la base: en el INSERT y en cada SELECT de login. Si se hiciera
 * en un solo lado, el login de la otra forma de escribir el correo no encontraría
 * la fila.
 *
 * El `trim()` va antes del `toLowerCase()` y no al revés, por un detalle de
 * Unicode que se nota justo con los correos: hay caracteres de espacio (U+00A0,
 * el "no-break space") que `.trim()` sí saca pero que un pegado desde un celu a
 * veces deja. Es un detalle; la razón de hacerlo en este orden es que el valor
 * que se compara con la base tiene que ser el MISMO que se comparó al guardar.
 *
 * @param {unknown} value Lo que venga del body.
 * @returns {string} El correo normalizado, o `''` si no había.
 */
export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Valida correo y clave de una alta o un login.
 *
 * Se usa en `register` (que es donde la clave se elige) y también en `login`
 * (donde no se elige nada): los MISMOS mensajes, porque si el login aceptara
 * una clave de 3 caracteres y el registro no, el usuario descubriría la regla
 * recién después de haber elegido la clave.
 *
 * @param {object} body Body ya parseado.
 * @returns {{email: string, password: string}} Los dos campos, ya normalizados.
 * @throws {HttpError} 400 con el mensaje concreto de lo que falta.
 */
export function readCredentials(body) {
  const email = normalizeEmail(body && body.email);
  const password = typeof (body && body.password) === 'string' ? body.password : '';

  if (!email || !password) {
    throw new HttpError(400, 'Necesitás el correo y la clave.');
  }
  if (email.length > 254) {
    // 254 es el máximo de la RFC 5321. Más que eso no es un correo, es un
    // `text` gigante en una columna con índice único.
    throw new HttpError(400, 'El correo es demasiado largo.');
  }
  if (!EMAIL_RE.test(email)) {
    throw new HttpError(400, 'El correo no parece una dirección válida.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    // ↑ Se cuenta en CARACTERES y el máximo en BYTES, a propósito: los dos son
    //   el número que le importa a quien lee el mensaje, y los dos tienen
    //   tamaños distintos que importan (bcrypt trunca por bytes, no por
    //   caracteres: 'ñ' ocupa 2 bytes en UTF-8).
    throw new HttpError(
      400,
      `La clave tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    );
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new HttpError(
      400,
      `La clave no puede tener más de ${MAX_PASSWORD_BYTES} bytes. `
      + 'Es el límite de bcrypt: a partir de ahí los caracteres sobrantes se '
      + 'ignoran y no cuentan como parte de la clave.',
    );
  }
  return { email, password };
}

/**
 * Hashea una clave.
 * @param {string} plain La clave en claro. No se guarda ni se loguea nunca.
 * @returns {Promise<string>} El hash bcrypt, listo para `users.password_hash`.
 */
export function hashPassword(plain) {
  return bcrypt.hash(plain, rounds());
}

/**
 * Compara una clave con su hash.
 *
 * El `catch` no es decorativo: un `password_hash` corrupto en la base (una
 * migración a medio aplicar, un restore de un backup viejo) hace que `bcrypt`
 * tire, y sin esto un solo registro roto le devuelve un 500 a su dueño con un
 * mensaje de stack. Lo que tiene que pasar es que ese login NO entre, y punto.
 *
 * @param {string} plain La clave que escribió el usuario.
 * @param {string|null|undefined} hash El hash guardado, o `null` si no hay usuario.
 * @returns {Promise<boolean>} Si coinciden.
 */
export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * El hash contra el que se compara cuando el correo NO existe.
 *
 * Existe para que el tiempo de respuesta no dependa de si la cuenta existe. Sin
 * esto, `POST /api/login` con un correo inventado responde en 2 ms y con un
 * correo real en 400 ms, y con esa diferencia cualquiera puede enumerar las cuentas
 * de la plataforma probando correos y midiendo. Es el mismo motivo por el que el
 * mensaje de error es idéntico en los dos casos: si el mensaje es el mismo pero
 * el tiempo no, el mensaje igual no protege nada.
 *
 * Se compara contra el MISMO costo que usa `hashPassword`, para que la
 * alternativa sea compararlo con `null` (que es instantáneo) y volver al mismo
 * problema. Por eso el hash es de costo 10 y no de 12: si se sube
 * `BCRYPT_ROUNDS` hay que regenerarlo, y está anotado acá.
 *
 * @returns {Promise<string>} Un hash bcrypt de costo 10.
 */
export function dummyHash() {
  return DUMMY_HASH;
}

// ════════════════════════════════════════════════════════════════════════════
// EL TOKEN DE SESIÓN
// ════════════════════════════════════════════════════════════════════════════

/**
 * Firma una cadena con el secreto de la sesión.
 * @param {string} payload La parte del token que se firma.
 * @returns {string} El HMAC-SHA256 en base64url.
 */
function sign(payload) {
  // ↑ `base64url` y no `base64`: los caracteres `+` y `/` del base64 estándar no
  //   son válidos en una cookie sin escaparlos, y `=` de padding corta el
  //   `split('=')` del parser de cookies. base64url no tiene ninguno de los dos.
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * Compara dos cadenas en tiempo constante, sin tirar si difieren de largo.
 *
 * LA TRAMPA: `crypto.timingSafeEqual(a, b)` **tira** `TypeError` si los dos
 * buffers tienen distinto largo, en vez de devolver `false`. Como el largo de
  * la firma se lee de la cookie que envió el cliente, un atacante puede cortarlo
 * a propósito y obtener un 500 en lugar de un 401 — o, peor, si alguien lo
 * envolvió en un try/catch mal hecho, una ruta de código distinta. Por eso el
 * largo se compara ANTES, y en el camino de "largo distinto" se hace igual una
 * comparación real contra un buffer del mismo tamaño: así el tiempo gastado no
 * depende de por dónde se cayó la validación.
 *
 * @param {string} a Valor recibido.
 * @param {string} b Valor esperado.
 * @returns {boolean} Si son iguales.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);   // ←no compara nada: solo quema el mismo tiempo
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Arma un token de sesión para un usuario.
 *
 * El token es `v1.<user_id>.<exp>.<firma>` y se firma TODO lo anterior a la firma,
 * incluida la expiración. Es decir que la expiración no es una promesa del
 * servidor: si alguien pudiera cambiarla, la firma no verificaría. Por eso la
 * fecha va ADEMÁS en la cookie, y por eso el servidor la vuelve a mirar.
 *
 * @param {string} userId UUID del usuario.
 * @returns {{token: string, expiresAt: number, ttlSeconds: number}} El token y
 *   los datos para armar la cookie.
 */
export function createSessionToken(userId) {
  const seconds = ttlSeconds();
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const payload = `${TOKEN_VERSION}.${userId}.${exp}`;
  return {
    token: `${payload}.${sign(payload)}`,
    expiresAt: exp,
    ttlSeconds: seconds,
  };
}

/**
 * Verifica un token y devuelve su contenido.
 *
 * Verifica TRES cosas y en este orden: que tenga la forma, que la firma sea
 * nuestra, y que no haya vencido. El orden importa para el timing: la firma se
 * compara SIEMPRE (aunque el token ya esté vencido), así que el tiempo de
 * respuesta no revela si el token era válido y lo que solo estaba vencido.
 *
 * @param {string|null|undefined} token El valor crudo de la cookie.
 * @returns {{userId: string, expiresAt: number}} Contenido del token.
 * @throws {HttpError} 401 si el token no sirve para nada.
 */
export function verifySessionToken(token) {
  const crudo = typeof token === 'string' ? token : '';
  const partes = crudo.split('.');
  // 4 partes y no "al menos": un token con un punto de más tiene que ser inválido,
  // y un `slice(0, 4)` lo aceptaría.
  if (partes.length !== 4) throw new HttpError(401, UNAUTHORIZED);

  const [version, userId, expRaw, firma] = partes;
  if (version !== TOKEN_VERSION || !UUID_RE.test(userId)) throw new HttpError(401, UNAUTHORIZED);

  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp <= 0) throw new HttpError(401, UNAUTHORIZED);

  // La firma se calcula con los MISMOS campos que venía, no con los ya
  // normalizados: si `userId` viniera con mayúsculas y se firmara con la versión
  // en minúscula, la comparación fallaría siempre.
  const esperada = sign(`${version}.${userId}.${expRaw}`);
  if (!safeEqual(firma, esperada)) throw new HttpError(401, UNAUTHORIZED);

  if (exp <= Math.floor(Date.now() / 1000)) throw new HttpError(401, UNAUTHORIZED);

  return { userId, expiresAt: exp };
}

// ════════════════════════════════════════════════════════════════════════════
// LA COOKIE
// ════════════════════════════════════════════════════════════════════════════

/**
 * ¿La cookie de sesión va con `Secure`?
 *
 * `Secure` SÍ, siempre, y es lo que hace que la cookie NO viaje por HTTP en
 * claro: sin eso, cualquiera en la misma red (un café, un hotel) que vea el
 * tráfico puede leer la sesión completa de un usuario y usarla como si fuera
 * él. En producción no hay excepción.
 *
 * La excepción es LOCAL y es a propósito: un navegador IGNORA una cookie `Secure`
 * que llega por `http://`, así que con `Secure` fijo la prueba local del login
 * no funcionaría nunca y el error que se ve ("no se guarda la cookie") no dice
 * nada de por qué. Por eso se afloja SOLO cuando el pedido llegó por HTTP plano a
 * un host de loopback: en `vercel dev` o en `localhost`, y en ningún otro lado.
 *
 * `SESSION_COOKIE_SECURE=0` fuerza el apagado y `=1` lo fuerza, para cuando hay
 * un proxy raro adelante que hay que acomodar.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {boolean} Si va con `Secure`.
 */
export function shouldUseSecureCookie(req) {
  const forzado = process.env.SESSION_COOKIE_SECURE;
  if (forzado === '0') return false;
  if (forzado === '1') return true;
  const headers = (req && req.headers) || {};
  const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return true;
  if (proto && proto !== 'http') return true;   // Unknown pero no plano: assume TLS
  const host = String(headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const esLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  return !esLoopback;
}

/**
 * Arma el valor del header `Set-Cookie` de la sesión.
 *
 * Los cuatro atributos, y por qué cada uno:
 *   · `HttpOnly` — el JavaScript de la página no puede leer la cookie. Es lo que
 *     hace que un XSS no se lleve la sesión: el token está en el navegador pero
 *     fuera del alcance del script de la página.
 *   · `Secure` — solo por HTTPS. Ver `shouldUseSecureCookie()`.
 *   · `SameSite=Lax` — el navegador NO manda la cookie en pedidos que vienen de
 *     otro sitio (un formulario o un `fetch` cross-site), así que es la
 *     protección CSRF que tiene este proyecto. Se usa `Lax` y no `Strict` por un
 *     motivo concreto: `Strict` tampoco manda la cookie en la navegación
 *     "pegar un link de la app en un mail y tocarlo", y el usuario llegaría
 *     logged-out sin entender por qué. `Lax` sí la manda en una navegación de
 *     nivel superior, que es el caso legitimo, y la bloquea en todo lo demás.
 *   · `Path=/` — sin esto la cookie solo viaja a `/api`, y ninguna navegación
 *     del SPA la vería. Es más amplia de lo que parece, y es lo correcto: la
 *     cookie no lleva nada que solo sirva para la API.
 *
 * `Max-Age` Y `Expires` van los dos: algunos clientes (y algunos bots) miran uno
 * y otros el otro, y la cookie tiene que morir en el servidor y en el navegador.
 * `Max-Age` en SEGUNDOS es relativo y no depende del reloj del cliente;
 * `Expires` es una fecha absoluta que el navegador puede usar para limpiar antes.
 *
 * @param {import('node:http').IncomingMessage} req Petición, para decidir `Secure`.
 * @param {string} token El token ya firmado.
 * @param {number} maxAgeSeconds Segundos de vida.
 * @param {number} expiresAt Epoch en SEGUNDOS (no en milisegundos).
 * @returns {string} El valor para `Set-Cookie`.
 */
export function buildSessionCookie(req, token, maxAgeSeconds, expiresAt) {
  const partes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    `Expires=${new Date(expiresAt * 1000).toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (shouldUseSecureCookie(req)) partes.push('Secure');
  return partes.join('; ');
}

/**
 * Arma el `Set-Cookie` que BORRA la sesión.
 *
 * Para borrar una cookie hay que mandarla otra vez con el MISMO nombre y el
 * mismo `Path`, y con `Max-Age=0` y un `Expires` en el pasado. Los atributos
 * `HttpOnly`/`Secure`/`SameSite` no hacen falta para borrarla (el navegador
 * identifica la cookie por nombre+path), pero se mandan igual: si algún día
 * cambia el `Secure` según el protocolo, la cookie vieja podría quedar viva con
 * atributos distintos de los que tiene la nueva, y mandarlos iguales evita ese
 * caso.
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {string} El valor para `Set-Cookie`.
 */
export function buildClearSessionCookie(req) {
  const partes = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (shouldUseSecureCookie(req)) partes.push('Secure');
  return partes.join('; ');
}

/**
 * Deja al usuario con sesión: firma el token y manda la cookie.
 *
 * `appendHeader` y no `setHeader` porque `Set-Cookie` es la ÚNICA cabecera que se
 * puede repetir: si algún día un endpoint manda dos cookies (por ejemplo, una de
 * "la sesión cambió"), con `setHeader` la segunda pisa a la primera y el usuario
 * se queda logged-out sin explicación.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @param {import('node:http').ServerResponse} res Respuesta.
 * @param {string} userId UUID del usuario.
 * @returns {{expiresAt: number, ttlSeconds: number}} Datos de la sesión, por si
 *   el endpoint quiere devolverlos.
 */
export function issueSession(req, res, userId) {
  const { token, expiresAt, ttlSeconds: seconds } = createSessionToken(userId);
  res.setHeader('Set-Cookie', buildSessionCookie(req, token, seconds, expiresAt));
  return { expiresAt, ttlSeconds: seconds };
}

/**
 * Borra la cookie de sesión del navegador (estilo Node.js).
 * @param {import('node:http').IncomingMessage} req Petición.
 * @param {import('node:http').ServerResponse} res Respuesta.
 * @returns {void}
 */
export function clearSession(req, res) {
  res.setHeader('Set-Cookie', buildClearSessionCookie(req));
}

/**
 * Crea el valor del header `Set-Cookie` para una nueva sesión (estilo Web Fetch API).
 * No depende de req/res, usa variables de entorno para decidir `Secure`.
 * @param {string} userId UUID del usuario.
 * @returns {string} El valor para `Set-Cookie`.
 */
export function createSessionCookie(userId) {
  const { token, expiresAt, ttlSeconds: seconds } = createSessionToken(userId);
  return buildSessionCookieForFetch(token, seconds, expiresAt);
}

/**
 * Crea el valor del header `Set-Cookie` que BORRA la sesión (estilo Web Fetch API).
 * @returns {string} El valor para `Set-Cookie`.
 */
export function clearSessionCookie() {
  return buildClearSessionCookieForFetch();
}

/**
 * Parsea y valida una cookie de sesión cruda (estilo Web Fetch API).
 * @param {string|null|undefined} cookieValue El valor crudo de la cookie.
 * @returns {{userId: string, expiresAt: number}|null} La sesión si es válida, null si no.
 */
export function parseSessionCookie(cookieValue) {
  try {
    return verifySessionToken(cookieValue);
  } catch {
    return null;
  }
}

/**
 * Arma el `Set-Cookie` de sesión sin depender de req (para Web Fetch API).
 * Usa `SESSION_COOKIE_SECURE` o detecta HTTPS por defecto.
 * @param {string} token El token ya firmado.
 * @param {number} maxAgeSeconds Segundos de vida.
 * @param {number} expiresAt Epoch en SEGUNDOS.
 * @returns {string} El valor para `Set-Cookie`.
 */
function buildSessionCookieForFetch(token, maxAgeSeconds, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    `Expires=${new Date(expiresAt * 1000).toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  // En Web Fetch API no tenemos req, usamos variable de entorno o asumimos HTTPS en prod
  const secure = process.env.SESSION_COOKIE_SECURE === '1' || process.env.VERCEL === '1';
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Arma el `Set-Cookie` que BORRA la sesión sin depender de req.
 * @returns {string} El valor para `Set-Cookie`.
 */
function buildClearSessionCookieForFetch() {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'HttpOnly',
    'SameSite=Lax',
  ];
  const secure = process.env.SESSION_COOKIE_SECURE === '1' || process.env.VERCEL === '1';
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ════════════════════════════════════════════════════════════════════════════
// LAS DOS COMPUERTAS
// ════════════════════════════════════════════════════════════════════════════

/**
 * La forma que ve el cliente. NUNCA el `password_hash`.
 * @param {{id: string, email: string, created_at?: any}} row Fila de `users`.
 * @returns {{id: string, email: string, createdAt: string|null}} El usuario.
 */
export function publicUser(row) {
  // ↑ El `select` de `requireSession` ya pide las columnas una por una, así que
  //   `password_hash` ni siquiera está en memoria acá. El snake_case del
  //   `created_at` se pasa a camelCase porque TODO lo que sale de la API en este
  //   proyecto es camelCase (ver `regions.js` y el `profileComplete`).
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : null,
  };
}

/**
 * PRIMERA COMPUERTA: ¿hay sesión?
 *
 * Hace TRES chequeos, y los tres importan:
 *   1. Que haya cookie.
 *   2. Que la cookie esté bien firmada y no haya vencido (`verifySessionToken`).
 *   3. Que el usuario EXISTA en la base.
 *
 * El tercero es el que se olvida y es carísimo: la cookie es un token firmado
 * válido hasta que expira, así que si el usuario se dio de baja (paso 11) o se
 * lo borró de la base a mano, su cookie seguiría pasando los dos primeros
 * chequeos. Sin esta query, `/api/me` devolvería 200 con datos de un usuario que
  * no existe y todos los endpoints "con sesión" irían a escribir filas con un
 * `user_id` huérfano — que la FK no va a dejar pasar, pero con la historia de
 * errores que produce. Con la query, es un 401 limpio.
 *
 * El `select` pide las columnas una por una y NO usa `select *` a propósito: es la
 * línea de defensa para que el `password_hash` no esté ni en memoria.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {Promise<{user: object, session: {userId: string, expiresAt: number}}>}
 *   El usuario y la sesión.
 * @throws {HttpError} 401 si no hay sesión válida.
 */
export async function requireSession(req) {
  const token = getCookieValue(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, UNAUTHORIZED);

  const session = verifySessionToken(token);

  const { rows } = await query(
    'select id, email, created_at from users where id = $1',
    [session.userId],
  );
  if (!rows[0]) {
    // ↑ Cookie firmada y válida de un usuario que ya no está. 401, no 403: para
    //   el cliente la sesión no sirve, y lo que tiene que hacer es volver al
    //   login. El mensaje es el mismo de siempre a propósito (ver UNAUTHORIZED).
    throw new HttpError(401, UNAUTHORIZED);
  }

  return { user: rows[0], session };
}

/**
 * SEGUNDA COMPUERTA: ¿hay sesión Y perfil?
 *
 * Llama a `requireSession` PRIMERO, así que un usuario sin cookie recibe 401 y
 * uno con cookie pero sin CV recibe 403. Nunca al revés, y nunca 401 para el
 * segundo caso: ver la tabla de arriba.
 *
 * Devuelve user Y profile juntos para que el endpoint NO tenga que consultar dos
 * veces: `requireSession` ya hizo un select de `users` y este hace uno de
 * `profiles`, y el endpoint que llama no necesita ninguno de los dos.
 *
 * EL SHAPE QUE DEVUELVE: `profile` es la fila CRUDO de la tabla `profiles`, con
 * `full_name`, `years_experience`, etc. Convertirla al contrato de la API
 * (camelCase + las `skills` de la tabla `skills`, que viven en otra tabla) es
 * trabajo de `GET /api/profile`, en el paso 7. Acá no se hace a propósito: este
 * módulo es el que decide SI hay perfil, no cómo se ve.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {Promise<{user: object, profile: object}>} El usuario y su perfil.
 * @throws {HttpError} 401 sin sesión, 403 con sesión y sin perfil.
 */
export async function requireProfile(req) {
  const { user } = await requireSession(req);

  const { rows } = await query('select * from profiles where user_id = $1', [user.id]);
  if (!rows[0]) {
    // ↑ 403 y NO 401. La sesión existe y es válida; lo que falta es el CV. El
    //   `profileComplete: false` va en el cuerpo porque el frontend decide a
    //   dónde mandarlo mirando ESA bandera, no el código HTTP.
    throw new HttpError(403, PROFILE_MISSING, { profileComplete: false });
  }

  return { user, profile: rows[0] };
}

/**
 * ¿Este usuario ya tiene perfil?
 *
 * Va aparte de `requireProfile` para el caso de "session sí, perfil no": hay que
 * poder CONTESTAR que no lo tiene (`/api/me` → `profileComplete: false`) sin que
 * eso sea un error. Un `select 1` y no `select *`: la respuesta es un booleano.
 *
 * @param {string} userId UUID del usuario.
 * @returns {Promise<boolean>} Si existe la fila en `profiles`.
 */
export async function hasProfile(userId) {
  const { rows } = await query('select 1 as ok from profiles where user_id = $1', [userId]);
  return rows.length > 0;
}

/**
 * La IP del cliente, reexportada.
 *
 * El rate limit del login la necesita y `lib/rateLimit.js` ya importa de acá.
 * Se reexporta para que un endpoint futuro que quiera loguear la IP no tenga que
 * acordarse de cuál de los dos archivos la trae.
 * @param {import('node:http').IncomingMessage} req Petición.
 * @returns {string} La IP.
 */
export { clientIp };

// Reexportado para que los endpoints no tengan que saber de dónde sale el error
// tipado: los que tiran 401 y 403 son de acá, no de `http.js`.
export { HttpError };
