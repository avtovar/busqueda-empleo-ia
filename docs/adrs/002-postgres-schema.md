# ADR 002: Esquema Postgres con Migraciones Inmutables

## Estado
Aceptada (2026-09-30)

## Contexto
El proyecto original usaba archivos JSON en disco (`data/history.json`, `data/consultoras-status.json`). En Vercel no hay disco persistente entre invocaciones.

## Decisión
- **Base de datos**: Postgres (Neon o Supabase) con pooler (puerto 5432 en Neon, 6543 en Supabase).
- **Migraciones**: Archivos SQL versionados en `migrations/` con prefijo numérico (`001_users.sql`, `002_profiles.sql`, etc.).
- **Runner**: `scripts/migrate.js` — cada archivo en su propia transacción + registro en tabla `schema_migrations` (`filename`, `checksum_sha256`, `applied_at`).
- **Inmutabilidad**: Un archivo ya aplicado **nunca se edita**. Si el checksum cambia, el runner aborta. Para cambios reales, se crea un archivo nuevo (`009_...sql`).
- **Idempotencia**: `npm run migrate` sobre base ya migrada → `0 aplicada(s), N ya estaba(n)` y exit code 0.

## Esquema (13 migraciones, 7 tablas)

| Tabla | Propósito | Claves |
|---|---|---|
| `users` | Usuarios (email, password_hash) | PK `id` (uuid) |
| `profiles` | Perfil profesional (FK `user_id` = PK) | PK `user_id`, `fullName`, `title`, `yearsExperience`, `summary`, `photo`, `location`, `keywords[]`, `marketSkills[]`, `projects[]`, `links{}` |
| `skills` | Skills con peso (0-1) | PK compuesta (`user_id`, `name`), `weight` numeric(4,3) |
| `searches` | Registro de cada corrida de búsqueda | PK `id`, `user_id`, `region`, `keywords[]`, `online`, `created_at` |
| `job_history` | Ofertas vistas (dedup + retención 6 meses) | PK compuesta (`user_id`, `key`), `job` (jsonb), `regions[]`, `first_seen`, `last_seen`, `expires_at`, `active` |
| `favorites` | Ofertas guardadas por usuario | PK compuesta (`user_id`, `key`), `job` (jsonb), `created_at` |
| `apify_usage` | Rate limit diario Apify | PK compuesta (`user_id`, `day`), `count`, `updated_at` |
| `cv_parses` | Rate limit parsing CV (LLM) | PK compuesta (`user_id`, `parsed_at`), `user_id`, `parsed_at` |
| `login_attempts` | Rate limit login | PK compuesta (`email`, `ip`, `attempted_at`) |
| `global_usage` | Tope global diario (LLM + Apify + signups) | PK `day`, `cv_parses`, `apify_searches`, `signups` |
| `account_deletions` | Auditoría de baja (sin FK a users) | PK `id`, `user_id`, `email`, `ip`, `user_agent`, `deleted_at` |

## Consecuencias
- ✅ Datos persisten entre invocaciones serverless.
- ✅ Migraciones idempotentes y auditables (checksum SHA256 de bytes crudos).
- ✅ Advisory locks en migraciones para evitar carreras.
- ⚠️ Pool pequeño (`PG_POOL_MAX=2`) para no saturar pooler de Neon.
- ⚠️ `NUMERIC` viene como string de `pg` → type parser global en `db.js` (`types.setTypeParser(types.builtins.NUMERIC, Number)`).

## Alternativas consideradas
- **JSON en Vercel Blob**: Rechazado por consultas complejas (rate limits, historial, favoritos).
- **SQLite en disco**: Rechazado (no hay disco persistente en Vercel).
- **Prisma/ORM**: Rechazado por overhead y control de migraciones.