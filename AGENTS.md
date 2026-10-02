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

### Lo que se hereda intacto
`jobSources.js` (bolsas gratis), `matcher.js` (`computeMatch`), `coverLetter.js`
(cartas de presentación), `history.js` (historial, su lógica de deduplicado y expiración),
`portal.js` (`withPortal`), `analytics.js`, el frontend React 18 + Vite completo
(`App.jsx`, `utils.js`, los 9 componentes).

### Lo que se elimina
`consultoras.js`, `consultorasStore.js`, `ConsultorasList.jsx`, la pestaña "consultoras",
sus endpoints `/api/consultoras*`, su tracker y `CONSULTORAS_DATA_DIR`.
También `curatedJobs.js` y `demoData.js`: son 57 ofertas y un set de demo **escritas a mano
para Ali y en otros países** (Perú, Colombia, Chile, México, Europa). No son datos
reutilizables para un usuario genérico — borrarlas o vaciarlas, no "adaptarlas".

## Comandos

No hay linter, ni formateador, ni typecheck, ni framework de tests. **No los agregues**:
la verificación es manual (abajo).

```bash
npm install                    # instala TODO (raíz + frontend, ver workspaces más abajo)
npm run check                  # node --check sobre cada .js de api/ y scripts/
npm run build                  # vite build -> frontend/dist
npm run migrate                # aplica migrations/*.sql contra DATABASE_URL
npm run dev                    # vite en 5173, con proxy /api -> localhost:3000
npx vercel dev                 # serverless local: usa esto para probar /api de verdad
```

`npm run dev` **no levanta el backend**: es solo Vite. Para tocar `/api`, o `npx vercel dev`,
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
`vite` no estaría instalado y el `buildCommand` fallaría en cada deploy.

Consecuencia práctica: `npm install` en la raíz instala las dependencias de los dos lados y
**no existe `frontend/node_modules`** (todo queda hoisted en el `node_modules` raíz). Si
algún día agregás una dependencia al frontend, la instalás desde la raíz, no de adentro.

### `npm run check` no mira los `.jsx`

`node --check` no sabe parsear JSX, así que `scripts/check.js` solo recorre los `.js` de
`api/` y `scripts/`. **Los `.jsx` los valida el build de Vite**, que además detecta imports
rotos. Por eso `npm run build` es obligatorio cuando tocaste `frontend/src`.

## Verificación (es lo único que hay)

```bash
npm run check                                  # 1. sintaxis de api/ y scripts/
npm run build                                  # 2. que el JSX compila (detecta imports rotos)

# 3. que las funciones responden. /api/health NO toca la DB ni Apify: es el smoke test.
curl -fsS localhost:3000/api/health
curl -fsS localhost:3000/api/jobs               # necesita sesión: cookie de login
curl -fsS localhost:3000/api/directorio         # sin sesión, si lo dejás público
```

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

Nunca leas, imprimas ni commitees el valor de `APIFY_API_TOKEN`.

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
| `api/lib/profile.js` (nuevo) | — | Es el que reemplaza al `cvProfile.js`: `loadProfile(userId)` lee `profiles` + `skills` **siempre** por `user_id`, y `normalizeProfile(row, skillRows)` convierte la fila cruda (snake_case) al contrato de la API. |

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
`publishedAt(job)`** (`matcher.js:264`), que prueba `date || postedAtTimestamp || postedAt` en
ese orden. No hardcodees `job.postedAt` en un sort: **las 5 bolsas de `jobSources.js`
normalizan a `date`** (`publication_date`, `created_at`, `pubDate`) y `postedAt` solo existe
en Apify, así que desempatar por `postedAt` comparaba `''` contra `''` en toda la ruta
gratuita y no desempataba nada. El orden de campos es el mismo que usa `history.js:45`.
Y ojo con `||` contra `??`: `date` puede ser `''` (Remotive sin fecha) y eso es *falsy*, así
que tiene que ser `||`, no `??`.

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

### Las regiones NO están repetidas en el frontend: salen de `api/lib/regions.js`
El origen las tenía en 5 lugares (`cvProfile.regions`, `apifyLinkedin.REGION_LOCATIONS`,
`analytics.js`, `matcher.assignRegion()` y `utils.js REGION_LOCATION`). Hoy **el frontend las
importa**: `utils.js` deriva `REGION_LOCATION` de `REGIONS`, `RegionTabs.jsx` genera las
pestañas con `Object.keys(REGIONS)`, y `App.jsx` usa `regionLabel()`.

**Vite SÍ resuelve imports fuera del root del workspace**: `frontend/src/utils.js` importa
`../../api/lib/regions.js` y el build pasa, porque el archivo es JS puro sin dependencias de
Node. Ojo con el path: desde `src/` van **dos** `..` y desde `src/components/` **tres**.
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

