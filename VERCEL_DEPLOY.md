# Guía de despliegue en Vercel — busqueda-empleo-ia

> **Objetivo**: desplegar la app en Vercel con Postgres (Neon o Supabase), sesiones seguras, y variables de entorno correctas. La guía asume que ya tenés el repo en GitHub.

---

## 1. Prepará la base de datos (Neon o Supabase)

### Neon (recomendado, gratis y rápido)
1. Entrá a [console.neon.tech](https://console.neon.tech) → **Create Project**.
2. Elegí región cercana (ej. `us-east-1` o `eu-central-1`).
3. En **Connection Details** > **Pooled connection** (puerto 5432, **NO** la directa):
   - La URL pooled termina en `-pooler` y usa `sslmode=require`.
   - **Copiá esa URL completa** → es tu `DATABASE_URL`.

> **Por qué pooled**: las funciones serverless abren/ cierran conexiones por invocación. La conexión directa agota el pool de Neon en segundos; la pooled no.

### Supabase (alternativa)
1. [supabase.com](https://supabase.com) → New Project.
2. Settings > Database > **Connection pooling** > **Transaction pooler** (puerto 6543).
3. Copiá la URI → `DATABASE_URL`.

---

## 2. Generá `SESSION_SECRET`

En tu terminal local:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copiá el string de 64 caracteres hex. **No lo compartas, no lo commitees.**

> Si alguna vez la rotás, **todas las sesiones abiertas se invalidan** (los usuarios vuelven a loguearse). Con usuarios reales, avisalo.

---

## 3. Variables de entorno en Vercel

En el dashboard de Vercel: **Settings > Environment Variables** > **Add New**.

### Obligatorias (la app no arranca sin ellas)

| Variable | Valor | Comentario |
|---|---|---|
| `DATABASE_URL` | La URL pooled de Neon/Supabase | **Con pooler**. En Neon: la que dice "Pooled connection". |
| `SESSION_SECRET` | El string de 64 chars que generaste arriba | Clave HMAC para firmar cookies. |

### Opcionales (la app funciona sin ellas, pero pierden features)

| Variable | Valor | Comentario |
|---|---|---|
| `LLM_API_KEY` | Tu clave del proveedor (OpenAI, Anthropic, etc.) | **Se paga por token**. Sin ella: registro/login funcionan, **subir CV NO**. |
| `LLM_MODEL` | Ej: `gpt-4o-mini` | Solo si tu proveedor tiene varios modelos. |
| `APIFY_API_TOKEN` | Token de tu cuenta Apify | **Se cobra por ejecución**. Sin él: `/api/linkedin-search` no existe / da 503. |
| `APIFY_MAX_RESULTS` | `200` (default) | Límite de ofertas por búsqueda. Subirlo cuesta plata. |
| `APIFY_DAILY_LIMIT` | `3` (default) | Búsquedas LinkedIn por usuario/día. Tabla `apify_usage` lo enforza. |
| `CV_PARSE_LIMIT` | `5` (default) | CVs por usuario/hora. Tabla `cv_parses` lo enforza. |
| `CV_PARSE_LIMIT_WINDOW_MINUTES` | `60` | Ventana del límite anterior. |
| `CV_PARSE_RETENTION_HOURS` | `24` | Purga de filas viejas. Debe ser > ventana. |
| `PG_POOL_MAX` | `2` (default) | Conexiones máximas por invocación. |
| `PG_POOL_IDLE_MS` | `10000` (default) | Tiempo de vida de cliente ocioso. |
| `MIGRATE_LOCK_TIMEOUT_MS` | `60000` (default) | Lock de migraciones concurrentes. |

> **Nombres exactos**: Vercel distingue mayúsculas. Usá los nombres de la tabla tal cual.

---

## 4. Importá el repo en Vercel

1. Vercel > **Add New... > Project** > Importá tu repo de GitHub.
2. **Framework Preset**: *Other* (no Vite, no Next.js — el build lo hace el `buildCommand`).
3. **Build Command**: `npm run build`
4. **Output Directory**: `frontend/dist`
5. **Install Command**: `npm install` (default, déjalo)
6. **Root Directory**: `.` (raíz del repo, **NO** `frontend/`)
7. **Environment Variables**: ya las agregaste en el paso 3.
8. **Deploy**.

> **Por qué Root = `.`**: el `package.json` de la raíz declara `"workspaces": ["frontend"]`. Vercel corre `npm install` en la raíz, que hoistea `vite` y todo al `node_modules` global. Si pusieras `frontend/`, `vite` no se instalaría y el build fallaría.

---

## 5. Corré las migraciones (UNA sola vez, desde tu máquina)

**NO** las pongas en el build de Vercel. Correlas local contra la base de producción:

```bash
# En tu máquina, con el .env local apuntando a la MISMA DATABASE_URL de Vercel
npm run migrate
```

Salida esperada:
```
1 aplicada(s), 11 ya estaba(n)    # o el número que corresponda
```

> Si ya corrieron (ej. en otro deploy), sale `0 aplicada(s), N ya estaba(n)` — es idempotente y sale con código 0.

---

## 6. Verificá el deploy

### Smoke test (gratis, no toca DB ni Apify)
```bash
curl -fsS https://TU-DOMINIO.vercel.app/api/health
# {"ok":true,"service":"busqueda-empleo-ia","time":"..."}
```

### Test con sesión (necesita cookie)
1. Abrí `https://TU-DOMINIO.vercel.app` en el navegador.
2. Registrate (correo + clave).
3. Subí un CV (PDF/DOCX) → se extrae con el LLM (si pusiste `LLM_API_KEY`).
4. Andá a la pestaña **Argentina** → deberían aparecer ofertas reales.
5. Probá **Directorio de empleo** (botón `🔗` abajo de las pestañas).
6. Probá **Propuesta de Interés** (botón `📊`).

---

## 7. Checklist post-deploy

- [ ] `GET /api/health` → 200 `{"ok":true}`
- [ ] Registro → 201 + cookie `HttpOnly; Secure; SameSite=Lax`
- [ ] Login → 200 + misma cookie
- [ ] Subir CV → 200 (si `LLM_API_KEY` está) / 403 `profileComplete: false` (si no)
- [ ] `/api/jobs?region=argentina` → 200 con ofertas + `_online: true`
- [ ] `/api/directorio` → 200 con catálogo + `searchKind` por entrada
- [ ] `/api/analytics` → 200 con propuesta de interés
- [ ] `/api/linkedin-search` → 503 si no hay `APIFY_API_TOKEN`, 200 si sí (y **te cobra**)
- [ ] Borrar cuenta → 200 + cookie `Max-Age=0` + fila en `account_deletions`

---

## 8. Variables que NO van en Vercel (solo local)

| Variable | Dónde |
|---|---|
| `.env` completo | Tu máquina local (copia de `.env.example`). **Nunca en Vercel.** |
| `LLM_BASE_URL` | Solo si usás un proveedor falso local para tests (`http://127.0.0.1:4000/v1`). En prod no hace falta. |

---

## 9. Troubleshooting rápido

| Síntoma | Causa probable | Solución |
|---|---|---|
| Build falla "vite not found" | Root Directory = `frontend/` | Cambiá a `.` (raíz del repo) |
| `/api/health` 500 | `DATABASE_URL` mal o sin pooler | Verificá que sea la URL **pooled** de Neon/Supabase |
| Login da 401 siempre | `SESSION_SECRET` distinto entre local y Vercel | Usá el **mismo** en los dos lados |
| Subir CV → 500 | `LLM_API_KEY` inválida o sin saldo | Verificá la clave en el proveedor; o dejala vacía y el CV no se parsea |
| `/api/linkedin-search` 503 | `APIFY_API_TOKEN` no seteada | Es normal si no querés pagar; el endpoint no existe sin token |
| "Modo demo" en la UI | Backend no responde o `_online: false` | Revisá logs de Vercel Functions; probá `/api/health` |
| Migraciones "ya aplicado pero contenido cambió" | Editaste un `.sql` ya corrido | **Nunca edites un `.sql` aplicado**. Escribí una migración nueva (`013_...sql`). |

---

## 10. Costos a tener en cuenta

| Servicio | Qué cobra | Dónde se limita |
|---|---|---|
| **Apify** | Por **ejecución** del actor LinkedIn | `APIFY_DAILY_LIMIT` (tabla `apify_usage`) |
| **LLM** | Por **token** (entrada + salida) | `CV_PARSE_LIMIT` (tabla `cv_parses`) |
| **Vercel** | Funciones serverless (incluye en plan gratis generoso) | — |
| **Neon/Supabase** | Postgres (plan gratis cubre desarrollo) | — |

**Regla de oro**: **Nunca** invoques `/api/linkedin-search` ni `/api/cv/parse` en tests, CI, ni para "verificar que anda". Usá `/api/health`, `/api/jobs`, `/api/directorio`, `/api/analytics` — son gratis.

---

## 11. Actualizar en el futuro

1. `git push` → Vercel detecta y redeployea solo.
2. Si agregaste migraciones: **corré `npm run migrate` local contra prod** antes del push (o justo después, antes de que alguien use la app).
3. Si cambiaste `SESSION_SECRET`: todos los usuarios se desloguean (esperado).

---

## Archivos clave del repo (para orientarte)

```
api/
  *.js                    # endpoints serverless (uno por archivo)
  lib/
    regions.js            # única config de regiones (Argentina)
    directorio.js         # catálogo de bolsas/consultoras (paso 9)
    db.js                 # único que abre conexiones a Postgres
    auth.js               # cookie firmada + dos compuertas (401/403)
    http.js               # errores/JSON/cookies (CERO imports)
    cvParseLimit.js       # rate limit del LLM (tabla cv_parses)
    jobSources.js         # 5 bolsas gratuitas (gratis)
frontend/
  src/
    App.jsx               # ruteo por compuertas + tabs + vistas
    components/
      DirectorioPage.jsx  # paso 9: catálogo con searchKind honesto
      RegionTabs.jsx      # países + secciones (analisis, directorio)
      AuthScreen.jsx      # login + registro en un componente
      CvOnboarding.jsx    # alta + editor de CV
    api.js                # fetch wrappers con FALLBACK
    utils.js              # helpers puros (linkedinSearchUrl, etc.)
migrations/
  *.sql                   # versiónados, idempotentes, NO se editan
.env.example              # plantilla de variables (13)
vercel.json               # routes + maxDuration: 30
```

---

**¿Dudas?** Revisá `AGENTS.md` (arquitectura, trampas, API) y `MEMORIA.md` (decisiones con `archivo:línea`, plan de 12 pasos).