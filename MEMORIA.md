# MEMORIA.md — Contexto de trabajo

Archivo de memoria del proyecto. **No es documentación general**: para cómo está armado el
proyecto está `AGENTS.md` (instrucciones para agentes), que es donde vive la **tabla de la
API** porque **`README.md` está orientado a quien llega de cero** (qué hace, cómo correrlo, la
tabla de la API y qué falta); acá queda lo que **no se deduce del código**: el pedido original,
el diagnóstico del código heredado con su evidencia, las decisiones que se tomaron y lo que
quedó abierto.

Última actualización real: **2026-10-02** (el paso 8 del plan: los 6 endpoints de ofertas,
verificado contra un Postgres real — ver §0, §2.9, §4.8 y §6). Las actualizaciones
anteriores fueron el andamiaje, `regions.js`, el paso 4 de la base de datos completo, el
paso 5 de auth, el paso 6 (perfil por usuario), el paso 7 (onboarding) y la pantalla de
acceso.

---

## 0. DÓNDE QUEDAMOS — leé esto primero si volvés al proyecto

**Pasos 1 a 8 de 12 HECHOS y VERIFICADOS. El paso 9 es el siguiente.**

El traspaso quedó el **2026-10-02**, con `npm run check` y `npm run build` en verde. Hay un
**Postgres 16 corriendo en Docker** con las 11 migraciones aplicadas, usado solo para
verificar: `docker stop pg-migrate-check` para bajarlo.

### La frase que resume dónde está el proyecto

**La app muestra ofertas reales de bolsas gratuitas.** El paso 8 cerró el último hueco que
separaba "una app que anda" de "una app que sirve para algo": `/api/jobs` devuelve el
ranking real contra el perfil del usuario, y la caché lo hace barato (48× en la segunda
llamada).

### Lo que falta, en orden

| Paso | Qué | Por qué es el siguiente |
|---|---|---|
| 9 | Directorio de Argentina (punto 11), sin scraping: links de búsqueda prellenados con las keywords del usuario, **verificando cada URL** | **Es el siguiente.** Con el paso 8 hecho, es lo único que agrega alcance sin costo ni scraping. Lo escriben `linkedinSearchUrl()` y `consultoraSearchUrl()`, que ya están en `utils.js` (ver §3.7) |
| 10 | Apify con límite diario por usuario (`apifyLinkedin.js`, el regex de QA) | **Se factura**: es el paso que mete un tercer servicio de pago. Trae `buildProfileKeywords()`, que sigue con el filtro `/(qa\|quality\|test\|automation\|sdet)/i` (ver §3.1) y el `REGION_LOCATIONS` propio que hay que reemplazar por `REGIONS` |
| 11 | Borrar cuenta (un `DELETE`, ver decisión 9) | |
| 12 | Docs: `README`, `.env.example`, guía de Vercel | es lo que hace que la tabla de la API de `AGENTS.md` se pueda mover a un `README.md` de verdad |

**Aparte, y NO es un paso del plan: el directorio de consultas de LinkedIn
(`/api/linkedin-search`)** es el paso 10. Y lo único que quedó a medio camino **dentro** del
paso 8 es `favorites`: la tabla existe (migración `006`) y **ningún endpoint la usa**, pero
tampoco hay un botón de "guardar oferta" en el frontend que la consuma, así que no es un
contrato roto: es una tabla esperando a que alguien la use.

### El único módulo del origen sin portar

`apifyLinkedin.js`, que vive en `F:\busqueda_trabajo\server\` y **se puede leer y copiar**.
Los que hay que dejar atrás: `consultoras.js`, `consultorasStore.js`, `curatedJobs.js`,
`demoData.js` (ver §3.6).

**Ya portados**: `analytics.js`, `coverLetter.js` y `matcher.js` reescritos y
parametrizados (paso 6); `cvProfile.js` **no se copió**, lo reemplaza `api/lib/profile.js`;
y en el paso 8 se portaron **`jobSources.js`, `portal.js` y `history.js`** a
`api/lib/`, con `api/lib/jobs.js` como orquestador nuevo.

### Los dos avisos para cuando se retome

1. **El frontend NO se tocó en el paso 8**, y esa es la decisión que hace posible el paso:
   el contrato de los 6 endpoints es EXACTAMENTE el del origen (`region`, `jobs`, `total`,
   `_online`), así que el consumidor heredado sigue sirviendo sin una sola línea de cambio.
   `source` y `checkedAt` son lo único agregado, y son aditivos (§2.9).
2. **El riesgo que tenía el paso 6 sigue RESUELTO y verificado, y ahora con la preuve
   numérica**: el filtro de relevancia de `matcher.js` (`isQARelevant`, §3.9-A) devolvía score
   0 para toda oferta de un contador o una enfermera. Con datos reales, el mismo código
   rankea **118 ofertas para el perfil de QA, 13 para el de Chef y 0 para el de Enfermera**
   (§2.9, el hallazgo que parece un bug y no lo es; cifras previas al arreglo de Jobicy de
   §4.10, que cambió el total de QA). La fórmula intacta y cómo se generaliza
   están en la skill `.opencode/skill/comparar-match/`.

> **Ojo con el nombre**: este archivo existe también en el origen (`F:\busqueda_trabajo`),
> pero **no se copió**: aquel era andamiaje de trabajo del proyecto anterior (diagnóstico
> del bug de las 50 ofertas, trabajo de frontend a medio hacer). Este es nuevo.

---

## 1. El pedido original

El usuario pidió, textualmente, crear un repositorio **nuevo** `busqueda-empleo-ia`
partiendo de `busqueda-trabajo` (que está **adjunto y sigue existiendo**), para desplegar
en **Vercel**, convirtiendo la app de un solo usuario fijo (Ali Tovar, QA) en
**multiusuario, cualquier profesión, con login seguro**. Alcance inicial: **solo
Argentina**.

"MANTENER": frontend React 18 + Vite, `jobSources.js` (fuentes gratis), `matcher.js`
(`computeMatch`), cartas de presentación, historial. Convenciones: comentarios en español
explicando el porqué, 2 espacios, comillas simples, punto y coma. Regla de Apify: nunca
llamar `/api/linkedin-search` en pruebas ni CI.

Los 14 puntos, textual:

| # | Pedido |
|---|---|
| 1 | Reemplazar `node:http` por funciones serverless en `/api` (Node ESM). Frontend estático. Configurar `vercel.json` y `maxDuration`. |
| 2 | Sin disco persistente: Postgres (Neon o Supabase). Tablas `users, profiles, skills, searches, job_history, favorites`. Todo filtrado por `user_id`. Incluir migraciones SQL. |
| 3 | No guardar el CV en disco: extraer texto en memoria y guardar solo los datos del perfil (o Vercel Blob). |
| 4 | Auth: registro/login (correo + clave con bcrypt o argon2), sesión por cookie HttpOnly+Secure+SameSite con expiración, logout, rate limit de login. Sesiones simultáneas: cada usuario ve solo sus datos. |
| 5 | Reemplazar el `PROFILE` global de `cvProfile.js` por perfil por usuario. `computeMatch`, `analytics`, `coverLetter`, `apifyLinkedin` y `jobSources` reciben el perfil como parámetro. |
| 6 | Onboarding: tras el primer login pedir el CV (PDF/DOCX). Extraer con un LLM (clave en `LLM_API_KEY`, proveedor configurable) un JSON `{ fullName, title, yearsExperience, summary\|null, photo\|null, location, skills:[{name, weight}] }`. Mostrar formulario de revisión/edición antes de guardar. Foto y "sobre mí" quedan vacíos y editables si el CV no los trae. |
| 7 | Generar keywords de búsqueda desde las skills del usuario (ya no fijas en QA). |
| 8 | Búsqueda manual: filtros de área/profesión, palabras clave, y botón "Ampliar búsqueda a otra área" que suma keywords **sin tocar el perfil**. |
| 9 | Región: solo Argentina por ahora, pero dejar las regiones en **una sola configuración** para agregar países después. |
| 10 | **ELIMINAR**: `consultoras.js`, `consultorasStore.js`, la pestaña "consultoras" y su tracker. |
| 11 | **AGREGAR** un directorio de Argentina, sin scraping: bolsas (LinkedIn, Indeed Argentina, Computrabajo, Bumeran, Get on Board, Jooble) y consultoras de selección/staffing (Adecco, Manpower, Randstad, Hays, Michael Page, Kelly). La app genera un **enlace de búsqueda prellenado** con las keywords del usuario. **Verificar que cada URL siga vigente.** |
| 12 | Apify: la clave la pone el dueño en `APIFY_API_TOKEN`. Límite diario de búsquedas de LinkedIn por usuario (configurable). |
| 13 | Seguridad: validar tipo y tamaño del CV, permitir borrar cuenta y datos, secretos solo en variables de entorno. |
| 14 | Documentación: `README`, `.env.example` (`DATABASE_URL`, `SESSION_SECRET`, `LLM_API_KEY`, `APIFY_API_TOKEN`, `APIFY_DAILY_LIMIT`), `AGENTS.md` y una guía de despliegue en Vercel paso a paso. |

El usuario cerró el pedido con: **"Antes de programar, dime tus dudas."**

---

## 2. Estado real del repositorio

**Paso 1 del plan (andamiaje) HECHO el 2026-09-30.** El andamiaje quedó armado y verificado:

```
package.json          raíz, type: module, scripts check/build/dev/migrate
  workspaces           ["frontend"]   ← ver la trampa de §2.1
vercel.json           buildCommand, outputDirectory: frontend/dist, maxDuration 30
.gitignore            .env, node_modules, frontend/dist, .vercel
.env.example          las 5 variables del punto 14 + APIFY_MAX_RESULTS
scripts/check.js      node --check archivo por archivo sobre api/ y scripts/
frontend/             copia intacta del origen (12 archivos, 42 módulos)
```

Verificado con `npm install` limpio (105 paquetes, un solo comando), `npm run check` (OK) y
`npm run build` (42 módulos, 191 KB JS, 21 KB CSS).

**Paso 2 (configuración única de regiones) ESCRITO y MEDIO CABLEADO, el 2026-09-30.**
`api/lib/regions.js` (225 líneas) existe y pasa `node --check`. Exporta `REGIONS` (solo
`argentina`), `DEFAULT_REGION`, `normalize()`, `isValidRegion()`, `regionLabel()`,
`emptyBuckets()` y `matchRegion()`.

**Del lado del frontend está cableado**: `utils.js` deriva `REGION_LOCATION` de `REGIONS`,
`RegionTabs.jsx` genera las pestañas con `Object.keys(REGIONS)` y `App.jsx` usa
`regionLabel()`. **Del lado del backend todavía no**, porque los módulos que lo importarían
siguen únicamente en `F:\busqueda_trabajo\server\`: `matcher.js`, `analytics.js` y
`apifyLinkedin.js`. Se importa del backend cuando se porten (pasos 6 y 8).

Ojo: el plan decía solo "crear la config de regiones", pero al escribirla se fusionaron
**las dos funciones de detección** que existían en el origen (`guessRegionFromText()` de
`jobSources.js` y `assignRegion()` de `matcher.js`) en una sola `matchRegion()`. Ver la
decisión 8 en §4.

**Paso 4 (DB) HECHO Y VERIFICADO el 2026-09-30, contra un Postgres 16 real, no solo
escrito.** El plan pedía 6 tablas; hay **7 tablas y 8 archivos de migración**:

```
migrations/001_users.sql                     users
migrations/002_profiles.sql                  profiles
migrations/003_skills.sql                    skills
migrations/004_searches.sql                  searches
migrations/005_job_history.sql               job_history
migrations/006_favorites.sql                 favorites
migrations/007_apify_usage.sql               apify_usage        (límite diario de Apify)
migrations/008_searches_user_created_at_idx.sql                    ← NO estaba en el plan
scripts/migrate.js                           runner (el que package.json declaraba y no existía)
api/lib/db.js                                el ÚNICO lugar que abre conexiones
```

**El alcance real: son 8 archivos y no 6, y el octavo existe por un defecto del séptimo.**
`004_searches.sql` **describía** el índice `searches_user_created_at_idx` a lo largo de medio
bloque de comentarios y **nunca lo escribió**: después del último comentario del archivo venía
el EOF. `\d searches` lo delata, `searches` era la única tabla sin índice por `user_id`. Se
corrigió con `008` y **no** editando el `004`, porque el runner aborta si un archivo ya aplicado
cambia de checksum, y su propio mensaje dice qué hacer en ese caso ("escribí una migración
nueva"). Menos mal que todavía no había un deploy real: ahora la corrección funciona sobre
cualquier base, la que tiene el `004` aplicado y la que no.

Qué hace `scripts/migrate.js`, y por qué importa: mete **cada archivo en su propia transacción**
junto con el INSERT de su registro, así que un `.sql` a medio aplicar deja el archivo pendiente
y volver a correr es seguro. El registro es `(filename, sha256 de los BYTES CRUDOS)` — leer el
archivo como `Buffer` y no como string es a propósito, para que el hash no dependa del BOM ni
de los finales de línea. Toma un `pg_try_advisory_lock` **de sesión** con un cliente reservado
para toda la corrida (si se pidiera con `query()` a pelo, el pool devolvería el cliente y el
lock se quedaría colgado), y avisa cada medio segundo si hay otro runner en vez de parecer
colgado.

**Verificación real (Postgres 16 en Docker, `localhost:55432`, `?sslmode=disable`):** las 8
migraciones aplicadas una tras otra y **la idempotencia confirmada** — correr `npm run migrate`
de nuevo sobre la base ya migrada responde `0 aplicada(s), 8 ya estaba(n)` y sale con código 0.
Las 7 tablas quedaron en `count = 0`, que es el estado correcto: el plan **no incluye migración
de datos** (§5-1 y §5-2 siguen abiertas).

`api/lib/db.js` es el **único** lugar del proyecto que abre conexiones, y por diseño **no
conecta al importarse**: el pool se crea la primera vez que alguien consulta de verdad, y
`DATABASE_URL` se valida adentro de `getPool()`, no al cargar el módulo. Eso es lo que
permite que **`/api/health` siga respondiendo sin base de datos**, que es el smoke test del
deploy. Notarlo ahora es importante: es la restricción que todos los endpoints van a
heredar y no es evidente.

### 2.1 La trampa del workspace, y por qué `frontend` NO es una carpeta suelta

En Vercel **solo se ejecutan las instrucciones de la raíz**: no existe un
`npm install` dentro de `frontend/`. Si `frontend` fuera una carpeta independiente, `vite`
no estaría instalado y **el `buildCommand` fallaría en cada deploy**.

Por eso la raíz declara `"workspaces": ["frontend"]`: un solo `npm install` instala los dos
lados. Consecuencia: **no existe `frontend/node_modules`**, todo queda hoisted en el
`node_modules` raíz. Para agregar una dependencia del frontend se corre `npm install <pkg>`
desde la raíz.

El `npm run build` de la raíz es `npm --prefix frontend run build`. Funciona igual con
workspaces porque npm agrega el `.bin` de los directorios padre al `PATH`.

### 2.2 Dependencias elegidas, y por qué

| Paquete | Para qué | Por qué este |
|---|---|---|
| `pg` | Postgres (Neon) | el driver oficial; el pooler lo resuelve la URL |
| `bcryptjs` | hash de contraseñas | **JS puro, cero módulos nativos**. En Vercel los binarios nativos fallan en *runtime*, no en build, y ese modo de fallo es muy feo de diagnosticar. Upgrading a `@node-rs/argon2` queda como mejora futura. |
| `pdf-parse` | extraer texto del PDF | JS puro |
| `mammoth` | extraer texto del DOCX | JS puro. El punto 6 pide PDF **y** DOCX. |
| — LLM | parsing del CV con IA | **sin SDK**: se hace con `fetch` contra la API OpenAI-compatible, que es lo que casi todos los proveedores exponen. Menos dependencias y "proveedor configurable" sale gratis. |

El CLI de Vercel **no** es dependencia: se usa con `npx vercel dev`. Son ~100 MB y no vale
la pena bajarlos en cada `npm install`.

El origen `F:\busqueda_trabajo` está en `main`, árbol limpio, último commit
`036f01d "Mejora y IA"`. **Se puede leer y copiar de ahí.** Tiene 13 módulos en `server/`
(~200 KB) y 12 archivos en `frontend/src/` (~190 KB).

Entorno verificado: Node **v24.21.0**, npm **11.6.4**, **no hay Vercel CLI instalado**
(`vercel` no está en el PATH).

### 2.3 Detalle de la copia, para que nadie lo repita

Al copiar `frontend/src` con PowerShell, `Copy-Item -LiteralPath ... -Recurse` volcó el
**contenido** de `src/` en la raíz de `frontend/` en vez de crear `frontend/src/`. El build
falló con `Rollup failed to resolve import "/src/main.jsx"`. PowerShell copia el *contenido*
cuando el destino ya existe. Si copiás carpetas, creá el destino primero y después mové.

### 2.4 La trampa del type parser de `NUMERIC`: un defecto que NO se descubre solo

`migrations/003_skills.sql:49-54` dejaba escrito, textual, el handoff para el que escribiera
`db.js`, y **no se cumplió**: faltaba
`pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number)`. El handoff estaba en el archivo
correcto y era imposible no verlo al escribir el pool; lo que pasa es que **al escribir el pool
nadie lee los comentarios de las migraciones**.

Medido contra la base real, con y sin la línea:

```
                     SIN la línea                                CON la línea
