# MEMORIA.md — Contexto de trabajo

Archivo de memoria del proyecto. **No es documentación general**: para cómo está armado el
proyecto está `AGENTS.md` (instrucciones para agentes), que es donde vive la **tabla de la
API** porque **`README.md` está orientado a quien llega de cero** (qué hace, cómo correrlo, la
tabla de la API y qué falta); acá queda lo que **no se deduce del código**: el pedido original,
el diagnóstico del código heredado con su evidencia, las decisiones que se tomaron y lo que
quedó abierto.

Última actualización real: **2026-10-09** (revisión de CI/tests y atomicidad del rate limit de login).
Las actualizaciones anteriores fueron el andamiaje, `regions.js`, el paso 4 de la base de datos
completo, el paso 5 de auth, el paso 6 (perfil por usuario), el paso 7 (onboarding), la pantalla
de acceso, directorio de Argentina, Apify/LinkedIn, borrado de cuenta, guía de despliegue Vercel,
favoritos y build con Rspack/SWC.

---

## 0. DÓNDE QUEDAMOS — leé esto primero si volvés al proyecto

**Todas las fases del plan están HECHAS y VERIFICADAS.**

El traspaso quedó el **2026-10-08**, con `npm run check` (9 archivos) y `npm run build` (Rspack/SWC) en verde. Hay un **Postgres 16 corriendo en Docker** con las 13 migraciones aplicadas, usado solo para verificar: `docker stop pg-history-check` para bajarlo.

### La frase que resume dónde está el proyecto

**La app muestra ofertas reales de bolsas gratuitas, tiene un directorio de empleo de Argentina sin scraping, busca en LinkedIn real con Apify (con límite diario), el usuario puede borrar su cuenta y guardar favoritos, y el build usa Rspack/SWC para evitar bugs de esbuild.**

### Lo que falta, en orden

| Paso | Qué | Por qué es el siguiente |
|---|---|---|
| 1 | **Deploy real a Vercel** | Requiere CI verde, tope de gasto en proveedores y `SESSION_SECRET` configurado |
| 2 | **Recuperar clave / verificar correo** | Requiere proveedor de mail (SendGrid, Resend, etc.) |
| 3 | **Seguimiento de postulaciones** | Tabla `favorites` existe, falta UI de estados (postulé/entrevista/oferta) + notas |
| 4 | **Alertas semanales por correo** | Depende de proveedor de mail + preferencias de usuario |
| 5 | **Exportar mis datos (portabilidad)** | Complemento natural del borrado, casi gratis (JSON del perfil) |

> **Nota**: CI con guard anti-cobro, lint, check, build, tests bloqueantes y audit informativo ya está configurado. El directorio de Argentina, Apify/LinkedIn, borrado de cuenta y favoritos **YA ESTÁN HECHOS**. Lo que queda es deploy real, mail y features de valor incremental.

### El único módulo del origen sin portar

**Ninguno.** `apifyLinkedin.js` se portó como `lib/apifyLinkedin.js` + `api/search/[...slug].js` + `lib/apifyLimit.js`; `/api/linkedin-search` es una ruta pública de Vercel rewrite.
Los que hay que dejar atrás: `consultoras.js`, `consultorasStore.js`, `curatedJobs.js`, `demoData.js` (ver §3.6).

**Ya portados**: `analytics.js`, `coverLetter.js` y `matcher.js` reescritos y parametrizados (paso 6); `cvProfile.js` **no se copió**, lo reemplaza `lib/profile.js`; en el paso 8 se portaron `jobSources.js`, `portal.js` y `history.js` a `lib/`, con `lib/jobs.js` como orquestador nuevo; en el paso 10 se portó `apifyLinkedin.js` como `lib/apifyLinkedin.js` + `api/search/[...slug].js` + `lib/apifyLimit.js`.

### Los dos avisos para cuando se retome

1. **El frontend NO se tocó en el paso 8**, y esa es la decisión que hace posible el paso: el contrato de los 6 endpoints es EXACTAMENTE el del origen (`region`, `jobs`, `total`, `_online`), así que el consumidor heredado sigue sirviendo sin una sola línea de cambio. `source` y `checkedAt` son lo único agregado, y son aditivos.
2. **El riesgo que tenía el paso 6 sigue RESUELTO y verificado**: el filtro de relevancia de `matcher.js` (`isQARelevant`) devolvía score 0 para toda oferta de un contador o una enfermera. Con datos reales, el mismo código rankea **118 ofertas para QA, 13 para Chef, 0 para Enfermera** (cifras previas al arreglo de Jobicy). La fórmula intacta y cómo se generaliza están en la skill `.opencode/skill/comparar-match/`.

> **Ojo con el nombre**: este archivo existe también en el origen (`F:\busqueda_trabajo`), pero **no se copió**: aquel era andamiaje de trabajo del proyecto anterior. Este es nuevo.

---

## Revisión de rate limit, tests y CI (2026-10-09)

- El login antes separaba la lectura del contador y la escritura del intento: requests
  concurrentes podían superar el límite. `withLoginAttempt()` toma un advisory lock por IP y
  mantiene en una transacción la comprobación, el resultado de bcrypt y el registro/limpieza.
  Esa serialización por IP es deliberada; no se deja un contador en memoria porque Vercel es
  serverless.
- El timestamp del rate limit usa `clock_timestamp()` en vez de `now()`: la transacción puede
  esperar el lock, y `now()` representaría el inicio anterior a la espera. La ventana debe
  medirse al momento de ejecutar la consulta/escritura.
