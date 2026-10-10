# AGENTS.md — busqueda-empleo-ia

Instrucciones para sesiones de OpenCode. Todo lo de acá se verificó leyendo el código
de origen (`F:\busqueda_trabajo`) y su configuración. Si algo deja de ser cierto,
actualizá este archivo en el mismo commit.

## Qué es este proyecto (y de dónde viene)

Nace de una copia de `F:\busqueda_trabajo` (el "Buscador de Empleo QA", usuario único
hardcodeado: Ali Tovar, QA Engineer). **El repositorio de origen todavía existe y es la
referencia**: cuando algo no quede claro acá, andá a leer el código de allá, no adivines.

El cambio de fondo es de arquitectura, no de features:

| | Origen (`busqueda-trabajo`) | Acá (`busqueda-empleo-ia`) |
|---|---|---|
| Backend | un proceso `node:http` que sirve API **y** estáticos | funciones serverless en `/api` (Node ESM) + frontend estático |
| Perfil | `const PROFILE` global en `cvProfile.js` | perfil por usuario, leído de la DB |
| Datos | dos JSON planos en `data/` | Postgres (Neon o Supabase) |
| Auth | ninguna | correo + clave, sesión por cookie HttpOnly |
| Alcance | 7 regiones, 1 persona | **solo Argentina**, cualquier profesión |

**Alcance inicial: SOLO ARGENTINA.** No re-agregues Europa/EEUU/México/Perú/Colombia/Chile
aunque el código heredado las tenga: están en el código viejo parahpoder borrarlas sin
dolor, no para que las soportes.

### Lo que se hereda
Del origen entran `matcher.js` (`computeMatch`), `coverLetter.js` (cartas de presentación),
`history.js` (historial, su lógica de deduplicado y expiración), `portal.js` (`withPortal`),
`analytics.js`, `jobSources.js` (bolsas gratis) y el frontend React 18 compilado con Rspack/SWC
(`App.jsx`, `utils.js`, los 9 componentes).

**Ojo con la palabra "intacto": hoy ninguno de esos está igual.** `matcher.js`,
`analytics.js` y `coverLetter.js` se reescribieron y parametrizaron en el paso 6 (el perfil
pasó de ser un `const` global a ser un parámetro), y `history.js` se reescribió entero en el
paso 8 (el backend de disco pasó a ser SQL). Lo que se conserva es **la lógica y las
decisiones**, no el archivo. Lo que sí quedó casi literal es `portal.js` y `jobSources.js`,
que son JS puro sin estado. El detalle de qué cambió está en `MEMORIA.md` §2.9 y §2.10.

### Lo que se elimina
`consultoras.js`, `consultorasStore.js`, `ConsultorasList.jsx`, la pestaña "consultoras",
sus endpoints `/api/consultoras*`, su tracker y `CONSULTORAS_DATA_DIR`.
También `curatedJobs.js` y `demoData.js`: son 57 ofertas y un set de demo **escritas a mano
para Ali y en otros países** (Perú, Colombia, Chile, México, Europa). No son datos
reutilizables para un usuario genérico — borrarlas o vaciarlas, no "adaptarlas".

## Comandos

Hay ESLint, `node:test` y un chequeo de sintaxis. No hay formateador ni typecheck.

```bash
npm install                    # instala TODO (raíz + frontend, ver workspaces más abajo)
npm run check                  # node --check sobre cada .js de api/ y scripts/
npm run build                  # Rspack/SWC -> frontend/dist
npm run lint                   # ESLint en frontend/src
npm test                       # node:test; requiere Postgres con migraciones
npm run migrate                # aplica migrations/*.sql contra DATABASE_URL
npm run dev                    # Rspack en 5173, con proxy /api -> localhost:3000
npx vercel dev                 # serverless local: usa esto para probar /api de verdad
```

`npm run dev` **no levanta el backend**: es solo Rspack. Para tocar `/api`, o `npx vercel dev`,
o levantá el server a mano. El proxy de `/api` va a `localhost:3000`.

`npx vercel dev` y no `vercel dev` a propósito: **la CLI de Vercel NO es una dependencia del
proyecto**. Es un paquete enorme y descargarlo en cada `npm install` lo vuelve lento. `npx` lo
baja una vez y lo cachea. Si algún día querés fijarlo, va como devDependency.

### `npm run migrate` es idempotente, y NO se edita un `.sql` que ya se aplicó
El runner registra `(filename, sha256 de los bytes crudos)` en `schema_migrations` y **aborta
si un archivo ya aplicado cambia de checksum**. Un `.sql` ya aplicado es inmutable: si el cambio
de esquema es real, escribí **una migración nueva** (`009_....sql`), no edites el anterior.
Volver a correr `npm run migrate` sobre una base ya migrada no hace nada y sale con código 0.

### `frontend` es un workspace de npm, no una carpeta suelta

La raíz declara `"workspaces": ["frontend"]`. No es un detalle: **en Vercel solo se ejecutan
las instrucciones de la raíz**, así que si `frontend` fuera una carpeta independiente,
las dependencias del frontend no estarían instaladas y el `buildCommand` fallaría en cada deploy.

Consecuencia práctica: `npm install` en la raíz instala las dependencias de los dos lados y
**no existe `frontend/node_modules`** (todo queda hoisted en el `node_modules` raíz). Si
algún día agregás una dependencia al frontend, la instalás desde la raíz, no de adentro.

### `npm run check` no mira los `.jsx`

`node --check` no sabe parsear JSX, así que `scripts/check.js` recorre los `.js` de
`api/`, `lib/` y `scripts/`. **Los `.jsx` los valida el build de Rspack/SWC**, que además
detecta imports rotos. Por eso `npm run build` es obligatorio cuando tocaste `frontend/src`.

## Verificación (es lo único que hay)

```bash
npm run check                                  # 1. sintaxis de api/ y scripts/
npm run lint                                   # 2. ESLint + accesibilidad del frontend
npm run build                                  # 3. que el JSX compila (detecta imports rotos)
npm test                                       # suite con Postgres y LLM falso local

# 4. que las funciones responden. /api/health NO toca la DB ni Apify: es el smoke test.
curl -fsS localhost:3000/api/health
curl -fsS localhost:3000/api/jobs               # 401 sin cookie; 403 con cookie y sin CV
curl -fsS localhost:3000/api/directorio         # 401 sin cookie; 403 con cookie y sin CV
```

**Los 6 endpoints de ofertas exigen las dos compuertas, así que probarlos a mano sin
sesión solo te da 401 y 403**: para ejercitarlos de verdad hay que levantar un backend
falso que mande `Set-Cookie` (es lo que hacen las baterías de §4.8 de `MEMORIA.md`).
`/api/health` sí es el único que se puede curllear sin cookie, pero **no es un endpoint de
ofertas**: es el smoke test, y además el registro y el login son públicos. O sea, lo que
se puede probar sin sesión es `/api/health`, `/api/register` y `/api/login`; todo lo demás
pide cookie, y lo que devuelve oferta además pide perfil.
`/api/directorio` **existe** (es el paso 9: directorio de Argentina, sin scraping), y
`/api/linkedin-search` también existe mediante rewrite al catch-all de búsqueda: ver abajo,
se factura.

`npm run check` **no ejecuta código**: solo parsea. Es seguro correrlo contra archivos que
importan variables de entorno o abren conexiones.

**Nunca invoques `/api/linkedin-search` para verificar nada.** Ver abajo.

## La regla que más cuesta aprender: Apify cuesta plata

`POST /api/linkedin-search` **ejecuta un actor de Apify que se factura por ejecución**.
No es una API gratuita como las demás fuentes.

- **Nunca la llames en pruebas, smoke tests ni CI**, ni para "verificar que anda". Todos
  los demás endpoints son gratis y verifican lo mismo.
- `jobSources.js` (Remotive, Arbeitnow, Himalayas, RemoteOK, Jobicy) es el camino gratis.
  Ese módulo **no menciona Apify en ningún lado**, y por eso se puede pegarle a `/api/jobs`
  sin riesgo de cobro. **No lo "conectes" a Apify.**
- La clave es **del dueño de la app**, va en `APIFY_API_TOKEN` (variable de entorno de
  Vercel). Nunca en el repo, nunca en el cliente: el navegador llama a `/api/linkedin-search`
  y la función serverless agrega el token.
- El CI del origen tenía 3 capas anti-cobro (check comentado a propósito, guard que **falla
  el job** si `APIFY_API_TOKEN` está definido, y `grep` del prefijo real `apifsk_` sobre los
  archivos versionados). **Portá esas tres capas al CI nuevo.** Si las sacás, el pipeline
  puede cobrar de verdad.
- `node --check` y `npm run build` **no** ejecutan código: son seguros. `vercel dev` tampoco
  cobra nada por sí solo.

### La trampa que casi cuesta plata

En el origen se intentó probar que `/api/linkedin-search` da 503 sin token y falló la forma:
se puso `APIFY_API_TOKEN=''` en el proceso *cliente*, pero `server/index.js` hacía
`import 'dotenv/config'`, o sea que **el token se leía del `.env` al arrancar el server**.
La petición salió con el token real y arrancó a facturar. **La única forma de probar el
camino sin token es arrancar el proceso SIN token, nunca mandarlo vacío desde otro
proceso.** En Vercel esto se resuelve solo (el server es el que tiene la variable), pero
no lo reproduzcas con un test que "simule" la ausencia del token.