skills.weight        "0.900"  typeof: string          →     0.9     typeof: number
profiles.years_...   "5.5"    typeof: string          →     5.5     typeof: number
.toFixed(2)          TypeError: w.toFixed is not a function  →  "0.90"
weight * 100         90  (SIN ERROR)                  →     90
```

**La fila `weight * 100` es la que hace peligroso el defecto**: `*` coerce la string en
silencio, así que **la mitad de los usos del dato funcionan con el bug presente**. La fórmula
del score de `matcher.js` multiplica, así que un test que solo mira el score da **verde con el
defecto ahí**. El mismo dato revienta recién cuando la UI lo formatea. Es la clase de defecto
que vuelve cada vez que alguien "optimiza" `db.js` y saca la línea: no la está usando, está
evitando un error que todavía no se vio.

Lo que hace falta saber para no meter la pata de nuevo:

- **Va a nivel de módulo**, apenas arriba del import. `setTypeParser` es un ajuste **global** del
  driver, no una opción de conexión: ponerlo adentro de `getPool()` lo deja en un camino que se
  puede saltear.
- **`Number('')` es `0` y `Number('abc')` es `NaN`**, así que un parser ingenuo convierte "sin
  dato" en "peso 0", y en el match de skills un peso **ausente** no es lo mismo que un peso
  **0 real** (uno es "no lo declaraste", el otro es "lo declaraste en cero"). No hace falta
  blindarlo: `pg` ni le llama al parser a un NULL. `pg/lib/result.js:63-76` corta antes con
  `if (rawValue !== null) ... else row[campo] = null`, y `_parseRowAsArray:50-61` hace lo mismo
  para filas como array. Verificado contra la base real: un `numeric` NULL llega como `null`.
- **Solo `NUMERIC`.** `int8`/`bigint` también viene como string y es **a propósito**: un int64
  no cabe exacto en un `number` de JS (2^53), así que parsearlo convierte ids y contadores
  grandes en números que ya no son el número que uno cree. `int4`, `float4` y `float8` ya
  llegan como number y no hay nada que arreglar. NUMERIC es el único decimal roto del esquema.

### 2.5 El status de `HttpError` va primero, y un `throw` sin status NO se descubre solo

Esto pasó de verdad en el paso 5 y es la trampa más silenciosa que se haya encontrado en el
proyecto. `HttpError` es `new HttpError(status, mensaje, extra?, headers?)`, y dos `throw` de
`auth.js:readCredentials` se escribieron sin el `400`:

```js
throw new HttpError(`La clave tiene que tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
// → status: "La clave tiene que tener al menos 8 caracteres."
```

El modo de falla es el peor posible, porque **nada parece roto**:

- El endpoint **responde**. `sendJson(res, err.status, ...)` manda el status que le pasaras.
- El **cuerpo es el mensaje correcto**: el usuario ve "La clave tiene que tener al menos 8
  caracteres." y entiende todo.
- El **código HTTP es una frase en español**, que ningún cliente, proxy ni monitor sabe
  interpretar. Se cachea como respuesta normal, no como error.

O sea: el mensaje llega, la validación funciona, y lo único roto es algo que casi nadie mira.
`npm run check` lo daba verde (es JavaScript válido) y los tests que solo miran el cuerpo
daban verde. Recién cuando la prueba comparó `res.statusCode === 400` salió a la luz.

Por eso el constructor **verifica el status** y tira un `TypeError` si el primer argumento no
es un entero entre 400 y 599. Convierte un defecto silencioso en un error de desarrollo ruidoso
y localizado, que además no depende de que alguien se acuerde de escribir el status.

Regla para todo `throw` de `http.js`, `auth.js` y `rateLimit.js`: **el status va primero y
siempre**. Si el mensaje es lo primero que escribís, es señal de que falta el status.

### 2.6 `Retry-After` es un header, no un campo del JSON

El 429 del rate limit devuelve `retryAfterSeconds` **en el cuerpo y como header**. Solo con
el body se veía "suficiente": el mensaje del 429 se armaba, y el comentario del código
decía *"El header `Retry-After` en segundos es lo que leen los clientes bien escritos"*
cuando ese header no existía. Un `Retry-After` ausente en un 429 (RFC 6585) hace que un
cliente con backoff reintente a ciegas: no tiene de cuánto esperar.

La solución fue darle a `HttpError` un **cuarto** parámetro `headers`, aparte de `extra`, y
que `withErrorHandling` lo pase a `sendJson`. Se los separa de `extra` a propósito: un campo del
cuerpo y un header son dos canales distintos, y metidos en la misma bolsa uno termina
confundido con el otro. Por eso el 429 lleva los dos: el body para el frontend, que lo
traduce a un mensaje en pantalla, y el header para los clientes que no parsean JSON.
**El frontend lee solo el body** (`api.js:apiError`): es el canal que esta misma decisión le
reservó, y leer el header obligaría a pasarle el `Response` entero a la función.
### 2.7 Los 7 países que quedaban en el frontend, y por qué el fallo es SILENCIOSO

El paso 3 limpió el frontend, pero dejó las regiones repetidas en 4 lugares más, porque
"el frontend no podía importar la config del backend". **Sí puede**: `vite build` resuelve
imports fuera del root del workspace sin problema, y `api/lib/regions.js` es JS puro sin
dependencias de Node. Medido: `frontend/src/utils.js` importa
`../../api/lib/regions.js`, el build sigue en verde con 42 módulos y el bundle **bajó**
1.24 kB (185.67 kB contra 186.91 kB) al borrar los mapas duplicados.

Lo que se redujo a Argentina y de dónde sale ahora cada cosa:

| Antes (copia a mano) | Ahora |
|---|---|
| `utils.js:540 REGION_LOCATION` (7 países) | derivado de `REGIONS` con `Object.fromEntries` |
| `RegionTabs.jsx:4 TABS` (7 países con bandera) | `Object.keys(REGIONS)` + `regionLabel()` |
| `App.jsx:45 REGION_NAMES` (7 países) | `regionLabel()`, que ya cae a la clave cruda |
| `AnalysisPage.jsx:6 flagRegion()` (7 banderas) | `utils.js: regionFlag()`, con un globo de respaldo |
| `api.js:35 FALLBACK.jobs.europa` / `.eeuu` | borrados |

**Lo único que NO se derivó es la bandera emoji**, y es a propósito: es decoración de la
interfaz, no configuración del dominio, y meter emojis en el módulo compartido obligaría al
backend a saber de banderas. Queda un `REGION_FLAG` de una entrada en `utils.js`, con `🌎`
de respaldo, así que un país nuevo aparece en las pestañas y en la analítica sin que haya
que tocar nada.

**El detalle del path, que rompió el build la primera vez:** `utils.js` y `App.jsx` están en
`frontend/src/` y necesitan **dos** `..`; `RegionTabs.jsx` está en `frontend/src/components/`
y necesita **tres**. Con dos, Vite dice `Could not resolve "../../api/lib/regions.js"`.

**Lo que NO se tocó y queda pendiente:** `JobDetailModal.jsx:65`
(`langIsEn = region === 'europa' || region === 'eeuu'`). Con Argentina-only **siempre da
false**, así que la rama de UI en inglés está muerta. Se conservó en vez de borrarse porque
si algún día entra un país de habla inglesa el idioma tiene que salir del `lang` que ya
está en `regions.js`, no de una comparación escrita a mano: es un paso propio, con sus
textos y sus firmas de `jobDestination`/`noDestinationText`.

### 2.8 `linkedinProfileKeywords()`: el criterio de la query, y por qué el de antes no servía

El filtro de QA (`/(qa|quality|test|automation)/i` sobre el nombre de la skill) **se
eliminó**, y con él la premisa de que el regex iba a decir qué es relevante. Para un
contador o una enfermera dejaba la lista **vacía** y la query de LinkedIn salía en blanco.

**Criterio elegido: `profile.keywords` (vocabulario de búsqueda del puesto, que genera el
LLM al leer el CV, punto 7 del pedido) + las skills de peso `>= 0.9`, agrupadas sin
repetidos, con las frases de varias palabras entrecomilladas.** El por qué de ese orden: las
`keywords` son lo más parecido a "cómo se llama este trabajo" y por lo tanto lo que menos
ruido mete; las skills de peso alto son el respaldo cuando el CV no trajo `keywords`, y el
peso es la única señal genérica que existe — **un número, no un nombre**, que es lo único
que puede significar "relevante" en una app de cualquier profesión.

El filtro de `/^sdft$/i` **se conservó** aunque su origen (los `keywords` de Ali) ya no
exista: es una normalización barata, no depende de la profesión de nadie, y un término que
no está en ningún aviso de empleo solo ensucia la búsqueda.

Medido con perfiles de prueba (módulo real, sin red):

```
contador (keywords + skills)  -> (contador OR contadora OR conciliacion OR Excel OR impositiva)
enfermera (skills peso 0.6)   -> (enfermeria OR enfermero)
perfil sin CV                -> ""
skills con la forma VIEJA     -> (qa)      ← degrada, no rompe
'sdft' + repetidos + vacíos   -> (Contador OR Excel)
```

**Y el modo de falla que hay que vigilar (es el de §2.4, otra vez):** el backend manda la
forma. Si manda el mapa `{ 'qa': 1 }` en vez del array, `Array.isArray()` no revienta y
`linkedinProfileKeywords()` cae a las `keywords` solas — **la UI muestra cero skills, sin
un error en consola**, y el resto de la app anda normal. `Object.entries(array)` tampoco
tira error: devuelve `[['0', {name, weight}], ...]`. Blindado con `Array.isArray()`, pero
blindar no es avisar.

### 2.9 El paso 8: la caché en memoria se volvió SQL, y `_online` se cacheó con ella

**HECHO y VERIFICADO el 2026-10-02.** Son 12 archivos: `api/lib/jobSources.js`,
`api/lib/portal.js`, `api/lib/searchTerms.js`, `api/lib/history.js`, `api/lib/jobs.js`, los
6 endpoints (`api/jobs.js`, `api/job.js`, `api/history.js`, `api/refresh.js`,
`api/cover-letter.js`, `api/analytics.js`) y `migrations/011_searches_online.sql`.

Lo que hace el orquestador es `getRanked(userId, profile, { force, region, keywords })` →
`{ regions, _online, source, checkedAt }`, y el orden interno es **caché primero, bolsas
después** (`jobs.js:497` y `:522`): el camino de la caché son dos queries de milisegundos y el
de las bolsas son cinco requests de red cuyo peor caso son 20 segundos.

#### La caché: qué reemplaza a qué

| Origen (`F:\busqueda_trabajo\server\index.js`) | Acá |
|---|---|
| `cache.regions` + `cache.at` (`:97`) | la fila más reciente de `searches` de ese usuario, y su `created_at` como reloj — `lastRun()` (`jobs.js:297`) |
| las ofertas de `cache.regions` | las filas de `job_history` con `last_seen >= created_at` de esa corrida — `jobsOfLastRun()` (`jobs.js:348`) |
| `cache.online` | la **columna `searches.online`** (migración `011`) |
| `refreshing` (`:100`) | **nada**, y está bien: no se puede portar |
| `lastApifyJobs` (`:110`) | el `job_history` del usuario, por `user_id`. Era el **fallback de `/api/job`**: en el origen `findById` (`index.js:224`) buscaba ahí las ofertas de la última corrida de Apify, que no estaban en `data.regions` |

El TTL es `CACHE_TTL_MS` (`jobs.js:147`, 30 minutos, el mismo del origen) y se compara
contra el `created_at` **de la base**. Es una decisión, no un descuido: el reloj de la corrida
es el de Postgres, así que dos requests concurrentes no pueden discrepar sobre si la caché
venció — que es exactamente lo que pasaba con `Date.now()` guardado en un objeto de módulo.

**`POST /api/refresh` existe por esto y no por otra cosa.** El botón "Actualizar búsqueda"
del frontend heredado (`App.jsx`, `handleRefresh`) lo único que hace es saltear el TTL. Sin
`force`, ese endpoint sería un no-op: leería la caché que escribió la corrida anterior y
devolvería lo mismo con otro `checkedAt`. Por eso `refresh.js:100` pasa `force: true`, y por
eso su respuesta manda `source`, que tiene que ser siempre `'live'` ahí — si alguna vez
devuelve `'cache'`, el `force` dejó de pasar y el botón es un no-op silencioso.

#### `_online` es un dato DE LA CORRIDA, y por eso es una columna

La migración `011` no es un lujo: es lo que hace que el caso más importante de todos sea
barato. Sin fila de `searches`, `lastRun` devuelve `null` y cada request vuelve a pagar las
cinco bolsas; y el peor caso es justo **`_online: false`**, donde no se puede cachear NUNCA el
aviso de "no pudimos contactar las bolsas" y cada request del usuario paga los 20 s de red
completos, para siempre. `recordSearch` escribe la fila de `searches` **siempre**, incluso con
cero ofertas (`jobs.js:567-591`).

Y `_online` es **siempre** el de `fetchJobs`, nunca "hubo ofertas" (`jobs.js:612-616`): son
dos hechos distintos, y confundirlos muestra "no pudimos contactar las bolsas" a alguien a
quien las bolsas le contestaron perfecto y no tiene nada para su perfil.

#### Lo que NO se re-rankea desde la base, y por qué

`recordSearch` borra los campos del match antes de serializar (`CAMPOS_DEL_MATCH`,
`history.js:457`; la función que lo hace es `sinCamposDeMatch`, `history.js:716`, y devuelve
una **copia**). Así que el `jsonb` no tiene `score`, y el camino de caché **re-rankea siempre**
contra el perfil de HOY (`jobs.js:511`). El motivo es el mismo que en `/api/job`: **el perfil
se edita, y un `score` guardado es rancio**.

#### El contrato: no se tocó el frontend

Es la decisión de diseño que hizo posible el paso. Los 6 endpoints devuelven **exactamente**
el shape del origen, porque el consumidor (`frontend/src/api.js`, `App.jsx`) ya existe y no
se toca:

| Endpoint | Cuerpo | Lo único agregado |
|---|---|---|
| `GET /api/jobs?region=` | `{ region, jobs, total, _online }` (`index.js:250-256`) | `source`, `checkedAt` |
| `GET /api/job?q=` | `{ job, summary }` | — |
| `GET /api/history?region=` | `{ region, jobs }` (`index.js:363`) | — |
| `POST /api/refresh` | `{ ok: true }` | `_online`, `at`, `total`, `source` |
| `GET /api/cover-letter?region=&id=` | lo que devuelve `generateCoverLetter`: `{ lang, region, subject, body }` | — |
| `GET /api/analytics` | la propuesta de interés | — |

`source` y `checkedAt` son **aditivos**: no lo pide ningún consumidor, y existen para que se
pueda **verificar que la caché funciona**, que es lo único que se puede hacer con una
variable que no existe (no hay logs, no hay métrica, no hay profiler en una función
serverless). Medido: **118 ofertas en 1682 ms** en la primera llamada, **las mismas 118 en
35 ms** en la segunda (`source: 'cache'`). 48× es el número con el que se midió que el
reemplazo de la caché en memoria por SQL funciona.
**OJO: esas dos cifras quedaron desactualizadas por el arreglo de Jobicy (§4.10)**, que hizo
que esa bolsa pasara de aportar 0 ofertas a aportar 50 — y el perfil de ejemplo es justo el
titulado "QA". El total actual es mayor y **no se volvió a medir**: lo que sí sigue valiendo
es el `source: 'cache'`, porque la caché no depende de cuántas bolsas respondan.

#### Lo que NO se comió el paso: el error de `/api/history`

El origen hacía `catch { sendJSON(res, 200, { region, jobs: [] }) }` (`index.js:364`). Se
quitó, y es una de las mejores decisiones del paso: la respuesta vacía es **indistinguible** de
"todavía no tenés historial", `App.jsx` muestra ese texto (una afirmación FALSA para alguien
con tres meses de búsquedas), y el problema real —la tabla no está, se cayó la conexión, no
corró una migración— queda escondido detrás de una pantalla que parece normal. Ahora el error
sube a `withErrorHandling` y sale **500** con el detalle en el log del servidor. Un 500
visible es infinitamente más útil que un 200 que miente.

Por la misma lógica, `/api/history` **no vuelve a enriquecer**: lo que se guarda en el `jsonb`
ya viene enriquecido, porque `lib/jobs.js` llama a `enrichJobs(jobs)` **antes** de rankear y
de guardar (`jobs.js:529`). Y no re-rankea: el historial es la lista de lo que el usuario
**vio**, con `active`/`firstSeen`/`lastSeen` y **sin `score`**.

#### Cifras verificadas

Las **dos** baterías corrieron contra un Postgres real con cookie firmada de verdad vía
`createSessionToken`: la de quien escribió el código (68 aserciones) y la del subagente que lo
revisó (120 aserciones). **Las dos, 0 fallos.** Más `npm run check` (**OK: 33 archivos**,
antes 26) y `npm run build` (44 módulos).

Además de las cifras de arriba: las 6 compuertas (sin cookie → **401** en los 6; con cookie y
sin perfil → **403** + `profileComplete: false`; cookie manipulada → 401),
`GET /api/job?q="'; drop table users; --"` → **404 y no 500**, y el aislamiento entre usuarios
(una oferta del usuario QA da **404** para la enfermera; `?user_id=` en la URL **se ignora**).

Detalles de contrato que salieron de ejercitarlo y que no se deducen del código:

- **`_online` llegó `true` con Arbeitnow devolviendo HTTP 429.** Es `allSettled` en
  `jobSources.js`: `_online` se pone **por petición**, no por fuente. Así que una bolsa que
  agota su cuota no dice "no se pudo contactar Remotive". Y `/api/jobs` **nunca** da 500 por
  culpa de la API de una bolsa: cada fetcher se traga su propio error.
- **`/api/analytics` blinda `githubEvidence.projects` SIEMPRE como array** (aunque vacío),
  porque `AnalysisPage.jsx:186` hace `skill.projects.map(...)` sin `|| []` adentro: un item
  sin ese campo no muestra una fila vacía, **tira la excepción de render y se cae la pestaña
  de análisis entera**. El guard va en el endpoint y no en el `.jsx` por la misma razón que
  `_online`: el endpoint es donde se DECLARA el contrato, y el frontend heredado no se toca.
- `candidato.skills` llega como **array** `[{ name, weight }]` con `weight` **numérico**,
  merced al type parser de `db.js` (§2.4): es un ajuste **global** del driver, no un casteo
  del endpoint. Perfil **sin** skills → 200 con `skills: []`.
- **Región inexistente → 200 con la región por defecto**, nunca 400: `resolveRegion()`
  normaliza antes de usar el valor.

#### El hallazgo que parece un bug y NO lo es: 118 / 13 / 0

Con perfiles de prueba contra las bolsas reales: **QA 118 ofertas, Chef 13, Enfermera 0.**
**Cifras del paso 8, antes del arreglo de Jobicy (§4.10)**: el total de QA ya no es 118
porque Jobicy pasó de aportar 0 a aportar 50. La conclusión de abajo no cambia, pero los
números hay que volver a medirlos si se los quiere citar.

Lo primero que cualquiera va a leer es "el matcher rompió a las profesiones no técnicas". Es al
revés, y por eso vale la pena dejarlo escrito:

- **Lo que demuestra es que el matcher rankea de verdad.** Devolvió tres números distintos
  para tres perfiles distintos: no hay forma de que un matcher que devuelve un número
  constante, o que matchea contra un perfil global, produzca 118/13/0. La generalización del
  paso 6 (§3.9-bis) está **verificada con datos reales**, que es más de lo que se había
  verificado antes (la batería del paso 6 era sintética, sin red).
- **Lo que explica el 0 es el idioma, no el código.** Las 5 bolsas son gratuitas y
  mayormente **en inglés y globales**. Un perfil con `skills: enfermería, cuidados` y
  `keywords: ['salud']` genera términos de búsqueda en español, y "enfermería" no matchea una
  descripción en inglés. El 13 del Chef es el mismo efecto a menor escala (las bolsas tienen
  más oferta de cocina que de enfermería).
- **El problema de fondo NO se resuelve en este paso.** Que no haya bolsas gratuitas en
  español para el mercado argentino es un paso propio, y depende de una decisión que todavía
  no se tomó (¿qué bolsa pública y gratuita en español se integra, o el paso 9 del directorio
  es la respuesta?). Queda anotado en §5, duda 8.

### 2.10 El filtro de retención NO está en `history.js`, y el comentario que lo decía ya está corregido

Es un hallazgo del paso 8 y es el tipo de cosa que se descubre al portar, porque el código
heredado mezclaba dos responsabilidades en una función.

**El origen** (`F:\busqueda_trabajo\server\history.js:421-452`) tenía `expireOldJobs(rankedByRegion)`
que hacía DOS cosas: filtrar de las ofertas de la búsqueda actual las ya vencidas (para que
la respuesta no las mostrara) Y borrar las vencidas del archivo.

**Acá la segunda queda entera y la primera se mudó.** `expireOldJobs(userId)`
(`history.js:876`) **solo borra**, y su firma pasó a ser `(userId)` porque ya no recibe
buckets. El filtro de visibilidad vive en `dentroDeRetencion(enriched, now)`
(`jobs.js:417`), aplicado sobre la lista **enriquecida** justo antes de rankearla.

**Por qué no podía quedarse adentro**, y por qué el comentario viejo era falso:

1. `rankByRegion` y `matchRegion` filtran por **región** y por `score > 0`. Ninguno de los
   dos criterios **sabe de antigüedad**. No era cierto que "el filtrado ya lo hizo
   `rankByRegion`/`matchRegion`".
2. Una oferta publicada hace ocho meses que la bolsa sigue listando entra al ranking; su
   `expires_at` queda en el pasado; `recordSearch` la upserta igual (el `on conflict` no mira
   el vencimiento); y la purga que va **en la misma transacción** la borra de nuevo.
3. El resultado es una oferta que `/api/jobs` **muestra** y `/api/history` **nunca muestra**:
   el mismo objeto, en dos endpoints del mismo proyecto, con resultados opuestos.

Por eso el filtro está en el módulo que **arma la lista visible** y no en el que la purga.
Y por eso `dentroDeRetencion` **reusa `expiresAtFor`** (`history.js:298`), que es el espejo en
JS de la misma regla que aplica el SQL del upsert
(`coalesce(pub, first_seen) + make_interval(months => 6)`): **no hay una tercera definición
de "seis meses"**. Si algún día alguien copia esa regla a mano en un tercer lugar, el
proyecto tiene tres verdades y dos no coinciden.

**El comentario de `history.js` se corrigió, y conviene saber que se corrigió.** El bloque
JSDoc de `expireOldJobs` (`history.js:839-874`) afirmaba la cosa falsa; ahora dice la verdad,
explica los tres puntos de arriba y apunta a `dentroDeRetencion` en la línea 846.

**Un detalle que quedó viejo y hay que arreglar cuando se toque `jobs.js`**: el comentario de
`jobs.js:385` cita el rango `history.js:840-856`, que era donde estaba la frase falsa y que
hoy ya no la cubre. No se corrigió porque el alcance del paso era no tocar un módulo ya
verificado, y una referencia equivocada a un rango de líneas es mucho menos peligrosa que la
afirmación falsa que ya no está.

---

## 3. Diagnóstico del código heredado (con evidencia)

Todo lo que hay que **deshacer** está verificado leyendo el origen. Esto no se deduce de los
nombres de archivo.

### 3.1 El perfil global está\cosido en 6 lugares (punto 5)

`server/cvProfile.js:25` declara `const PROFILE = {...}` y lo exporta en `:356`. El archivo
es **solo datos**, sin lógica, y el comentario del propio código lo dice: "si hay que cambiar
un peso, una keyword o una región, se cambia acá y el resto de la app se entera solo, porque
todos los módulos importan este mismo objeto PROFILE". Eso es exactamente lo que hay que
romper.

| Archivo:línea | Qué está hardcodeado | Estado |
|---|---|---|
| `server/matcher.js:56` | `computeMatch(job, candidateProfile = PROFILE)` | **ya parametrizado**, el único listo |
| `server/analytics.js:50` | `candidateSkills()` lee `PROFILE.marketSkills` + `PROFILE.skills` **por dentro** | hay que pasarle el perfil |
| `server/analytics.js:64` | `githubSkillEvidence()` lee `PROFILE.projects` | hay que pasarle el perfil |
| `server/apifyLinkedin.js:89` | `buildProfileKeywords()` lee `PROFILE.keywords` + `PROFILE.skills` | hay que pasarle el perfil **y borrar el filtro de QA** |
| `server/coverLetter.js:75` | `generateCoverLetter(job, regionKey)` no recibe perfil, pero interpola `fullName` y `yearsExperience` | hay que pasarle el perfil |
| `frontend/src/api.js:22` | `FALLBACK.profile` es un **perfil falso de Ali** con skills de QA | hay que sacarlo |

**`apifyLinkedin.buildProfileKeywords()` es el más trampa.** Sus dos filtros son de la
profesión de Ali:

```js
// apifyLinkedin.js:99-101
const roleKeywords = (PROFILE.keywords || []).filter((term) => (
  /(qa|quality|test|automation|sdet)/i.test(term) && !/^sdft$/i.test(term)
));
// apifyLinkedin.js:104-105
const coreSkills = Object.entries(PROFILE.skills || {})
  .filter(([name, weight]) => Number(weight) >= 0.9 && /(qa|quality|test|automation)/i.test(name))
```

Para un contador o una enfermera el primer filtro deja la lista **vacía**: la query de
LinkedIn sale en blanco. Ese regex **se elimina**, no se generaliza.

`jobSources.js:13` tiene el mismo problema en otra forma:
`export const BASE_KEYWORDS = ['qa', 'quality', 'tester', 'test', 'automation', 'sdet']`.
Es el punto 7 del pedido (keywords desde las skills del usuario).

### 3.2 `skills`: el punto de fricción más importante

Acá hay una **incompatibilidad real** entre lo que pide el punto 6 y lo que hace el código:

- **Hoy**: `PROFILE.skills` (`cvProfile.js:127`) es un **MAP**:
  `{ 'manual testing': 1, mobile: 0.9 }`, consumido con `Object.entries(...)`. Los **pesos
  están guardados como números** (`qa: 1`, `docker: 0.6`); el `Number(weight)` de
  `apifyLinkedin.js:104` es defensivo, no necesario.
- **Lo que devuelve el LLM** (punto 6): `skills: [{ name, weight }]` — un **array de
  objetos**.

Son estructuras incompatibles. Hay que decidir **una sola forma** y normalizar en el borde
(al leer de la DB y al mandar al LLM). Criterio: elegir la que **no rompa `computeMatch`**.

A favor del **array**: la tabla `skills` del punto 2 es una fila por skill, o sea que
guardarlo es natural, y el JSON del LLM ya viene así. En contra: hay que tocar el
`Object.entries()` de `matcher.js`.

Lo mismo aplica a `marketSkills` (`cvProfile.js:218`), que es
`[{ name, has, aliases }]`: usa la forma de array, y esa parte sí coincide con el LLM.

### 3.3 `marketSkills` no tiene de dónde sacarse para un usuario nuevo

`PROFILE.marketSkills` es un artefacto del análisis del CV de Ali: la lista de skills que
**el mercado de QA pide** y cuáles de ésos Ali tiene o le faltan. `analytics.js:50` la usa
para calcular brechas, y `analytics.js:64` (`githubSkillEvidence`) cruza las brechas con
`PROFILE.projects` para sugerir evidencia en repos.

Es un dato que **solo existe porque alguien lobjcó a mano para una persona y una profesión**.
Para un usuario genérico no hay de dónde. Hay que decidir: derivarlo del LLM, o dejar solo
las skills que el usuario tiene y recortar la parte de brechas.

### 3.4 Las 7 regiones están repetidas en 5 lugares (punto 9)

`argentina`, `europa`, `eeuu`, `mexico`, `peru`, `colombia`, `chile` aparecen en:

| Ubicación | Forma |
|---|---|
| `server/cvProfile.js:279` | `PROFILE.regions` — mapa con `label`, `lang`, `countries` |
| `server/apifyLinkedin.js:18` | `REGION_LOCATIONS` — el texto que se pasa a LinkedIn |
| `server/analytics.js:11` | otro mapa de labels, distinto del de `cvProfile` |
| `server/matcher.js:149` | `assignRegion()` — 7 `if` en cadena |
| `frontend/src/utils.js:540` | `REGION_LOCATION` |

Para **solo Argentina**, el punto 9 pide **una** configuración importada en todos lados
(label, lang, countries, ubicación de LinkedIn, URLs de búsqueda). Agregar países después
tiene que ser agregar una entrada a ese archivo, no editar 5.

### 3.5 Estado en memoria y en disco que no sobrevive serverless

El backend actual depende de cosas que en Vercel no existen:

| Cosa | Dónde | En Vercel |
|---|---|---|
| `cache` (búsqueda, TTL 30 min) | `server/index.js:97` | se recalcula en cada invocación |
| `lastApifyJobs` | `server/index.js:110` | se pierde entre requests |
| `refreshing` (dedupe de refrescos) | `server/index.js:100` | no sirve: dos invocaciones van en paralelo |
| `data/history.json` | `server/history.js` | Postgres |
| `data/consultoras-status.json` | `server/consultorasStore.js:20` | se elimina (punto 10) |
| `HISTORY_DATA_DIR` / `CONSULTORAS_DATA_DIR` | `history.js:20`, `consultorasStore.js:20` | sin sentido |

`findById()` (`server/index.js:213`) recorre `cache.regions` y después `lastApifyJobs`:
con lo dos en memoria muerta, `/api/job` y `/api/cover-letter` darían 404 siempre para
ofertas que no estén en la DB. Hay que rediseñarlos para que busquen por `user_id` + id.

El historial se escribe en **un solo lugar**: `recordSearch()` en `server/history.js:358`.
Su lógica (`keyOf:99`, `normalizeKey:72`, `expireOldJobs:421`) es buena y se conserva; lo
único que cambia es el backend de disco por SQL. **Ninguna fuente nueva escribe por su
cuenta**: todo pasa por ahí.

### 3.6 Datos de Ali que no se pueden reutilizar

Dos archivos son **contenido escrito a mano**, no lógica:

- `server/curatedJobs.js` — **65 KB, 57 ofertas**, con `regionGuess` de Argentina, México,
  Perú, Colombia, Chile, Europa y EEUU. Relevadas a mano de bolsas locales.
- `server/demoData.js` — **6.5 KB** de ofertas demo, mismas regiones.

No son generalizables a un usuario genérico de cualquier profesión, y **no están en la lista
de borrado del punto 10**. Decisión tomada: borrarlos (ver §4). Si no, `getRanked()` los
mezcla siempre en cada búsqueda y se los muestra a un contador argentino.

Aclaración importante: `server/consultoras.js` (32 KB) es **otro** archivo, el directorio de
consultoras QA, y ese **sí** está en el punto 10 para eliminar. No confundir con `curatedJobs.js`.

### 3.7 Lo que se hereda bien y no hay que tocar

- `server/portal.js:138` — `withPortal()` agrega `portal` y `sourceUrl` y devuelve una
  **copia**. Hay tres wrappers en `index.js:117-134` (`enrichJob`, `enrichJobs`,
  `enrichRegions`). **Todo** lo que devuelva ofertas tiene que pasar por ahí.
- `server/jobSources.js` — 5 APIs gratuitas (Remotive, Arbeitnow, Himalayas, RemoteOK,
  Jobicy), `fetchJobs():243`. **No menciona Apify en ningún lado**, y por eso el CI puede
  pegarle sin riesgo de cobro. No conectarlo a Apify.
- `server/coverLetter.js` — cartas ES/EN, `generateCoverLetter():75`, `summarize():14`.
- `server/history.js` — deduplicado y expiración.
- El frontend completo: `App.jsx` (36 KB), `utils.js` (36 KB), `styles.css` (38 KB) y los 9
  componentes. **Utils tiene los helpers que ya sirven para el punto 11**:
  `linkedinSearchUrl():592`, `consultoraSearchUrl():613`, `linkedinProfileKeywords():552`.

### 3.8 Lo que ya estaba mal en el origen (no portar)

- **`npm run build` de la raíz** (`package.json:10`) es
  `npm --prefix frontend install && npm --prefix frontend run build`: **instala dependencias
  cada vez** (golpe de red). Para iterar, `npm --prefix frontend run build`.
- **`server/cvProfile.js:327` `loadCvPath()`** busca el CV en rutas absolutas de Windows
  (`F:\Curriculum-Vitae\Ali_Tovar_CV.pdf`). No tiene sentido en Vercel: se elimina (punto 3).
- **`frontend/vite.config.js:44`** manda el proxy de `/api` a `localhost:3000`. En Vercel no
  hay backend en 3000; el proxy es solo de desarrollo.
- **El `AGENTS.md` del origen mentía.** Su sección "Estado actual" decía que había trabajo
  "aplicado en el working tree pero sin commitear", pero `git status` está **limpio** (todo
  commiteado en `036f01d`) y el frontend **ya** consume `portal`, `sourceUrl`, `saved` y
  `stats` (`JobList.jsx:125`, `App.jsx:386,497-515`, `Toolbar.jsx:180`). No copiar esa sección.
- **`DOCUMENTACION.md` del origen quedó viejo**: no menciona `APIFY_MAX_RESULTS` ni el
  contrato nuevo de `/api/linkedin-search`. En **el origen** el `README.md` sí es la
  documentación real — pero acá, en este repo, el `README.md` se escribió recién en el paso 12
  y está **orientado a quien llega de cero**: qué hace, cómo correrlo, variables de entorno y
  qué falta. Por eso **la tabla de la API vive en los dos**: la versión para humanos en
  `README.md`, y la de referencia con las compuertas y las trampas en `AGENTS.md`.

### 3.9 Los dos módulos que bloquean "cualquier profesión"

Son el hallazgo real de leer `matcher.js` y `analytics.js` completos. Estos son los bloqueos
concretos del punto 5, y no se ven en los nombres de los archivos.

**A. `matcher.js` — el filtro de relevancia mata a los no-QA**

`computeMatch` tiene dos cortes que devuelven `score: 0`:

- `matcher.js:90-97` — `isQARelevant`. La oferta tiene que ser claramente de QA/testing,
  armado con `ROLE_SYNONYMS` (`:31-38`: qa, tester, automation, sdet, devops, fullstack,
  analista) y `BASE_KEYWORDS` de `jobSources.js:13`.
- `matcher.js:101` — aunque diga "QA", si no matchea ninguna skill del CV, tampoco sirve.

**Para un contador o una enfermera el primer filtro devuelve score 0 para TODAS las ofertas y
la app muestra una lista vacía.** Es el bloqueo número uno. Lo que hay que reemplazar es **qué**
skills se buscan, no la técnica de matching: `textHasSkill()` (`:25-27`) usa
`(^|[^a-z])skill([^a-z]|$)` para que "qa" no entre en "quality", y eso está bien.

Fórmula del score (`:122-128`): `coverage*55 + roleAffinity*12 + min(matched,8)*2 -
min(missing,5)*3`, con clamp 0-100. El `*1.5` de `:115` (skill en el título vale más) es la
decisión más importante. `matched` devuelve **nombres, no objetos con peso** (`:134`).

**B. `matcher.js:182` — el bug de la llamada**

`computeMatch` sí acepta `(job, candidateProfile = PROFILE)`, pero el que la llama en cadena
**no reenvía el perfil**:

```js
const match = computeMatch(job);   // matcher.js:182 — usa el PROFILE global siempre
```

Aunque la firma esté parametrizada, el flujo real sigue matcheando contra el perfil global.
**Arreglar la firma no alcanza: hay que arreglar la llamada.** Un test que solo verifique
`computeMatch(job, miPerfil)` da verde mientras la app real matchea contra el CV equivocado.

**C. `analytics.js` — la propuesta de interés está cableada a QA y a banca**

`buildAnalytics` lee `PROFILE` en **más lugares** que `matcher.js` (import en `:6`,
`githubSkillEvidence()` en `:64`, `projectedProfile` en `:213-222`, `candidateSkills()` en
`:50`, y el bloque `candidato` en `:275-288`). Los tres helpers tienen que recibir el perfil.

De las 6 recomendaciones de `buildRecommendations()` (`:81-179`), **tres no sirven para
cualquier profesión**:

- **#2** (`:114-122`) depende de `SKILL_CLUSTERS` (`:22-31`): 8 áreas fijas de tecnología
  (E2E, Mobile, API, Performance, Lenguajes, CI/CD, Datos, BDD). Para un contador no hay nada
  que agrupar.
- **#4** (`:143-147`) escribe textualmente *"Tu background en banca digital es una ventaja"*,
  y se dispara con `paymentRe` (`:255`), un regex de banca/fintech. **Es texto de Ali, literal.**
- **#5** (`:152-163`) muestra la región con mejor match promedio. Con **scope de una sola
  región** siempre va a decir "Apuntá a Argentina". Es ruido: conviene desactivarla.

`REGION_LABELS` (`:10-18`) tiene los 7 países hardcodeados.

**Lo bueno: `matchProjection` (`:290-296`) es reutilizable tal cual.** Proyecta qué pasa si el
usuario sumara las skills que evidencia su GitHub: arma un perfil hipotético con esas skills
a peso `0.5`, recalcula el match de todas las ofertas y devuelve `delta` e `improvedJobs`.
Es la función que menos depende del hardcodeo de QA, y es la que hay que preservar.

### 3.9-bis Cómo quedó resuelto (paso 6, 2026-10-01)

Lo de arriba es el diagnóstico **del origen**, y sigue siendo la explicación de por qué el
código se escribió así. Cómo quedó en este repo:

| Problema del origen | Resolución |
|---|---|
| `isQARelevant` + `ROLE_SYNONYMS` + `BASE_KEYWORDS` cortaban toda oferta ajena a QA | **No portados.** No hay lista de profesiones en el código: los `roles` salen de `profile.keywords` y las skills de `profile.skills`. La relevancia es "matcheó algo del perfil", no "¿es de mi profesión?". |
| `matcher.js:182` reenviaba mal el perfil | `rankByRegion(jobs, profile, topN)` lo pasa a `computeMatch`, y el perfil es **obligatorio** en las dos firmas. Verificado con un caso que devuelve 3 ofertas de contabilidad para la contadora. |
| `SKILL_CLUSTERS` (8 áreas de tecnología) en la recomendación #2 | **No portado.** La recomendación se arma sobre `skillStats` del cruce oferta×perfil, así que sirve para cualquier profesión sin cambiar una línea. |
| `paymentRe` (regex de banca/fintech) en la recomendación #4 | **No portado.** Ninguna recomendación nombra un sector. Verificado: la salida de la contadora no menciona banca, fintech ni pagos. |
| `REGION_LABELS` con 7 países | Ahora sale de `regions.js` (que tiene solo Argentina). |
| `matchProjection` | **Preservada** y parametrizada: usa `profile.projects` a través de `githubSkillEvidence(profile)`. |
| Desempate del ranking por `postedAt` | **Defecto encontrado en este repo, no en el origen**: `jobSources.js` normaliza a `date`. Corregido con `publishedAt(job)`. Ver §6 paso 6. |

**Una decisión de diseño que conviene conocer antes de tocar `matcher.js`:** la fórmula no se
tocó, pero **el corte de score 0 sí es distinto al del origen**. El origen tenía dos cortes
("¿es de QA?" y "¿matcheó una skill?"); acá hay **uno solo**: si no matcheó nada del perfil,
no entra al ranking. La consecuencia práctica es que una oferta de otra profesión da **0** y
se descarta sola, sin necesidad de una lista de profesiones — que es exactamente lo que
hacían falta.

### 3.10 Un antecedente que resuelve la duda de `skills`

`analytics.js:284` ya hace la conversión map → array en la respuesta:

```js
skills: Object.entries(PROFILE.skills).map(([name, weight]) => ({ name, weight }))
```

O sea que **la API ya expone `skills` como array `[{ name, weight }]`** aunque internamente el
perfil sea un map. Es la misma forma que devuelve el LLM en el punto 6, y el mismo módulo
tiene que saber leer las dos. Es un antecedente fuerte a favor de elegir el **array** como
forma canónica.

### 3.11 Código muerto que no hay que portar

`matcher.js:126`: `score += Math.min(missing.length, 0) * 0;`. `Math.min(x, 0)` siempre es
≤ 0, y multiplicado por 0 da 0. No aporta nada. La penalización real es la línea siguiente
(`- Math.min(missing.length, 5) * 3`). El propio comentario lo admite.

---

## 4. Decisiones tomadas

**Las 5 dudas bloqueantes se respondieron el 2026-09-30.** Quedan cerradas así:

| # | Decisión | Consecuencia técnica |
|---|---|---|
| 1 | **`skills` = array `[{ name, weight }]`** como forma canónica | Hay que reescribir el `Object.entries()` de `matcher.js:63,107`. Precedente: `analytics.js:284` ya expone array. La tabla `skills` de la DB queda 1 fila por skill. |
| 2 | **El LLM genera `marketSkills` en el mismo prompt del onboarding** | Se conservan brechas y recomendaciones 1 y 2 de la propuesta de interés. `marketSkills` pasa a ser `[{ name, has, aliases }]` derivado del CV del usuario. |
| 3 | **`curatedJobs.js` y `demoData.js` se BORRAN** | `getRanked()` deja de mezclar ofertas de Ali. Hay que quitar el import en `index.js:28` y el fallback `DEMO_JOBS` de `getRanked()`. |
| 4 | **Neon** como Postgres | `DATABASE_URL` con el pooler. Driver `pg`. Definir cómo corren las migraciones (script propio, no en cada arranque). |
| 5 | **Solo perfil derivado; el CV NO se guarda** | El esquema acepta `photo` pero queda `null`, y el formulario de revisión lo deja vacío y editable. Sin Vercel Blob: menos piezas y menos datos personales guardados. |

Supuestos menores que siguen en pie (no bloquean, se ajustan si aparecen):

6. El límite diario de Apify se cuenta **por usuario** contra una tabla de uso diario, con
   `APIFY_DAILY_LIMIT` como default configurable.
7. El repo se construye en `F:\busqueda_empleo_interativa` (la carpeta física difiere del
   nombre pedido, `busqueda-empleo-ia`; el `package.json` va con el nombre pedido).
8. **`matchRegion()` fusiona las dos funciones de detección de región** del origen
   (`guessRegionFromText()` de `jobSources.js` y `assignRegion()` de `matcher.js`, que era
   una cadena de 7 `if`) en **una sola** dentro de `api/lib/regions.js`. No era parte del
   plan: salió al escribir la config, porque mantenerlas separadas obligaría a que el
   `matcher` importara un módulo de *fuentes* y viceversa. Sus 4 reglas, en orden:
   excluye si nombra otro país → si nombra un lugar de la región → si dice
   "remote/worldwide" sin país → si no dice nada, se asume remoto **pero solo mientras haya
   una sola región configurada**. Devuelve `{ region, remote }`, no una clave suelta, para que
    la UI pueda marcar "remoto" sin reparsear. `regions` aparte: `isValidRegion()` valida el
    `?region=` de la URL **antes** de usarlo (si no, un `?region=<script>` se cuela hasta
    donde arma la query).

**La decisión 9 no es un supuesto menor**: `on delete cascade` en todas las FK a `users`.
Revierte una línea del `AGENTS.md` que decía "sin cascada, son N `DELETE` explícitos". El porqué
completo y **las dos limitaciones que tiene** están en §4.1.

### 4.1 Decisión 9: `on delete cascade` en todas las FK, y lo que esa decisión NO arregla

**Tomada el 2026-09-30 al escribir `migrations/`. REVIERTE explícitamente una línea del
`AGENTS.md`**: decía *"Borrar cuenta = borrar el usuario y todo lo suyo (`profiles`, `skills`,
`searches`, `job_history`, `favorites`). Sin cascada en la DB, son N `DELETE` explícitos"*. El
esquema hace lo contrario, y es deliberado. La regla vieja estaba escrita **antes** de tener
las tablas; ahora se corrigió el `AGENTS.md` para que los dos documentos digan lo mismo.