- Los tests de sesión deben firmar con HMAC-SHA256 igual que producción; un SHA-256 de
  `payload + secret` producía cookies inválidas y hacía que las pruebas parecieran ejercitar
  compuertas aunque todas se rechazaban antes. `tests/test-utils.js` centraliza esa firma.
- Los handlers consolidados se prueban con las rutas concretas de su catch-all. Las rutas
  cortas de compatibilidad (`/api/login`, `/api/jobs`, etc.) las agrega `vercel.json`; una
  llamada directa a un handler no pasa por esos rewrites.
- La prueba de aislamiento siembra dos usuarios, sus perfiles y una oferta solo para el
  primero; el dueño obtiene 200 y el otro 404 incluso si intenta forzar `user_id` en la URL.
  Así no depende de proveedores de ofertas ni pasa solo porque una cookie apunta a un usuario
  inexistente.
- Las migraciones fallidas retornan código `1` desde `main()` y no lanzan la excepción al
  llamador; la prueba de checksum cambiado verifica ese contrato y captura el mensaje.
- El job de tests de CI es bloqueante. El audit npm es informativo por ahora: reporta
  vulnerabilidades high/critical sin bloquear el build.

Verificación de esta revisión: los **63 tests pasan** usando la base local aislada indicada
por el entorno de test y con las migraciones aplicadas; nunca usar una base productiva. También
pasaron `npm run check` (32 archivos), ESLint con `--max-warnings=0` y `npm run build`. Los
tests no llaman Apify ni un LLM real; el test de CV usa un proveedor falso local.

## Error de registro en producción (2026-10-09)

- La consola mostraba 401 en `/api/auth/me`, `/api/favorites` y `/api/jobs/jobs` antes de iniciar
  sesión: son respuestas normales de las compuertas de auth, no errores del registro.
- El 400 al crear cuenta sí era un bug: `AuthScreen` guardaba la clave en `clave`, pero invocaba
  `register()`/`login()` con `{ email, clave }`; esos helpers aceptan `{ email, password }`. Al
  serializar JSON, `password` quedaba ausente y `readCredentials()` devolvía "Necesitás el correo
  y la clave." Corregido mapeando `password: clave` en ambas llamadas.
- `AuthScreen.jsx` toca el contrato con `frontend/src/api.js`; no renombrar el estado de UI sin
  actualizar ese mapeo. Falta desplegar el cambio antes de que afecte al dominio de Vercel.

## PDF bloqueado en el alta (2026-10-09)

- El usuario podía seleccionar el PDF, pero el botón de analizar no se habilitaba: `elegirArchivo()`
  descarta la selección mientras `mostrarPrivacidad` sea `true`.
- La compuerta nueva (`!esEditor`) inicializa ese estado en `true`, pero `PrivacyNotice` estaba
  renderizado únicamente dentro del retorno del editor (`esEditor`). La persona nueva no veía el
  consentimiento y no podía habilitar la carga.
- Corregido moviendo la instancia condicional del aviso al contenido compartido de
  `CvOnboarding`, que renderizan tanto la compuerta como el editor. No se agregó OCR: los PDF
  escaneados sin texto seleccionable continúan rechazándose con un mensaje explícito.

## Decisiones de arquitectura (ADRs)

Las decisiones de arquitectura importantes están documentadas en `docs/adrs/` como registros individuales:

| ADR | Título | Estado |
|---|---|---|
| [001](./docs/adrs/001-serverless-architecture.md) | Arquitectura serverless en Vercel | Aceptada |
| [002](./docs/adrs/002-postgres-schema.md) | Esquema Postgres con migraciones inmutables | Aceptada |
| [003](./docs/adrs/003-auth-cookies.md) | Auth con cookie HMAC + dos compuertas (401/403) | Aceptada |
| [004](./docs/adrs/004-profile-per-user.md) | Perfil por usuario (no global) | Aceptada |
| [005](./docs/adrs/005-sql-cache.md) | Caché de ofertas en SQL (no memoria) | Aceptada |
| [006](./docs/adrs/006-rate-limits.md) | Rate limits en BD (login, CV, Apify, global) | Aceptada |
| [007](./docs/adrs/007-cascade-delete.md) | Borrado en cascada + auditoría sin FK | Aceptada |
| [008](./docs/adrs/008-rspack-swc.md) | Build con Rspack/SWC (no esbuild) | Aceptada |
| [009](./docs/adrs/009-bilingual-keywords.md) | Keywords bilingües + sinónimos ES/EN | Aceptada |
| [010](./docs/adrs/010-accessibility.md) | Accesibilidad WCAG 2.2 AA | Aceptada |

Ver `docs/adrs/` para el detalle de cada decisión.

---

## Typos y correcciones pendientes

- [ ] Revisar typos en `MEMORIA.md` y `README.md` (ej: "prerrequisario", "convienestudiar", "Las app de cada bolsa")
- [ ] Reemplazar referencias `archivo:línea` por referencias a funciones/decisiones (las líneas cambian)
- [ ] Mover rutas absolutas `F:\busqueda_trabajo\` a referencias relativas o eliminar
- [ ] Unificar terminología: "propuesta de interés" vs "analítica de mercado" vs "analítica"

---

## Referencias rápidas

- **AGENTS.md** — Instrucciones para agentes (comandos, arquitectura, trampas, tabla API)
- **README.md** — Documentación para humanos (qué hace, cómo correr, variables, estado)
- **VERCEL_DEPLOY.md** — Guía paso a paso de despliegue en Vercel
- **docs/adrs/** — Decisiones de arquitectura (ADRs)
- **SKILLS.md** — Skills disponibles en `.opencode/skill/`