// ============================================================================
// POST /api/logout — borra la cookie de sesión del navegador.
//
// El endpoint más chico de todos, y con una decisión que no es obvia: NO pide
// sesión.
//
// Que el logout no exija cookie parece un descuido y no lo es. Si exigiera
// sesión, entonces con la sesión vencida el logout devolvería 401, el `fetch` del
// frontend lo trataría como fallo, y la cookie —que es la que había que borrar—
// se quedaría en el navegador. El usuario cerraría sesión y seguiría con la
// sesión abierta hasta que expirara sola. Que el logout devuelva SIEMPRE 200 y
// borre la cookie siempre es lo que lo hace confiable.
//
// ── LO QUE ESTE LOGOUT NO PUEDE HACER (y por qué no está) ────────────────────
// La sesión de este proyecto es un token firmado, sin fila en la base
// (ver el why de eso arriba de todo en `api/lib/auth.js`). "Borrar la sesión" es
// por lo tanto borrar la cookie, y NADA más: si alguien copió el valor del token
// antes, ese token sigue siendo válido hasta que expire. Con `SESSION_TTL_DAYS`
// en 7 (el default) la ventana es acotada.
//
// Cuando haga falta revocar de verdad, la respuesta NO es agregar una tabla de
// sesiones (eso obliga a escribir en cada request y rompe el modelo de
// serverless): es un `session_version integer not null default 0` en `users`, que
// va DENTRO del token firmado y se incrementa en el logout y en el borrado de
// cuenta. Los tokens con la versión vieja dejan de verificar. Es un ALTER TABLE y
// un número más en el payload.
//
// El paso 11 (borrar cuenta) va a necesitar las dos cosas: borrar la fila Y
// revocar cualquier cookie que ande suelta, y por eso está anotado acá.
// ============================================================================

import { clearSession } from './lib/auth.js';
import { sendJson, withErrorHandling } from './lib/http.js';

export const config = { maxDuration: 30 };

/**
 * Borra la cookie. Siempre 200, haya cookie o no.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const POST = withErrorHandling(async (req, res) => {
  // Va antes del `sendJson`: el `writeHead` de `sendJson` congela las cabeceras
  // y el `Set-Cookie` que se escriba después no sale.
  clearSession(req, res);
  sendJson(res, 200, { ok: true });
});