**Lo que hay hoy:** las **seis** FK a `users` —`profiles`, `skills`, `searches`,
`job_history`, `favorites`, `apify_usage`— llevan `on delete cascade`, y en el caso de
`profiles` esa FK además **es** la primary key de la tabla. Borrar la cuenta es **una**
sentencia: `delete from users where id = $1`. El porqué está escrito en
`migrations/001_users.sql:89-121`.

Por qué, en corto:

1. **Una cascada no se puede dejar a medias; los N `DELETE` sí.** Son N sentencias: si la
   tercera falla —se corta la función en Vercel, Neon cierra una conexión, aparece una
   constraint que nadie conocía— las dos primeras ya quedaron escritas. El usuario desaparece
   de `users` y sus skills, búsquedas y guardadas quedan **huérfanas**: filas con un `user_id`
   que ya no apunta a nadie, que ninguna consulta va a volver a leer y que nadie va a limpiar
   nunca. Es el peor resultado posible para alguien que pidió ser borrado: **los datos
   personales quedan, la cuenta no**. Con cascada el borrado es una sentencia, y una sentencia
   es todo o nada.
2. **El sitio del error se mueve de código de aplicación a la declaración de la FK.** Los N
   `DELETE` explícitos se escriben, se prueban a medias, se mergean, y el olvido no avisa: el
   endpoint devuelve 200 igual. La cascada está declarada **en la misma línea que la tabla**,
   junto a las columnas, donde no se puede agregar una tabla nueva y olvidarse de la cascada sin
   que el esquema mismo lo diga. Un `insert into ... references users(id)` sin `on delete
   cascade` es visible en el `create table`.
