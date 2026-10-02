-- ============================================================================
-- 006_favorites.sql — las ofertas que el usuario guardó.
--
-- Es a `job_history` lo que `/api/linkedin-search` es a `/api/jobs`: mismo
-- shape de oferta (jsonb), misma clave de deduplicación, mismo `user_id`, pero
-- con una diferencia de NATURALEZA que está en todas las decisiones de acá:
-- el historial es efímero (6 meses de retención, se purga solo), las
-- guardadas no. Un usuario puede guardar la oferta de un puesto que vio hace
-- ocho meses y tiene que seguir ahí cuando vuelva. Por eso esta tabla NO
-- tiene `expires_at` ni columnas de retención: acá no se purga nada nunca.
-- ============================================================================

create table if not exists favorites (
  id uuid primary key default gen_random_uuid(),

  -- ↑ Regla número uno: user_id NOT NULL + índice por user_id + CASCADE. En
  --   esta tabla el filtro por user_id es todavía más crítico, porque una fuga
  --   acá no devuelve ofertas al azar: devuelve las ofertas que UN USUARIO
  --   guardó, que es información de comportamiento, no de mercado.
  user_id uuid not null references users (id) on delete cascade,

  -- ↑ La MISMA clave que en job_history, y calculada con la MISMA función
  --   keyOf(). No una uuid propia de la oferta, y no un id de la fuente: la
  --   oferta viene de cinco bolsas distintas (más Apify) y cada una usa su
  --   propio id, que además cambia entre publicaciones de la misma oferta
  --   (por utm_source y compañía). La clave es lo único que sobrevive a que la
  --   misma oferta aparezca en dos bolsas distintas o dos veces en la misma.
  key text not null,

  -- ↑ La oferta guardada, completa y con portal ya resuelto (conPortal se
  --   aplica antes de guardar: si se guardara sin enrichir, la lista de
  --   guardadas sería la única de la app sin portal ni link de origen).
  job jsonb not null,

  created_at timestamptz not null default now()
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- (`create index` normal y no concurrently: el runner mete cada archivo en su
--  propia transacción. Explicación completa en 001_users.sql.)
--
-- UNIQUE (user_id, key) hace tres cosas:
--   1) el botón de "guardar" es idempotente con un simple upsert, así que
--      apretarlo dos veces no crea dos filas ni tira error por conflicto;
--   2) "ya la guardé?" es una lectura de primary key (y es la consulta más
--      caliente de la app: se hace por oferta para pintar el botón);
--   3) como empieza por user_id, cumple la regla de índice por usuario, y
--      `where user_id = $1` lista las guardadas del usuario.
create unique index if not exists favorites_user_key_key on favorites (user_id, key);

-- ▲ NO hay índice (user_id, created_at desc), al revés que en searches y
--   job_history. Es una asimetría DELIBERADA y no un olvido:
--   · el historial crece con cada búsqueda (cientos de filas por usuario, y
--     la consulta siempre viene con "las últimas N" → el índice compuesto
--     evita traerlas todas a memoria solo para ordenarlas);
--   · las guardadas son decenas por usuario, no cientos. Traerlas, ordenarlas
--     en memoria por fecha y cortar es un microsegundo, y el índice extra se
--     tendría que mantener en cada guardado.
--   Si algún día las guardadas pasan a tener paginación real, este es el
--   primer índice que se agrega, y es una línea.
