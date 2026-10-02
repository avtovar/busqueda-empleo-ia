// ============================================================================
// GET /api/health — EL SMOKE TEST DEL DEPLOY.
//
// Lo único que este endpoint tiene que hacer es CONTESTAR, rápido y siempre. Y
// "siempre" es la parte importante: tiene que contestar igual con la base caída,
// con `DATABASE_URL` sin definir, con `SESSION_SECRET` sin definir y sin token de
// Apify.
//
// ── POR QUÉ NO HACE UN `select 1` ────────────────────────────────────────────
// Por tentador que parece. Y por qué NO:
//
//   · Si este endpoint tocara la base, un Neon caído haría que `/api/health`
//     diera error. Y en la pantalla de Vercel eso se ve IGUAL que un deploy
//     roto: dos deploys, un rojo, cero información. Con esta implementación, un
//     503 de `/api/health` significa "la FUNCIÓN no arrancó" (import roto,
//     error de sintaxis, falta de memoria) y un 200 con la base caída significa
//     "la función está sana y el problema es Neon". Son dos diagnósticos
//     distintos y se necesitan los dos.
//
//   · El smoke test del deploy se dispara apenas se despliega. Si dependiera de
//     la base, el deploy fallaría por un Neon que todavía está retomando
//     conexiones, y nadie sabría si el código estaba bien.
//
//   · `api/lib/db.js` está construido para que importar el módulo NO abra
//     conexión: el pool se crea la primera vez que alguien consulta. Acá la
//     garantía es más fuerte, porque no depende de una promesa: este endpoint
//     importa UNA SOLA cosa, `sendJson` de `api/lib/http.js`, y ese archivo tiene
//     CERO imports: ni de `db.js`, ni de `auth.js`, ni de nada del proyecto. O sea
//     que el grafo de imports de este handler termina ahí:
//         health.js  →  lib/http.js  →  (nada)
//     y como nada más se importa, este handler no tiene forma de llegar a abrir
//     una conexión, ni aunque alguien lo intente. Esa es la diferencia entre
//     "no llamo a la base" (una promesa) y "no puedo llamarla" (el grafo).
//
//     La contrapartida es que hay que mantener el cero-imports de `http.js`, y por
//     eso está anotado acá: `grep '^\s*import' api/lib/http.js` tiene que seguir
//     saliendo vacío.
//
// Lo mismo con Apify: este archivo no menciona `APIFY_API_TOKEN` y no llama a
// ningún actor. La regla de AGENTS.md es no ejecutarlo NUNCA para verificar nada,
// y la forma más segura de no ejecutarlo es que el archivo que verifica no lo
// mentione.
//
// ── POR QUÉ USA `sendJson` Y NO ESCRIBE A MANO ────────────────────────────────
// Podría hacer `res.writeHead(...)` + `res.end(JSON.stringify(...))` y quedaría
// con cero imports, que es lo que decía una versión anterior de este comentario.
// No lo hace a propósito: `sendJson` pone `Cache-Control: no-store`, que es lo
// que impide que el CDN de Vercel le devuelva a un smoke test la respuesta del
// deploy anterior, y poner ese header acá a mano sería una segunda copia de una
// regla de seguridad que puede quedar vieja sin que nadie se entere. Reusar una
// cosa centralizada vale más que el import.
// ============================================================================

import { sendJson } from './lib/http.js';

export const config = { maxDuration: 30 };

// `Date.now()` y no un import de una librería de tiempo: es una función nativa.
const SERVICE = 'busqueda-empleo-ia';

/**
 * Responde que la función está viva.
 *
 * El `time` no es un adorno: es lo que permite verificar a ojo que el endpoint
 * NO está abriendo una conexión (si la abriera, la latencia de la respuesta
 * incluiría el handshake TLS con Neon, que se nota). Un smoke test que además
 * mide cuánto tardó, mide la salud de las dependencias sin depender de ellas.
 *
 * @param {import('node:http').IncomingMessage} req Petición.
 * @param {import('node:http').ServerResponse} res Respuesta.
 * @returns {void}
 */
export const GET = (req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: SERVICE,
    time: new Date().toISOString(),
    // ↑ Se manda `no-store` desde `sendJson` (ver el comentario de esa función):
    //   un 200 de health cacheado en el CDN de Vercel haría que el smoke test
    //   siguiente viera la respuesta del deploy anterior.
  });
};