3. **Es reversible con un `ALTER TABLE`.** Cambiar a `on delete restrict` o `set null` es una
   migración nueva. Sacar código de aplicación ya mergeado es más difícil que al revés.

**Y las dos limitaciones que tiene, que hay que dejar escritas porque si no la decisión parece
mejor de lo que es:**

- **No protege de borrar mal UNA cuenta.** Un `delete from users where id = $1` con el `id`
  equivocado borra todo igual, y de una sola vez. La cascada garantiza que **lo que se borra se
  borra completo**; no garantiza que sea **lo correcto**. Contra eso hace falta otra cosa (soft
  delete, o una tabla de bajas pendientes) y **no es este archivo**.
- **No deja rastro.** La fila de `users` desaparece y no queda registro de que existió ni de
  cuándo se pidió la baja. Si hay que responder "este usuario pidió ser borrado el día X", ese
  evento hay que **loguearlo en el endpoint ANTES del `delete`**: la base no lo va a guardar.
  Cuando se escriba el endpoint de baja (paso 11 del plan), el log de auditoría va **antes** del
  `DELETE`, no después.

Ojo con un detalle de implementación que la cascada hace gratis y que conviene no romper: la
verificación contra la base real confirmó que **un solo `DELETE FROM users` con la cascada
puesta deja las 7 tablas en `count = 0`**. Un test que corre `delete from users` sin filtro
esperando que la cascada limpie, y después encuentra filas huérfanas, está probando la
cascada y no el `where`.

