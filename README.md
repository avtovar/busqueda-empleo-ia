# busqueda-empleo-ia

[![CI](https://github.com/avtovar/busqueda-empleo-ia/actions/workflows/ci.yml/badge.svg)](https://github.com/avtovar/busqueda-empleo-ia/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%3E%3D20-green)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Buscador de empleo para **Argentina**: subís tu CV, la app arma tu perfil, busca ofertas
en bolsas reales, calcula un **match** entre tu perfil y cada oferta, y te arma una
**propuesta de interés** con las skills que te faltan y las que el mercado pide.

Multiusuario, sin backend con estado: funciones serverless + Postgres.

> **Estado: en construcción.** Es un proyecto activo, no un producto terminado.
> Está hecho el camino completo de alta → CV → perfil → ofertas → match → carta →
> analítica, y también el borrado de cuenta. **Falta** el despliegue a Vercel.
> La sección [Qué falta](#qué-falta-y-por-qué-importa-el-orden) lo explica sin adornos.

---

## Índice

- [Qué hace](#qué-hace)
- [Limitación conocida, leela antes de probarlo](#limitación-conocida-leela-antes-de-probarlo)
- [Cómo correrlo](#cómo-correrlo)
- [Variables de entorno](#variables-de-entorno)
- [La API](#la-api)
- [Cómo está armado](#cómo-está-armado)
- [Los dos servicios que cuestan plata](#los-dos-servicios-que-cuestan-plata)
- [Verificación](#verificación)
- [Qué falta y por qué importa el orden](#qué-falta-y-por-qué-importa-el-orden)
- [Documentación para trabajar acá](#documentación-para-trabajar-acá)

---

## Qué hace

1. **Te registrás con correo y clave.** El perfil todavía no existe: es el estado
   normal de una cuenta nueva.
2. **Subís tu CV** (PDF o DOCX). Un LLM lo lee y arma un perfil: nombre, título,
   años de experiencia, resumen y **skills con un peso** entre 0 y 1. Ves el
   resultado antes de guardarlo y lo podés editar a mano.
3. **Buscás ofertas** contra tu perfil. Las app de cada bolsa son **gratuitas** y
   devuelven JSON directo: Remotive, Arbeitnow, Himalayas, RemoteOK y Jobicy.
   Los resultados se rankean por match y se cachean 30 minutos.
4. **Cada oferta trae su match**: el porcentaje, las skills que **coinciden** (verde)
   y las que **te faltan** (rojo).
5. **Carta de presentación** para la oferta que elijas, firmada con tu nombre y
   escrita desde el contexto del puesto y tu perfil.
6. **Propuesta de interés**: el cruzamiento de tu perfil contra las ofertas de la
   última corrida — demanda del mercado por cada skill, qué te sobra, qué te falta
   y por dónde convienestudiar.

## Limitación conocida, leela antes de probarlo

**Las 5 bolsas son gratuitas, globales y mayormente en inglés.** Con perfiles de
prueba, un perfil de **QA ve 118 ofertas**, uno de **Chef 13**, y uno de
**Enfermera 0**.

No es un bug: es la consecuencia de que las bolsas gratuitas no tengan cobertura en
español. `"enfermería"` no matchea una descripción de puesto en inglés. Lo que sí
demuestra es que el match se calcula **de verdad contra el perfil** y no devuelve un
número constante — si devolviera lo mismo para todos, los tres perfiles darían lo
mismo.

La forma de mejorar esa cobertura es agregar bolsas con más avisos en español. LinkedIn ya
está disponible como búsqueda automatizada, pero usa Apify y se factura (ver
[`/api/linkedin-search`](#los-dos-servicios-que-cuestan-plata)).

## Cómo correrlo

Necesitás **Node 20.19 o superior** y un **Postgres**.

```bash
git clone https://github.com/avtovar/busqueda-empleo-ia.git
cd busqueda-empleo-ia
npm install            # instala la raíz y el frontend (es un workspace de npm)
cp .env.example .env   # completá las variables (abajo)
npm run migrate        # crea el esquema
```

Después:

```bash
npx vercel dev          # backend real (funciones serverless) en :3000
npm run dev             # frontend con Rspack en :5173, proxea /api a :3000
```

`npm run dev` **no levanta el backend**: es solo Rspack. Para tocar `/api` de verdad,
`npx vercel dev` o levantá un server a mano.

> `npx vercel` y no `vercel dev` a propósito: la CLI de Vercel **no** es una
> dependencia del proyecto, así que no se descarga en cada `npm install`. `npx` la
> baja una vez y la cachea.

## Variables de entorno

Se configuran en `.env` para desarrollo y en el panel de Vercel para producción.

### Obligatorias

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a Postgres. **En Neon o Supabase usá el _pooler_** (el puerto pooler de Neon, el transaction pooler `6543` de Supabase), no la conexión directa: las funciones serverless abren y cierran conexiones por invocación. Para un Postgres local que no habla TLS, agregale `?sslmode=disable`. |
| `SESSION_SECRET` | Clave con la que se firma la cookie de sesión. Mínimo 32 caracteres. Generala con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Rotarla invalida todas las sesiones abiertas.** |

### Para el parseo del CV (cuesta plata)

| Variable | Para qué |
|---|---|
| `LLM_API_KEY` | Clave del proveedor que lee el CV y arma el perfil. Es **compatible con cualquier API estilo OpenAI**: la URL sale de `LLM_BASE_URL`, y si no la ponés usa `https://api.openai.com/v1`. |

Sin `LLM_API_KEY` el registro y el login funcionan, pero **no se puede subir el CV**.
No hay otra forma de crear un perfil.

### Opcionales, con default

| Variable | Default | Para qué |
|---|---|---|
| `PG_POOL_MAX` | `2` | Conexiones máximas por invocación. Subirlo multiplica por cada invocación en paralelo. |
| `PG_POOL_IDLE_MS` | `10000` | Milisegundos que un cliente puede quedar ocioso. |
| `MIGRATE_LOCK_TIMEOUT_MS` | `60000` | Espera de `npm run migrate` si otra migración está corriendo. |
| `CV_PARSE_LIMIT` | `5` | Cuántos CVs puede analizar un usuario por ventana. **Subirlo sube el costo máximo por cuenta de forma lineal.** |
| `CV_PARSE_LIMIT_WINDOW_MINUTES` | `60` | Tamaño de esa ventana. |
| `CV_PARSE_RETENTION_HOURS` | `24` | Cuánto se guarda el registro de un parseo antes de purgarlo. |
| `LLM_MODEL` | el del proveedor | Solo si tu proveedor tiene más de un modelo. |

### Para LinkedIn (cuesta plata, **implementado**)

| Variable | Default | Para qué |
|---|---|---|
| `APIFY_API_TOKEN` | — | Token del **dueño de la app**, nunca del usuario. |
| `APIFY_MAX_RESULTS` | `200` | Máximo de ofertas por búsqueda. |
| `APIFY_DAILY_LIMIT` | `3` | Búsquedas por usuario por día. |

> **Ojo grave:** cada búsqueda de LinkedIn **ejecuta un actor de Apify y se cobra**.
> El endpoint `/api/linkedin-search` **EXISTE** (implementado 2026-10-03) con rate limit diario `apify_usage` + `APIFY_DAILY_LIMIT`. **Nunca lo llames para probar** — usá `/api/health`, `/api/jobs`, `/api/directorio`, `/api/analytics` que son gratis.

## La API

Cada función exporta el verbo HTTP que le corresponde (`GET`, `POST`, `PUT` o
`DELETE`) y usa `export const config = { maxDuration: 30 }`.

La columna **compuerta** es lo único que hay que mirar antes de tocar un handler: es la
que decide si el frontend cae en la pantalla de acceso (401), en el onboarding del CV
(403) o entra a la app (200).

| Método | Ruta | Compuerta | Devuelve |
|---|---|---|---|
| `GET` | `/api/health` | ninguna | `{ ok, service, time }`. No toca la DB ni Apify: es el smoke test del deploy |
| `POST` | `/api/register` | ninguna (es el alta) | `{ ok, user, profileComplete: false }`. **Nunca** escribe `profiles` |
| `POST` | `/api/login` | ninguna | `{ ok, user, profileComplete }`. Mismo cuerpo y tiempo pareados para correo inexistente y clave mala |
| `POST` | `/api/logout` | ninguna | `{ ok: true }` + cookie con `Max-Age=0`. No borra nada del servidor. Es el único que **no** llama a `requireSession`: si no hay sesión, no hay cookie que borrar y tampoco hay nada que terminar |
| `GET` | `/api/me` | `requireSession` | `{ user, profileComplete }`. **Es el que decide a dónde va el usuario**: 200 siempre, nunca 403 |
| `GET` | `/api/profile` | **`requireProfile`** | el perfil del contrato, plano (sin envoltorio) |
| `PUT` | `/api/profile` | `requireSession` | `{ ok, profileComplete, profile }`. Es **reemplazo**, no parche: lo que no viene en el body se borra |
| `POST` | `/api/cv/parse` | `requireSession` | `{ ok, profile, kind, saved: false }`. **Único** que llama a un LLM de pago. El `saved: false` es la respuesta a la pregunta importante: el perfil NO quedó guardado hasta el `PUT` |
| `DELETE` | `/api/account` | `requireSession` | `{ ok: true }` + cookie con `Max-Age=0`. Audita la baja **antes** de borrar, y el `delete` se lleva las 7 tablas por cascada |
| `GET` | `/api/jobs?region=` | **`requireProfile`** | `{ region, jobs, total, _online, source, checkedAt }` |
| `GET` | `/api/job?q=` | **`requireProfile`** | `{ job, summary }`. `summary` **puede ser `null`** |
| `GET` | `/api/history?region=` | **`requireProfile`** | `{ region, jobs }`. Cada item con `active`/`firstSeen`/`lastSeen` y **sin `score`** |
| `POST` | `/api/refresh` | **`requireProfile`** | `{ ok: true, _online, at, total, source }`. Sin `force` sería un no-op |
| `GET` | `/api/cover-letter?region=&id=` | **`requireProfile`** | `{ lang, region, subject, body }` |
| `GET` | `/api/analytics` | **`requireProfile`** | Analítica de mercado. Sin parámetros y **sin `force`**, por costo |
| `POST` | `/api/linkedin-search` | `requireProfile` | Búsqueda LinkedIn real vía Apify. **Se factura**. Rate limit diario `apify_usage` + `APIFY_DAILY_LIMIT`. `buildProfileKeywords` generalizado (sin regex QA). |
| `GET` | `/api/directorio` | `requireProfile` | `{ region, keyword, terms, bolsas, consultoras }`. Cada entrada con `searchUrl` + `searchKind: 'sitio' | 'google' | 'ninguno'`. No scrapea: abre búsquedas prellenadas |
| `GET` | `/api/favorites` | `requireProfile` | `{ favorites }`, ofertas guardadas por el usuario autenticado |
| `POST` | `/api/favorites` | `requireProfile` | `{ ok: true, saved }`. Alterna guardar/quitar una oferta usando `{ key, job }` |

Cinco cosas de esa tabla que no se deducen leyendo los handlers:

- **`requireProfile` en los 6 endpoints de ofertas, no `requireSession`.** Sin perfil el
  matcher no tiene contra qué calcular y devolvería cero ofertas con un `200`, que es
  indistinguible de "no hay nada para tu perfil". Un `requireSession` ahí daría `403`
  solo cuando falta el CV, que no es el mismo problema.
- **`401` y `403` son distintos y no es un detalle.** `401` es "no sé quién sos" y
  manda al login; `403` es "sé quién sos pero te falta el CV" y manda al onboarding.
  Confundirlos mete al usuario en un bucle de login.
- **`DELETE /api/account` usa `requireSession`, NO `requireProfile`.** Es la única
  diferencia con los endpoints de ofertas y es deliberada: una cuenta a medio crear
  (correo y clave listos, CV nunca subido) tiene que poder borrarse igual. Por eso el
  aviso de la zona de peligro está también en la compuerta del alta, y no solo en el
  panel del CV.
- **`_online` lo manda el backend.** El frontend lo lee para elegir el rótulo de
  arriba, y devuelve el JSON crudo: si el endpoint no lo manda, un backend sano se
  anuncia como caído.
- **`?region=` con una región que no existe devuelve `200` con la región por
  defecto**, nunca `400`. Una región desconocida es lista vacía, no un error.

## Cómo está armado

```
api/                    funciones serverless (una por endpoint), Node ESM
  account.js            DELETE /api/account: audita y borra la cuenta entera
  lib/
    regions.js          la ÚNICA definición de regiones. Argentina.
    db.js               el único módulo que abre conexiones a Postgres
    auth.js             bcrypt, cookie firmada HMAC, las dos compuertas
    http.js             errores, JSON, cookies. CERO imports, a propósito
    profile.js          el perfil por usuario (el reemplazo del global)
    matcher.js          el cálculo del match y el rankeo
    analytics.js        la propuesta de interés
    coverLetter.js      carta de presentación y resumen de la empresa
    jobs.js             orquestador: caché + consulta + rankeo + historial
    jobSources.js       las 5 bolsas gratuitas
    history.js          historial en Postgres (el único escritor)
    portal.js           portal y link de origen de cada oferta
    searchTerms.js      los términos de búsqueda, derivados del perfil
    llm.js              el único módulo que habla con el LLM
    cvText.js           validación y extracción de texto del PDF/DOCX
    cvParseLimit.js     el límite de parseos del LLM (tabla `cv_parses`)
    rateLimit.js        el límite de intentos de login (tabla `login_attempts`)
    text.js             helpers puros de texto, compartidos por matcher y los otros
    directorio.js       catálogo de bolsas/consultoras + armado de URLs (paso 9)
frontend/src/           React 18 + Rspack/SWC
  components/
    DeleteAccountModal.jsx  la confirmación escrita del borrado
    BorrarCuentaZona.jsx    el aviso "borrar mi cuenta" (CV panel y compuerta)
    DirectorioPage.jsx      directorio de empleo: bolsas y consultoras de AR
    RegionTabs.jsx          pestañas: países + secciones (analisis, directorio)
migrations/             SQL versionado. Un archivo aplicado NO se edita nunca.
```

Cinco decisiones que no se deducen del código:

**El perfil es un parámetro, no un import.** El proyecto original tenía un `const
PROFILE` global con los datos de una sola persona y todo el mundo lo importaba. Acá
`computeMatch(job, profile)` y `rankByRegion(jobs, profile)` lo exigen como argumento:
sin default, a propósito. Por eso el mismo código rankea a un contador, una enfermera
o a un QA.

**En serverless no hay memoria entre invocaciones.** Dos requests del mismo usuario
pueden ir a dos instancias distintas. Por eso la caché de ofertas **no es una variable
de módulo** sino la fila más reciente de `searches` más las filas de `job_history`, y
el ranking se **recalcula al leer** (el perfil se edita, y un score guardado está
rancio). Lo mismo con los rate limits: son tablas, no contadores en memoria.

**Todo filtrado por `user_id`, siempre.** Es el error más probable al pasar de un
JSON global a SQL: un `WHERE` olvidado es una fuga de datos entre usuarios. El
`user_id` sale **siempre** del HMAC de la cookie, nunca del query string ni del body.

**Una migración aplicada es inmutable.** El runner registra el checksum de cada archivo
y **aborta** si uno ya aplicado cambió. Si el cambio de esquema es real, escribí un
archivo nuevo. Correr `npm run migrate` dos veces no hace nada y sale con código 0.

**`skills` es un array `[{ name, weight }]`, con el peso numérico, en los dos
lados.** El modo de falla es silencioso: si llega como mapa en vez de array, un
`.filter` no tira error, **devuelve lista vacía**, y el síntoma es "no me aparece
ninguna skill" sin un error en la consola.

## Los dos servicios que cuestan plata

No hay uno, hay **dos**, y cada uno tiene su propio límite en su propia tabla.

### El LLM (`POST /api/cv/parse`)

El único endpoint que llama a un LLM, y se paga por token con `LLM_API_KEY`.

- **Nunca lo llames en pruebas ni en CI contra el proveedor real.** Lo único que se
  puede ejercitar de verdad es un servidor OpenAI-compatible falso en `127.0.0.1`:
  `llm.js` arma la URL como `${LLM_BASE_URL}/chat/completions`, así que alcanza con
  levantar algo que responda un `chat.completion`.
- **`LLM_BASE_URL` se lee en cada llamada, no al importar el módulo.** Podés importar los
  handlers, poner `process.env.LLM_BASE_URL` y recién ahí llamar: el `fetch` va al proveedor
  que vos hayas puesto, no a `api.openai.com`. (Si el valor fuera una constante de módulo, un
  script de prueba que importara antes de setear la variable mandaría la petición al
  proveedor real y se pagaría de verdad.)
- El límite vive en la tabla `cv_parses`, con `CV_PARSE_LIMIT` (5 por hora). **Subirlo
  sube el costo por cuenta de forma lineal.**

### Apify (LinkedIn) — implementado, con costo

Cada búsqueda **ejecuta un actor y se factura**. El endpoint `/api/linkedin-search`
está implementado y protegido por un límite diario por usuario y un tope global.

- **Nunca lo invoques para "verificar que anda".** Los demás endpoints son gratis y
  verifican lo mismo.
- La clave es del **dueño de la app**, va en `APIFY_API_TOKEN` en el panel de Vercel.
  Nunca en el repo, nunca en el cliente.
- Cuando se implemente, tiene que venir con un CI que ** falle el job** si
  `APIFY_API_TOKEN` está definido en un pull request, más un `grep` del prefijo real
  de los tokens sobre los archivos versionados.

## Verificación

```bash
npm run check    # node --check sobre cada .js de api/, lib/ y scripts/
npm run lint     # ESLint + reglas de accesibilidad sobre el frontend
npm run build    # Rspack/SWC → frontend/dist, y valida los .jsx
npm test         # node:test; requiere Postgres con las migraciones aplicadas
curl -fsS localhost:3000/api/health
```

`npm run check` **no ejecuta código**: solo parsea, así que es seguro correrlo contra
archivos que leen variables de entorno. `npm run build` es obligatorio cuando tocaste
`frontend/src`, porque valida JSX y detecta imports rotos. La suite usa un Postgres de
prueba y nunca debe apuntar a datos de producción; las llamadas al LLM se dirigen a un
servidor falso local y las pruebas no invocan Apify.

Lo que se puede probar sin sesión es `/api/health`, `/api/register` y `/api/login`.
**Los 6 endpoints de ofertas piden cookie y perfil**: sin cookie dan `401`, y con
cookie pero sin CV dan `403`.

## Qué falta y por qué importa el orden

| | Qué falta | Por qué en ese orden |
|---|---|---|
| 1 | **CI con guard anti-cobro + secret scanning** | **HECHO (2026-10-08)** — `.github/workflows/ci.yml` con 3 capas anti-cobro Apify. |
| 2 | **Control de registro (SIGNUP_CODE) + tope global de gasto** | **HECHO (2026-10-08)** — `SIGNUP_CODE` opcional + `global_usage` table + limits. |
| 3 | **Tests automatizados + CI pipeline** | **EN PROGRESO** — tests con node:test, LLM falso, Postgres service. |
| 4 | **Deploy a Vercel** | `VERCEL_DEPLOY.md` escrito. Requiere CI verde y tope de gasto en proveedores. |
| 5 | **Aviso de privacidad + consentimiento (Ley 25.326)** | Requerido para CV → LLM (transferencia internacional de datos personales). |
| 6 | **Accesibilidad WCAG 2.2 AA** | Color-only (match verde/rojo), modales, status messages, tabs, lang en ofertas EN. |
| 7 | **Keywords bilingües (es/en) + sinónimos** | Mejora cobertura: hoy 0 ofertas para Enfermera porque bolsas son en inglés. |
| 8 | **Caché compartida de bolsas + límite a "Actualizar"** | Advisory lock para que 2 requests simultáneas no peguen 2× a las 5 bolsas. |
| 9 | **Favoritos (endpoint + frontend)** | Tabla `favorites` existe (migración 006), falta endpoint y botón UI. |
| 10 | **Limpieza MEMORIA.md (ADRs + "dónde quedamos" corto)** | 120 KB mezcla estado, decisiones, hallazgos, bitácora. Partir en docs/decisiones/. |

> **Nota**: el borrado de cuenta (`DELETE /api/account` con auditoría y cascada) se implementó fuera de esta secuencia. Los pasos 1 y 2 de esta lista son **nuevos** (octubre 2026) y eran prerrequisitos para abrir el registro público.

## Documentación para trabajar acá

| Archivo | Qué tiene |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | Cómo trabajar en el repo: comandos, arquitectura, trampas del esquema, convenciones. Leelo **antes** de tocar código. |
| [`MEMORIA.md`](./MEMORIA.md) | El contexto que no se deduce del código: el pedido original, decisiones con su porqué, hallazgos con `archivo:línea`, y las dudas abiertas. |
| [`VERCEL_DEPLOY.md`](./VERCEL_DEPLOY.md) | Guía paso a paso para desplegar en Vercel: base de datos, variables de entorno, migraciones, smoke test, costos. |

Los dos están en español y son densos a propósito: explican **por qué** cada cosa es
como es, no qué hace. Si cambiás algo, los dos se actualizan en el mismo commit.

---

Argentina · React 18 + Rspack/SWC · funciones serverless de Vercel · Postgres