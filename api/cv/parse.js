// POST /api/cv/parse — ARCHIVO DEDICADO (ruta exacta, sin rewrite).
// ↑ Existe porque el catch-all `api/profile/[...slug].js` no recibe slugs de dos
//   segmentos (`cv/parse`) en Vercel: esa ruta devolvía 404 de plataforma sin
//   llegar a la función. La lógica sigue en el router de perfil; acá solo se
//   re-exporta su POST para que la ruta exacta tenga función propia.
import { POST as profilePOST } from '../profile/[...slug].js';

// ↑ Re-export y no copia: el parseo (LLM, cuota, validación) vive en un solo lugar.
export const POST = profilePOST;
