# ADR 001: Arquitectura Serverless en Vercel

## Estado
Aceptada (2026-09-30)

## Contexto
El proyecto original (`busqueda-trabajo`) era un servidor Node.js monolítico (`server/index.js`) que servía tanto la API como los archivos estáticos del frontend. Para desplegar en Vercel, hay que migrar a funciones serverless.

## Decisión
- **Backend**: Funciones serverless en `/api` (Node ESM), una por endpoint o grupo de endpoints relacionados (catch-all).
- **Frontend**: Build estático con Vite → `frontend/dist`, servido como sitio estático.
- **Configuración**: `vercel.json` con `buildCommand: "npm run build"`, `outputDirectory: "frontend/dist"`, `maxDuration: 30` (60 para `/api/cv/parse` y `/api/linkedin-search`).
- **Routing**: Rewrites en `vercel.json` para mapear rutas limpias (`/api/jobs` → `/api/jobs/jobs`) y SPA fallback (`/((?!api/).*)` → `/index.html`).

## Consecuencias
- ✅ Escala a cero, sin servidores que mantener.
- ✅ Cold starts manejables (< 1s para funciones simples).
- ⚠️ No hay memoria entre invocaciones: toda caché y rate limit debe ir a Postgres.
- ⚠️ `maxDuration: 30` es justo para llamadas a LLM (25s) + Apify (hasta 20s).
- ⚠️ Pool de Postgres pequeño (`PG_POOL_MAX=2`) para no agotar conexiones del pooler.

## Alternativas consideradas
- **Next.js**: Rechazado por acoplamiento a Vercel y complejidad innecesaria (la app no usa SSR).
- **Express en servidor propio**: Rechazado por costo operativo y escalado manual.