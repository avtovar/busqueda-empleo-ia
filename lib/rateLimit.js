// ============================================================================
// RATE LIMIT DEL LOGIN, CONTRA LA BASE DE DATOS.
//
// El punto 4 del pedido pide rate limit en `/api/login`: sin él, cualquiera que
// conozca la URL puede probar contraseñas en serio contra una cuenta ajena. Y
// con el historial de contraseñas reutilizadas de la gente, eso no es "una"
// cuenta: es un diccionario entero.
//
// ── POR QUÉ ESTO VIVE EN LA BASE Y NO EN MEMORIA ─────────────────────────────
// En Vercel cada invocación es un proceso distinto. Un `Map` a nivel de módulo
// arranca VACÍO en cada una, así que mil intentos seguidos se reparten entre mil
// procesos que no comparten nada y cada uno ve "primer intento". Un rate limit en
// memoria no limita: se ve que funciona, da sensación de estar y no detiene a
// nadie. La tabla es `login_attempts` (migrations/009), que sí sobrevive.
//
// ── LOS DOS LÍMITES Y POR QUÉ SON DOS ────────────────────────────────────────
// Los números están acá y NO en la tabla, por la misma razón que APIFY_DAILY_LIMIT
// no es una columna (007): cambiarlos tiene que ser cambiar una variable y
// redesplegar, no una migración sobre datos.
//
//  1. POR PAREJA (correo + IP) — 10 fallos en 15 min.
//     Frena al atacante que se concentra con una cuenta.
//     La PAREJA y no solo el correo es una decisión de seguridad: con un límite
//     solo por correo, CUALQUIERA podría bloquear la cuenta de una víctima real
//     con diez pedidos desde diez IP distintas, y esa persona se quedaría sin
//     poder entrar quince minutos sin entender por qué. Es un ataque de
//     denegación de servicio contra usuarios reales, hecho por alguien que no
//     tiene nada que perder. El límite por IP cubre el caso simétrico.
//
//  2. POR IP (cualquier correo) — 30 fallos en 15 min.
//     Frena el spray: un atacante que prueba 500 contraseñas contra 500 cuentas
//     distintas desde una sola máquina. Sin esto la capa 1 nunca se activaría,
//     porque cada cuenta recibiría un solo intento.
//
// ── LO QUE ESTO NO CUBRE ─────────────────────────────────────────────────────
// Un atacante DISTRIBUIDO contra UNA cuenta (muchas IP, mismo correo) no choca
// contra ninguna de las dos capas. La forma de taparlo es una tercera capa "por
// correo desde cualquier IP", y no se agregó a propósito: permitiéndole bloquear
// la cuenta de un usuario real durante la ventana, que es el falso positivo
// descrito en migrations/009, sale más caro que el agujero que tapa. Para una
// app de empleo, donde el usuario es una persona con la contraseña de su correo
// en el teléfono, bloquear a un usuario real es peor que dejar pasar un
// atacante de una botnet. Está escrito acá y en la migración para que nadie lo
// "arregle" subiendo un número.
//
// ── POR QUÉ ESTE ARCHIVO NO ES UN MIDDLEWARE ─────────────────────────────────
// El conteo tiene que pasar SIEMPRE, incluso con la cuenta inexistente: si solo
// se contara cuando el correo existe, un atacante probando contra correos
// inventados no sería limiting y el límite solo protegería a quien ya tiene
// cuenta. Y el borrado al entrar bien tiene que estar en el camino del login.
// Las dos cosas hacen que el módulo sea un par de funciones que el handler
// llama, no algo que envuelve al handler.
// ============================================================================

import { query } from './db.js';
import { HttpError } from './http.js';

// ── Valores por defecto ──────────────────────────────────────────────────────
//
// Los tres números y la ventana. Se pueden cambiar por variable de entorno
// (`api/lib/rateLimit.js` los lee en cada llamada, no al importar, para que
// cambiarlos no requiera reiniciar nada).
const DEFAULT_WINDOW_MINUTES = 15;
const DEFAULT_MAX_PER_PAIR = 10;
const DEFAULT_MAX_PER_IP = 30;

// Cuánto se guarda un intento antes de la purga.
//
// 24 horas es mucho más que la ventana de 15 minutos, y a propósito: si la
// retención fuera igual a la ventana, un intento del minuto 14 se borraría
// justo cuando todavía cuenta, y el límite se aflojaría por la mitad en la
// frontera. Con 24 horas hay margen de sobra para cualquier ajuste de la ventana
// sin que haya que migrar nada, y la tabla sigue acotada.
const DEFAULT_RETENTION_HOURS = 24;

// ── Configuración ────────────────────────────────────────────────────────────

/**
 * Lee un entero de una variable de entorno con default y rango.
 * @param {string} name Nombre de la variable.
 * @param {number} fallback Default.
 * @param {number} min Mínimo.
 * @param {number} max Máximo.
 * @returns {number} El valor usable.
 */
function intFromEnv(name, fallback, min, max) {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(raw) || raw < min || raw > max) return fallback;
  return raw;
}