Cada función exporta `GET`/`POST` y usa `export const config = { maxDuration: 30 }`.
`vercel.json` enruta `/api/*` a las funciones y el rewrite del SPA **excluye `api/`** con
`/((?!api/).*)`: si el rewrite se llevara `/api/health`, el smoke test recibiría el
`index.html` del frontend en vez de JSON, y el deploy no podría distinguir "la función no
arrancó" de "devolvió basura".

### `db.js` es el único que abre conexiones, y una línea de ahí no se puede sacar
`api/lib/db.js` es el **único** módulo del proyecto que abre conexiones. Nada más importa `pg`.
Dos cosas sueltas que no se deducen del código:

- **El pool se crea la primera vez que alguien consulta de verdad, no al importar el archivo.**
  Es deliberado: es lo que permite que `/api/health` responda **sin base de datos** (el smoke
  test del deploy no puede depender de que Neon esté sano). Si alguna vez agregás un
  `new Pool()` a nivel de módulo, o un `await` en el import, rompés esa garantía.
- **`pg` devuelve `NUMERIC` como string, y `api/lib/db.js` lo arregla con un type parser
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
- Si agregás o cambiás un endpoint, actualizá la tabla de la API del `README.md`. El
  `README.md` es la documentación real del proyecto; `DOCUMENTACION.md` quedó viejo en el
  origen (no menciona `APIFY_MAX_RESULTS` ni el contrato nuevo de `/api/linkedin-search`):
  no lo tomes como fuente de verdad.
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
- El CV: validar **tipo MIME y tamaño** antes de parsear, y no guardarlo en disco (Vercel es
  efímero). Extraer texto en memoria, mandarlo al LLM, y persistir **solo el perfil
  derivado**. Si se conserva el archivo, es Vercel Blob — y entonces hay que definir qué
  pasa con la foto.
- `/api/health` debe seguir respondiendo **sin** token de Apify y **sin** base de datos: es
  lo que usa el smoke test. Si le agregás un `SELECT 1`, el deploy deja de poder
  diagnosticar un problema de DB.
