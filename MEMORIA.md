# MEMORIA.md — Contexto de trabajo

Archivo de memoria del proyecto. **No es documentación general**: para cómo está armado el
proyecto está `AGENTS.md` (instrucciones para agentes), que es donde vive la **tabla de la
API** porque **`README.md` está orientado a quien llega de cero** (qué hace, cómo correrlo, la
tabla de la API y qué falta); acá queda lo que **no se deduce del código**: el pedido original,
el diagnóstico del código heredado con su evidencia, las decisiones que se tomaron y lo que
quedó abierto.

Última actualización real: **2026-10-08** (FASE 3 completada: favoritos, build con Rspack/SWC, typos corregidos). Las actualizaciones anteriores fueron el andamiaje, `regions.js`, el paso 4 de la base de datos completo, el paso 5 de auth, el paso 6 (perfil por usuario), el paso 7 (onboarding), la pantalla de acceso, directorio de Argentina, Apify/LinkedIn, borrado de cuenta, guía de despliegue Vercel.

---

## 0. DÓNDE QUEDAMOS — leé esto primero si volvés al proyecto

**Todas las fases del plan están HECHAS y VERIFICADAS.**

El traspaso quedó el **2026-10-08**, con `npm run check` (9 archivos) y `npm run build` (Rspack/SWC) en verde. Hay un **Postgres 16 corriendo en Docker** con las 13 migraciones aplicadas, usado solo para verificar: `docker stop pg-history-check` para bajarlo.

### La frase que resume dónde está el proyecto

**La app muestra ofertas reales de bolsas gratuitas, tiene un directorio de empleo de Argentina sin scraping, busca en LinkedIn real con Apify (con límite diario), el usuario puede borrar su cuenta y guardar favoritos, y el build usa Rspack/SWC para evitar bugs de esbuild.**

### Lo que falta, en orden

| Paso | Qué | Por qué es el siguiente |
|---|---|---|
| 1 | **CI/CD completo** | GitHub Actions con guard anti-cobro Apify, secret scanning, tests con node:test, lint, audit |
| 2 | **Deploy real a Vercel** | Requiere CI verde, tope de gasto en proveedores, `SESSION_SECRET` rotado |
| 3 | **Recuperar clave / verificar correo** | Requiere proveedor de mail (SendGrid, Resend, etc.) |
| 4 | **Seguimiento de postulaciones** | Tabla `favorites` existe, falta UI de estados (postulé/entrevista/oferta) + notas |
| 5 | **Alertas semanales por correo** | Depende de proveedor de mail + preferencias de usuario |
| 6 | **Exportar mis datos (portabilidad)** | Complemento natural del borrado, casi gratis (JSON del perfil) |

> **Nota**: El directorio de Argentina, Apify/LinkedIn, borrado de cuenta y favoritos **YA ESTÁN HECHOS**. Lo que queda es infraestructura (CI/CD, deploy, mail) y features de valor incremental.

### El único módulo del origen sin portar

**Ninguno.** `apifyLinkedin.js` se portó como `api/lib/apifyLinkedin.js` + `api/linkedin-search.js` + `api/lib/apifyLimit.js`.
Los que hay que dejar atrás: `consultoras.js`, `consultorasStore.js`, `curatedJobs.js`, `demoData.js` (ver §3.6).

**Ya portados**: `analytics.js`, `coverLetter.js` y `matcher.js` reescritos y parametrizados (paso 6); `cvProfile.js` **no se copió**, lo reemplaza `api/lib/profile.js`; en el paso 8 se portaron `jobSources.js`, `portal.js` y `history.js` a `api/lib/`, con `api/lib/jobs.js` como orquestador nuevo; en el paso 10 se portó `apifyLinkedin.js` como `api/lib/apifyLinkedin.js` + `api/linkedin-search.js` + `api/lib/apifyLimit.js`.

### Los dos avisos para cuando se retome

1. **El frontend NO se tocó en el paso 8**, y esa es la decisión que hace posible el paso: el contrato de los 6 endpoints es EXACTAMENTE el del origen (`region`, `jobs`, `total`, `_online`), así que el consumidor heredado sigue sirviendo sin una sola línea de cambio. `source` y `checkedAt` son lo único agregado, y son aditivos.
2. **El riesgo que tenía el paso 6 sigue RESUELTO y verificado**: el filtro de relevancia de `matcher.js` (`isQARelevant`) devolvía score 0 para toda oferta de un contador o una enfermera. Con datos reales, el mismo código rankea **118 ofertas para QA, 13 para Chef, 0 para Enfermera** (cifras previas al arreglo de Jobicy). La fórmula intacta y cómo se generaliza están en la skill `.opencode/skill/comparar-match/`.

> **Ojo con el nombre**: este archivo existe también en el origen (`F:\busqueda_trabajo`), pero **no se copió**: aquel era andamiaje de trabajo del proyecto anterior. Este es nuevo.

---

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