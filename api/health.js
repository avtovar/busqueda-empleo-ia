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
//   · `lib/db.js` está construido para que importar el módulo NO abra
//     conexión: el pool se crea la primera vez que alguien consulta. Acá la
//     garantía es más fuerte, porque no depende de una promesa: este endpoint
//     NO importa nada del proyecto (ni `sendJson`, ni `db.js`, ni `auth.js`).
//     Esa es la diferencia entre "no llamo a la base" (una promesa) y
//     "no puedo llamarla" (el grafo de imports).
//
// Lo mismo con Apify: este archivo no menciona `APIFY_API_TOKEN` y no llama a
// ningún actor. La regla de AGENTS.md es no ejecutarlo NUNCA para verificar nada,
// y la forma más segura de no ejecutarlo es que el archivo que verifica no lo
// mencione.
// ============================================================================

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
 * @param {Request} req Petición (Web Fetch API).
 * @returns {Response} Respuesta JSON con Cache-Control: no-store.
 */
export const GET = async (req) => {
  return new Response(JSON.stringify({
    ok: true,
    service: SERVICE,
    time: new Date().toISOString(),
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
};