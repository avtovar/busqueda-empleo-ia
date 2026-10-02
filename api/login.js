// ============================================================================
// POST /api/login — correo y clave, con rate limit contra la base.
//
// Este es el endpoint más sensible del proyecto: es la puerta a las contraseñas.
// Tres cosas lo hacen más difícil de romper de lo que parece, y las tres están
// comentadas abajo:
//
//   1. El mensaje de error es IDÉNTICO para "correo inexistente" y "clave
//      incorrecta". Un mensaje distinto convierte el endpoint en un enumerador de
//      cuentas: con el mismo par se puede preguntar "¿existe esta casilla?" sin
//      necesitar ninguna clave.
//   2. El TIEMPO de respuesta también es el mismo. Si el caso "no existe" saliera
//      10 veces más rápido (porque no hay nada que comparar con bcrypt), el
//      mensaje idéntico no protegería nada: alcanza con medir. Por eso se
//      compara contra un hash de mentira cuando no hay usuario.
//   3. El rate limit se consulta ANTES de bcrypt, así que un atacante que ya
//      quemó sus intentos no gasta ni los ~300 ms de CPU de un bcrypt por
//      intento.
//
// El orden importa y es el inverso del intuitivo:
//
//   rate limit ──► select del usuario ──► bcrypt ──► registro del fallo / cookie
//
// El registro del fallo va DESPUÉS de saber que la clave estaba mal, porque solo
// los intentos fallidos se cuentan: un usuario que entra bien tres veces por día
// no tiene que quedarse sin poder entrar nunca. Y se cuenta también cuando el
// correo NO existe, que es lo que hace que el límite sirva contra un atacante que
// todavía no sabe a quién ataca.
// ============================================================================

import {
  dummyHash,
  hasProfile,
  issueSession,
  publicUser,
  readCredentials,
  verifyPassword,
} from './lib/auth.js';
import { query } from './lib/db.js';
import { HttpError, clientIp, readJsonBody, sendJson, withErrorHandling } from './lib/http.js';
import { assertLoginAllowed, clearFailedLogins, recordFailedLogin } from './lib/rateLimit.js';

export const config = { maxDuration: 30 };

// EL mensaje. Una sola constante, usada en los DOS caminos de falla, y escrito
// para que no diga cuál de los dos pasó. Es el mismo texto de arriba a abajo y
// el mismo texto para todos los correos: el objetivo es que las dos respuestas
// sean indistinguibles byte a byte, no solo parecidos. Ver la comparación que hay
// que hacer si algún día se cambia esta línea.
const INVALID_CREDENTIALS = 'El correo o la clave no son correctos.';

// Tope del body, igual que en `register`.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Entra con correo y clave.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const POST = withErrorHandling(async (req, res) => {
  const body = await readJsonBody(req, { limitBytes: MAX_BODY_BYTES });
  const { email, password } = readCredentials(body);
  const ip = clientIp(req);

  // 1) Rate limit ANTES de cualquier trabajo caro. Si está quemado, sale acá con
  //    un 429 y su `Retry-After`, sin haber tocado `users` ni haber corrido bcrypt.
  //    Este es el orden que hace que el límite sirva: el costo de un intento
  //    bloqueado es una query, no un hash.
  await assertLoginAllowed({ email, ip });

  // 2) El usuario. `select` con las columnas nombradas y NO `select *`: el
  //    `password_hash` tiene que estar porque hay que compararlo, pero pedir solo
  //    esas tres columnas deja claro que no hay un cuarto campo que filtrar.
  const { rows } = await query(
    'select id, email, password_hash, created_at from users where email = $1',
    [email],
  );
  const user = rows[0] || null;

  // 3) bcrypt, SIEMPRE. Con usuario contra su hash y sin usuario contra el hash
  //    de mentira. `||` y no un if: si el camino del usuario se puede saltear,
  //    el timing vuelve a delatar qué correos existen.
  const hash = user ? user.password_hash : dummyHash();
  const claveOk = await verifyPassword(password, hash);

  if (!user || !claveOk) {
    // 4) Un solo camino de salida para los dos casos, con el MISMO mensaje. El
    //    intento se registra igual en los dos: ver la nota de arriba.
    await recordFailedLogin({ email, ip });
    throw new HttpError(401, INVALID_CREDENTIALS);
  }

  // 5) Entró. Los intentos fallidos de ese correo se borran: la persona demostró
  //    que sabe la clave, y no tiene sentido dejarle el límite en el camino.
  await clearFailedLogins(email);

  // 6) Cookie. Va antes del `sendJson` por la misma razón que en `register`: el
  //    `writeHead` de `sendJson` congela las cabeceras.
  issueSession(req, res, user.id);

  // 7) `profileComplete` se CONSULTA y no se supone. Un usuario que vuelve a
  //    entrar ya tiene perfil y su respuesta tiene que decirlo, o el frontend lo
  //    mandaría al onboarding del CV cada vez que cierra la pestaña. Es un
  //    `select 1` sobre la primary key de `profiles`, que es lo más barato que
  //    hay: una lectura de índice.
  const profileComplete = await hasProfile(user.id);

  sendJson(res, 200, {
    ok: true,
    user: publicUser(user),
    profileComplete,
  });
});
