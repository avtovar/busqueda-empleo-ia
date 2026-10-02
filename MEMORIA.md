# MEMORIA.md — Contexto de trabajo

Archivo de memoria del proyecto. **No es documentación general**: para cómo está armado el
proyecto están `AGENTS.md` (instrucciones para agentes) y el `README.md` (la documentación
real). Acá queda lo que **no se deduce del código**: el pedido original, el diagnóstico del
código heredado con su evidencia, las decisiones que se tomaron y lo que quedó abierto.

Última actualización real: **2026-09-30** (cinco veces: andamiaje, `regions.js`, paso 4 de la
base de datos completo — verificado contra un Postgres 16 real —, paso 5 de auth, y el
frontend adaptado a los dos cambios de contrato: `skills` como array y regiones derivadas de
`regions.js` — ver §2.7 y §2.8).

---

## 0. DÓNDE QUEDAMOS — leé esto primero si volvés al proyecto

**Pasos 1 a 7 de 12 HECHOS y VERIFICADOS. El paso 8 es el siguiente.**

El traspaso quedó el **2026-09-30**, con `npm run check` y `npm run build` en verde. Hay un
**Postgres 16 corriendo en Docker** con las 10 migraciones aplicadas, usado solo para
verificar: `docker stop pg-migrate-check` para bajarlo.

### La frase que resume dónde está el proyecto

**El alta en dos etapas ya se completa entera desde el navegador; las ofertas que ve el
usuario siguen siendo de demo.** Los 6 primeros pasos eran los que no se podían ver ni usar:
con el 7 aparece la primera pantalla de verdad (subir el CV, revisarlo, guardarlo), pero todo
lo demás sigue igual hasta el paso 8.

### Lo que falta, en orden

| Paso | Qué | Por qué es el siguiente |
|---|---|---|
| **8** | **Ofertas**: `/api/jobs`, `/api/job`, `/api/history`, `/api/refresh`, `/api/cover-letter`, `/api/analytics` | **Es el siguiente.** El alta ya se completa desde la UI (paso 7); acá la app recién empieza a consultar bolsas de empleo reales. |
| 9 | Directorio de Argentina (punto 11), sin scraping | |
| 10 | Apify con límite diario por usuario (`apifyLinkedin.js`, el regex de QA) | |
| 11 | Borrar cuenta (un `DELETE`, ver decisión 9) | |
| 12 | Docs: `README`, `.env.example`, guía de Vercel | |

**Aparte, y NO es un paso del plan: faltan los formularios de login y registro** (paso 8 del
"auth", el que hoy es solo andamiaje). El **ruteo por `profileComplete` ya existe** (es lo que
hice en el paso 7: `App.jsx` consulta `/api/me` y abre la compuerta del CV), así que lo que
falta es la pantalla a la que ir. Sin ella, un usuario que abra la app ve el aviso de sesión
inválida con botón de reintento, en vez de ofertas de demo de otro.

### 7 endpoints que el frontend YA llama y que NO existen

`/api/jobs`, `/api/job`, `/api/history`, `/api/refresh`, `/api/cover-letter`, `/api/analytics`,
`/api/linkedin-search`. Los 7 están en `frontend/src/api.js` y responden 404. `/api/profile` ya
existe (es lo que escribe `profiles` + `skills`, paso 6). Salvo `/api/health`, los 4 de auth y
los 2 de `/api/cv/*`, **`api/` no tiene nada más**.

### 3 módulos del origen sin portar (los que quedan)

`apifyLinkedin.js`, `history.js`, `jobSources.js`, `portal.js` — todos en
`F:\busqueda_trabajo\server\`, que **se puede leer y copiar**. Los que hay que dejar atrás:
`consultoras.js`, `consultorasStore.js`, `curatedJobs.js`, `demoData.js` (ver §3.6).

**Ya portados en el paso 6**: `analytics.js`, `coverLetter.js` y `matcher.js` están
reescritos y parametrizados, y `cvProfile.js` **no se copió**: lo reemplaza
`api/lib/profile.js`, que lee el perfil de la DB. Quedan 4 módulos, no 7.

### Los dos avisos para cuando se retome

1. **El frontend va a romper en el paso 8** al empezar a recibir datos reales: hoy consume un
   `PROFILE` global y endpoints inexistentes. Es esperado, no es un error nuevo.
2. **El riesgo que tenía el paso 6 está RESUELTO y verificado**: el filtro de relevancia de
   `matcher.js` (`isQARelevant`, §3.9-A) devolvía score 0 para toda oferta de un contador o
   una enfermera. Ya no existe; el mismo código rankea las tres profesiones. La fórmula
   intacta y cómo se generaliza están en la skill `.opencode/skill/comparar-match/`.

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
  contrato nuevo de `/api/linkedin-search`. El `README.md` es la documentación real.

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
prueba con un **OpenAI-compatible falso** en `127.0.0.1` (`LLM_BASE_URL` antes de importar nada,
porque `llm.js` lee la variable **al importar el módulo**) y el PDF real de 58 863 bytes. 46
aserciones, todas verdes, y el contador de llamadas al LLM falso coincide **exactamente** con la
cantidad de 200 — que es la prueba de que el límite corta antes de la llamada que se paga.

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
   `publishedAt(job)` (`matcher.js:264`), que prueba `date || postedAtTimestamp ||
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
8. **Ofertas**: funciones serverless `/api/jobs`, `/api/job`, `/api/history`, `/api/refresh`,
   `/api/cover-letter`, `/api/analytics`. Todo con `requireSession` y `withPortal`.
   **OJO con el número: hay dos listas y este "paso 8" NO es el login.** La numeración de
   `AGENTS.md` (la del "estado actual") llega hasta 8 contando la pantalla de acceso como paso
   8, mientras que el plan de esta lista llama "paso 8" a las ofertas. Cuando un documento
   diga "paso N", fijate en cuál de las dos listas está escribiendo; a partir de acá las dos se
   diferencian y el número solo no dice nada.
9. **Directorio de Argentina** (punto 11): sin scraping, links de búsqueda prellenados con las
   keywords del usuario. **Verificar cada URL antes de meterla.**
10. **Apify**: `/api/linkedin-search` con el token del servidor, límite diario por usuario.
11. **Borrar cuenta**: **un** `delete from users where id = $1`, con la cascada de §4.1. **Y el
    log de auditoría va antes del `delete`**, porque la base no guarda rastro de la baja.
12. **Docs**: `README`, `.env.example` (las 5 variables), guía de despliegue en Vercel.

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