### 4.2 El flujo de alta es en DOS ETAPAS, y por eso hay DOS compuertas

El usuario loibcó explícitamente: **primero se registra con correo y clave, después sube el
CV**. No es un detalle de UX, es una decisión de arquitectura que hay que respetar:

```
 1. POST /api/register  (correo + clave)  ──►  fila en `users` + cookie de sesión
 2. el usuario YA está adentro, pero NO tiene perfil todavía
 3. sube el CV ──► POST /api/cv/parse ──► LLM ──► devuelve JSON
 4. formulario de REVISIÓN/EDICIÓN (nada se guarda todavía)
 5. POST /api/profile  ──► escribe `profiles` + `skills`
 6. recién acá se habilita el resto de la app
```

**Consecuencia clave: `users` tiene que poder existir SIN `profiles`.** No se puede crear el
perfil en la misma transacción del registro con campos NOT NULL que salen del CV, porque en
el paso 1 todavía no hay CV. Perfil y skills se escriben después, en el paso 5.

Por eso hay **dos compuertas distintas**, y confundirlas produce bugs raros:

| Situación | Código | Qué tiene que pasar |
|---|---|---|
| Sin cookie | **401** | redirigir a `/login` |
| Con cookie, **sin perfil** | **403** + bandera `profileComplete: false` | redirigir al onboarding del CV |
| Con cookie y perfil | 200 | la app normal |

`GET /api/me` es el que decide a dónde va el usuario, y devuelve
`{ user, profileComplete }`. El frontend rutea con esa bandera. Los endpoints que necesitan
perfil (`/api/jobs`, `/api/analytics`, `/api/cover-letter`, `/api/linkedin-search`) devuelven
403 si falta, porque `computeMatch` sin perfil no tiene contra qué medir.

Ojo con el punto 6 del pedido: "tras el primer login pedir el CV". Es exactamente esta
ventana entre el paso 1 y el paso 5. Si alguien ya tiene perfil y vuelve a entrar, no se le
vuelve a pedir el CV: `profileComplete: true` lo manda directo a la app.

### 4.3 La sesión: token firmado, sin tabla de sesiones (paso 5, HECHO)

**Decisión: la cookie es un token firmado, no un id guardado en una tabla.** El token es
`v1.<user_id>.<exp>.<HMAC-SHA256 base64url>`, y `SESSION_SECRET` es lo único que hay que
rotar. La alternativa obvia —una fila por sesión en la DB— se descartó porque agrega una tabla
entera, una escritura por login y un `DELETE` por logout, todo para guardar un dato que el
HMAC ya sabe autenticar.

Lo que se compró con esa decisión y **no es gratis**:

- **El logout no revoca nada en el servidor**: manda `Set-Cookie` con `Max-Age=0` y listo. La
  cookie que alguien ya copió sigue sirviendo hasta que expire (7 días). Es el precio
  conocido de no tener tabla de sesiones, y está anotado en `logout.js`.
- **La revocación real es la versión del token**, hoy fija en `v1` (`TOKEN_VERSION`). El paso
  11 (borrar cuenta) es el que la va a necesitar: para invalidar todas las sesiones de un
  usuario, `users` va a necesitar una columna de versión y `verifySessionToken` tiene que
  compararla. Está anotado en `logout.js` para que no se pierda.
- **Expiración validada server-side** contra `exp` del propio token, no contra la DB: un
  token vencido da 401 aunque la firma sea perfecta (probado).
- `requireSession` **igual consulta `users` en cada request**. Eso no es un descuido: es lo
  que hace que la cookie de un usuario dado de baja dé 401 en vez de un 200 con datos
  fantasma. Cuesta un `SELECT` por request y se paga a propósito.

**El `user_id` va en el token, no se busca por correo.** Consecuencia directa: un token bien
firmado con un `user_id` que no existe da 401 (no 500), y eso está verificado.

**Alta en dos etapas, aplicado literal**: `register` inserta **solo** en `users` y devuelve
`profileComplete: false`. No secreates `profiles` ni `skills`, ni una fila vacía, "para
dejarlo listo". Verificado: `profiles` queda en 0 filas después de un alta.

**El timing del login está pareado con un bcrypt dummy.** Con `INVALID_CREDENTIALS` como
constante única, "correo inexistente" y "clave mala" devuelven el mismo status y el mismo
cuerpo, pero el segundo caso hacía bcrypt y el primero no: eso solo bastaba para enumerar
correos válidos por tiempo. Se llama a `bcrypt.compare` contra un hash fijo en ambos caminos
(`api/lib/auth.js`, `dummyHash()`). Medido en la verificación: 69.5 ms vs 70.9 ms.

### 4.4 El rate limit del login vive en Postgres, no en memoria (paso 5, HECHO)

`migrations/009_login_attempts.sql` + `api/lib/rateLimit.js`. 10 fallos por `(email, IP)` y
30 por IP, en una ventana de 15 minutos; la retención es 24 horas y se purga sola.

En serverless **no hay memoria entre invocaciones**, así que un contador en un módulo no
serviría para nada: cada request puede ir a una instancia distinta. Por eso la tabla.

Decisiones que no se deducen del código:

- **Cuenta los intentos fallidos contra correos INEXISTENTES.** Es lo que hace que el límite
  sirva: el flujo natural de un atacante es probar correos inventados *para no delatar cuáles
  existen*, y si solo contáramos contra cuentas reales, ese flujo no contaría para nada. Los
  dos casos pasan por `recordFailedLogin()` igual.
- **Un intento BLOQUEADO (429) no se cuenta.** Se verificó: 13 intentos dejan 10 filas, no 14.
  Si se contaran, el límite se seguiria extendiendo solo y el bloqueo se volvería
  permanente sin que nadie pueda desbloquearse.
- **El mensaje del 429 no dice qué capa se pasó.** Decir "te pasaste de 10 intentos para esta
  cuenta" es un oráculo: le confirma al atacante que el correo existe. El cuerpo es
  genérico, y `retryAfterSeconds` + el header `Retry-After` van aparte.
- **El login exitoso borra los intentos de ese correo** (`clearFailedLogins`), pero no los de
  la IP: borrarlos por IP dejaría pasar un atacante que rota de cuenta.

### 4.5 El rate limit del LLM: tabla de eventos + advisory lock (paso 7, HECHO)

`migrations/010_cv_parses.sql` + `api/lib/cvParseLimit.js`, llamado desde
`api/cv/parse.js` paso 6. 5 parseos por usuario cada 60 minutos; retención 24 horas con purga
oportunista.

Es el **tercer** servicio pagado que había que acotar (después de Apify en 007 y el login en
009), y el único cuya ventana no es un bucket calendario. Eso define casi todo:

- **La tabla es un log de eventos, no un contador.** `apify_usage` (007) puede ser
  `unique(user_id, day)` con un `count` que se suma, porque su ventana es "hoy" y una columna
  `day` la define. Acá la ventana es **relativa** ("más viejo que ahora menos una hora") y con
  un contador único no hay forma de responderla: habría que saber cuándo fue el parseo número
  N, y un `integer` no lo sabe. Guardando una fila por parseo, la pregunta es un `count` con
  un `where parsed_at > ...`, y el `min(parsed_at)` arma el `Retry-After` sin tener que mentir.
- **El límite NO está en la tabla, es una variable de entorno** (`CV_PARSE_LIMIT`,
  `CV_PARSE_LIMIT_WINDOW_MINUTES`, `CV_PARSE_RETENTION_HOURS`), igual que `APIFY_DAILY_LIMIT`.
  Bajarlo tiene que ser cambiar una variable y redesplegar, no una migración sobre datos que
  deja a los usuarios trabados a mitad de cuota.
- **La FK a `users` SÍ existe, y en `login_attempts` NO, a propósito.** Ahí el intento se
  registra aunque el correo no exista, así que no puede haber FK (o el 500 sería un oráculo para
  enumerar cuentas). Acá un parseo sin sesión válida no llega a contar nunca, porque el límite
  va **después** de `requireSession`. Por eso `on delete cascade` también aplica: borrar la
  cuenta se lleva los parseos, y "cuándo esta persona subió su CV" es un dato de ella.
- **Va después de validar el archivo y antes del LLM.** Un 401, un 415 (tipo malo), un 413
  (muy grande) o un 400 (escaneo sin capa de texto) no llegan al LLM, así que no tienen por qué
  consumir cuota: cobrándole al usuario un parseo por un PDF que la app rechazó por el nombre
  sería cobrarle por un error de la app.

Lo que **no** se deduce del código y costó decidir:

- **El `count` y el `insert` van en una transacción con `pg_advisory_xact_lock`, y el upsert de
  007 NO sirve como patrón.** En 007 el `+ 1` va adentro de un `on conflict do update` porque la
  fila es única por (usuario, día) y el conflicto detecta el duplicado. Acá el "conflicto" que
  hay que detectar es *"ya hubo N en la ventana"*, que no es una restricción de unicidad sino un
  `count`, así que no hay nada que poner en el `on conflict`. Y meter el `count` y el `insert`
  en un CTE tampoco sirve, por una razón de **PostgreSQL**: todas las sub-sentencias de un CTE
  con `insert` comparten el mismo snapshot, así que el `select` del CTE principal **no ve** la
  fila que se acaba de insertar, y el `count` saldría con un parseo menos.

  **Control medido, 5 requests concurrentes con límite 3:**

  | | aceptados | filas |
  |---|---|---|
  | con `pg_advisory_xact_lock` | 3 | 3 |
  | sin el lock | **4** | **4** |

  El caso sin lock NO es detectable con requests secuenciales: aparece solo con concurrencia, o
  sea que un test en serie daría verde con el bug presente.
- **`hashtextextended` y no `hashtext`**, porque devuelve un bigint. `hashtext` devuelve un
  int4 y el espacio de nombres de advisory locks de una sola clave es 2^32: dos usuarios
  distintos se bloquearían entre sí con probabilidad no despreciable.
- **El lock se suelta al committear, ANTES de llamar al LLM.** El candado dura lo que dura el
  `count` y el `insert`, no los 25 segundos del `fetch`. Si quedara tomado durante la llamada,
  dos requests del mismo usuario se pondrían en fila y el segundo pagaría su parseo para
  recibir un 429 que no le corresponde.
- **Un parseo que se PAGÓ y después falló (502, 504, `finish_reason: 'length'`) CUENTA igual.**
  El contador va antes de la llamada a propósito: los tokens se facturan aunque la respuesta no
  llegue, y contar después dejaría el límite sin efecto contra un atacante que dispara llamadas
  que dan timeout y nunca paga ninguna. El precio es un falso positivo acotado.
- **La ventana se recorta para no comerse la retención** (`Math.min(pedida, retention * 60 - 1)`).
  Si la retención llegara a ser menor que la ventana, la purga borraría filas que todavía están
  contando, el `count` bajaría solo y el usuario recuperaría cuota sin que nadie se la haya
  otorgado. Un límite que se afloja solo es peor que no tenerlo, porque deja de avisar.
- **Un valor de entorno inválido NO es un error**: `CV_PARSE_LIMIT=hola` cae en el default. Es
  un error de dedo, no una decisión, y tirar un `ConfigError` convertiría "escribí mal el
  número" en "la app está caída". (Distinto de `LLM_API_KEY`, que sí es `ConfigError`: sin clave
  no hay nada que hacer; acá sin límite hay una app que funciona y cuesta plata.)
- **`CV_PARSE_LIMIT=0` apaga el límite entero**, y existe para tests y desarrollo local, donde
  no hay una clave de LLM de la que protegerse. En producción nadie lo apaga.