/**
 * La configuración del límite, leída del entorno.
 *
 * `enabled: false` apaga TODO, y existe por una sola razón: los tests y el
 * desarrollo local. Un test que tiene que hacer 30 logins seguidos para probar
 * otra cosa no debería tener que esperar 15 minutos, y en una red de pruebas
 * compartida el límite puede ser molesto. En producción nadie lo apaga, así que
 * el default es `true`.
 *
 * @returns {{enabled: boolean, windowMinutes: number, maxPerPair: number,
 *   maxPerIp: number, retentionHours: number}} La configuración.
 */
export function loginLimitConfig() {
  return {
    enabled: process.env.LOGIN_LIMIT !== '0',
    windowMinutes: intFromEnv('LOGIN_LIMIT_WINDOW_MINUTES', DEFAULT_WINDOW_MINUTES, 1, 24 * 60),
    maxPerPair: intFromEnv('LOGIN_LIMIT_MAX_PER_PAIR', DEFAULT_MAX_PER_PAIR, 1, 10_000),
    maxPerIp: intFromEnv('LOGIN_LIMIT_MAX_PER_IP', DEFAULT_MAX_PER_IP, 1, 100_000),
    retentionHours: intFromEnv('LOGIN_ATTEMPTS_RETENTION_HOURS', DEFAULT_RETENTION_HOURS, 1, 24 * 365),
  };
}

// ── La consulta ──────────────────────────────────────────────────────────────

/**
 * Verifica que este par (correo, IP) todavía puede intentar un login.
 *
 * UNA sola query para las dos capas, a propósito. Con dos queries, un atacante
 * que va justo en el límite vería una respuesta más lenta en el request que
 * supera la primera que en el que no, y podría usar eso para medir a qué distancia
 * está. Y con dos queries hay una ventana entre ellas en la que otra invocación
 * inserta.
 *
 * El `filter` de PostgreSQL hace las dos cuentas sobre un solo recorrido: sobre
 * las filas de ESTA IP, una cuenta con el mismo correo (la pareja) y una cuenta
 * total (la IP). Los `min(attempted_at)` son para el `Retry-After`: en vez de
 * decir "esperá 15 minutos" (que es mentira si hace 2 minutos que falló tres
 * veces) se dice el tiempo que falta para que el más viejo salga de la ventana.
 *
 * @param {object} args
 * @param {string} args.email Correo ya normalizado.
 * @param {string} args.ip IP del cliente.
 * @returns {Promise<{allowed: boolean, layer: 'pair'|'ip'|null, retryAfterSeconds: number, remaining: number}>}
 *   `allowed: true` si se puede seguir.
 * @throws {HttpError} 429 con `Retry-After` si se pasó el límite.
 */