Nunca lees, imprimas ni commitees el valor de `APIFY_API_TOKEN`.

## La misma regla, pero con el LLM: dos servicios pagos, no uno

`POST /api/cv/parse` es el **único** endpoint que llama a un LLM, y **también se paga por
token**, con `LLM_API_KEY` (la clave del dueño de la app). Es la misma clase de riesgo que
Apify y aplica todo lo de arriba:

- **Nunca lo llames en pruebas, smoke tests ni CI** contra el proveedor real. Lo único que se
  puede ejercitar de verdad es un **OpenAI-compatible falso**: `llm.js` arma la URL como
  `${LLM_BASE_URL}/chat/completions`, así que alcanza con levantar un `node:http` que
  responda un `chat.completion` y apuntar `LLM_BASE_URL` a `http://127.0.0.1:<puerto>/v1`.
- **`LLM_BASE_URL` se lee en cada llamada, NO al importar.** `llmConfig()` (`llm.js:200`) es la
  que arma la configuración y se invoca desde el camino de la request (`llm.js:515`), así que
  la variable se puede poner en cualquier momento **antes de la llamada**. Esto es lo que hace
  testeable el módulo contra un proveedor falso, y es al revés de lo que decía esta sección
  antes: importás los handlers, ponés `process.env.LLM_BASE_URL` y recién ahí llamás. Lo mismo
  para `LLM_API_KEY`: la validación es perezosa y deliberada, y `llm.js:183` lo dice. Recordá
  que en Windows un `import()` de ruta absoluta necesita `pathToFileURL`.
- Escribí la URL del proveedor en un servidor local y **no** la mandes vacía desde otro
  proceso: es la misma trampa que está arriba, con el mismo modo de falla.

Los tres servicios con costo tienen su propio límite, y los tres son tablas en Postgres porque
**en serverless no hay memoria entre invocaciones**:

| Servicio | Tabla | Función | Config |
|---|---|---|---|
| Apify | `apify_usage` (007) | contador por día | `APIFY_DAILY_LIMIT` |
| Login | `login_attempts` (009) | log de intentos fallidos | `LOGIN_LIMIT*` |
| LLM | `cv_parses` (010) | log de parseos por usuario | `CV_PARSE_LIMIT*` |

**Lo que NO hay que hacer es reusar `rateLimit.js` para el LLM.** `withLoginAttempt` cuenta
intentos fallidos de autenticación y mantiene el chequeo, bcrypt y registro bajo un lock por IP:
escribirle una fila por cada parseo deja al usuario sin
poder entrar 15 minutos después de 10 CVs, y consultarlo sin escribir da un contador en cero
justo para el atacante. El módulo nuevo es `lib/cvParseLimit.js`, y el porqué entero está
en su cabecera.

Ojo con el **orden** en `api/profile/[...slug].js`: `requireSession` → validar archivo y extraer texto
→ **`assertCvParseAllowed`** → LLM. Lo que se rechaza antes de esa línea no costó tokens, así
que no tiene por qué consumir cuota. Y el `await` del rate limit **no contiene** la llamada al
LLM: la transacción se committea antes de esperar al proveedor, o dos requests del mismo
usuario se pondrían en fila detrás de un lock de 25 segundos.

## Arquitectura: lo que no se deduce de los nombres

### El perfil global ya está deshecho: estos 6 eran los lugares
`cvProfile.js` del origen exportaba un `const PROFILE` global con los datos de una sola
persona (Ali Tovar, QA) y lo importaban todos. **Los 6 lugares están resueltos en el paso 6**:

| Archivo (origen) | Qué estaba hardcodeado | Cómo quedó |
|---|---|---|
| `matcher.js:56` | `computeMatch(job, candidateProfile = PROFILE)` | `computeMatch(job, profile)` — el perfil es **obligatorio**, sin default. `profileOrEmpty()` (`:56`) normaliza `null`/`undefined`/perfil sin `skills` array a `emptyProfile()`. |
| `analytics.js:50` | `candidateSkills()` leía `PROFILE.marketSkills` + `PROFILE.skills` | `candidateSkills(profile)` (`:81`), y `githubSkillEvidence(profile)` (`:106`) en vez de leer `PROFILE.projects`. |
| `apifyLinkedin.js:89` | `buildProfileKeywords()` leía `PROFILE.keywords` y **filtraba por regex de QA** | **Todavía NO portado** (es el paso 10). El regex `/(qa\|quality\|test\|automation\|sdet)/i` está para Tirar: para un contador o una enfermera devuelve una query vacía. Los keywords tienen que venir del perfil. |
| `coverLetter.js:75` | `generateCoverLetter(job, regionKey)` interpolaba `fullName`/`yearsExperience` del global | `generateCoverLetter(job, regionKey, profile)` (`:336`) y `summarize(job, profile)` (`:121`). Sin perfil la carta sale sin firma. |
| `frontend/src/api.js:22` | `FALLBACK.profile` era un perfil falso de Ali | **Borrado** en el paso 3. `loadProfile()` devuelve `null` sin perfil. |
| `lib/profile.js` (nuevo) | — | Es el que reemplaza al `cvProfile.js`: `loadProfile(userId)` lee `profiles` + `skills` **siempre** por `user_id`, y `normalizeProfile(row, skillRows)` convierte la fila cruda (snake_case) al contrato de la API. |

**El perfil es un parámetro, no un import.** Si escribís un módulo nuevo que necesite
perfil, que lo reciba. Importar `profile.js` está bien para `emptyProfile()` y los helpers
puros; lo que no puede volver es leer un perfil de una variable global.

### `skills` es un ARRAY `[{ name, weight }]` — en TODOS los dos lados
**Decidido (decisión 1 de `MEMORIA.md` §4): la forma canónica es el array**, que es lo que
devuelve el LLM, lo que expone la tabla `skills` de la DB y lo que ya devolvía la analítica
del origen. **Los pesos son NÚMEROS**, no texto.

Los 3 consumidores del frontend leen el array: `CvPanel.jsx`, `AnalysisPage.jsx` y
`linkedinProfileKeywords()` en `utils.js`. Y **los del backend también, desde el paso 6**:
`profile.js:normalizeSkills()` normaliza filas de la DB al array, y `matcher.js`,
`analytics.js` y `coverLetter.js` lo recorren con `for (const s of profile.skills)`.

**El modo de falla de esto es SILENCIOSO, y por eso hay que revisarlo a mano:** un
`Object.entries(array)` no tira error — devuelve `[['0', {name, weight}], ...]`. Y el
`.filter(s => s.weight >= 0.9)` sobre la forma map lee `undefined`, que no es `>= 0.9`, así
que **la lista de skills sale vacía sin ningún error en consola**. Si un usuario reporta
"no me aparece ninguna skill", la primera hipótesis es que el endpoint está mandando el mapa
`{ 'qa': 1 }` en vez del array. El frontend blinda con `Array.isArray()` para no reventar,
pero **blindar no es avisar**: la UI muestra cero skills y el resto anda normal. `profile.js`
blinda por el otro lado: `normalizeSkills()` acepta el mapa y lo convierte, así que un
endpoint que mande la forma vieja no rompe nada — **pero el perfil devuelto es el array**.

`PROFILE.marketSkills` (`[{ name, has, aliases }]`) era un artefacto del análisis del CV de
Ali. **Ahora se deriva del perfil**: `normalizeMarketSkills(rows)` lee la columna
`profiles.market_skills`, y la analítica lo combina con la evidencia de
`profile.projects` para sugerir nuevas skills. Sin fila, el array queda vacío — y está bien
así, es el estado real de un usuario sin historial.

### El desempate del ranking lee `date`, no `postedAt`
`rankByRegion()` ordena por score y, a igual score, por fecha de publicación — para que dos
ofertas con el mismo porcentaje no se interchangeen de posición entre requests. **El campo es
`publishedAt(job)`** (`matcher.js:281`), que prueba `date || postedAtTimestamp || postedAt` en
ese orden. No hardcodees `job.postedAt` en un sort: **las 5 bolsas de `jobSources.js`
normalizan a `date`** (`publication_date`, `created_at`, `pubDate`) y `postedAt` solo existe
en Apify, así que desempatar por `postedAt` comparaba `''` contra `''` en toda la ruta
gratuita y no desempataba nada.