Verificado: `npm run check` (22 archivos), `npm run build` (42 módulos), los 10 endpoints de
prueba con un **OpenAI-compatible falso** en `127.0.0.1` (poniendo `LLM_BASE_URL` antes de
importar nada, aunque **no hacía falta**: `llmConfig()` —`llm.js:200`, invocada desde `:515`— lee
la variable **en cada llamada**, así que también habría funcionado setearla después del import) y
el PDF real de 58 863 bytes. 46
aserciones, todas verdes, y el contador de llamadas al LLM falso coincide **exactamente** con la
cantidad de 200 — que es la prueba de que el límite corta antes de la llamada que se paga.
**Corregido después** (2026-10-02): esta sección decía que `llm.js` leía la variable **al
importar el módulo**, y era falso. `llmConfig()` (`llm.js:200`) es una **función** que se invoca
desde el camino de la request (`llm.js:515`) y no hay ninguna constante a nivel de módulo que
guarde la config, así que la variable se lee **en cada llamada**. El propio JSDoc de `llm.js:183`
decía lo correcto ("perezoso, y NO al importar") y la doc lo contradecía. Verificado con un
OpenAI-compatible falso en `127.0.0.1`: importando `llm.js` **sin** `LLM_BASE_URL` ni
`LLM_API_KEY` (no explota), poniendo las dos **después** del import, la petición sale a
`127.0.0.1:<puerto>/v1/chat/completions` y el cuerpo no menciona `openai.com`; y apuntar a otro
puerto falla, que es la prueba de que la config no está cacheada. El orden de importación no
importa; lo que importa es que la variable esté puesta **antes de llamar**.

**Lo que este límite NO protege**: un adversario que se registra cuentas nuevas. El registro es
abierto y no hay verificación de correo, así que acota el gasto de UNA cuenta, no el total. Es
la misma limitación que tiene el rate limit del login, y el número de cuentas lo limita el costo
del alta, que hoy es cero. Queda anotado en §5.

### 4.6 El frontend del onboarding: cuatro decisiones que no se deducen del código (paso 7)

1. **Un solo componente para compuerta y editor** (`CvOnboarding.jsx`, sin props = compuerta, con
   `onCancel` = modal de edición). La razón concreta: **`PUT /api/profile` es un reemplazo, no un
   parche** — lo que no viene en el body se borra, `skills` incluida. Editar un peso o corregir
   un título tiene que reenviar el perfil entero, y volver a subir el CV para eso gastaría otro
   análisis de la cuota (que es un LLM de pago). Por eso el editor existe, y por eso el
   formulario **arrastra y muestra contados y nombrados** `marketSkills` y `projects`: si no se
   dijera, guardar un perfil bien guardado borraría en silencio los proyectos del CV y las
   tarjetas de la Propuesta de Interés, y la primera explicación de nadie sería "la app se rompió".
2. **Los errores se muestran TAL CUAL los escribió `http.js`.** `apiError()` solo le AGREGA
   datos al `Error` (`status` y `retryAfter`), nunca texto. Reescribir la explicación en el
   cliente significa mantener dos versiones y que una quede vieja; y el 429 se distingue del
   resto por el ícono (⏳) y por un color ámbar (`.cv-error.limite`), no por otra frase.
3. **La compuerta se abre con `profileComplete === false` del `/api/me`, no con `!profile`.**
   `loadProfile()` devuelve `null` tanto por un 403 real como por una llamada que falló, así que
   con `!profile` un problema de red pintaba "subí tu CV" a alguien que ya lo subió — y el único
   botón de esa pantalla consumía otro análisis. Es el mismo criterio con el que ya se abrió la
   compuerta de sesión: usar el endpoint que *decide* en vez de inferir desde un dato que se
   puede degradar.
4. **Las dos escrituras del alta llevan `AbortSignal.timeout` (75 s y 30 s) y las lecturas no.**
   Las lecturas tienen `FALLBACK`, así que colgar no rompe nada. Las escrituras, en cambio,
   quedarían con el botón en "Analizando tu CV…" para siempre sin salida posible, y en el
   parseo se está esperando a un LLM de pago. El abort se traduce a **504**, el mismo código que
   devuelve `cv/parse.js` cuando el proveedor no responde, para que el cliente y el servidor no
   tengan dos textos para lo mismo. `status: 0` queda reservado a "no hubo conexión" (y ahí el
   mensaje sí es del cliente, porque no hubo nadie que escribiera uno).

Verificado: `npm run check` (22 archivos), `npm run build` (43 módulos) y **27 aserciones de la
capa de red** contra un backend falso en `127.0.0.1` (no toca Apify, ni el LLM, ni la base):
el campo del multipart se llama `cv` y viaja con nombre y tipo, `saved: false` explícito,
`marketSkills` y `projects` vuelven del parseo, el `PUT` manda el perfil entero, y 400/401/415/429
salen con el mensaje del backend sin reescribir, con `status` y con `retryAfter`; el timeout
da 504 y una conexión rechazada da `status: 0`.

### 4.7 La pantalla de acceso: cinco decisiones que no se deducen del código (paso 8)

Además de las cuatro que están resumidas en `AGENTS.md`, hay tres cosas de esta pantalla que
salieron de exercising y que no se ven leyendo el componente:

**1. El logout IGNORA la respuesta del backend, y eso es deliberado.** `logout()` devuelve
`false` si no hubo conexión y nunca lanza. Si `handleLogout` tirara, un logout con el server
caído dejaría al usuario en la app con un botón que no hace nada, que es el peor resultado de
los tres posibles. El logout optimista que manda la pantalla igual es el correcto, porque el
próximo `GET /api/me` devuelve 401 y devuelve al login. Y el estado local se limpia entero
(`profile`, `analytics`, `jobsData`, `editando`), no a medias: las ofertas y la analítica son de
ESE usuario y con el nombre de otro arriba es una fuga de datos, no un detalle cosmético.

**2. `handleAuthed` recarga el perfil Y las ofertas, y solo si hay perfil.** La tentación es
usar solo el `profileComplete` que vino en la respuesta del login y ya está. Con
`profileComplete: false` no hay nada que recargar, y con `true` sí: el `loadProfile()` que se
hizo al montar devolvió 401, así que sin este `Promise.all` la persona entra a la app con
`profile: null` y ve las ofertas `FALLBACK` con el nombre del usuario arriba. Las dos ofertas
tiene que volver a salir de `/api/jobs`, no solo el perfil, porque el % de match es de la
persona que acaba de entrar.

**3. La clave corta da 400 y NO consume cuota del rate limit, y eso rompe los tests.** En
`login.js`, `readCredentials` corre antes de `assertLoginAllowed`, así que una clave de menos
de 8 caracteres ni llega a contarse como intento. Para exercitar el 429 hay que mandar claves
**largas** y de formato válido: un `'mala' + i` de 5 a 6 caracteres produce 400
en los 25 intentos, no un solo 429, y el test pasa "verde" sin haber probado nada. Pasa lo mismo
con el límite de IP: como es por **pareja** (correo+ip), un test que cambia de correo cada
intento mide `por_ip` y no `por_pareja`, y no mide la capa que dice medir.

Verificado con `npm run check` (22 archivos), `npm run build` (44 módulos), **40 aserciones** de
los helpers reales de `frontend/src/api.js` contra los handlers reales de `api/` sobre un
Postgres 16, y **19 de render** de `AuthScreen` con `react-dom/server` (que es lo único que
detecta una variable sin definir dentro de un JSX: `node --check` no parsea `.jsx` y
`npm run build` compila sin ejecutar). Sin Apify, sin LLM y sin proveedor de correo.

Un detalle del render que costó un rato y que va a volver a pasar: `renderToStaticMarkup` emite
`autoComplete` y `minLength` en camelCase, aunque en el DOM real sean minúsculas. Buscar
`autocomplete=` en minúsculas sobre el HTML renderizado da FAIL sobre un componente que está
bien.

### 4.8 Las TRES decisiones del **paso 8 de las OFERTAS** (el plan de §6, NO el de `AGENTS.md`) que contradijeron la instrucción original, y por qué la instrucción estaba mal

Las tres son el mismo tipo de error: **la instrucción decía lo que quería decir, y hacerle
caso produce un fallo silencioso.** Se dejan escritas con el razonamiento porque en el
siguiente paso alguien va a volver a leer el mismo comentario del llamador y va a creer que
ahí está la especificación.

**1. A `recordSearch` se le pasa `ranked` (los buckets), NO `enriched` (el array plano).**

La instrucción original decía: "pasale `enriched` a `recordSearch`". El motivo de fondo era
correcto y se cumplió entero: **lo que se guarda es la OFERTA y no el MATCH**, porque
`sinCamposDeMatch` (`history.js:716`) borra `score`, `matched`, `missed`, `requested`,
`roles`, `inTitle` y `comment` de una **copia** antes de serializar. Los bytes que terminan en
el `jsonb` son los mismos con cualquiera de los dos argumentos.

Pero `recordSearch` espera `{ region: [ofertas] }`, no un array. `collectEntries`
(`history.js:658`) hace `Object.entries(rankedByRegion)` y **descarta todo lo que no sea un
array** (`history.js:663`). Con un array plano, `Object.entries` devuelve
`[['0', oferta], ['1', oferta], ...]`: ninguna de esas "listas" es un array, el filtro las
descarta todas, y el resultado es la fila de `searches` escrita con **cero** filas de
`job_history` — **sin un error en ninguna parte**. El síntoma sería `/api/job` dando 404 para
toda oferta y `/api/history` siempre vacío, dos endpoints que "andan" y no muestran nada.

O sea: lo que SÍ se cumplió es lo que el comentario quiere decir; lo que NO se hizo es lo que
el comentario pide. `jobs.js:550-565` lo dice en el lugar donde va a volver a leerse.

**2. Con cero ofertas se escribe IGUAL la fila de `searches`.**

`recordSearch(userId, {}, { region, keywords, online })` → 0 filas de `job_history`, 1 fila de
`searches`. "Si no hay ofertas no se escribe historial de ofertas" se cumple exactamente: no
queda ni una fila, ni un `key`, ni un `first_seen`. Lo que se escribe es otra cosa.

La fila de `searches` **no es historial de ofertas: es el registro de que se corrió una
búsqueda**, y es lo único que puede cachear `_online` (y los `keywords`/`region` de la
corrida). Sin ella, `lastRun` devuelve `null` y el próximo request vuelve a pegarle a las cinco
bolsas — y el caso que más lo necesita es **exactamente** el peor: con las bolsas caídas
(`_online: false`) no se puede cachear NUNCA el aviso de "no pudimos contactar las bolsas", y
cada request del usuario paga los 20 s de red completos, para siempre. Para eso existe la
columna `online` de la migración `011`; no existe para otra cosa.

Confundir "historial de ofertas" con "historial de corridas" rompe justo el caso que más las
necesita. Es el mismo error de forma que el anterior, en el otro sentido: acá la instrucción
("no escribas nada si no hay ofertas") era correcta en su intención, pero su lectura literal
era falsa: lo que no hay que escribir es historial de **ofertas**.

**3. El filtro de retención va en `jobs.js`, no en `history.js`.**

Está desarrollado entero en §2.10, porque no es solo una decisión de este paso: es un hallazgo
sobre el código heredado. El resumen: `expireOldJobs` de este proyecto **no filtra, solo
borra**, y el filtro de visibilidad está en `dentroDeRetencion` (`jobs.js:417`), que reusa
`expiresAtFor` (`history.js:298`) para no crear una tercera definición de "seis meses". La
instrucción original ("dejá el filtrado donde estaba") habría producido una oferta que
`/api/jobs` muestra y `/api/history` nunca muestra.

**Lo que las tres tienen en común**, y es la razón de escribirla acá y no en el código: las
tres **fallan en silencio**. Ninguna lanza una excepción, ninguna deja un warning, y en las
tres el síntoma es "la app anda pero no muestra nada" o "muestra cosas que no debería". Es la
misma clase de defecto que §2.4 (el `NUMERIC` como string) y que §2.5 (el status que era una
frase): **un contrato que solo se nota cuando falta**.

### 4.9 El comentario de `history.js` que mentía, y que se corrigió

Por si alguien lo encuentra raro al leer el archivo: el bloque JSDoc de `expireOldJobs`
(`history.js:839-874`) afirmaba que *"el filtrado ya lo hizo `rankByRegion`/`matchRegion`
antes de que existiera una fila de historial"*. Es falso, por las tres razones de §2.10. **Se
corrigió** en el paso 8: ahora dice la verdad, explica por qué el filtro no puede quedar ahí
adentro y apunta a `dentroDeRetencion` (`jobs.js:417`) en la línea 846.

El `AGENTS.md` tiene la misma regla sobre los documentos, y se aplicó: donde algo escrito
quedó falso se corrigió o se borró, nunca se dejó. En este commit eso tocó la afirmación de
que "el frontend todavía consume endpoints que no existen" (ya era falsa después del paso 8).
La otra, la de que la tabla de la API estaba en un `README.md` que no existía, se volvió a tocar
al escribir el `README` del paso 12 (2026-10-02): ahora la tabla vive en los dos archivos, la
versión para humanos en `README.md` y la de referencia en `AGENTS.md`.

### 4.10 Jobicy tiene un mínimo de 3 caracteres en el `tag`, y eso perdía una bolsa entera para los títulos cortos

Hallazgo del paso 8, verificado empíricamente contra la API real de Jobicy (no de manual).

**El `3` es un requisito del proveedor, no una decisión de diseño**, y es el único dato de
este proyecto que depende del comportamiento de un tercero que no está en ningún esquema ni
en ninguna librería: es el que más fácil se "limpia" por error, porque el código nuevo se ve
correcto sin él.

#### El camino completo, que es lo que hace el bug invisible

`fetchJobicy` (`jobSources.js:734`) manda el término principal del perfil como `&tag=`. Ese
término viene de `primaryTerm(terms)` (`searchTerms.js:189`), que devuelve
`collapseTerm(terms[0])` (`searchTerms.js:191`), y `terms[0]` es el **título** del perfil
(`searchTerms.js:158` es el primer `push`, y el JSDoc de `:95` dice que el título va primero
siempre). O sea: **el `tag` es el título del usuario, crudo**.

Y el título se puede quedar legítimamente en 1 o 2 letras: `collapseTerm` tiene un piso de
`TERM_MIN_LENGTH = 2` (`searchTerms.js:75`, aplicado en `:251`). Ese piso está puesto a
propósito —para que "QA" o "Go" no se descarten como término inútil— y por eso produce
exactamente los tokens que esta bolsa rechazaba. **Un piso razonable en un módulo se vuelve
un bug en otro.**

#### Lo medido

```
400  tag=qa           (len 2)       200  tag=dev        (len 3)  jobCount=50
400  tag=go           (len 2)       200  tag=zzz        (len 3)  jobCount=0
400  tag=js           (len 2)       200  tag=qqqq       (len 4)  jobCount=0
400  tag=ai           (len 2)       200  tag=xyzzy      (len 5)  jobCount=0
400  tag=rh           (len 2)       200  tag=nurse      (len 6)  jobCount=1
400  tag=QA           (len 2)       200  tag=enfermeria (len 10)  jobCount=0
```

**Son dos reglas distintas, y confundirlas es el error:**

