// ============================================================================
// POST /api/register — ETAPA 1 DEL ALTA: correo y clave.
//
// Este endpoint hace DOS cosas y deliberadamente NO hace una tercera:
//
//   1. Valida y hashea la clave.
//   2. Inserta la fila en `users` y deja la cookie de sesión puesta.
//
// Lo que NO hace es crear el perfil. El perfil viene del CV (pasos 6 y 7) y en
// este momento el usuario todavía no subió ninguno. Si este endpoint creara la
// fila en `profiles`, el alta dejaría de ser en dos etapas y `profiles` tendría
// que poder existir con columnas vacías que el LLM todavía no corrió — que es
// exactamente el caso que 002_profiles.sql resuelve con todas las columnas
// nullable, y que se rompe en cuanto alguien pone un `not null`.
//
// Y por eso la respuesta dice `profileComplete: false`: no es un default
// conservador, es un hecho. Se acaba de crear la fila en `users` y por lo tanto
// NO hay fila en `profiles`. El frontend lo lee y manda al usuario al onboarding
// del CV.
//
// El paso 6 (`/api/cv/parse`) y el paso 7 (`/api/profile`) no están escritos
// todavía. Este endpoint no deja ningún hook pendiente para ellos: el usuario
// queda con sesión válida y sin perfil, que es un estado que `requireSession`
// acepta y `requireProfile` rechaza con 403, y el frontend lo rutea al CV.
// ============================================================================

import {
  hashPassword,
  issueSession,
  publicUser,
  readCredentials,
} from './lib/auth.js';
import { query } from './lib/db.js';
import { HttpError, readJsonBody, sendJson, withErrorHandling } from './lib/http.js';

export const config = { maxDuration: 30 };

// Tope del body. Un registro son dos campos de un kilobyte; 64 KB es el default
// de `readJsonBody` y se pone explícito para que quede claro que este endpoint
// no acepta un CV adentro.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Crea la cuenta y deja la sesión abierta.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const POST = withErrorHandling(async (req, res) => {
  const body = await readJsonBody(req, { limitBytes: MAX_BODY_BYTES });
  const { email, password } = readCredentials(body);

  // Hashear ANTES de tocar la base. Si el INSERT falla (el correo ya existe), el
  // costo de bcrypt ya está pagado, pero da igual: el caso del correo repetido es
  // raro y 300 ms no se notan. Lo que sí importa es el orden inverso: hashear
  // DESPUÉS de insertar dejaría una ventana en la que hay una cuenta viva sin
  // hash, y si el hash falla la cuenta queda inservible.
  const passwordHash = await hashPassword(password);

  // `returning` evita el segundo select: la fila que se insertó y la que se
  // devuelve son la misma, y con ella el id que va dentro de la cookie.
  let user;
  try {
    const { rows } = await query(
      'insert into users (email, password_hash) values ($1, $2) returning id, email, created_at',
      [email, passwordHash],
    );
    user = rows[0];
  } catch (err) {
    // ↑ `23505` es `unique_violation`. Es el `users_email_key` de 001_users.sql.
    //   Se traduce el código y no se mira el mensaje de Postgres, porque el
    //   mensaje crudo nombra la tabla, la columna y el índice, y ese texto no
    //   tiene por qué ver un usuario que se está registrando.
    //
    //   Y es un 409 y no un 400: el correo ya está en uso NO es un error de este
    //   pedido, es un estado del mundo. El frontend lo muestra como "esa cuenta
    //   ya existe, entrá con tu clave". Ojo que esto SÍ es un oráculo de
    //   enumeración de cuentas (cualquiera puede preguntar qué correos existen) y
    //   es una decisión consciente: acá se elige la experiencia de uso, y el
    //   punto 4 del pedido pide que el LOGIN no filtre, que es el endpoint donde
    //   la enumeración sirve para ROBAR una clave y no para volver a registrarse.
    //   Si algún día se decide lo contrario, el 409 se cambia por un 400 genérico
    //   acá y no se toca `login.js`.
    if (err && err.code === '23505') {
      throw new HttpError(409, 'Ya existe una cuenta con ese correo.');
    }
    throw err;
  }

  // La cookie va ANTES de la respuesta: `issueSession` escribe el `Set-Cookie` en
  // `res`, y `sendJson` después. Al revés, el `writeHead` de `sendJson` congelaría
  // las cabeceras y la cookie no saldría nunca — el usuario se registraría y
  // quedaría sin sesión, con un error que parece de frontend.
  issueSession(req, res, user.id);

  sendJson(res, 200, {
    ok: true,
    user: publicUser(user),
    // ↑ SIEMPRE false acá, y no un default: este endpoint sabe que no hay perfil
    //   porque acaba de crear la fila en `users`. Un `true` acá mandaría al
    //   usuario a una app que no tiene contra qué matchear ofertas.
    profileComplete: false,
  });
  // ↑ 200 y no 201. REST purito diría 201 Created con un `Location`; se usa 200
  //   porque es lo que espera el contrato del frontend y porque `res.ok` (lo que
  //   chequea el `fetch`) cubre los dos igual. Si algún día el frontend distingue
  //   los códigos, acá es el único lugar que hay que tocar.
});
