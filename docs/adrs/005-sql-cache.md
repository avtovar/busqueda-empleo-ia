# ADR 005: Caché de Ofertas en SQL (No Memoria)

## Estado
Aceptada (2026-10-02)

## Contexto
El origen usaba tres variables de módulo en `server/index.js`: `cache` (regions + at), `refreshing` (promesa compartida), `lastApifyJobs` (array). En Vercel cada invocación es un proceso distinto → variables de módulo no sirven.

## Decisión
- **Caché = tabla `searches` + tabla `job_history`**:
  - `searches`: una fila por corrida (`user_id`, `region`, `keywords[]`, `online`, `created_at`).
  - `job_history`: ofertas de esa corrida (`last_seen >= searches.created_at`).
  - `searches.online` (columna, migración 011) = `_online` de la corrida.
- **TTL**: 30 min (`CACHE_TTL_MS`), comparado contra `searches.created_at` (reloj de Postgres, no `Date.now()`).
- **Orden**: Caché primero (2 queries ms), bolsas después (5 requests, hasta 20s).
- **`POST /api/refresh`**: Fuerza `force=true` → salta TTL, escribe nueva corrida, `source: 'live'`. Sin `force` sería no-op.
- **Concurrencia**: Advisory lock `pg_advisory_xact_lock(hashtextextended(user_id, 0))` en `getRanked()` serializa el camino "live" por usuario. Si dos requests llegan con `force` o caché vencida, el segundo espera y lee la caché recién escrita.

## Consecuencias
- ✅ Caché persiste entre invocaciones y usuarios concurrentes.
- ✅ Reloj único (Postgres) evita discrepancias entre instancias.
- ✅ `_online` cacheado por corrida (no "hubo ofertas").
- ✅ `source: 'cache' | 'live'` para verificar que funciona (48× speedup medido).
- ✅ Advisory lock evita trabajo duplicado en refresh concurrente.
- ⚠️ `refreshing` del origen no se porta (no portable a serverless).
- ⚠️ `lastApifyJobs` no se porta: `/api/job` busca en `job_history` por `user_id + key`.

## Alternativas consideradas
- **Redis/Upstash**: Rechazado (costo + dependencia externa, BD ya existe).
- **Memoria con sticky sessions**: Rechazado (no existe en Vercel).
- **TTL en `searches` sin `job_history`**: Rechazado (necesitamos ofertas para re-rankear contra perfil actual).