---
name: comparar-match
description: Explica y mantiene el cálculo del porcentaje de match entre el perfil del usuario y cada oferta (computeMatch y rankByRegion en matcher.js), y cómo se generaliza a cualquier profesión. Usar cuando el usuario pida "cómo se calcula el match", "por qué esta oferta tiene 80%", "cambiar la fórmula del puntaje", "revisar el score", "el match no funciona para mi profesión", o al tocar matcher.js, el score, los tags verdes/rojos o el filtro de relevancia.
---

# La comparación de match: usuario ↔ ofertas

Es la función que responde "¿qué tan válida es esta oferta para mí?". Vive en
`lib/matcher.js` (en el origen: `server/matcher.js`). Es **lógica de negocio**, no
plumbing: los números están elegidos a mano y cambian el orden de los resultados.

## Qué devuelve cada oferta

`computeMatch(job, perfil)` devuelve **exactamente** estos campos, y el frontend los consume
por nombre. Si cambiás la forma, rompés la UI:

| Campo | Qué es | Para qué lo usa la UI |
|---|---|---|
| `score` | 0-100, redondeado | el "%" grande y el orden |
| `matched` | array de **strings** (nombres de skill que tenés y la oferta pide) | tags **verdes** |
| `missed` | array de strings (la oferta pide y **no** tenés), top 8 | tags **rojos**, las brechas |
| `requested` | array de strings, top 12 | el detalle de "qué pide la oferta" |
| `roles` | array de categorías detectadas en el título | el chip de rol |
| `inTitle` | boolean | "aparece en el título" |

Ojo: **`matched` devuelve los nombres, no los objetos con peso.** El peso se usa para el
cálculo pero se pierde en el return (`m: m.skill`). Si necesitás el peso en la UI, cambialo
consistemente en los dos lados.

## La fórmula del score

```
score = coverage * 55          // cobertura de skills, con bonus si están en el título
      + roleAffinity * 12      // categorías de rol detectadas en el título
      + min(matched, 8) * 2    // bonus por cantidad, topa en 8
      - min(missing, 5) * 3    // penalización por brechas, topa en 5
      → clamp(0, 100)
```

`coverage = gain / total`, donde `gain` suma `weight * 1.5` si la skill también aparece en el
**título** (no solo en la descripción), y `weight` es el peso del perfil.

O sea: **el mismo skill vale más si está en el título que en el cuerpo de la oferta.** Ese
1.5 es la decisión más importante de la fórmula. Si lo cambiás, cambia el orden de todo.

**Los pesos son números, no texto.** En el perfil de origen (`cvProfile.js`) están escritos
como `qa: 1`, `docker: 0.6`. En este repo el perfil sale de la DB y `profile.js:toWeight()`
ya devuelve número. No inventes la versión con strings.

## El corte de score 0 (y por qué ya no rompe multiusuario)

En el origen `computeMatch` tenía **dos** cortes tempranos que devolvían `{ score: 0, ... }`:

1. **`isQARelevant`** — la oferta tenía que ser claramente de QA/testing.
2. **`matched.length === 0 && roles.length === 0`** — aunque fuera de QA, si no matcheaba
   ninguna skill del CV, tampoco servía.

El primero estaba armado con `ROLE_SYNONYMS` (qa, tester, automation, sdet, devops,
fullstack, analista) y `BASE_KEYWORDS` de `jobSources.js`. **Para un contador o una
enfermera devolvía score 0 para todas las ofertas y la app mostraba una lista vacía.**

**Acá está resuelto (paso 6)**: `isQARelevant`, `ROLE_SYNONYMS` y `BASE_KEYWORDS` **no se
portaron**, y no hay lista de profesiones en ninguna parte. Queda **un solo corte**: si no
matcheó nada del perfil, `score` es 0 y la oferta no entra al ranking.

Lo que reemplaza a la detección por profesión:

