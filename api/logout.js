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
// serverless). Y tampoco es el `session_version integer` que este archivo tenía
// anotado acá como tarea pendiente del paso 11: se llegó a considerar y salió al
// revés, porque `requireSession` ya consulta `users` en CADA request. Borrar la
// fila de `users` (o invalidarla de otra forma) deja todos los tokens de esa
// persona dando 401 sin tocar ningún otro estado. Agregar `session_version`
// entonces solo agrega una escritura más por login y un segundo lugar donde el
// estado de la sesión puede quedar desincronizado del de la cuenta. Si algún día
// hace falta revocar SIN borrar la cuenta, esa es una decisión nueva; el lugar
// para discutirla es `MEMORIA.md` §5, no este comentario.
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