- Borrar cuenta = **un** `delete from users where id = $1`. **NO son N `DELETE` explícitos**:
  las **seis** FK a `users` llevan **`on delete cascade`** (en `profiles` esa FK además es la
  primary key de la tabla), así que un solo `DELETE` se lleva `profiles`, `skills`, `searches`,
  `job_history`, `favorites` y `apify_usage`. La línea vieja de este archivo ("sin cascada, son
  N `DELETE` explícitos") era anterior a las migraciones y quedó **revertida**: el porqué
  completo, y **las dos limitaciones que la cascada NO arregla** (no protege borrar mal *una*
  cuenta, y no deja rastro de la baja), están en `MEMORIA.md` §4.1, decisión 9. Lo que sí sale
  de ahí: **logueá la baja en el endpoint ANTES del `delete`**, porque la fila desaparece y la
  base no guarda ningún registro del evento.
- Secretos **solo** en variables de entorno de Vercel. `.env` nunca se commitea.

## Estado actual

El **andamiaje está hecho y verificado** (paso 1 del plan): `package.json` con workspaces,
`vercel.json`, `.gitignore`, `.env.example`, `scripts/check.js` y el `frontend/` copiado
del origen. El paso 2 (**configuración única de regiones**) tiene escrito
`api/lib/regions.js` y **el frontend ya está cableado**: `utils.js`, `RegionTabs.jsx` y
`App.jsx` lo importan. Falta que lo importen los módulos del backend que todavía no se
portaron (`apifyLinkedin.js`, que es el paso 10). El paso 3 (limpieza) **también está
hecho**, y fue casi todo frontend: `ConsultorasList.jsx` borrado, `FALLBACK.profile` (el
perfil falso de Ali) eliminado de `api.js`, las 7 regiones bajadas a Argentina y
`FALLBACK.jobs` sin los buckets de Europa y EEUU.

El **paso 4 (DB) está HECHO y VERIFICADO**: existen `migrations/` (9 archivos), `api/lib/db.js`
(el único lugar que abre conexiones), y `scripts/migrate.js`. **`npm run migrate` ya funciona**,
y el pool se crea la primera vez que alguien consulta de verdad — por eso `/api/health` puede
seguir respondiendo sin base de datos. El type parser de `NUMERIC` está activado globalmente en
`db.js` (§2.4 de MEMORIA.md).

El **paso 5 (auth) también está HECHO y VERIFICADO contra un Postgres real**: existen
`api/lib/auth.js` (cookie firmada + las dos compuertas), `api/lib/http.js` (errores, JSON,
cookies, `withErrorHandling`), `api/lib/rateLimit.js` (rate limit del login sobre la tabla
`login_attempts` de `migrations/009_login_attempts.sql`) y los endpoints `register.js`,
`login.js`, `logout.js`, `me.js` y `health.js`. **Lo que NO hay todavía**: el frontend de
auth (formularios de login/registro y ruteo por `profileComplete`), y los endpoints que
consumen perfil, así que la segunda etapa del alta todavía no se puede completar desde la UI.

**Ojo con las tres capas de auth, que están separadas a propósito**:

| Capa | Dónde | Qué resolver |
|---|---|---|
| Sesión (cookie firmada, HMAC) | `auth.js` | `requireSession(req)` → `{ user }` o 401 |
| Perfil | `auth.js` | `requireProfile(req)` → `{ user, profile }` o **403** |
| Rate limit del login | `rateLimit.js` | `assertLoginAllowed()` antes de comparar claves |

Las dos primeras se distinguen por el **status**: 401 es "no sabés quién sos", 403 es "sabés
quién sos pero te falta el CV". `requireProfile` devuelve `{ user, profile }` **juntos** a
propósito: un endpoint que necesite el perfil casi siempre necesita también el `user_id`, y
devolverlos por separado es la forma de que alguien se olvide de uno y filtre datos de otro.
**`GET /api/me` es la excepción deliberada**: devuelve 200 con `profileComplete: false` porque
es el endpoint que *decide* a dónde va el usuario; un 403 ahí mandaría al login en un bucle.

**La cookie es un token firmado, no un id**: `v1.<user_id>.<exp>.<HMAC-SHA256 base64url>`.
El logout NO borra nada del servidor (no hay tabla de sesiones): manda una cookie con
`Max-Age=0`. La revocación real es la versión del token, que hoy está fija en `v1` porque el
paso 11 (borrar cuenta) necesita invalidar sesiones. `requireSession` consulta `users` en
cada request, así que **una cookie de un usuario dado de baja da 401**, no un 200 con datos
fantasma.

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

**`api/lib/http.js` tiene CERO imports, y eso es una garantía, no un detalle de estilo.**
`health.js` importa `sendJson` de ahí, así que el grafo del smoke test termina en
`health.js → lib/http.js → (nada)` y no hay forma de que el endpoint toque la base. **Si
agregás un import a `http.js`, rompés esa garantía** (no el código, la promesa de que
`/api/health` responde sin DB). Verificado con `grep '^\s*import' api/lib/http.js` vacío y con
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

El **paso 6 (perfil por usuario) está HECHO y VERIFICADO**: existen `api/lib/profile.js`
(el reemplazo de `cvProfile.js`), `matcher.js`, `analytics.js`, `coverLetter.js` y el nuevo
`text.js` (helpers puros de texto, shared por los otros cuatro: `jobText`, `asText`,
`escapeReg`, `textHasSkill`, `toNumber`). `BASE_KEYWORDS`, `ROLE_SYNONYMS` e `isQARelevant`
**no se portaron**: la relevancia, los `roles`, `roleAffinity` e `inTitle` salen de
`profile.keywords` y de `profile.skills`, así que el mismo código rankea para un contador,
una enfermera o un QA. Verificado con `npm run check` (17 archivos), `npm run build`
(42 módulos) y una batería sintética que **no toca la DB ni Apify**.

Ojo también con: las dependencias de runtime (`pg`, `bcryptjs`, `pdf-parse`, `mammoth`) ya están
instaladas y **`scripts/migrate.js` existe**, así que **`npm run migrate` funciona**. El frontend
compila pero todavía consume endpoints que no existen, y muestra el set de ofertas demo del
`FALLBACK.jobs` mientras el backend no responda.

| Skill | Cubre |
|---|---|
| `.opencode/skill/verificar-cambio/` | el ciclo de verificación y la prohibición de llamar a Apify |
| `.opencode/skill/comparar-match/` | `computeMatch`, la fórmula del score y su generalización |
| `.opencode/skill/propuesta-interes/` | `buildAnalytics` y las 6 recomendaciones |
| `.opencode/skill/agregar-pais/` | la configuración única de regiones (punto 9) |

`MEMORIA.md` tiene el detalle de todo esto con `archivo:línea`, las **decisiones ya tomadas**
(inclusive la 9, la de la cascada), las dudas que siguen abiertas, y el plan de trabajo en 12
pasos. Leelo antes de codear: casi todas las decisiones del plan salen de ahí.

La fuente de verdad para el código a portear es `F:\busqueda_trabajo`.

**No copies `MEMORIA.md`, `DOCUMENTACION.md`, los logs (`*.log`) ni los archivos
`C?Users*sh-run.*` del origen**: son andamiaje de trabajo del proyecto anterior, no
documentación de este. El `AGENTS.md` del origen tiene una sección "Estado actual" que ya
era **falsa** cuando la leí (decía que había trabajo sin commitear; el árbol estaba limpio y
el frontend ya consumía `portal`/`saved`/`stats`). Si leés documentación vieja, verificala
contra el código antes de creerla.
