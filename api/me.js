// ============================================================================
// GET /api/me — "¿quién soy y a dónde me mandás?"
//
// Este es el endpoint que decide el ruteo del frontend, y es el ÚNICO que
// devuelve 200 con `profileComplete: false`.
//
// ── POR QUÉ ESTE ENDPOINT NO ES COMO LOS OTROS ───────────────────────────────
// La regla del proyecto es: los endpoints que necesitan perfil devuelven 403 sin
// perfil, para que el frontend mande al onboarding del CV en vez de al login.
// `/api/me` es la excepción, y la excepción es el punto:
//
//   · Es el que CONSULTA el estado, no el que lo EXIGE. Si exigiera perfil, el
//     frontend no tendría forma de preguntarle a la app "¿a dónde me mandás?":
//     la única respuesta posible sería un error, y con un error no se puede
//     construir la pantalla de decisión.
//
//   · Es la excepción necesaria para que la compuerta de 403 tenga sentido. Cuando
//     `/api/jobs` dice 403 con `profileComplete: false`, el frontend tiene que
//     poder distinguir "tu sesión no sirve" (401) de "tu sesión sirve pero te
//     falta el CV" (403), y ese es exactamente el trabajo de este endpoint.
//
// ── LOS TRES CÓDIGOS QUE PUEDE DEVOLVER ──────────────────────────────────────
//
//   401  sin cookie, con cookie inválida, con cookie vencida, o con cookie firmada
//        de un usuario que ya no existe en la base  ──►  el frontend va a /login
//
//   200 { user, profileComplete: true }   ──►  el frontend va a la app
//   200 { user, profileComplete: false }  ──►  el frontend va al onboarding del CV
//
// Los dos 200 son idénticos salvo por una bandera. Podría ser un 204 o un 403,
// pero volverían a obligar al frontend a adivinar: "no sé qué hacer con esto,
// que reintente". Un 200 con la respuesta completa es lo que hace que el ruteo
// sea una línea de `if` en el cliente.
//
// ── POR QUÉ NO DEVUELVE EL PERFIL ────────────────────────────────────────────
// Porque no es lo que se le pidió y porque `/api/profile` (paso 7) va a devolverlo
// con el shape de la API (camelCase + las `skills` de la tabla `skills`, que
// viven en otra tabla). Si `/api/me` lo devolviera, el frontend tendría dos
// lugares de donde sacar el perfil y habría que decidir cuál gana. Este endpoint
// devuelve lo MÍNIMO para decidir el ruteo: quién sos y si ya completaste el
// onboarding.
// ============================================================================

import { hasProfile, publicUser, requireSession } from './lib/auth.js';
import { sendJson, withErrorHandling } from './lib/http.js';

export const config = { maxDuration: 30 };

/**
 * Devuelve el usuario y si su perfil está completo.
 *
 * @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export const GET = withErrorHandling(async (req, res) => {
  // `requireSession` tira 401 si no hay cookie, si no valida, si venció o si el
  // usuario ya no existe. Con el `withErrorHandling` de `http.js`, ese 401 sale
  // con su mensaje y no hace falta un try/catch acá.
  const { user } = await requireSession(req);

  // Un `select 1` sobre la primary key de `profiles`, que es `user_id`. Es la
  // consulta más barata que hay y es la que decide la pantalla siguiente.
  const profileComplete = await hasProfile(user.id);

  sendJson(res, 200, {
    user: publicUser(user),
    // ↑ SIEMPRE presente, en los dos casos. El frontend rutea mirando el valor de
    //   esta bandera y no la ausencia de un campo: una clave que a veces está y a
    //   veces no es un `if (res.profileComplete !== undefined)` que alguien va a
    //   invertir sin darse cuenta.
    profileComplete,
  });
});
