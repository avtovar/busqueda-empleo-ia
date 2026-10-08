-- ============================================================================
-- 013_global_usage.sql — contador global diario de uso (LLM + Apify + Signups).
--
-- PROTEGE EL BOLSILLO DEL DUEÑO DE LA APP: incluso si alguien crea miles de
-- cuentas falsas (registro abierto, sin verificación de correo), el tope global
-- evita que el gasto total se dispare. Es la capa final que funciona aunque
-- todos los demás límites fallen.
--
-- TRES CONTADORES EN UNA FILA POR DÍA (UTC):
--   cv_parses      — CVs parseados con LLM (cuesta tokens)
--   apify_searches — búsquedas de LinkedIn vía Apify (cuesta por ejecución)
--   signups        — registros de usuarios nuevos
--
-- EL LÍMITE EN SÍ NO ESTÁ ACÁ: son variables de entorno
--   GLOBAL_DAILY_CV_LIMIT, GLOBAL_DAILY_APIFY_LIMIT, GLOBAL_DAILY_SIGNUP_LIMIT
-- (ver .env.example). Que sea configuración y no una columna es lo correcto:
-- es una decisión del dueño de la app, cambiarlo = cambiar variable + redeploy.
--
-- La purga es oportunista (60 días) y se dispara desde recordGlobalUsage(),
-- que es el único escritor. No hay cron en Vercel.
-- ============================================================================

create table if not exists global_usage (
  -- El DÍA (no timestamp) al que pertenece este contador, en UTC.
  -- Lo calcula Postgres: (now() at time zone 'utc')::date
  day date not null primary key,

  -- Cuántos CVs se parsearon en toda la app este día. Empieza en 0.
  cv_parses integer not null default 0,

  -- Cuántas búsquedas de LinkedIn (Apify) se hicieron en toda la app este día.
  apify_searches integer not null default 0,

  -- Cuántos registros de usuarios nuevos hubo en toda la app este día.
  signups integer not null default 0,

  updated_at timestamptz not null default now()
);

-- Índice por day ya existe por ser PK, pero explícito para claridad:
create index if not exists global_usage_day_idx on global_usage (day);