| Tag | Respuesta | Cómo hay que leerlo |
|---|---|---|
| **inexistente pero de 3+ caracteres** | `200` con `jobCount: 0` | lista vacía, **la bolsa está viva** |
| **de 1 o 2 caracteres** | `400` | **la bolsa rechaza la consulta** |

O sea: **un tag desconocido NO es un error.** El comentario anterior del código afirmaba justo
eso —que un tag inexistente es una lista vacía tolerable— y por eso no contemplaba el caso
corto: el razonamiento era correcto y estaba incompleto, que es la peor forma de estar
equivocado.

#### El daño eran DOS cosas, no una

1. **Se perdía una de las 5 bolsas gratuitas, y para siempre.** El `catch` de `fetchJobicy`
   hace `return { jobs: [], online: false }` (`jobSources.js:794`), así que un usuario cuyo
   título normaliza a un token de 1-2 letras se quedaba **sin Jobicy** en cada corrida. Y no
   es un borde: "QA", "Desarrollador Go", "Developer JS", "Analista AI" y "RH" son títulos
   perfectamente normales. **El título "QA" es literalmente el perfil de ejemplo del
   proyecto** (el del `FALLBACK.jobs` y el de las pruebas del paso 8), o sea que el caso
   bloqueado era el primero que se probó.
2. **`online: false` era una mentira.** La bolsa estaba perfectamente sana; la culpa era del
   query que mandó la app. Y como `fetchJobs` agrega `_online` **por fuente** con
   `Promise.allSettled` (`jobSources.js:911`, aplicado en `:929`, que solo sube el global si
   alguna fuente vino `true`), un 400 de Jobicy **no hunde el `_online` global** —las otras
   cuatro responden—, así que el síntoma global no se veía. Lo que estaba mal era el valor
   **por fuente**, y el `console.warn` que acompaña al 400 (`jobSources.js:793`) se leía
   como "no pudimos contactar las bolsas" cuando en realidad la bolsa estaba perfecta. Esa
   es la clase de bug que el paso 8 sí detecta (§2.9: `_online` llegó `true` con Arbeitnow en
   429) pero que acá no se veía, porque el `false` de una bolsa se diluía en el `true` de las
   otras cuatro.

#### El arreglo fue DEGRADAR, no RESISTIR

Una guarda de longitud en `fetchJobicy` (`jobSources.js:766`): si el término tiene menos de
3 caracteres **no se manda `tag`** y se pide el catálogo completo, que es lo que ya pasaba
cuando no había término. La URL queda idéntica a `?count=50` (`jobSources.js:773`), y a
propósito se interpola un solo `${tag}` en vez de repetir la condición: el caso "sin término"
y el caso "término corto" tienen que producir **exactamente** la misma URL.

La asimetría es la decisión: **se pierde el FILTRO, no la BOLSA** — y el filtro lo puede
rehacer `matcher` del lado del cliente, donde un tag de 2 letras no cuesta un 400. La otra
opción, "resistir" (buscar el tag más parecido, o ampliar a `&tag=` vacío a mano), es una
regla nueva que además adivina lo que el usuario quería.

#### Por qué NO se tocó el `catch` (y esta es la parte que hay que recordar)

Deliberadamente el `catch` sigue diciendo `online: false`. Mapear el 400 a bolsa sana habría
sido **una regla nueva y sin verificar**: un 400 en general puede ser cualquier cosa (query
mal armada, parámetro desconocido, cuota) y no se midió que significara "estoy viva". Y una
regla sin verificar en un valor que el frontend le muestra al usuario es peor que un `false`
honesto. Con la guarda de 3 caracteres **el 400 de este caso desaparece**, así que la
semántica no hace falta y no hay que inventarla.

Es el mismo criterio de §4.8, aplicado al revés: allá no se respetó una instrucción porque
iba a producir un fallo silencioso; acá **no** se mejora el `catch` aunque "parezca más
correcto", porque sería una afirmación sin evidencia. La regla es la misma en los dos
sentidos: **no agregar semántica que no se midió.**

**Verificado**: con un perfil de título "QA" (`searchTerms` → `["QA", "automation",
"testing", …]`, `primaryTerm` = `"QA"`, largo 2), la URL pasó de `?count=50&tag=QA` (400) a
`https://jobicy.com/api/v2/remote-jobs?count=50`, y **Jobicy pasó de aportar 0 ofertas a
aportar 50**, sin warning y con `online: true`. 10 aserciones, 0 fallos. `npm run check`
sigue en **OK: 33 archivos** y `npm run build` en 44 módulos.

#### Lo que este arreglo invalida de las cifras del paso 8

**Las mediciones de §2.9 y de §6 quedaron desactualizadas y hay que volver a medirlas**:
las 118 ofertas del perfil de QA ya no son 118, porque el perfil de ejemplo es justo el
titulado "QA" y Jobicy pasó de aportar 0 a aportar 50 (antes de deduplicar). Lo mismo con el
118 / 13 / 0 de los tres perfiles de prueba. **No se volvió a medir el total** —no se puede
sin la base y la red—, así que lo que se hizo fue **acotar las cifras viejas** en vez de
inventar unas nuevas: si alguien necesita el número actual, que lo mida. La conclusión de
§2.9 (que el matcher rankea de verdad y que el 0 de Enfermera es el idioma, no el código)
**no cambia**: la guarda de 3 caracteres es de una bolsa, no del matcher, y para el perfil de
Enfermera lo que decide el score sigue siendo el texto en inglés.

---

## 5. Dudas que siguen abiertas

Las 5 que bloqueaban el arranque están **resueltas** (ver §4). Quedan estas, anotadas por si
aparecen durante la implementación. **Ninguna bloquea el paso 1.**

1. **¿Se migra el perfil de Ali al repo nuevo?** No está en el pedido. Si hay que crearlo
   como primer usuario de prueba, es un alta manual (o un script de seed). Decidir antes de
   escribir la migración de `profiles`.
2. **¿Se corre alguna migración de los 229 registros del historial de Ali?** `data/` del
   origen tiene datos reales. Si no se migran, la tabla arranca vacía y es correcto.
3. **Proveedor del LLM por defecto.** El punto 6 pide `LLM_API_KEY` con "proveedor
   configurable". Falta definir cuál es el default y si el usuario puede elegirlo o es
   configuración del dueño de la app.
4. **¿Se permite el registro abierto o hay lista de invitados?** El punto 4 pide registro,
   pero en Vercel cualquiera que conozca la URL podría crear una cuenta. El rate limit del
   login protege las contraseñas, no el registro.

5. **El registro abierto es el agujero que NO tapa el rate limit del LLM (2026-10-01).**
   `cv_parses` limita el gasto de **una** cuenta (5 CVs por hora). Un adversario que se
   registre diez cuentas tiene diez cuotas, y el alta no cuesta nada porque no hay verificación
   de correo. La salida NO es subir el límite por usuario (sería peor: multiplica el gasto de
   los usuarios reales por el del atacante) sino poner una compuerta en el alta: verificación
   de correo, lista de invitados, o un límite de altas por IP con la tabla de `login_attempts`.
   **Queda sin decidir cuál de las tres**; es la misma pregunta que la duda 4, vista desde el
   lado del costo. Ver la resolución del paso 8 más abajo, que la deja abierta a propósito.

   **Decidido en el paso 8 (2026-10-01): NO se implementa todavía, y el registro queda abierto.**
   El razonamiento, para que no se reabra por olvido: las tres salidas posibles tienen
   requisitos que el proyecto hoy no tiene. La verificación de correo necesita un proveedor
   (Resend, Postmark, SES) y una tabla de tokens con expiración: son una dependencia nueva, una
   variable de entorno con una clave de otro dueño y un endpoint más, a cambio de evitar un
   gasto acotado que el rate limit ya limita por cuenta. La lista de invitados necesita alguien
   que reparta códigos, y hoy no hay nadie: el dueño de la app tendría que hacerlo a mano por
   cada alta. El límite de altas por IP sí se puede hacer hoy con `login_attempts`, pero es
   el que menos sirve —el atacante que se registra diez cuentas lo hace con IPs distintas, y el
   límite castiga al que comparte conexión, que es un usuario real—. O sea: la única que
   funciona de verdad es la primera, y la primera es la cara. Queda para más adelante, junto
   con el paso 9 y el de afinar el gasto del LLM, que son más urgentes.

   Lo que SÍ se hizo en el paso 8 es dejar la decisión **explícita y no accidental**: la pantalla
   de acceso tiene un solo punto de alta, así que agregar una compuerta después es agregar un
   paso a `AuthScreen.enviar` y una tabla, no rediseñar el login. Y el 429 del parseo ya dice
   qué hacer cuando alguien agota su cuota, que es la mitad del problema del costo.

6. **`AuthScreen` es una pantalla, no un router (2026-10-01).** Decisión de arquitectura, no
   detalle: la app no tiene router ni rutas, y el login se dibuja desde el condicional
   `sinSesion` de `App.jsx`. El motivo concreto es el F5 —con una ruta `/login` real, recargar
   esa URL tiene que volver a pintar el login, y eso pide una regla de redirección que hoy no
   existe y que no vale la pena agregar para un caso de un solo estado—. La consecuencia a
   tener presente: **no hay URL para compartir ni para volver con un link**, y no hay historial
   del navegador. Si algún día se quiere eso, es el momento de meter un router, y el condicional
   es el que se reemplaza.

7. **El estado de sesión es un string de cuatro valores, no un booleano (2026-10-01).**
   `'desconocido'`, `'logueado'`, `'sin-sesion'`, `'sin-respuesta'`. La distinción que obliga
   a tener cuatro y no dos es `'sin-respuesta'`: sin ella, con el server caído se le diría a
   alguien "iniciá sesión" y el login tampoco funcionaría, que es peor que mostrarle la app en
   modo demo con las ofertas `FALLBACK`. El costo es que cada consumidor tiene que decidir qué
   hacer con los cuatro, y el que se paga caro es `App.jsx` cuando llega un estado nuevo.

8. **Las 5 bolsas gratuitas son en inglés, y el mercado argentino no (2026-10-02, paso 8).**
   El hallazgo medido del paso 8 es que el perfil de Enfermera da **0 ofertas** y el de Chef 13
   (§2.9; cifras previas al arreglo de Jobicy de §4.10). No es un bug del matcher: es que
   Remotive, Arbeitnow, Himalayas, RemoteOK y Jobicy
   publican mayoritariamente en inglés y son globales, así que los términos que genera un
   perfil en español no matchean una descripción en inglés. Lo que hay que decidir es **qué se
   hace con eso**, y hay dos salidas que no se excluyen: integrar alguna bolsa gratuita y en
   español que exista para el mercado argentino, o dejar que el **directorio del paso 9** (que
   genera enlaces de búsqueda prellenados en las bolsas reales del país: LinkedIn Argentina,
   Indeed Argentina, Computrabajo, Bumeran, Get on Board, Jooble — punto 11 del pedido) sea la
   respuesta para el mercado local y las bolsas gratuitas queden para remoto/inglés. **Hoy no
   se eligió**, y por eso no se escribió nada: el paso 9 tiene que decidir esto antes de
   escribirse. Lo que NO se puede hacer es "arreglar" el matcher para que dé más ofertas: ya
   rankea correctamente contra el perfil, que es lo que se necesitaba demostrar.

---

## 6. Plan de trabajo (orden propuesto)

Cada paso termina con `npm run check` + `npm run build` verdes (ver `AGENTS.md`).

1. **Andamiaje — HECHO (2026-09-30)**: `package.json` raíz con workspaces, `vercel.json`,
   `.gitignore`, `.env.example`, `scripts/check.js` y el `frontend/` copiado.
   Verificado con `npm install` + `npm run check` + `npm run build`. Ver §2.
2. **Config de región**: `api/lib/regions.js` único con Argentina. **ESCRITO, sin cablear**
   (2026-09-30): falta importarlo en `matcher.js`, `analytics.js`, `apifyLinkedin.js` y
   `frontend/src/utils.js` — los tres primeros todavía no se portaron (se hace en los pasos
   6 y 8), el cuarto es el paso 3.
3. **Limpieza**: **HECHO el 2026-09-30.** En la práctica fue solo frontend, porque los
   archivos del backend nunca se copiaron a este repo:
   - `ConsultorasList.jsx` **borrado**, y con él las ramas de la pestaña en `App.jsx`,
     `Toolbar.jsx` (`isConsulta`) y `RegionTabs.jsx`. Las 73 referencias a "consultora"
     bajaron a 5: 4 son de `utils.js:617 consultoraSearchUrl()`, que **se conserva** porque
     es el helper del punto 11 (directorio de Argentina), y 1 es un comentario nuevo.
   - `FALLBACK.profile` de Ali **borrado** de `api.js`. `loadProfile()` ahora devuelve
     `null` sin perfil, que es el estado real de la app (§4.2). Los 4 consumidores ya lo
     bancaban (`CvPanel` con `if (!profile) return null`, el resto con `profile?.`).
  - `utils.js` pasó de 73 a 5 referencias; `linkedinProfileKeywords()` ya no cae a
    `'"QA Engineer" OR automation'` sino a `''` **sin perfil**, que es un cambio de
    comportamiento real. Con perfil carga ahora arma la query desde `keywords` + las
    skills de peso alto de cualquier profesión (§2.8), y el regex de QA se eliminó.
   - **Alcance ampliado en el mismo paso, y fue lo más importante**: el nombre de Ali
     seguía hardcodeado en la UI en 6 lugares aunque su perfil falso ya no estuviera. Se
     quitó todo: el subtítulo "Las mejores ofertas para **Ali Tovar** · QA Engineer" ahora
     sale del perfil, el mensaje de postulación **ya no firma con el nombre de nadie** si
     no hay perfil (se copia al portapapeles y se manda a la empresa), y el link
     `avtovar.github.io/Curriculum-Vitae/Ali_Tovar_CV.pdf` **se borró** de `CvPanel.jsx`.
     Ese último no se parametrizó: la decisión 5 dice que **el CV no se guarda**, así que no
     existe URL de CV por usuario y el link no tenía arreglo posible.
   - Verificado: `npm run check` OK y `npm run build` OK (41 módulos, era 42). Cero
     llamadas a Apify. `ConsultorasList.jsx` no se importa en ningún lado (el build lo
     detecta si lo estuviera).
- **Pendiente, conscientemente no hecho**: `styles.css` quedó con clases huérfanas
      (`.consultoras-tab`, `.consultora-card`, `.estado-select`, `.notas-input`,
      `.cat-*`) y `FALLBACK.jobs` sigue siendo el set demo de QA (ya sin los buckets
      de Europa/EEUU: se borraron al bajar las regiones a Argentina). Quitar
      `FALLBACK.jobs` arrastra `loadJobs()` y el texto de "Modo demo", y `styles.css` no se
      tocó para mantener el diff chico. Anotar para cuando se soporte el backend.
