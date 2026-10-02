-- ============================================================================
-- 004_searches.sql — historial de búsquedas del usuario.
--
-- Es el registro de "qué buscó este usuario, cuándo y con qué palabras". Sirve
-- para mostrar búsquedas recientes y para el cruce de keywords del analytics.
--
-- OJO con el nombre: esta tabla es el historial de TODAS las búsquedas, sin
-- distinguir fuente. El conteo de búsquedas de LinkedIn (la única que se
-- factura) NO va acá: está en apify_usage, porque necesita un contador por día y
-- no un historial por búsqueda. Meter las dos cosas en una tabla obligaría a un
-- índice parcial por origen y a mezclar "qué buscó" con "cuántas veces le dieron
-- a buscar".
-- ============================================================================

create table if not exists searches (
  id uuid primary key default gen_random_uuid(),

  -- ↑ user_id not null + foreign key + cascade: borrado en cascada y, sobre
  --   todo, filtro obligatorio en cada select. Un historial global con una
  --   columna user_id nullable es exactamente el filtro olvidado que termina
  --   mostrando las búsquedas de otro usuario.
  user_id uuid not null references users (id) on delete cascade,

  -- ▲ Región como texto con default 'argentina' y SIN check ni enum. La
  --   configuración de países vive en api/lib/regions.js (el punto 9 del plan),
  --   no en el esquema: un enum acá obligaría a un alter type ... add value
  --   —que en Postgres no se puede dejar dentro de la misma transacción que lo
  --   usa, justo la que envuelve el runner— más una migración de datos cada vez
  --   que se agrega un país. El proyecto va a agregar países, y esa es la razón.
  region text not null default 'argentina',

  -- ↑ Keywords de la búsqueda, YA NORMALIZADAS por la app.
  --
  --   text[] y no jsonb, a diferencia de profiles: acá la forma es una lista
  --   plana de strings que la aplicación escribe y el frontend solo lee. No hay
  --   un LLM que produzca claves heterogéneas ni un consumidor que espere
  --   estructura interna, así que no hay nada que justifique el jsonb. text[] es
  --   un tipo de primera clase de Postgres: se indexa con gin, se consulta con
  --   && (solapamiento), @> y unnest(). Con jsonb habría que serializar y
  --   deserializar para obtener lo mismo, y se perderían los operadores de array
  --   sin ganar nada a cambio.
  keywords text[] not null default '{}',

  -- ▲ Keywords extra de "ampliar búsqueda" (el botón que relajó los filtros).
  --   Columna aparte y no una bandera booleana: si todo se guardara en keywords,
  --   al reconstruir una búsqueda del historial no se sabría cuáles eran las que
  --   escribió el usuario y cuáles las que generó la ampliación, y el historial
  --   deja de poder reproducir la búsqueda que se hizo.
  extra_keywords text[] not null default '{}',

  created_at timestamptz not null default now()
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- (create index normal y no concurrently: el runner mete cada archivo en su
--  propia transacción. Explicación completa en 001_users.sql.)
--
-- searches_user_created_at_idx: (user_id, created_at desc), y no un índice
-- simple por user_id a propósito. El único acceso a esta tabla es "las últimas
-- búsquedas de ESTE usuario, más recientes primero" (limit 20), y ese orden
-- descendente solo se resuelve con los datos ordenados en el índice: con un
-- índice simple, Postgres filtraría por user_id y después ordenaría con un sort
-- de toda la historia del usuario. La columna izquierda sigue siendo user_id, así
-- que el filtro tampoco necesita tocar la tabla. Un índice por user_id aparte
-- sería redundante.
--
-- ▲ No hay índice gin sobre keywords: hoy nadie busca en el historial. Es el
--   índice a agregar el día que exista "buscar mis búsquedas anteriores por
--   'react'"; ponerlo antes sería escribir de más en cada búsqueda. Cuando se
--   agregue va solo sobre el array —
--     create index searches_keywords_gin on searches using gin (keywords)
--   — porque para pegarle el user_id al mismo índice haría falta btree_gin, que
--   es una extensión y este proyecto no instala ninguna. Un GIN global que
--   después filtre por user_id es peor que uno por usuario: el planner puede
--   usar el GIN para el texto y después descartar (o no) el resto de las filas.