export async function assertLoginAllowed({ email, ip }) {
  const cfg = loginLimitConfig();
  if (!cfg.enabled) {
    return { allowed: true, layer: null, retryAfterSeconds: 0, remaining: cfg.maxPerPair };
  }

  const { rows } = await query(
    `select
       count(*) filter (where email = $1)          as por_pareja,
       min(attempted_at) filter (where email = $1)  as pareja_desde,
       count(*)                                    as por_ip,
       min(attempted_at)                            as ip_desde
     from login_attempts
     where ip = $2
       and attempted_at > now() - make_interval(mins => $3)`,
    [email, ip, cfg.windowMinutes],
  );

  const fila = rows[0] || {};
  const porPareja = Number(fila.por_pareja || 0);
  const porIp = Number(fila.por_ip || 0);

  // El orden importa para el `Retry-After`: se chequea la pareja primero porque es
  // la capa más específica. Si las dos superaron el límite, el que se muestra es
  // el de la pareja, que es el más restrictivo y el que se va a liberar antes.
  const capa = porPareja >= cfg.maxPerPair
    ? { nombre: 'pair', desde: fila.pareja_desde, limite: cfg.maxPerPair }
    : porIp >= cfg.maxPerIp
      ? { nombre: 'ip', desde: fila.ip_desde, limite: cfg.maxPerIp }
      : null;

  if (!capa) {
    return {
      allowed: true,
      layer: null,
      retryAfterSeconds: 0,
      // Cuántos intentos le quedan de la capa más ajustada. Se devuelve para que
      // un endpoint futuro pueda avisar ("te quedan 2 intentos") sin tener que
      // repetir la query.
      remaining: Math.min(cfg.maxPerPair - porPareja, cfg.maxPerIp - porIp),
    };
  }

  // Cuánto falta para que el intento MÁS VIEJO de la capa que se pasó salga de la
  // ventana. Se usa `Date.now()` y no `now()` de Postgres a propósito: el valor
  // que se manda es un número de segundos que va en una cabecera HTTP, y el reloj
  // del servidor de la aplicación es el que va a contar desde que llegó la
  // respuesta. La diferencia entre los dos relojes es de milisegundos y no
  // importa; lo que importa es que el número sea decreciente para el cliente.
  const antiguedad = capa.desde ? (Date.now() - new Date(capa.desde).getTime()) / 1000 : 0;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(cfg.windowMinutes * 60 - antiguedad),
  );

  // ▲ El mensaje NO dice cuál capa se pasó ni cuántos intentos quedan. Decirlo
  //   ("te pasaste de 10 intentos para esta cuenta") es un oráculo: le confirma
  //   al atacante que el correo existe y que el sistema lo está mirando, que es
  //   justo la información que hace que busque el siguiente objetivo con más
  //   cuidado en vez de más rápido.
  throw new HttpError(
    429,
    'Demasiados intentos de acceso. Esperá un momento antes de volver a intentar.',
    {
      retryAfterSeconds,
// En el cuerpo va el dato para el frontend, que es el único que sabe
    // traducirlo a un mensaje en pantalla.
      retryAfter: retryAfterSeconds,
    },
    // ↑ Y ACÁ va el header de verdad. `Retry-After` es obligatorio en un 429
    //   (RFC 6585) y lo leen los clientes que hacen backoff por su cuenta, sin
    //   mirar el JSON: si estuviera únicamente en el body, un cliente bien escrito
    //   recibiría un 429 sin ningún header y no sabría cuándo reintentar.
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

// ── Contar y limpiar ─────────────────────────────────────────────────────────

/**
 * Registra un intento fallido.
 *
 * Se llama SIEMPRE que el login falle, exista la cuenta o no. Esa es la parte
 * que hace que el límite sirva: si solo se contara con cuenta existente, un
 * atacante probando contra correos inventados (que es lo que hace para no delatar
 * qué correos existen) no contaría para nada.
 *
 * @param {object} args
 * @param {string} args.email Correo ya normalizado.
 * @param {string} args.ip IP del cliente.
 * @returns {Promise<void>} No devuelve nada: el error va en el 401 de siempre.
 */
export async function recordFailedLogin({ email, ip }) {
  await query('insert into login_attempts (email, ip) values ($1, $2)', [email, ip]);
  await purgeOldAttempts();
}

/**
 * Borra los intentos de un correo que acaba de entrar bien.
 *
 * El login exitoso perdona: un usuario que se equivocó tres veces de a voces y
 * después entró bien no tiene que esperar quince minutos a que se le calcite la
 * contraseña. Y de paso es la operación que borra PII: los correos que se
 * escribieron a mano en esta tabla son datos personales de alguien que pudo ser
 * un atacante, y no hay razón para guardarlos más de lo necesario.
 *
 * Se borra por CORREO y no por (correo, IP): la idea es "esta persona ya demostró
 * que sabe la clave", y eso no depende de desde dónde se haya conectado.
 *
 * @param {string} email Correo ya normalizado.
 * @returns {Promise<void>}
 */
export async function clearFailedLogins(email) {
  await query('delete from login_attempts where email = $1', [email]);
}

/**
 * Purga los intentos viejos.
 *
 * Oportunista, y la decisión es la misma de 007 (que la tablita del límite diario
 * de Apify se purga desde el endpoint que la visita): en Vercel no hay cron —
 * las funciones no corren por sí solas— así que la purga se dispara desde el
 * único lugar que escribe en esta tabla, que es un intento fallido. Con la
 * ventana en 15 minutos y la retención en 24, cada request borra casi siempre
 * cero filas; la primera de la hora es la que hace trabajo.
 *
 * El error se traga a propósito: si la purga falla, el login tiene que devolver
 * el mismo 401 de siempre. Tirar acá convertiría "no se pudo limpiar una tabla de
 * intentos" en "el usuario no puede entrar", que es un problema de permisos o de
  * conexión, presentado como un problema de contraseña.
 *
 * @returns {Promise<void>}
 */
export async function purgeOldAttempts() {
  const cfg = loginLimitConfig();
  try {
    await query(
      'delete from login_attempts where attempted_at < now() - make_interval(hours => $1)',
      [cfg.retentionHours],
    );
  } catch (err) {
    console.warn('[rate-limit] no se pudo purgar login_attempts: %s', err.message);
  }
}

/**
 * ¿Cuántos intentos lleva este par dentro de la ventana?
 *
 * NO lo usan los endpoints: está para que un script de verificación pueda
 * comprobar que el rate limit de verdad corta y que después de la ventana vuelve
 * a dejar pasar, sin tener que inferirlo del estado de la base a ojo. También
 * sirve para un futuro `/api/me` que quiera avisarle a alguien "tenés X intentos
 * fallidos", que hoy no se muestra.
 *
 * @param {object} args
 * @param {string} args.email Correo.
 * @param {string} args.ip IP.
 * @returns {Promise<{pair: number, ip: number, windowMinutes: number}>} Los conteos.
 */
export async function countRecentAttempts({ email, ip }) {
  const cfg = loginLimitConfig();
  const { rows } = await query(
    `select
       count(*) filter (where email = $1) as por_pareja,
       count(*)                       as por_ip
     from login_attempts
     where ip = $2
       and attempted_at > now() - make_interval(mins => $3)`,
    [email, ip, cfg.windowMinutes],
  );
  const fila = rows[0] || {};
  return {
    pair: Number(fila.por_pareja || 0),
    ip: Number(fila.por_ip || 0),
    windowMinutes: cfg.windowMinutes,
  };
}