4. **DB — HECHO y VERIFICADO (2026-09-30).** `migrations/*.sql` con las **7 tablas** (el plan
   decía 6: se agregó `apify_usage` para el límite diario de Apify) y **8 archivos**, `user_id`
   en todas con FK `on delete cascade` (decisión 9, §4.1), índices por `user_id` en todas.
   **Alcance real del paso:** `searches` se había quedado sin el índice que `004_searches.sql`
   describía en comentarios pero nunca escribió, y se corrigió con la migración `008`.
   `api/lib/db.js` (el único lugar que abre conexiones, sin conectar al importarse) y
   `scripts/migrate.js` (el que `package.json` declaraba y no existía) están escritos, así que
   **`npm run migrate` ya funciona**. Verificado contra un Postgres 16 real: las 8 aplicadas e
   **idempotencia confirmada** (`0 aplicada(s), 8 ya estaba(n)` al volver a correrlas), las 7
   tablas en `count = 0`. El type parser de `NUMERIC` de `db.js` también está y verificado
   contra esa base: §2.4.
5. **Auth — HECHO y VERIFICADO (2026-09-30).** `api/lib/http.js` (error/JSON/cookies con CERO
   imports), `api/lib/auth.js` (bcrypt, cookie firmada, las dos compuertas), `api/lib/rateLimit.js`
   (sobre la tabla `login_attempts` de la migración `009`) y los endpoints `register.js`,
   `login.js`, `logout.js`, `me.js` y `health.js`. El token es
   `v1.<user_id>.<exp>.<HMAC base64url>`, sin tabla de sesiones: §4.3, §4.4.
   **Verificado contra un Postgres 16 real con 114 comprobaciones**: alta en dos etapas
   (`users` sola, `profiles` queda vacía), los cuatro atributos de cookie, los dos 401/403
   distintos, los dos cuerpos de login **idénticos byte a byte** con tiempos pareados
   (69.5 vs 70.9 ms), cookie alterada/vencida/ de usuario borrado → 401, aislamiento entre dos
   usuarios, logout idempotente, las validaciones de body, `SESSION_SECRET` ausente y corta,
   y el rate limit cortando de verdad (10 por par, 30 por IP, y unlocking pasado la ventana).
   **Dos defectos reales encontrados y corregidos**: el status ausente en dos `throw` de
   `readCredentials` (§2.5) y el `Retry-After` que se anunciaba en un comentario y no existía
   (§2.6). `/api/health` verificado en un proceso separado **sin** `DATABASE_URL`, con
   `closePool()` devolviendo `false` como prueba de que el pool nunca se creó. Las 8 tablas
   quedaron en `count = 0`.
6. **Perfil por usuario — HECHO y VERIFICADO (2026-10-01).** Escribí
   `api/lib/profile.js` (el reemplazo de `cvProfile.js`: `loadProfile(userId)`,
   `loadProfileSkills`, `normalizeProfile(row, skillRows)`, `normalizeSkills(rows)`,
   `emptyProfile()`) y porté **`matcher.js`, `analytics.js` y `coverLetter.js`
   parametrizados**, más el nuevo `api/lib/text.js` con los helpers puros que los tres
   comparten (`jobText`, `asText`, `escapeReg`, `textHasSkill`, `toNumber`). `cvProfile.js`
   **no se copió**: lo que hace ahora es leer la fila de `profiles` + `skills` por
   `user_id`.

   **Lo que cambió de verdad, más allá de "leer de la DB":**
   - `computeMatch(job, profile)` y `rankByRegion(jobs, profile, topN = 0)`: el perfil
     es **obligatorio en las dos**, sin default. Se arregla el bug de §3.9-B, donde
     `rankByRegion` reenviaba mal el argumento y todas las ofertas se rankeaban contra el
     perfil global de Ali.
   - `generateCoverLetter(job, regionKey, profile)` y `summarize(job, profile)` reciben
     el perfil; sin perfil la carta sale **sin firma y sin biografía inventada**.
   - `buildAnalytics(regions, profile)` y las dos funciones internas que leían el global
     por dentro: `candidateSkills(profile)` y `githubSkillEvidence(profile)`.
   - **`BASE_KEYWORDS`, `ROLE_SYNONYMS` e `isQARelevant` NO se portaron**, y es la parte
     importante: los `roles`, `roleAffinity`, `inTitle` y el descarte de ofertas sin
     coincidencia salen ahora de `profile.keywords` + `profile.skills`. La **fórmula del
     score no se tocó** (§3.9-C), así que un QA sigue viendo los mismos porcentajes que
     en el origen.
   - `matcher.js` y `analytics.js` ahora importan `regions.js`, lo que cierra la parte
     del paso 2 que les tocaba. `apifyLinkedin.js` sigue pendiente (paso 10).

   **Verificado** con `npm run check` (17 archivos OK), `npm run build` (42 módulos OK) y
   una **batería sintética que no toca la DB ni Apify**: una contadora, una enfermera y un
   QA rankean ofertas propias con score > 0 y las ofertas ajenas dan 0; el perfil ausente y
   el perfil vacío no rompen; una oferta sin `tags` (que en el origen tiraba `TypeError`)
   tampoco; y ni la analítica ni la carta mencionan banca, fintech ni "Ali".

   **Un defecto real encontrado y corregido durante la verificación**: el desempate del
   ranking leía `job.postedAt`, y las 5 bolsas de `jobSources.js` normalizan a **`date`**.
   O sea que en toda la ruta gratuita comparaba `''` contra `''` y **no desempataba nada**:
   dos ofertas con el mismo score quedaban en orden de llegada. Ahora usa
   `publishedAt(job)` (`matcher.js:281`), que prueba `date || postedAtTimestamp ||
   postedAt`. Mismo orden de campos que `history.js:45`.
7. **Onboarding — HECHO y VERIFICADO de las dos mitades (2026-10-01).** La de backend:
   `/api/cv/parse` (validar MIME y tamaño, extraer texto en memoria, LLM con `LLM_API_KEY`,
   proveedor configurable), `api/lib/cvText.js`, `api/lib/llm.js` y el **rate limit contra la
   tabla `cv_parses`** (§4.5). Verificado con las 10 migraciones contra un Postgres 16 y 46
   aserciones contra un OpenAI-compatible falso en `127.0.0.1`.
   La de frontend: `frontend/src/components/CvOnboarding.jsx` (un solo componente, dos usos:
   compuerta del alta y **editor** de un perfil existente), las cuatro funciones de red de
   `frontend/src/api.js` (`loadSession`, `parseCv`, `saveProfile` y el helper `apiError`) y el
   ruteo de las dos compuertas en `App.jsx`. Las cuatro decisiones que no se deducen del código
   están en **§4.6**.
   7b. **Pantalla de acceso (login + registro) — HECHO y VERIFICADO (2026-10-01).** Es el "paso 8"
   de la numeración de `AGENTS.md`, **no** el paso 8 de este plan (que son las ofertas: ver la
   nota en el punto 8). Los endpoints de auth ya estaban desde el punto 5 de este plan; lo que
   faltaba era la mitad de adelante: `frontend/src/components/AuthScreen.jsx` (un componente con
   un modo interno, no dos), los helpers `register`, `login` y `logout` de `frontend/src/api.js`,
   el botón de salir en el header y el ruteo por compuertas de `App.jsx`. Verificado con 40
   aserciones de los helpers reales contra los handlers reales de `api/` sobre un Postgres 16
   (401/400/409/429, cookie `HttpOnly` + `SameSite=Lax`, logout, `status: 0` sin backend y
   aislamiento entre dos usuarios) y 19 de render de `AuthScreen` con `react-dom/server`.
   Las tres decisiones que no se deducen del código están en **§4.7**.
8. **Ofertas — HECHO y VERIFICADO (2026-10-02).** `/api/jobs`, `/api/job`, `/api/history`,
   `/api/refresh`, `/api/cover-letter`, `/api/analytics`, más `api/lib/jobSources.js`
   (las 5 bolsas gratuitas), `api/lib/portal.js`, `api/lib/searchTerms.js`,
   `api/lib/history.js` (el historial en Postgres) y **`api/lib/jobs.js`**, el orquestador
   nuevo que no existía en el origen. También `migrations/011_searches_online.sql`.
   **OJO con el número: hay dos listas y este "paso 8" NO es el login.** La numeración de
   `AGENTS.md` (la del "estado actual") llama "paso 8" a la pantalla de acceso, mientras que
   el plan de esta lista llama "paso 8" a las ofertas. Cuando un documento diga "paso N",
   fijate en cuál de las dos listas está escribiendo; a partir del 8 las dos se diferencian y
   el número solo no dice nada.

   **Lo que cambió de verdad, más allá de "existen los endpoints":**
   - **La caché dejó de estar en memoria.** `cache` + `refreshing` + `lastApifyJobs` son
     `let` a nivel de módulo (`index.js:97,100,110`) y en serverless no existen. Ahora es la
     fila más reciente de `searches` más las filas de `job_history` con `last_seen >=
     created_at`. El TTL se compara contra el `created_at` **de la base**. Tabla completa del
     reemplazo en §2.9.
   - **`POST /api/refresh` existe por eso**: sin `force` sería un no-op.
   - **`searches.online`** (migración `011`) es lo que permite cachear `_online`, que es el
     dato que el frontend lee para el rótulo de "Modo demo" (`App.jsx:607`). Sin esa columna,
     el caso "las bolsas están caídas" pagaría 20 s de red en cada request, para siempre.
   - **El frontend NO se tocó**: el contrato de los 6 endpoints es el del origen, y `source`
     + `checkedAt` son aditivos.
   - **Tres decisiones contradijeron la instrucción original** y están con su porqué en
     **§4.8**. La más importante: a `recordSearch` se le pasa `ranked` (los buckets) y NO
     `enriched` (el array plano), porque `collectEntries` descarta todo lo que no sea un array
     y el historial quedaría vacío sin un solo error.

   **Verificado** con `npm run check` (**OK: 33 archivos**, antes 26) y `npm run build` (44
   módulos), y con **las dos** baterías de aserciones contra un Postgres real y cookie firmada
   de verdad vía `createSessionToken` (la de quien escribió el código, 68, y la del subagente
   que lo revisó, 120): **las dos, 0 fallos**. Más las cifras medidas: **118 ofertas reales en
   1682 ms** y **las mismas 118 en 35 ms** en la segunda llamada (`source: 'cache'`), las 6
   compuertas, `?q="'; drop table users; --"` → 404 y no 500, y el aislamiento entre usuarios
   (una oferta del QA da 404 para la enfermera; `?user_id=` en la URL se ignora).

   **Tres hallazgos que hay que leer bien**: el filtro de retención que NO está donde el
   comentario decía (§2.10, con el bloque de `history.js` ya corregido), el 118/13/0 de
   QA/Chef/Enfermera (§2.9), que es la **prueba** de que el matcher rankea de verdad y no un
   bug, y el mínimo de 3 caracteres del `tag` de Jobicy (§4.10), que hacía perder una bolsa
   entera a los títulos cortos. **Ese último es el único de los tres que además cambió el
   código después de medido**: por eso las cifras de arriba quedaron acotadas y hay que
   volver a medirlas si se las quiere citar.
9. **Directorio de Argentina** (punto 11): sin scraping, links de búsqueda prellenados con las
   keywords del usuario. **Verificar cada URL antes de meterla.** Los helpers ya existen en
   `frontend/src/utils.js` (`linkedinSearchUrl()`, `consultoraSearchUrl()`) y `portal.js` ya
   trae los patrones de URL de búsqueda (`PORTAL_QUERY_SEARCH`, `PORTAL_LISTING`). **Antes de
   escribirlo hay que resolver la duda 8 de §5**: si esto es también la respuesta al problema
   de las bolsas en inglés. Es el paso siguiente y es el único que agrega alcance sin costo.
10. **Apify**: `/api/linkedin-search` con el token del servidor, límite diario por usuario.
    **Se factura**: es el paso que mete un tercer servicio de pago, y el único módulo del
    origen sin portar. Trae `buildProfileKeywords()` con el filtro `/(qa|quality|test|
    automation|sdet)/i` (§3.1) y su `REGION_LOCATIONS` propio, que tiene que salir de
    `REGIONS`.
11. **Borrar cuenta**: **un** `delete from users where id = $1`, con la cascada de §4.1. **Y el
    log de auditoría va antes del `delete`**, porque la base no guarda rastro de la baja.
12. **Docs - PARCIAL (2026-10-02).** El `README.md` está **escrito y publicado** (repo público
    `avtovar/busqueda-empleo-ia`, commit `b6fe7e7`): qué hace, cómo correrlo, variables de
    entorno, tabla de la API, arquitectura, **la limitación del producto** (las 5 bolsas son en
    inglés: Enfermera 0 ofertas, QA 118) y las dos advertencias de costo (LLM y Apify).
    `.env.example` ya tenía las variables, y son **13**, no las 5 que decía el plan.
    **Falta la guía de despliegue en Vercel**, que es la mitad que sí importa para el destino:
    crear el proyecto, `DATABASE_URL` apuntando al **pooler**, `SESSION_SECRET`, correr
    `npm run migrate` desde fuera, y qué es opcional. Ese es el pedazo pendiente de este paso.

---

## 7. Restricciones que no se negocian

- **`POST /api/linkedin-search` se factura por ejecución.** No llamarlo para "probar que
  anda", ni en test, ni en smoke test, ni en CI. Los demás endpoints son gratis y verifican
  lo mismo. `jobSources.js` es el camino gratis.
- **La trampa que casi cuesta plata en el origen**: se quiso probar que el endpoint da 503
  sin token poniendo `APIFY_API_TOKEN=''` en el proceso *cliente*, pero `server/index.js:9`
  hace `import 'dotenv/config'` y **el token se leía del `.env` al arrancar el server**. La
  petición salió con el token real y arrancó a facturar. **La única forma de probar el
  camino sin token es arrancar el proceso SIN token**, nunca mandarlo vacío desde otro
  proceso. En Vercel esto se resuelve solo (la función es la que tiene la variable).
- **Portar las 3 capas anti-cobro del `ci.yml` del origen**: el check de
  `/api/linkedin-search` comentado a propósito, un guard que **falla el job** si
  `APIFY_API_TOKEN` está definido, y un `grep` del prefijo real `apifsk_` sobre los
  archivos versionados. Si el CI nuevo no las tiene, el pipeline puede cobrar de verdad.
- Nunca leer, imprimir ni commitear el valor de `APIFY_API_TOKEN`.
- **Todo filtrado por `user_id`**, siempre, en cada query. Es el error más probable al
  migrar de un JSON global a SQL: un `WHERE` olvidado es una fuga entre usuarios.

---

## 8. Lo que NO se copió del origen, y por qué

| No se copió | Por qué |
|---|---|
| `MEMORIA.md` del origen | es el contexto de trabajo del proyecto anterior (el bug de las 50 ofertas), no de este |
| `DOCUMENTACION.md` | quedó viejo: no menciona `APIFY_MAX_RESULTS` ni el contrato de `/api/linkedin-search` |
| `*.log` (`server-*.log`, `stdout.log`, `stderr.log`) | ruido de ejecución local |
| `C?UsersavtovAppDataLocalTempsh-run.*` | artefacto de un script de PowerShell con nombre mal escapado |
| `Dockerfile`, `.dockerignore` | es despliegue en Vercel, no en Docker |
| `.github/workflows/` | se reescriben para el CI nuevo, portando las 3 capas anti-cobro |
| `busqueda_de_trbajosh.sh` | launcher bash de un solo usuario |
| `no_subir/` | siempre en `.gitignore` |
| `server/index.js` | se reemplaza por funciones serverless; solo se conservan `enrichJob`/`enrichJobs`/`enrichRegions` |