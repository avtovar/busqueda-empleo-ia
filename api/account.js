// ============================================================================
// DELETE /api/account — borra la cuenta y todo lo que tiene arriba.
//
// El endpoint más destructivo de la API y el más corto: cuatro pasos. Toda la
// dificultad del proyecto está en las decisiones que hay alrededor, y están
// escritas abajo porque ninguna se deduce leyendo el código.
//
// ── POR QUÉ ES UN `DELETE` Y NO UN `POST` ─────────────────────────────────────
// Es la semántica HTTP correcta, y sale gratis: `DELETE` es idempotente por
// definición, no necesita body, y cualquier capa que no lea el código (un proxy,
// un log de acceso, un crawler) lo trata como lo que es. Un
// `POST /api/account/delete` sería indistinguible de un `GET` para todas ellas.
//
// ── POR QUÉ `requireSession` Y NO `requireProfile` ───────────────────────────
// La compuerta del perfil (403) es para los endpoints que NECESITAN el perfil para
// trabajar. Acá no lo necesitan: el borrado tiene que poder ejecutarse con una
// cuenta a medio dar de alta —el caso real de quien se registra, se arrepiente y
// quiere irse sin llegar a subir el CV—, y con `requireProfile` esa persona no
// podría borrar nada, porque `profiles` no existe. Borrar la cuenta es un
// derecho, y un derecho que depende del estado previo de la app es condicional.
//
// Ojo con lo que esto NO habilita: `requireProfile` además impide que un usuario
// sin perfil toque `/api/jobs`. Acá el endpoint es exactamente UNO y no devuelve
// datos del usuario, así que no hay nada que filtrar.
//
// ── POR QUÉ NO HAY `session_version`, NI FALTANDO LAS COOKIES ─────────────────
// La pregunta obvia es "revocar los tokens que ese usuario tenga sueltos". No hace
// falta y no se agrega: **borrar la fila de `users` ya invalida todos los
// tokens**, porque `requireSession` consulta `users` en CADA request
// (`api/lib/auth.js:651-660`). Un token bien firmado de un usuario que ya no está
// da 401, que es la misma respuesta que si el token no tuviera firma. La columna
// sería una escritura y un número en el payload para obtener un resultado que la
// base ya garantiza.
//
// El `Set-Cookie` con `Max-Age=0` del final NO es por eso: es para que el
// navegador no siga mostrando la app con datos en memoria, y para que el
// siguiente request no gaste un round-trip en descubrir que su cookie ya no sirve.
//
// ── POR QUÉ EL `user_id` SALE DE `requireSession` Y NUNCA DEL REQUEST ────────
// Del body, del query string y de los headers no se lee NADA. El id es el que
// verificó la cookie. Un endpoint de borrado que aceptara un id del cliente es un
// endpoint donde un descuido de tipografía es la diferencia entre borrar tu cuenta
// y borrar la de otro.
//
// ── EL ORDEN DE LOS CUATRO PASOS ──────────────────────────────────────────────
//   1. `requireSession` — 401 si no hay cookie válida.
//   2. INSERT en `account_deletions` — el rastro, ANTES del borrado: MEMORIA.md
//      §4.1, "la base no deja rastro, así que hay que loguearlo antes".
//   3. `DELETE FROM users WHERE id = $1` — una sola sentencia, y las 7 FK con
//      `on delete cascade` se llevan el resto (decisión 9, `001_users.sql:89-121`).
//   4. `clearSession` + 200.
//
// Los pasos 2 y 3 van en UNA transacción (`withTransaction`) y no como dos
// `query()` sueltos. Sin transacción, un INSERT que entra y un DELETE que falla
// dejan una fila diciendo "esta cuenta se dio de baja" para una cuenta que sigue
// ahí: el registro afirma algo que no pasó. Con transacción no hay estado
// intermedio posible, y un 500 del `withErrorHandling` significa "no se borró
// nada, se puede reintentar".
//
// ▲ LO QUE LA TRANSACCIÓN NO CUBRE, y hay que saberlo: dos requests del mismo
//   usuario que pasen los dos `requireSession` antes de que corra el primer
//   `DELETE`. En ese caso los dos INSERT pasan (no hay FK que los frene: es justo
//   lo que los hace sobrevivir) y la tabla queda con dos filas para una sola
//   baja. Es un registro duplicado, NO datos sin borrar: la cuenta se borra igual,
//   completa, y el defecto es cosmético en una bitácora. Se acepta, igual que
//   `history.js` acepta dos corridas simultáneas de una búsqueda porque el
//   `unique (user_id, key)` las deduplica. Si molestara, la salida es un
//   `pg_advisory_xact_lock` sobre el id —la misma técnica de `cvParseLimit.js`— y
//   no una fila más.
// ============================================================================

