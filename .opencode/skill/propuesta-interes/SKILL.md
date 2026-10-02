---
name: propuesta-interes
description: Genera y mantiene la "Propuesta de Interés", la analítica de mercado que cruza las ofertas encontradas contra el perfil del usuario (demanda por skill, brechas, fortalezas y recomendaciones). Usar cuando el usuario pida "propuesta de interés", "análisis de mercado", "qué me falta para el mercado", "recomendaciones", "brechas de skills", o al tocar analytics.js, /api/analytics o la página de análisis.
---

# La Propuesta de Interés

Es la página que responde "**mirá el mercado: esto es lo que pide, esto es lo que tenés, y
esto te falta**". No es un simple listado de ofertas: cruza **todas** las ofertas detectadas
contra el perfil del usuario y produce recomendaciones accionables.

En el origen: `server/analytics.js` → `GET /api/analytics` → `frontend/src/components/AnalysisPage.jsx`.
Acá: `api/analytics.js`.

## Qué produce

`buildAnalytics(regions)` devuelve un paquete con:

| Bloque | Qué es |
|---|---|
| `candidato` | los datos del perfil del usuario (nombre, título, años, skills, proyectos) |
| `total` / `avgScore` | cuántas ofertas se detectaron y el match promedio |
| `byRegion` | por región: cantidad, match promedio y máximo |
| `skillStats` | **demanda de cada skill**: en cuántas ofertas aparece y qué % del total |
| `strongSkills` | las que el usuario **ya tiene** y el mercado pide (top 10) |
| `missingSkills` | las que el mercado pide y el usuario **no** tiene, con su % |
| `matchProjection` | simulación: qué passaría si sumara las skills que evidencia su GitHub |
| `recommendations` | las 6 recomendaciones accionables, con prioridad e ícono |

## Las recomendaciones y qué las dispara

Están en `buildRecommendations()`. La tabla del origen era esta, y **las 4 marcas de "NO"
son el motivo por el que este módulo se reescribió en el paso 6**:

| # | Ícono | Se disparaba cuando | ¿Servía para cualquier profesión? |
|---|---|---|---|
| 1 | 🔥 | hay brechas y `total > 0`. Nombra las 3 más demandadas | sí, pero dependía de `marketSkills` |
| 2 | 🎯 | agrupaba brechas por `SKILL_CLUSTERS` y elegía el área más pedida | **NO**: los clusters eran de tecnología/QA |
| 3 | 🗣️ | inglés aparecía en ≥20% de las ofertas | sí |
| 4 | 🏦 | banca/fintech/pagos aparecía en ≥20% de las ofertas | **NO**: el texto hardcodeaba el background de Ali |
| 5 | 📌 | había regiones con ofertas; mostraba la de mejor match promedio | inútil con **una sola región** |
| 6 | 💪 | había skills con ≥50% de demanda que el usuario ya dominaba | sí |

**Cómo quedaron (paso 6):** `buildAnalytics(regions, profile)` produce **3** recomendaciones
en vez de 6, y todas se derivan del cruce oferta×perfil. Las que dependían de una lista
fija (2 y 4) **no existen**: la brecha se agrupa por `skillStats` y no hay ninguna mención de
sector ni de país. Las que sobreviven son brechas, fortaleza, y proyección.

## Lo que había que generalizar — HECHO en el paso 6

En el origen este módulo leía `PROFILE` **directamente y en muchos lugares**, a diferencia de
`matcher.js` que al menos recibía el perfil. Todo eso está resuelto:

| Origen | Cómo quedó |
|---|---|
| `candidateSkills()` leía `PROFILE.marketSkills` + `PROFILE.skills` | `candidateSkills(profile)` (`:81`) |
| `githubSkillEvidence()` leía `PROFILE.projects` | `githubSkillEvidence(profile)` (`:106`) |
| `projectedProfile` hacía `{ ...PROFILE, skills: {...} }` | `buildAnalytics(regions, profile)` arma el perfil proyectado desde `p` |
| el bloque `candidato` leía nombre, título, años, ubicación, links | Lee de `p`, con `profileOrEmpty()` para el perfil ausente |
| **`SKILL_CLUSTERS`** (8 áreas fijas de tecnología) | **No portado.** La recomendación 2 se arma sobre `skillStats`, el cruce oferta×perfil. |
| **`paymentRe`** (regex de banca/fintech) y el texto "Tu background en banca digital" | **No portados.** Ninguna recomendación nombra un sector. |
| **`REGION_LABELS`** con 7 países | Sale de `regions.js` (que tiene solo Argentina). |
| Recomendación 5 con scope Argentina | Se genera desde `byRegion`, sin texto fijo de país. |