**Ojo con `||` contra `??`, porque hay un lugar donde cada uno es el correcto y se ven
distintos.** En `publishedAt` tiene que ser `||`: `date` puede ser `''` (Remotive sin
fecha), que es *falsy*, y con `??` el `''` ganaría. En `publicationTime`
(`history.js:223`) tiene que ser `??` **más** un corte explícito del `''` en la línea
siguiente, porque ahí el resultado es un número y el `''` se traduce a `null` ("no hay fecha
de publicación"), no a la cadena vacía. Los dos leen los mismos tres campos en el mismo
orden; lo que cambia es qué se hace con el `''`. No unifiques uno con el otro.

### Cada bolsa tiene sus propias reglas de query: no copies el patrón de otra
`primaryTerm(terms)` puede devolver legítimamente un token de **1 o 2 caracteres**
(`searchTerms.js` tiene un piso de 2 a propósito), y eso es un término válido para
`matcher` pero **no para la URL de todas las bolsas**: Jobicy devuelve **HTTP 400** con un
`tag` de menos de 3 caracteres, y un 400 ahí le costaba una de las 5 bolsas al usuario entero.
**Si agregás una sexta bolsa, medí su respuesta a un tag corto antes de darla por buena** —y
fijate en que "lista vacía" y "rechazo" son dos cosas distintas: un tag inexistente de 3+
caracteres da `200` con `jobCount: 0` y la bolsa está sana. El detalle medido, y por qué el
`catch` de cada fuente sigue diciendo `online: false` aunque el 400 sea "sabido", están en
`MEMORIA.md` §4.10.

### `portal.js` es un paso obligatorio
`withPortal()` agrega `portal` y `sourceUrl` y devuelve una **copia**; nunca hay que mutar
los objetos compartidos. **Todo** lo que devuelva ofertas tiene que pasar por
`enrichJob`/`enrichJobs`/`enrichRegions`, o el frontend recibe ofertas sin portal ni link de
origen. Eso vale también para las funciones nuevas.

### El historial se escribe en un solo lugar
`recordSearch()` en `history.js` es el único que persiste. Al pasarlo a Postgres, **ninguna
fuente nueva escribe por su cuenta**: todo pasa por ahí. Su lógica de `keyOf`,
`normalizeKey`, `expireOldJobs` y retención es buena y se conserva; lo que cambia es el
backend de disco por SQL.

### Las regiones NO están repetidas en el frontend: salen de `lib/regions.js`
El origen las tenía en 5 lugares (`cvProfile.regions`, `apifyLinkedin.REGION_LOCATIONS`,
`analytics.js`, `matcher.assignRegion()` y `utils.js REGION_LOCATION`). Hoy **el frontend las
importa**: `utils.js` deriva `REGION_LOCATION` de `REGIONS`, `RegionTabs.jsx` genera las
pestañas con `Object.keys(REGIONS)`, y `App.jsx` usa `regionLabel()`.

**Rspack resuelve imports fuera del root del workspace**: `frontend/src/utils.js` importa
`../../lib/regions.js`, porque el archivo es JS puro sin dependencias de Node. Ojo con el
path: desde `src/` van **dos** `..` y desde `src/components/` **tres**.
La única cosa de una región que quedó en el frontend es la bandera emoji
(`utils.js: REGION_FLAG`), que es decoración y no configuración del dominio.

**No hardcodees países en el frontend**: si falta un label o una bandera, se agrega en
`regions.js` y se arregla acá. Del lado del backend, `matcher.js` y `analytics.js` ya lo
importan (paso 6). **El que falta es `apifyLinkedin.js`**: su `REGION_LOCATIONS` va a salir
de `REGIONS` cuando se porte en el paso 10.

### En serverless no hay disco ni memoria entre invocaciones
`cache`, `lastApifyJobs` y los JSON de `data/` **no sobreviven** a una invocación de Vercel.
Nada de estado entre requests: o va a la DB, o se recalcula en cada llamada. Escribí las
funciones asumiendo ejecución concurrente y possibly-paralela (dos requests a la vez), sin
`await` sobre un "último resultado" global.

Las funciones exportan los métodos que usan y declaran `maxDuration`; los handlers que pueden
esperar a un proveedor externo tienen 60 segundos y los demás 30.
`vercel.json` enruta `/api/*` a las funciones y el rewrite del SPA **excluye `api/`** con
`/((?!api/).*)`: si el rewrite se llevara `/api/health`, el smoke test recibiría el
`index.html` del frontend en vez de JSON, y el deploy no podría distinguir "la función no
arrancó" de "devolvió basura".

### La caché dejó de estar en memoria: es una fila de `searches` más las filas que se escribieron con ella
El origen tenía **tres** variables de módulo detrás de `/api/jobs`: `cache`
(`index.js:97`), `refreshing` (`index.js:100`) y `lastApifyJobs` (`index.js:110`). Las tres
son `let` a nivel de módulo, y en serverless **no existen**: dos requests del mismo usuario
pueden ir a dos instancias distintas y cada una arranca sin la variable de la otra.

La caché de este proyecto es **SQL**, y son tres piezas que ya estaban en el esquema:

| Qué reemplaza a | Qué es ahora | Dónde |
|---|---|---|
| `cache.regions` + `cache.at` | la fila más reciente de `searches` de ese usuario (`select ... order by created_at desc limit 1`) y su `created_at` como reloj | `lastRun()` (`jobs.js:297`) |
| las ofertas de `cache.regions` | las filas de `job_history` de ese usuario con `last_seen >= created_at` de la corrida | `jobsOfLastRun()` (`jobs.js:348`) |
| `cache.online` | la **columna `searches.online`** (migración `011`) | `011_searches_online.sql` |
| `refreshing` (dedupe de refrescos) | **nada**, y está bien: no se puede portar | ver abajo |
| `lastApifyJobs` (el fallback de `/api/job` para ofertas que no estaban en la caché) | el `job_history` de ese usuario, por `user_id`, que es lo que ya persistía `recordSearch` | `job.js` lo busca por `q` |

El TTL es `CACHE_TTL_MS` en `lib/jobs.js` (30 minutos, el mismo del origen) y se
compara contra el `created_at` **de la base**, no contra un `Date.now()` guardado en un
objeto: el reloj de la corrida es el de Postgres, así que dos requests concurrentes no pueden
discrepar sobre si la caché venció.

**`POST /api/refresh` existe por esto.** El botón "Actualizar búsqueda" del frontend heredado
(`App.jsx`, `handleRefresh`) lo único que hace es saltear el TTL. Sin el argumento `force`, ese
endpoint sería un no-op: leería la caché que acaba de escribir la corrida anterior y devolvería
lo mismo con otro `checkedAt`. Por eso `refresh.js` pasa `force: true` y por eso su respuesta
manda `source`, que tiene que ser siempre `'live'` ahí: si alguna vez devuelve `'cache'`, el
`force` dejó de pasar y el botón es un no-op silencioso.

**El `refreshing` del origen no tiene reemplazo y no se lo busca.** Dos requests con `force`
a la vez hacen dos corridas contra las cinco bolsas **gratuitas**, y el
`unique (user_id, key)` de `job_history` evita que se dupliquen filas. Si algún día molesta,
la solución es un `pg_advisory_xact_lock` en la transacción de `recordSearch` — la misma
técnica de `cvParseLimit.js` — no una variable de módulo, que es lo que no funciona acá.

### `_online` lo manda el BACKEND, y `source` no lo pide nadie
`frontend/src/App.jsx:607` lee `jobsData._online` para elegir el rótulo de arriba:
"Conexión exitosa con las fuentes de empleo" o "Modo demo: no se pudo contactar las fuentes
en línea". **Ese campo lo tiene que mandar el endpoint**: `frontend/src/api.js:76` hace
`return await res.json()` y devuelve el JSON crudo, así que lo único que el navegador puede
agregar es su propio `FALLBACK`. Si `/api/jobs` no lo manda, **un backend sano se anuncia como
caído** — y el `useState` inicial de `App.jsx:198` es `{ jobs: [], _online: false }`, o sea que
también arranca diciendo "demo".

Es la clase de error "contrato que no se nota hasta que falta": nada en el frontend falla,
nada en el backend falla, y el síntoma es un rótulo mintiendo. Lo mismo con
`jobs.js:612-616`: **`_online` es siempre el de `fetchJobs`, nunca "hubo ofertas"**. Son dos
hechos distintos, y confundirlos muestra "no pudimos contactar las bolsas" a alguien a quien
las bolsas le contestaron perfecto y no tiene nada para su perfil.

`source: 'cache' | 'live'` es **aditivo y no lo pide ningún consumidor**. Existe para poder
**verificar que la caché funciona**, que es lo único que se puede hacer con una variable que
no existe (no hay logs, no hay métrica, no hay profiler en una función serverless). No lo
borres por "adoptado": es el campo con el que se midió que la 2ª llamada bajó de 1682 ms a
35 ms con las mismas 118 ofertas. **Ojo: esas dos cifras y ese total quedaron viejos** con el
arreglo de Jobicy (`MEMORIA.md` §4.10), que hizo que esa bolsa aportara 50 ofertas en vez de 0;
la 2ª llamada sí sigue dando `source: 'cache'`, que es lo que el campo prueba.

### El filtro de retención vive en `jobs.js`, NO en `history.js`
`expireOldJobs()` de este proyecto **no filtra, solo borra**. Su comentario afirmaba que "el
filtrado ya lo hizo `rankByRegion`/`matchRegion`", y es **falso**: los dos filtran por
**región** y por `score > 0`, y ninguno de los dos criterios sabe de antigüedad. Sin el filtro,
una oferta publicada hace ocho meses que la bolsa sigue listando entra al ranking, su
`expires_at` queda en el pasado, `recordSearch` la upserta igual (el `on conflict` no mira el
vencimiento) y la purga que va **en la misma transacción** la borra de nuevo: el resultado es
una oferta que `/api/jobs` muestra y `/api/history` nunca muestra.

El filtro está en `dentroDeRetencion()` (`jobs.js:417`), aplicado sobre la lista **enriquecida**
justo antes de rankearla, y **reusa `expiresAtFor` de `history.js`**: no es una tercera
definición de "seis meses". Si algún día se copia esa regla a mano en un tercer lugar, el
proyecto tiene tres verdades y dos no coinciden.

Ojo con lo que se **corrigió**: el bloque de comentario de `expireOldJobs`
(`history.js:839-874`, con el puntero a `jobs.js:417` en la línea 846) antes afirmaba la
cosa falsa y ahora dice la verdad y explica por qué el filtro no puede quedar ahí adentro.
Un detalle que quedó viejo y hay que arreglar cuando se toque ese archivo: el comentario de
`jobs.js:385` cita el rango viejo (`history.js:840-856`), que hoy ya no cubre la frase
falsa.

### Tres trampas del esquema que revientan un `INSERT` de prueba
`migrations/` tiene 13 archivos y tres detalles que no se deducen mirando el SQL de un vistazo.
Si escribís un test que **siembre un perfil a mano**, con cualquiera de estos tres mal el
`INSERT` revienta (y el mensaje del error no los señala):

- **`profiles` NO tiene columna `skills`.** La tabla `skills` es aparte
  (`migrations/003_skills.sql`), con `user_id` como parte de la primary key y su propio
  `INSERT`. Un `insert into profiles (...) values (...)` que incluya `skills` es un error de
  columna inexistente.
- **`profiles.links` es un OBJETO jsonb, no un array** (`002_profiles.sql:88`, con el check
  `profiles_links_object` en la `:100`). El default es `'{}'`. Mandar `'[]'` viola el
  constraint. Los otros tres (`keywords`, `market_skills`, `projects`) sí son arrays, y cada
  uno tiene su propio check `profiles_*_array`.
- **`searches.keywords` es un `text[]`** (`004_searches.sql:42`), no un jsonb ni un string.
  Por eso el INSERT de `recordSearch` castea explícitamente `$3::text[]`.

### La carta y el resumen salen de `coverLetter.js`, no de la analítica
`/api/cover-letter` devuelve **lo que devuelve `generateCoverLetter`** tal cual
(`api/cover-letter.js:113`): `{ lang, region, subject, body }`. El frontend solo lee
`subject` y `body`; `lang` y `region` viajan por el contrato del origen y no los usa nadie.

`/api/job` devuelve `{ job, summary }` y el `summary` es el **`summarize()` de
`lib/coverLetter.js`**, **no** de `analytics.js`. Puede ser `null`: con la
oferta re-rankeada y sin dato, el resumen no tiene de qué armarse.
`JobDetailModal.jsx:59` lo banca (`const s = summary || { companySummary: ... }`), así que
`null` es un estado válido de la respuesta y no hay que castearlo en el endpoint.

Un detalle de `job.js` que no se deduce del nombre del parámetro: se busca por **`q`**, no por
`id`, porque es lo que manda el frontend (`api.js:157`); `id` se acepta como alias. Y el `job`
se **re-rankea** contra el perfil de hoy con `computeMatch` directo (no con
`rankByRegion([job], profile)`, que **descarta** la oferta si da `score: 0`, que es justo el
caso que el usuario pide). El motivo es el mismo que borra los campos del match antes de
guardar: **el perfil se edita, y un `score` guardado es rancio.**

### `/api/history` ya NO se come los errores devolviendo 200 con lista vacía
El origen sí lo hacía (`server/index.js:364`: `catch { sendJSON(res, 200, { region, jobs:
[] }) }`), y era un error: la respuesta vacía es **indistinguible** de "todavía no tenés
historial". `App.jsx` muestra ese texto, que es una afirmación falsa para alguien con tres
meses de búsquedas, y el problema real —la tabla no está, se cayó la conexión, no corrió una
migración— queda escondido detrás de una pantalla que parece normal.

Ahora no hay `catch`: el error sube a `withErrorHandling` y sale **500** con el detalle en el
log del servidor. Un 500 visible es infinitamente más útil que un 200 que miente. **No lo
vuelvas a agregar como "robustez".**

Del mismo modo, `/api/history` **no vuelve a enriquecer** (`enrichJobs`), aunque el origen lo
hacía: acá lo que se guarda en el `jsonb` **ya viene enriquecido**, porque `lib/jobs.js`
llama a `enrichJobs(jobs)` **antes** de rankear y de guardar. Si algún día aparece una fila
sin `portal`, el problema no es este endpoint: es que se escribió por un camino que no pasó
por `enrichJobs`. Y tampoco re-rankea: el historial es la lista de lo que el usuario **vio**,
y cada item sale con `active`/`firstSeen`/`lastSeen` y **sin `score`** (no hay puntaje rancio
que mostrar, y `/api/job` ya existe para el detalle de una).

### `db.js` es el único que abre conexiones, y una línea de ahí no se puede sacar
`lib/db.js` es el **único** módulo del proyecto que abre conexiones. Nada más importa `pg`.
Dos cosas sueltas que no se deducen del código:

- **El pool se crea la primera vez que alguien consulta de verdad, no al importar el archivo.**
  Es deliberado: es lo que permite que `/api/health` responda **sin base de datos** (el smoke
  test del deploy no puede depender de que Neon esté sano). Si alguna vez agregás un
  `new Pool()` a nivel de módulo, o un `await` en el import, rompés esa garantía.
- **`pg` devuelve `NUMERIC` como string, y `lib/db.js` lo arregla con un type parser
  global.** La línea es `types.setTypeParser(types.builtins.NUMERIC, Number)`, arriba del todo,
  y **va a nivel de módulo a propósito**: registrar el parser es un ajuste global del driver,
  no una opción de conexión, así que tiene que estar listo antes de la primera query (ponerlo
  adentro de `getPool()` lo deja en un camino que se puede saltear).

  **El modo de falla de esto es silencioso, y por eso no se descubre solo:**

  ```
  weight * 100        →  90    (funciona: `*` coerce la string, sin error)
  weight.toFixed(2)   →  TypeError: w.toFixed is not a function
  ```

  Sin la línea, `skills.weight` llega como `'0.900'` y `profiles.years_experience` como
  `'5.5'`. Como la fórmula del score de `matcher.js` **multiplica**, la mitad de los usos del
  dato funcionan con el bug presente y un test que solo mira el score da **verde**; el mismo
  dato revienta recién cuando la UI lo formatea. **No la borres "porque no se está usando":
  lo que está haciendo es evitar una excepción que todavía no se vio.** `migrations/003_skills.sql:49-54`
  lo dice con todas las letras, y §2.4 de `MEMORIA.md` tiene el detalle.

  Dos cosas que hacen falta saber si algún día la tocás: un `numeric` **NULL tiene que seguir
  llegando como `null`**, no como `0` (peso ausente y peso 0 son cosas distintas en el match) —
  hoy está garantizado porque `pg/lib/result.js:63-76` ni le llama al parser a un NULL; y el
  ajuste es **solo `NUMERIC`**, porque `int8`/`bigint` también viene como string y eso es
  **a propósito** (un int64 no cabe exacto en un `number` de JS).

## Convenciones del repo

- **Comentarios `// ↑` en JS/JSX y `/* */` en CSS, en español, explicando el porqué**
  (no el qué). Son densos y están en casi todas las líneas del código heredado. Es una
  convención real del proyecto, no decoración: **el código nuevo va con el mismo estilo o
  parece que no es del proyecto.**
- ESM (`"type": "module"`). 2 espacios, comillas simples, punto y coma, funciones flecha.
- En el origen `dotenv` era la única dependencia de runtime. Con auth y DB ya no aplica:
  bcrypt/argon2, driver de Postgres y el parser de CV entran justificadas.
- Si agregás o cambiás un endpoint, actualizá **la tabla de la API de dos lugares**: la de más
  abajo en este archivo (que es la de referencia, con compuertas y trampas) y la de `README.md`
  (que es la de arranque, más corta). **Los dos se desincronizan solos**, así que ninguno de
  los dos alcanza: si tocás uno, tocás el otro.
  Ojo: **esta tabla NO se borra aunque exista el `README.md`.** El `README.md` está orientado a
  quien llega de cero —qué hace, cómo correrlo, qué variables hay— y **no** lleva el porqué de
  las decisiones, así que la versión de referencia sigue teniendo que vivir acá.
  Lo que sí es cierto del `README.md` del ORIGEN es que `DOCUMENTACION.md` quedó viejo (no menciona
  `APIFY_MAX_RESULTS` ni el contrato nuevo de `/api/linkedin-search`): no lo tomes como
  fuente de verdad.
- **Actualizá `AGENTS.md` y `MEMORIA.md` en el mismo commit en que cambies algo.** Es una
  regla fija del proyecto, no una sugerencia:
  - `AGENTS.md` va lo que hace falta **saber para trabajar acá**: comandos, arquitectura,
    trampas, convenciones.
  - `MEMORIA.md` va lo que **no se deduce del código**: el pedido original, decisiones tomadas
    con su porqué, hallazgos con `archivo:línea`, y las dudas que siguen abiertas.
  Si descubrís algo que surprises a un agente nuevo y no está en ninguno de los dos, va en
  los dos. Si un cambio invalida algo que estaba escrito, **borralo**: más vale que falte
  que diga una mentira.
- Las skills del proyecto están en `.opencode/skill/<nombre>/SKILL.md` y se autodetectan
  (no hay que registrarlas). Cada una cubre un flujo concreto. **Si creás un skill, agregalo
  al `AGENTS.md`**, así se sabe que existe.

## Seguridad (esto no es negociable)

- **El alta es en dos etapas: correo+clave primero, CV después.** `users` tiene que poder
  existir **sin** `profiles` (el perfil se escribe recién cuando el usuario sube el CV), así
  que hay **dos compuertas y no una**:

  | Situación | Código |
  |---|---|
  | sin cookie válida | **401** → a `/login` |
  | con cookie, **sin perfil** | **403** + `profileComplete: false` → al onboarding del CV |
  | con cookie y perfil | 200 |

  `GET /api/me` devuelve `{ user, profileComplete }` y es el que decide a dónde manda al
  usuario. Los endpoints que necesitan perfil devuelven **403**, no 401: la sesión existe,
  lo que falta es el CV. Un 401 acá mandaría al usuario al login en un bucle.

- **Todo filtrado por `user_id`**, siempre, en cada query. Es el error más probable al
  migrar de un JSON global a SQL: un `WHERE` olvidado es una fuga de datos entre usuarios.
  En el origen `/api/profile` devuelve el `PROFILE` global sin preguntar quién es: **todos**
  los endpoints que devuelven datos de usuario tienen que resolver la sesión primero y 401
  (o 403) si no corresponde.
- Cookie de sesión: **HttpOnly + Secure + SameSite** + expiración. Rotar `SESSION_SECRET` con
  usuarios reales invalida todas las sesiones: es aceptable, pero avisalo.
- Rate limit en `/api/login`. Sin él, cualquiera puede probar contraseñas en serio.
- Rate limit en `/api/cv/parse`, que es lo que evita que un usuario vacíe la clave del LLM.
  Van **dos servicios pagos** acá y cada uno tiene su tabla; ninguno es gratis.
- El CV: validar **tipo MIME y tamaño** antes de parsear, y no guardarlo en disco (Vercel es
  efímero). Extraer texto en memoria, mandarlo al LLM, y persistir **solo el perfil
  derivado**. Si se conserva el archivo, es Vercel Blob — y entonces hay que definir qué
  pasa con la foto.
- `/api/health` debe seguir respondiendo **sin** token de Apify y **sin** base de datos: es
  lo que usa el smoke test. Si le agregás un `SELECT 1`, el deploy deja de poder
  diagnosticar un problema de DB.
- Borrar cuenta = **un** `delete from users where id = $1`. **NO son N `DELETE` explícitos**:
  las **siete** FK a `users` llevan **`on delete cascade`** (en `profiles` esa FK además es la
  primary key de la tabla), así que un solo `DELETE` se lleva `profiles`, `skills`, `searches`,
  `job_history`, `favorites`, `apify_usage` y `cv_parses`. La línea vieja de este archivo
  ("sin cascada, son N `DELETE` explícitos") era anterior a las migraciones y quedó
  **revertida**: el porqué completo, y **las dos limitaciones que la cascada NO arregla** (no
  protege borrar mal *una* cuenta, y no deja rastro de la baja), están en `MEMORIA.md` §4.1,
  decisión 9. Lo que sí sale de ahí: **logueá la baja en el endpoint ANTES del `delete`**, porque
  la fila desaparece y la base no guarda ningún registro del evento.
- **El registro de la baja NO lleva FK a `users`** (migración `012`, tabla
  `account_deletions`). Es el punto de todo el paso 11: con una FK, el `delete` borraría el
  rastro en la misma cascada y la tabla quedaría siempre vacía. Por eso la única forma de
  escribirla es un `INSERT` explícito, y va **en la misma transacción** que el `DELETE`: si la
  auditoría falla, el rollback deja la cuenta entera. La fila guarda correo, fecha, IP y
  User-Agent, y la UI **dice** que quedan (en `DeleteAccountModal`): una reserva de privacidad
  que omite la IP es falsa.
- **`DELETE /api/account` usa `requireSession`, NO `requireProfile`.** Es la única excepción a
  la regla de las dos compuertas: una cuenta a medio crear tiene que poder borrarse. Si alguna
  vez se le cambia la compuerta, hay que sacar también el aviso de `BorrarCuentaZona` de la
  compuerta del alta, o queda una acción que la UI promete y el backend rechaza con 403.
- Secretos **solo** en variables de entorno de Vercel. `.env` nunca se commitea.

## La API, endpoint por endpoint

El README tiene el resumen de arranque; esta tabla es la referencia completa para desarrollar.
La columna "compuerta" es lo único
que hay que mirar antes de tocar un handler: es la que decide si el frontend cae en la
pantalla de acceso (401), en el onboarding del CV (403) o entra a la app (200).

| Método | Ruta | Compuerta | Devuelve |
|---|---|---|---|
| `GET` | `/api/health` | **ninguna** | `{ ok, service, time }`. No toca la DB ni Apify: es el smoke test del deploy |
| `POST` | `/api/register` | ninguna (es el alta) | `{ ok, user, profileComplete: false }`. **Nunca** escribe `profiles` |
| `POST` | `/api/login` | ninguna | `{ ok, user, profileComplete }`. Mismo cuerpo y tiempo pareados para correo inexistente y clave mala |
| `POST` | `/api/logout` | **ninguna** | `{ ok: true }` + cookie con `Max-Age=0`. No borra nada del servidor. Es el único que **no** llama a `requireSession`: sin sesión no hay cookie que borrar, y exigirla haría que el logout fallara justo cuando más falta hace (cookie vencida) |
| `GET` | `/api/me` | `requireSession` | `{ user, profileComplete }`. **Es el que decide a dónde va el usuario**: 200 siempre, nunca 403 |
| `GET` | `/api/profile` | **`requireProfile`** | el perfil del contrato, plano (sin envoltorio). 403 si falta el CV |
| `PUT` | `/api/profile` | `requireSession` | `{ ok, profileComplete, profile }`. Es **reemplazo**, no parche: lo que no viene en el body se borra |
| `POST` | `/api/cv/parse` | `requireSession` | `{ ok, profile, kind, saved: false }`. **Único** que llama a un LLM de pago |
| `DELETE` | `/api/account` | `requireSession` | `{ ok: true }` + cookie con `Max-Age=0`. Audita la baja en la misma transacción que el `delete`, y **no** pide perfil: una cuenta sin CV se puede borrar |
| `GET` | `/api/jobs?region=` | **`requireProfile`** | `{ region, jobs, total, _online, source, checkedAt }`. El primero que ve ofertas reales |
| `GET` | `/api/job?q=` | **`requireProfile`** | `{ job, summary }`. `summary` es el `summarize()` de `coverLetter.js` y **puede ser `null`** |
| `GET` | `/api/history?region=` | **`requireProfile`** | `{ region, jobs }`. Cada item con `active`/`firstSeen`/`lastSeen` y **sin `score`** |
| `POST` | `/api/refresh` | **`requireProfile`** | `{ ok: true, _online, at, total, source }`. Disparador del TTL: sin `force` sería un no-op |
| `GET` | `/api/cover-letter?region=&id=` | **`requireProfile`** | `{ lang, region, subject, body }` — lo que devuelve `generateCoverLetter` tal cual |
| `GET` | `/api/analytics` | **`requireProfile`** | `{ generatedAt, candidato, matchProjection, skillStats, strongSkills, missingSkills, englishPct, recommendations, githubEvidence }`. Sin parámetros y **sin `force`**, por costo |
| `POST` | `/api/linkedin-search` | `requireProfile` | `{ region, jobs, total, regions, stats, _online, source, checkedAt, resultLimit, pages, searchUrl }`. **Se factura** (actor Apify). Rate limit diario `apify_usage` + `APIFY_DAILY_LIMIT`. `buildProfileKeywords` generalizado (sin regex QA). |
| `GET` | `/api/directorio` | `requireProfile` | `{ region, keyword, terms, bolsas, consultoras }`. Cada entrada con `searchUrl` + `searchKind: 'sitio' | 'google' | 'ninguno'`. No scrapea: abre búsquedas prellenadas en el sitio de cada portal/consultora |
| `GET` | `/api/favorites` | `requireProfile` | `{ favorites }`, solo ofertas guardadas por el usuario autenticado |
| `POST` | `/api/favorites` | `requireProfile` | `{ ok: true, saved }`. Alterna guardar/quitar una oferta usando `{ key, job }` |

Tres cosas de esa tabla que no se deducen mirando los handlers:

- **`requireProfile` es la de los 6 endpoints de ofertas, no `requireSession`.** Las seis
  ofertas que devuelve `/api/jobs` están rankeadas contra el perfil: sin perfil el `matcher`
  no tiene contra qué calcular y devolvería cero ofertas con un 200, que es indistinguible de
  "no hay nada para tu perfil". Un `requireSession` ahí daría 403 solo cuando falta el CV.
- **`DELETE /api/account` NO pide perfil, y por eso es el único endpoint de escritura con
  `requireSession` en lugar de `requireProfile`.** Una cuenta a medio crear (correo y clave
  listos, CV nunca subido) es una cuenta real y tiene que poder deshacerse; si exigiera
  perfil, un usuario que se registró por error y no quiere subir su CV quedaría atrapado.
- **`/api/analytics` NO lleva `force` y esa es la decisión.** La tentación es pegarlo para
  que la página muestre datos frescos; es un error de costo (cada apertura golpearía las cinco
  bolsas) y además rompe la coherencia: `buildAnalytics` recalcula el score contra un perfil
  proyectado sobre las ofertas de la última corrida, así que con `force` el análisis hablaría
  de vacantes que la lista de al lado no tiene.
- **`?region=` con una región que no existe devuelve 200 con la región por defecto**, nunca
  400: `resolveRegion()` normaliza antes de usarlo. Un 400 por un query param del frontend
  sería un modo de falla del cliente, no del backend.

## Estado actual

El **andamiaje está hecho y verificado** (paso 1 del plan): `package.json` con workspaces,
`vercel.json`, `.gitignore`, `.env.example`, `scripts/check.js` y el `frontend/` copiado
del origen. El paso 2 (**configuración única de regiones**) tiene escrito
`lib/regions.js` y **el frontend ya está cableado**: `utils.js`, `RegionTabs.jsx` y
`App.jsx` lo importan. Falta que lo importen los módulos del backend que todavía no se
portaron (`apifyLinkedin.js`, que es el paso 10). El paso 3 (limpieza) **también está
hecho**, y fue casi todo frontend: `ConsultorasList.jsx` borrado, `FALLBACK.profile` (el
perfil falso de Ali) eliminado de `api.js`, las 7 regiones bajadas a Argentina y
`FALLBACK.jobs` sin los buckets de Europa y EEUU.

El **paso 4 (DB) está HECHO y VERIFICADO**: existen `migrations/` (los 8 de este paso; hoy
hay 13), `lib/db.js`
(el único lugar que abre conexiones), y `scripts/migrate.js`. **`npm run migrate` ya funciona**,
y el pool se crea la primera vez que alguien consulta de verdad — por eso `/api/health` puede
seguir respondiendo sin base de datos. El type parser de `NUMERIC` está activado globalmente en
`db.js` (§2.4 de MEMORIA.md).

El **paso 5 (auth) también está HECHO y VERIFICADO contra un Postgres real**: existen
`lib/auth.js` (cookie firmada + las dos compuertas), `lib/http.js` (errores, JSON,
cookies, `withErrorHandling`), `lib/rateLimit.js` (rate limit del login sobre la tabla
`login_attempts` de `migrations/009_login_attempts.sql`) y los endpoints `register.js`,
`login.js`, `logout.js`, `me.js` y `health.js`.

**Ojo con la numeración: hay dos listas de pasos y a partir del 8 se diferencian.** La de
este archivo ("estado actual") llama **paso 8 a la pantalla de acceso**, que ya está HECHA:
`frontend/src/components/AuthScreen.jsx`, los helpers `register`/`login`/`logout` de
`frontend/src/api.js` y el ruteo por compuertas en `App.jsx` (que ya no muestra el aviso de
sesión inválida). El **paso 8 del plan de `MEMORIA.md` §6 son las OFERTAS**, que también
están hechas (abajo). Cuando un documento diga "paso N", fijate en cuál de las dos listas
está escribiendo: el número solo no dice nada.

**Ojo con las tres capas de auth, que están separadas a propósito**:

| Capa | Dónde | Qué resolver |
|---|---|---|
| Sesión (cookie firmada, HMAC) | `auth.js` | `requireSession(req)` → `{ user }` o 401 |
| Perfil | `auth.js` | `requireProfile(req)` → `{ user, profile }` o **403** |
| Rate limit del login | `rateLimit.js` | `withLoginAttempt()` serializa por IP y agrupa límite, bcrypt y registro en una transacción |

Las dos primeras se distinguen por el **status**: 401 es "no sabés quién sos", 403 es "sabés
quién sos pero te falta el CV". `requireProfile` devuelve `{ user, profile }` **juntos** a
propósito: un endpoint que necesite el perfil casi siempre necesita también el `user_id`, y
devolverlos por separado es la forma de que alguien se olvide de uno y filtre datos de otro.
**`GET /api/me` es la excepción deliberada**: devuelve 200 con `profileComplete: false` porque
es el endpoint que *decide* a dónde va el usuario; un 403 ahí mandaría al login en un bucle.

**La cookie es un token firmado, no un id**: `v1.<user_id>.<exp>.<HMAC-SHA256 base64url>`.
El logout NO borra nada del servidor (no hay tabla de sesiones): manda una cookie con
`Max-Age=0`. Y **no hace falta una columna `session_version` para revocar**: la revocación
real es la fila de `users`, porque `requireSession` la consulta en cada request. Eso significa
que **una cookie de un usuario dado de baja da 401**, no un 200 con datos fantasma, y que la
forma de invalidarle todas las sesiones a alguien es borrarle la cuenta.

**No agregues `session_version` "por las dudas"**: se llegó a pensar durante el paso 11 y
salió al revés. Con `requireSession` validando contra `users` en cada request, una columna
de versión no agrega revocación: agrega **una escritura más por login** y un segundo lugar
donde el estado de la sesión puede quedar desincronizado del de la cuenta. Si algún día
hace falta revocar *sin* borrar la cuenta, esa es una decisión nueva, y el lugar para discutirla
es `MEMORIA.md` §5.

**`Secure` se omite solo en loopback**: `shouldUseSecureCookie()` lo desactiva si el host es
localhost/127.0.0.1 por HTTP, porque en local sobre `http://` un `Secure` hace que el navegador
**no** guarde la cookie y el login parecería fallar sin explicación. En cualquier otro host va
siempre, incluido `http://` con un dominio real.

`SESSION_SECRET` se valida **perezosamente** (en el primer uso, no al importar) y si falta o
mide menos de 32 caracteres devuelve un 500 con un mensaje que dice exactamente cómo
generarla. Es `ConfigError`, no `HttpError`, a propósito: 500 y no 4xx, para que un smoke test
que solo mira "no es 5xx" no lo dé por bueno.

**`new HttpError(status, mensaje, extra?, headers?)` — el status va PRIMERO y es obligatorio.**
Está verificado en el constructor: si el primer argumento no es un entero entre 400 y 599,
tira un `TypeError` en vez de armar una respuesta con un status que es una frase en español.
Ese chequeo existe porque el bug ocurrió de verdad en este paso: dos `throw` de
`auth.js:readCredentials` iban sin el `400` y producían
`status: La clave tiene que tener al menos 8 caracteres.`

**`lib/http.js` tiene CERO imports, y eso es una garantía, no un detalle de estilo.**
`health.js` importa `sendJson` de ahí, así que el grafo del smoke test termina en
`health.js → lib/http.js → (nada)` y no hay forma de que el endpoint toque la base. **Si
agregás un import a `http.js`, rompés esa garantía** (no el código, la promesa de que
`/api/health` responde sin DB). Verificado con `grep '^\s*import' lib/http.js` vacío y con
un proceso sin `DATABASE_URL` donde `closePool()` devuelve `false` (o sea, el pool nunca se
creó).

`login_attempts` cuenta los intentos fallidos **también para correos que no existen**, que es
lo que hace que el límite sirva: si solo contara contra cuentas reales, un atacante probando
correos inventados no contaría para nada. El login exitoso borra los intentos de ese correo.

**Ojo con `profile` nullable**: `loadProfile()` devuelve `null` sin perfil, y es el estado
normal de la app (se registra con correo+clave primero, el CV se sube después). Los
consumidores usan `profile?.` o `if (!profile) return null`. Con perfil ausente la UI
muestra "tu perfil" y el mensaje de postulación sale **sin firma**: no se muestra ni se
manda el nombre de nadie.

El **paso 6 (perfil por usuario) está HECHO y VERIFICADO**: existen `lib/profile.js`
(el reemplazo de `cvProfile.js`), `matcher.js`, `analytics.js`, `coverLetter.js` y el nuevo
`text.js` (helpers puros de texto, shared por los otros cuatro: `jobText`, `asText`,
`escapeReg`, `textHasSkill`, `toNumber`). `BASE_KEYWORDS`, `ROLE_SYNONYMS` e `isQARelevant`
**no se portaron**: la relevancia, los `roles`, `roleAffinity` e `inTitle` salen de
`profile.keywords` y de `profile.skills`, así que el mismo código rankea para un contador,
una enfermera o un QA. Verificado con `npm run check` (17 archivos), `npm run build`
(42 módulos) y una batería sintética que **no toca la DB ni Apify**.

Ojo también con: las dependencias de runtime (`pg`, `bcryptjs`, `pdf-parse`, `mammoth`) ya están
instaladas y **`scripts/migrate.js` existe**, así que **`npm run migrate` funciona**. El
frontend ya no consume endpoints inexistentes: los 6 de ofertas existen desde el paso 8, así
que `FALLBACK.jobs` queda solo para cuando el backend no responde (server caído, deploy
todavía en curso). Ver abajo.

El **paso 7 (onboarding) está HECHO y VERIFICADO de las dos mitades**: la de backend son
`lib/cvText.js` (validación MIME/tamaño + extracción de PDF/DOCX en memoria), `lib/llm.js`
(el único módulo que habla con el proveedor, con recorte de entrada y tope de salida) y
**`cv_parses`** (migración `010`) con `lib/cvParseLimit.js`, llamado desde `api/profile/[...slug].js`
paso 6. Verificado con `npm run check` (22 archivos), `npm run build` (43 módulos), las 10
migraciones aplicadas e idempotentes contra un Postgres 16, y 46 aserciones contra un
**OpenAI-compatible falso** en `127.0.0.1` con el PDF real: 401/415/400 no consumen cuota, 200
hasta el límite, 429 con `Retry-After` en el body y en el header, los rechazos no suman filas,
dos usuarios aislados, ventana relativa, purga a 24 horas, cascada al borrar la cuenta, y el
`CV_PARSE_LIMIT=0` de tests. El contador de llamadas al LLM falso coincidió **exactamente** con
la cantidad de 200.

La **mitad de frontend** de este paso son `frontend/src/components/CvOnboarding.jsx` (un solo
componente con dos usos: la compuerta del alta y el editor de un perfil existente), las cuatro
funciones de red de `frontend/src/api.js` (`loadSession`, `parseCv`, `saveProfile`, más
`apiError`) y el ruteo de las dos compuertas en `App.jsx`. Verificado con `npm run check` (22
archivos), `npm run build` (43 módulos) y 27 aserciones de la capa de red contra un backend
**falso** en `127.0.0.1` (no toca Apify, ni el LLM, ni la base).

Ojo con cuatro decisiones de esa capa, que no se deducen del código:

- **El aviso de privacidad también se muestra en la compuerta del alta**, no solo
  en el editor. `elegirArchivo()` descarta la selección mientras
  `mostrarPrivacidad` sea `true`; por eso `PrivacyNotice` tiene que renderizarse
  dentro del contenido compartido de `CvOnboarding`, para que un usuario nuevo
  pueda consentir y habilitar el botón de análisis.
- **`PUT /api/profile` es un REEMPLAZO, no un parche.** El formulario manda el perfil entero y
  arrastra los dos campos que **no** se editan (`marketSkills` y `projects`), porque lo que no
  viene en el body se borra. El editor los muestra contados y nombrados abajo del formulario
  para que nadie piense que se perdió nada. Por eso el editor es un modal aparte y no un
  "volvé a subir el CV": corregir un peso de skill no debería gastar otro análisis de la cuota.
- **El mensaje de error se muestra TAL CUAL** lo escribió `http.js`, y el cliente solo le AGREGA
  `status` y `retryAfter` (datos, no texto). El 429 se distingue por el ícono y por un color
  ámbar (`.cv-error.limite`), no por reescribir la explicación.
- **La compuerta se abre con `profileComplete === false` del `/api/me`, NO con `!profile`.**
  `loadProfile()` devuelve `null` tanto por un 403 real como por una llamada que falló, y con
  `!profile` un problema de red pintaba "subí tu CV" a alguien que ya lo subió.
- **Las dos escrituras del alta llevan `AbortSignal.timeout`** (75 s el parseo, 30 s el PUT) y
  las de lectura no. Las de lectura tienen `FALLBACK`, así que colgar no rompe nada; en el
  alta, colgar deja el botón en "Analizando tu CV…" para siempre, y en el parseo se está
  esperando a un LLM de pago. El abort se traduce a **504** (el mismo código que devuelve
  `cv/parse.js`) y no a `status: 0`, que queda para "no hubo conexión".

**Lo que NO hay todavía**: una compuerta en el alta. El rate limit del LLM limita **una** cuenta:
con el registro abierto y sin verificación de correo, un adversario se registra diez cuentas y
tiene diez cuotas. La salida es una compuerta en el alta, **no** subir el límite por usuario. La
pantalla de acceso del paso 8 **no** la implementa, a propósito: sin un proveedor de correo no
hay forma honesta de verificar que el correo existe, y un campo de "código de invitación" sin un
dueño que reparta códigos es una formalidad. Queda anotado en `MEMORIA.md` §5, duda 5.

### La pantalla de acceso se DIBUJA, no se redirige
`AuthScreen.jsx` se renderiza desde el condicional `sinSesion` de `App.jsx`, y no hay un router
ni una ruta `/login`. Tres razones, en orden de peso:

- **El F5 sobre `/login` tiene que volver a pintar el login.** Con router eso se resuelve con una
  regla de redirección; sin router, el condicional que devuelve el mismo componente cada vez
  resuelve el caso sin una sola ruta nueva.
- **`sin-sesion` es el ÚNICO estado que abre la pantalla.** `'desconocido'` (el `/api/me` todavía
  no respondió) y `'sin-respuesta'` (no hubo backend) tienen que **conservar las ofertas
  `FALLBACK`**: con el server caído, mandar a alguien a un login que tampoco va a funcionar es
  peor que mostrarle la app en modo demo. Es la distinción que justifies el string de estado en
  vez de un booleano.
- **El 401 no se corrige con un banner de error arriba.** Con la pantalla delante no hay nada más
  que leer, así que el error va adentro del formulario, que es donde está el campo que hay que
  corregir.

Ojo con cuatro decisiones que no se deducen del código:

- **El login y el registro son UN componente con un modo interno**, no dos. Los dos formularios
  piden exactamente lo mismo, y el error del 409 convive con el 401 del login en la misma
  pantalla. Cambiar de modo **limpia el error y la clave, pero no el correo**.
- **`autocomplete` cambia según el modo** (`current-password` en login, `new-password` en
  registro). Con `new-password` en el login el gestor de contraseñas se niega a autocompletar; con
  `current-password` en el registro ofrece *generar* una clave y se la mete al usuario.
- **NO se valida el formato del correo ni el largo de la clave en el cliente.** Se manda y se
  muestra lo que responda el backend (`auth.js:readCredentials` es quien tiene las reglas). Un
  formulario con su propia versión de "esto no es un correo" muestra un error distinto del del
  servidor, y ahí hay dos verdades. La única guarda local es el botón deshabilitado con los
  campos vacíos, que evita un 400 previsible y no es una regla de negocio.
- `AuthScreen.jsx` guarda la clave en el estado local `clave`, pero las funciones `register()`
  y `login()` reciben el campo `password`: al llamarlas hay que mapearlo como
  `{ email, password: clave }`. Si se pasa `{ email, clave }`, JSON omite `password` y el
  backend responde 400 ("Necesitás el correo y la clave.").
- **`logout()` NO lanza y devuelve `false` si el backend no responde.** El logout no borra nada
  del servidor: manda la cookie con `Max-Age=0`. Si el server estaba caído, la cookie sigue viva en
  el navegador, y `handleLogout` pone `estado: 'sin-sesion'` igual. La alternativa —dejar al
  usuario en la app con un botón que no hace nada— es peor que un logout optimista que el próximo
  `GET /api/me` corrige con un 401. `handleLogout` **limpia el estado local entero**
  (`profile`, `analytics`, `jobsData`, `editando`): las ofertas y la analítica son de ESE
  usuario, y dejarlas sería mostrarle a alguien los datos de la sesión anterior con su nombre
  arriba.

Y dos cosas que se ven exercising y que son de `login.js`, no del frontend:

- **Una clave de menos de 8 caracteres da 400 y NO cuenta como intento.** `readCredentials`
  corre antes de `withLoginAttempt`, así que no se llega al rate limit. No es una falla: ese
  intento no corrió bcrypt ni tocó `users`. Pero sí significa que un 429 tiene que armarse con
  claves largas y **deben pasar por la validación de formato**, o el test no mide lo que dice medir.
- **El límite es por PAREJA (correo+ip), no por correo ni global.** `LOGIN_LIMIT_MAX_PER_PAIR`
  viene en 10 y `LOGIN_LIMIT_MAX_PER_IP` en 30, con ventana de 15 min. Para ejercitar el 429 hay
  que vaciar `login_attempts` después, porque la ventana no expira en un test.

### El paso 8 (OFERTAS) está HECHO Y VERIFICADO: la app ya muestra ofertas de verdad
Son 12 archivos: `lib/jobSources.js` (las 5 bolsas gratuitas, `fetchJobs(profile)` →
`{ jobs, online }`), `lib/portal.js`, `lib/searchTerms.js`, `lib/history.js`,
`lib/jobs.js` (el orquestador, `getRanked()` → `{ regions, _online, source,
checkedAt }`), los 6 endpoints y `migrations/011_searches_online.sql`.

**Antes de este paso la app compilaba pero los 6 endpoints de ofertas devolvían 404 y el
frontend pintaba el set demo `FALLBACK.jobs`. Ahora `/api/jobs` devuelve ofertas reales de
las 5 bolsas y la app NO muestra `FALLBACK.jobs` mientras el backend responda**: el fallback
queda solo para cuando no hay backend, que es un estado distinto y real (server caído,
deploy en curso).

Cifras verificadas (las dos baterías de aserciones, la propia y la del subagente, corrieron
contra un Postgres real con cookie firmada de verdad vía `createSessionToken`):

| | |
|---|---|
| `npm run check` | **OK: 33 archivos** (antes 26: +7 de `api/`) |
| `npm run build` | 44 módulos |
| `/api/jobs?region=argentina` | **118 ofertas reales en 1682 ms**, `_online: true` — cifra **previa** al arreglo de Jobicy, así que el total actual es mayor |
| 2ª llamada (caché) | las mismas 118 en **35 ms**, `source: 'cache'` — 48× (el `source` sigue valiendo; el total no) |
| `POST /api/refresh` | 200 `ok:true`, y después `/api/jobs` sirve la corrida nueva |
| las 6 compuertas | sin cookie → **401** en los 6; con cookie y sin perfil → **403** + `profileComplete:false`; cookie manipulada → 401 |
| `GET /api/job?q="'; drop table users; --"` | **404, no 500** |
| aislamiento | una oferta del usuario QA da **404** para la enfermera; `?user_id=` en la URL **se ignora** |

Detalles de contrato que salieron de ejercitarlo, y que no se deducen del código:

- **`_online` llegó `true` con Arbeitnow devolviendo HTTP 429.** Es el comportamiento de
  `allSettled` en `jobSources.js`: `_online` se pone **por petición**, no por fuente, así que
  que una bolsa haya agotado su cuota no significa "no se pudo contactar Remotive". Y
  `/api/jobs` nunca da 500 por culpa de la API de una bolsa: cada fetcher se traga su propio
  error.
- **`/api/analytics` manda `githubEvidence` con `projects` SIEMPRE array** (aunque vacío),
  porque `AnalysisPage.jsx:186` hace `skill.projects.map(...)` sin `|| []` adentro: un item sin
  ese campo no muestra una fila vacía, **tira la excepción de render y se cae la pestaña de
  análisis entera**. Y `candidato.skills` llega como **array** `[{name, weight}]` con `weight`
  **numérico**, gracias al type parser de `db.js`.
- **Perfil sin skills → 200 con `skills: []`**, no `undefined` ni 500.
- **Región inexistente → 200 con la región por defecto**, nunca 400.

Y el hallazgo que hay que leer bien, porque parece un bug y **no lo es**: con perfiles de
prueba, **QA da 118 ofertas, Chef 13, Enfermera 0** (cifras previas al arreglo de Jobicy de
`MEMORIA.md` §4.10: el total de QA ya cambió, la conclusión no). Es la consecuencia directa de
haber roto el `PROFILE` global en el paso 6: las 5 bolsas son gratuitas, mayormente en inglés y
globales, así que "enfermería" no matchea una descripción en inglés. Lo que **demuestra** es
que el matcher rankea de verdad según el perfil y no devuelve un número constante — o sea que la
generalización del paso 6 funciona. El problema de fondo (que no haya bolsas gratuitas en
español) **no se resuelve en este paso**: es un paso propio.

### El paso 9 (Directorio de Argentina) está HECHO y VERIFICADO (2026-10-03)

Son 5 archivos nuevos + 6 modificados:
- `lib/directorio.js` — catálogo puro (9 bolsas + 4 consultoras de Argentina), `slugify`, `linkedinSearchUrl`, `consultoraSearchUrl` (mudadas de `utils.js`), `directorioFor`, `buildDirectory`.
- `api/directorio.js` — `GET /api/directorio?region=` con `requireProfile`, `normalizeProfile` + `loadProfileSkills`, `sendJson`.
- `frontend/src/components/DirectorioPage.jsx` — vista con dos secciones (bolsas/consultoras), tarjetas reusando `.job-card`, etiquetas `searchKind` (`sitio`/`google`/`ninguno`), aviso honesto cuando `keyword === ''`.
- `frontend/src/components/RegionTabs.jsx` — botón `🔗 Directorio de empleo` en `.region-tabs-secondary`, exporta `SECCIONES = ['analisis', 'directorio']` y `esSeccion()`.
- `frontend/src/api.js` — `loadDirectorio(region)` (patrón de lectura con `FALLBACK: null`).
- `frontend/src/App.jsx` — cableado en `goToRegion` (rama `directorio` ANTES de países, cachea con `directorioCargado`), `statusText`, `handleRefresh` (vuelve a pedir el catálogo), `handleToggleHistory` (bloquea en secciones), `limpiarSesion` (limpia `directorio` + flag), render ternario `region === 'directorio' ? <DirectorioPage/>`.
- `frontend/src/Toolbar.jsx` — `esSeccionActual = esSeccion(region)` (generaliza el viejo `isConsulta`).
- `frontend/src/styles.css` — bloque `.directorio-*`, grilla `repeat(auto-fit, minmax(260px, 1fr))`, reusa `.cat-pill` + `.cat-qa`/`.cat-multi`/`.cat-gov` para las tres `searchKind`, **limpia clases huérfanas del tracker de outreach** (`.consultoras-tab`, `.consultoras-filter`, `.filter-label`, `.consultora-controls`, `.estado-select`, `.notas-input`, `.consultora-card`, `.consultora-logo`, `.consultora-logo-init`, y las tres variantes `.cat-it`, `.cat-staffing`, `.cat-fintech`).
- `frontend/src/utils.js` — `linkedinSearchUrl` reexportada desde `../../lib/directorio.js`; `consultoraSearchUrl` borrada (se mudó al backend).

**Verificación**: `npm run check` → **OK: 36 archivos** (antes 34: +2 `api/`); `npm run build` → 50 módulos. 43 aserciones del módulo puro (script temporal): `slugify` (acentos, `C#/C++`, vacío, signos, `ñ`), `linkedinSearchUrl`/`consultoraSearchUrl` byte a byte, respuesta exacta (`Object.keys` profundo), 8 bolsas `sitio` + Get on Board `ninguno`, 4 consultoras `google`/`ninguno`, caso sin perfil en 4 variantes (`null`, `{}`, `skills: []`, skills sin peso) → 13 entradas a `searchUrl === home` con `searchKind: 'ninguno'`. **0 fallas**.

**Bolsas incluidas (verificadas)**: LinkedIn (SSR), Indeed AR (`?q=`, 403 a curl es anti-bot), Computrabajo (path `/trabajo-de-{slug}`, SSR, el más limpio), Bumeran (documentado por su sitemap, SPA), Empleo.com (`?q=`, español AR), Randstad AR (`/trabajos/{slug}/`, sin prefijo `s-`), Michael Page (`?search=`, sin ubicación), Jooble AR (patrón del índice, 403 a bots), Get on Board (vivo, `?q=` ignorado → `home` con `country=Argentina`).

**Consultoras incluidas**: Randstad, Michael Page (Google `site:`), Adecco, Manpower (sin búsqueda por URL → `home`).

**Excluidos con evidencia**: Hays (DNS falla, no opera en AR), Kelly (DNS falla, negocio absorbido), `bolsatrabajo.com` (dominio a la venta), `zonajobs.com.ar` (absorbido por Bumeran).

| Skill | Cubre |
|---|---|
| `.opencode/skill/verificar-cambio/` | el ciclo de verificación y la prohibición de llamar a Apify |
| `.opencode/skill/comparar-match/` | `computeMatch`, la fórmula del score y su generalización |
| `.opencode/skill/propuesta-interes/` | `buildAnalytics` y las 6 recomendaciones |
| `.opencode/skill/agregar-pais/` | la configuración única de regiones (punto 9) |

`MEMORIA.md` tiene el detalle de todo esto con `archivo:línea`, las **decisiones ya tomadas**
(inclusive la 9, la de la cascada), las dudas que siguen abiertas, y el plan de trabajo en 12
pasos. **El paso 9 (directorio de Argentina) está HECHO y VERIFICADO** (2026-10-03). **El paso 10 (Apify) está HECHO y VERIFICADO** (2026-10-03). **El paso 12 (guía de despliegue Vercel) está HECHO** (2026-10-03, `VERCEL_DEPLOY.md`). **Los 12 pasos del plan están completados.**

La fuente de verdad para el código a portear es `F:\busqueda_trabajo`.

**No copies `MEMORIA.md`, `DOCUMENTACION.md`, los logs (`*.log`) ni los archivos
`C?Users*sh-run.*` del origen**: son andamiaje de trabajo del proyecto anterior, no
documentación de este. El `AGENTS.md` del origen tiene una sección "Estado actual" que ya
era **falsa** cuando la leí (decía que había trabajo sin commitear; el árbol estaba limpio y
el frontend ya consumía `portal`/`saved`/`stats`). Si leés documentación vieja, verificala
contra el código antes de creerla.