import { clearSession, clientIp, requireSession } from './lib/auth.js';
import { withTransaction } from './lib/db.js';
import { sendJson, withErrorHandling } from './lib/http.js';

export const config = { maxDuration: 30 };

/**
 * Da de baja la cuenta de quien está llamando.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const DELETE = withErrorHandling(async (req, res) => {
  // Primero la compuerta. Si tira, el `withErrorHandling` responde 401 y no corre
  // ni una línea de la transacción. Con una cookie firmada de una cuenta ya
  // borrada pasa igual: es el `select` de `requireSession` el que lo detecta.
  const { user } = await requireSession(req);

  // El email sale del mismo `select` de `requireSession`, o sea de la fila que
  // existe AHORA y no de lo que el cliente mande. Si el endpoint aceptara un
  // email del body, el registro podría decir "se borró tal cuenta" con el correo
  // de otra.
  const email = user.email;

  const headers = req.headers || {};
  const ip = clientIp(req);
  // ↑ `clientIp` y no `req.socket.remoteAddress`: detrás del proxy de Vercel eso
  //   es la IP del runtime, no la del cliente, y una bitácora de bajas con la
  //   misma IP repetida en todas las filas no sirve para investigar nada.
  const userAgent = typeof headers['user-agent'] === 'string' ? headers['user-agent'] : null;
  // ↑ Sin recortar y sin `|| ''`: un header ausente es `undefined` y a la base le
  //   llega `null`. Ponerle `''` sería afirmar que el cliente no mandó User-Agent,
  //   que no es lo mismo que no saberlo.

  await withTransaction(async (client) => {
    // El rastro, PRIMERO. La tabla no tiene FK a propósito (ver el porqué en
    // `012_account_deletions.sql`): este INSERT sobrevive al DELETE de abajo.
    await client.query(
      'insert into account_deletions (user_id, email, ip, user_agent) values ($1, $2, $3, $4)',
      [user.id, email, ip, userAgent],
    );

    // UNA sola sentencia. Las 7 FK con `on delete cascade` (profiles, skills,
    // searches, job_history, favorites, apify_usage, cv_parses) se llevan todo lo
    // demás dentro de ESTA transacción: entra la cascada entera o no entra nada.
    // Los N `DELETE` explícitos que esta cascada reemplazaba dejaban datos
    // huérfanos si el tercero fallaba; el porqué está en `001_users.sql:89-121`.
    await client.query('delete from users where id = $1', [user.id]);

    // El `rowCount` NO se chequea, a propósito. Un 0 acá significaría que otro
    // request borró la cuenta entre el `requireSession` y este query (la carrera
    // de arriba). El INSERT que se acaba de hacer sigue siendo cierto —alguien
    // con esa cookie pidió la baja— y tirar un error mostraría un 500 por una
    // baja que ya se completó. Peor que un registro duplicado.
  });

  // Van DESPUÉS de la transacción y ANTES del `sendJson`: el `writeHead` de
  // `sendJson` congela las cabeceras, así que un `Set-Cookie` escrito después no
  // sale. Que la cookie se borre aunque la transacción ya haya commiteado es lo
  // correcto: la cuenta ya no existe, así que cualquier request con esa cookie
  // va a ser un 401, y lo que se evita es el round-trip para enterarse.
  clearSession(req, res);
  sendJson(res, 200, { ok: true });
});