**Lo que sigue siendo regla**: si queda un solo helper leyendo un perfil global, los números
se calculan contra el CV de otra persona y la página muestra texto que no le pertenece al que
la está mirando. Si escribís un helper nuevo, que reciba `profile`.

Verificado: la salida de una contadora no menciona banca, fintech, pagos ni "Ali", y
`buildAnalytics(rank, null)` no explota.

## El map → array: la forma canónica es el array

En el origen, `analytics.js:284` hacía la conversión map → array en la respuesta:

```js
skills: Object.entries(PROFILE.skills).map(([name, weight]) => ({ name, weight }))
```

O sea que **la API ya exponía las skills como array `[{ name, weight }]`** aunque internamente
el perfil fuera un map. Ese fue el antecedente de decidir el **array** como forma canónica
(la duda abierta nº1 del proyecto, ya resuelta).

**Acá el array es la forma en los DOS lados**: `profile.js:normalizeSkills()` normaliza las
filas de la DB al array (y acepta el map por compatibilidad, así que un endpoint con la forma
vieja no rompe nada), y `analytics.js` lo recorre con `for (const skill of p.skills)`.

El modo de falla es silencioso: un `Object.entries(array)` no tira error, devuelve
`[['0', {...}]]`, y un `.filter(s => s.weight >= 0.9)` sobre el map lee `undefined`. El
resultado es **una lista de skills vacía sin ningún error en consola**. Si la UI muestra cero
skills, sospechá de la forma antes que de la query.

## `marketSkills` es el Ancestro de las brechas

La recomendación 1 y todo el bloque `missingSkills` salen de `marketSkills`, que es
`[{ name, has, aliases }]`: qué skills pide el mercado y cuáles de ésas tenés.

En el origen es un artefacto del análisis del CV de Ali. **Para un usuario nuevo no hay de
dónde sacarlo**, así que la propuesta de interés no puede construirse tal cual sin resolver
esa duda. Si `marketSkills` desaparece, `missingSkills` queda vacío y las recomendaciones 1 y
2 no se disparan: la página pasa a ser solo fortalezas y promedios.

## `matchProjection`: la función más interesante del módulo

Proyecta qué pasaría **si el usuario sumara las skills que evidencia su GitHub**: arma un
perfil hipotético con esas skills a peso `0.5`, recalcula el match de **todas** las ofertas y
compara el promedio. De ahí salen `delta` (cuánto subiría) e `improvedJobs` (cuántas ofertas
mejorarían).

Eso es un buen producto y es reutilizable tal cual, siempre que `PROFILE.projects` se
reemplace por los proyectos del usuario (o por un campo vacío). Es la función que menos
depende del hardcodeo de QA.

## Verificar un cambio acá

`node --check api/analytics.js`, `npm run build`, y después `/api/analytics` **con sesión
de un usuario real**. Lo que hay que mirar:

- [ ] Los datos de `candidato` son los del usuario de la cookie, no los de otra persona
- [ ] Un usuario **no-QA** recibe recomendaciones, no una página vacía
- [ ] Ninguna recomendación dice algo de la profesión o del país de otro usuario
- [ ] `strongSkills` y `missingSkills` no se contradicen (una skill no puede estar en las dos)
- [ ] Los % de `skillStats` suman coherente con `total`
- [ ] Sin sesión, `/api/analytics` devuelve **401**, no los datos de nadie

Para probarlo **no llames a `/api/linkedin-search`**: se factura por ejecución. `/api/analytics`
se alimenta de `/api/jobs`, que es gratis.