- Los **`roles`** (lo que aportaba `roleAffinity` y `inTitle`) salen de `profile.keywords`.
- Las **skills** y los pesos salen de `profile.skills` (array `[{ name, weight }]`).
- Una oferta de otra profesión da 0 y se descarta sola, sin lista de profesiones.

**Conserva `textHasSkill()`** y su patrón `(^|[^a-z])skill([^a-z]|$)`: es lo que evita que
"qa" entre dentro de "quality". Lo que se va es **qué** skills se buscan, no el patrón.

## `rankByRegion` ya pasa el perfil (el bug que había)

En el origen, `computeMatch` **sí** aceptaba un segundo parámetro:

```js
export function computeMatch(job, candidateProfile = PROFILE) { ... }
```

Pero el que la llamaba en cadena **no se lo pasaba**:

```js
// matcher.js:182 del ORIGEN — dentro de rankByRegion()
const match = computeMatch(job);   // ← sin perfil: usaba el PROFILE global siempre
```

Aunque la firma estuviera parametrizada, en el flujo real el `PROFILE` global se seguía
usando. **Era invisible en desarrollo** (funcionaba, porque el global era el único perfil)
y **un error de datos en multiusuario**. Arreglar la firma no alcanzaba: había que arreglar
la llamada.

**Acá está arreglado (paso 6)**: `computeMatch(job, profile)` y
`rankByRegion(jobs, profile, topN = 0)`, con el perfil **obligatorio en las dos** (sin
default). Un `profileOrEmpty()` local normaliza `null`/`undefined`/perfil sin `skills` array
a `emptyProfile()`, así que la función nunca tira.

## El desempate del ranking lee `date`, no `postedAt`

A igual score, `rankByRegion` desempata por fecha de publicación. Usa
`publishedAt(job)` (`matcher.js:264`):

```js
return job.date || job.postedAtTimestamp || job.postedAt || '';
```

**No hardcodees `job.postedAt` en el sort**: las 5 bolsas de `jobSources.js` normalizan a
**`date`** (`publication_date`, `created_at`, `pubDate`) y `postedAt` solo existe en Apify.
Con `postedAt` el desempate comparaba `''` contra `''` en toda la ruta gratuita, o sea que
**no desempata nada** y dos ofertas con el mismo score quedaban en orden de llegada.

Y ojo con `||` contra `??`: `date` puede ser `''` (Remotive no siempre trae fecha) y eso es
*falsy*, así que tiene que ser `||`. Con `??` el `''` cortaría la cadena.

## Dos cosas del origen que no hay que copiar

- **Código muerto**: `score += Math.min(missing.length, 0) * 0;` (línea 126). `Math.min(x, 0)`
  siempre es ≤ 0 y multiplicado por 0 da 0. No aporta nada; el comentario lo admite ("junto a
  penalización abajo"). La penalización real es la línea siguiente (restar hasta 5×3). No lo
  arrastres.
- **`assignRegion` con 7 `if`**: decide la región con regex por país y le da prioridad a
  `regionGuess`. Esa parte ya se resuelve con `regions.js` (`matchRegion`) y **no existe
  más** en `matcher.js`. No la mezcles con el cálculo del score.

## Verificar un cambio acá

`node --check lib/matcher.js` y después probá con ofertas reales. Lo que hay que mirar:

- [ ] Un usuario **no-QA** con su perfil recibe ofertas con score **mayor a 0**
- [ ] Un skill en el **título** puntúa más que el mismo skill solo en la descripción
- [ ] Las brechas (`missed`) coinciden con lo que la oferta pide y el usuario no tiene
- [ ] `rankByRegion` **sí** reenvía el perfil del usuario a `computeMatch`
- [ ] El score siempre está entre 0 y 100
- [ ] `npm run check` y `npm run build` pasan

Para probar el matching **no llames a `/api/linkedin-search`**: se factura por ejecución.
Usá `/api/jobs`, que corre sobre las fuentes gratuitas.