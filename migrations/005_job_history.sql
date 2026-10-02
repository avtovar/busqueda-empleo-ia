-- ============================================================================
-- 005_job_history.sql — las ofertas que el usuario vio, deduplicadas por `key`.
--
-- Es la versión SQL de `data/history.json` del proyecto origen. La LÓGICA se
-- conserva tal cual (es buena y está testeada por el uso): lo único que cambia
-- es el backend de disco. Lo que se conserva de history.js:
--   · `keyOf(job)` calcula la clave: "título::empresa::<slug del id o del link>",
--     normalizada a minúsculas. El link va en la clave porque SIN él dos ofertas
--     distintas del mismo puesto en la misma empresa se pisaban entre sí y una
--     desaparecía del historial sin dejar rastro (el bug que está comentado en
--     history.js:99). Esa clave se calcula en el backend, no en SQL.
--   · la retención: 6 meses.
--   · una oferta puede caer en VARIAS regiones y las regiones se UNEN, nunca se
--     pisan (por eso `regions` es un array y no una columna de texto).
--
-- Y hay una diferencia GRANDISIMA que conviene que quede escrita: el origen se
-- serializaba TODO con un mutex en memoria (`withLock`, history.js:135) porque
-- dos búsquedas simultáneas(load→mutar→save del archivo entero) se pisaban.
-- En serverless ese mutex NO EXISTE: cada invocación es un proceso distinto y
-- dos requests corren en paralelo de verdad. El UNIQUE (user_id, key) de abajo
-- reemplaza al mutex: la deduplicación pasa a ser una restricción que la base
-- garantiza, y el "upsert" hace el trabajo de leer-modificar-escribir sin que
-- haya ventana entre las dos operaciones. O sea que el UNIQUE no es solo
-- integridad: es el reemplazo del lock que no se puede portar.
-- ============================================================================

create table if not exists job_history (
  id uuid primary key default gen_random_uuid(),

  -- ↑ Regla número uno del proyecto, sin excepciones: user_id NOT NULL, con
  --   índice por user_id (abajo) y CASCADE para que borrar la cuenta borre
  --   también el historial. Acá se corre el riesgo más fuerte de todo el
  --   esquema: el historial es el contenido que el usuario tiene más celoso
  --   por privacidad, y el error de olvidar el WHERE user_id acá devuelve
  --   ofertas de otra persona, no un número feo.
  user_id uuid not null references users (id) on delete cascade,

  -- ↑ La clave de deduplicación, calculada por el backend (keyOf del origen,
  --   portado tal cual). `text` y no una columna de URL porque la clave es un
  --   derivado de la oferta, no un dato de ella, y porque el origen normaliza
  --   a minúsculas con una regex que convierte todo lo que no sea [a-z0-9:] en
--   espacio. La longitud de una fila está acotada por el normalizador (trunca
--   el slug a 80 caracteres), así que no crece sin límite.
--   `key` es una palabra NO reservada de Postgres: no necesita comillas dobles
--   ni quoting, y `where key = $1` es SQL válido. Si algún día alguien lo
--   escribe entre comillas ("key"), la columna deja de existir y el error es
--   críptico.
  key text not null,

  -- ↑ La oferta completa, tal cual la devuelve la fuente, enrichida con portal
  --   y sourceUrl. jsonb y no json: es un objeto arbitrario cuyo schema cambia
  --   con cada bolsa de empleo nueva (Remotive, Arbeitnow, Himalayas, RemoteOK,
  --   Jobicy) y cambiar el schema no puede requerir una migración. jsonb parsea
  --   una sola vez al insertar y la consulta posterior es un volcado de bytes.
  --
  --   Por qué la oferta NO tiene columnas sueltas (title, company, score, url):
  --   porque la lista de campos la define cada fuente y cambia; una tabla con 15
  --   columnas de job sería 15 columnas que hay que migrar cada vez que Apify
  --   inventa un campo. Lo que sí se indexa o se busca va en columna propia
  --   (como `key`), no adentro del jsonb.
  job jsonb not null,

  -- ↑ Las regiones en las que apareció esta oferta, como array. NO es una
  --   columna `region` de texto: el origen tuvo ese bug (la segunda región
  --   pisaba a la primera y la oferta desaparecía de un historial, está
  --   comentado en history.js:120-123) y lo arregló guardando un array que se
  --   une. `getHistoryForRegion(region)` filtra por `region = any(regions)`.
  regions text[] not null default '{}',

  -- ↑ Primera vez que se vio. NO se toca nunca (salvo migración explícita de
  --   la clave vieja): es el "desde cuándo conozco esta oferta".
  first_seen timestamptz not null default now(),

  -- ↑ Última vez que se vio. En cada corrida que la vuelve a traer se actualiza
  --   con un upsert (ver el UNIQUE de abajo). Es lo que ordena la lista del
  --   historial y lo que define si la oferta sigue ACTIVA (ver el final).
  last_seen timestamptz not null default now(),

  -- ↑ Cuándo vence esta oferta de la retención de 6 meses.
  --
  --   Lo escribe el BACKEND y no un trigger ni un default, porque en el origen
  --   la ventana corre desde la fecha de PUBLICACIÓN de la oferta si la tiene
  --   (effectiveStart: publicationTime ?? firstSeen, history.js:54), y esa fecha
  --   vive adentro del jsonb de `job` (la usan job.date / job.postedAtTimestamp /
  --   job.postedAt, con tres formatos distintos según la bolsa). Si `expires_at` fuera NULL,
  --   la purga tiene que caer al branch de abajo, que es first_seen + 6 meses:
  --   más conservador (mantiene un poco más), nunca más agresivo.
  expires_at timestamptz
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- (Los dos son `create index` normal y NO concurrently, porque el runner mete
--  cada archivo en su propia transacción y CONCURRENTLY no puede ir dentro de
--  una. La explicación completa está en 001_users.sql. Ojo: esto va a doler
--  más que en los otros índices, porque `job_history` es la tabla que más crece
--  — es la única donde el CREATE INDEX de una migración futura podría tardar
--  segundos y bloquear escrituras. Ese es el día en el que hay que revisar el
--  runner, no hoy.)
--
-- 1) UNIQUE (user_id, key). Tres trabajos en un índice:
--    a) Es la deduplicación: dos ofertas con la misma clave son la misma oferta.
--       Dos usuarios distintos SÍ pueden tener la misma oferta (mismo puesto
--       publicado, que lo ven los dos), por eso el user_id va ADENTRO del
--       unique y no solamente con un índice normal.
--    b) Es el destino del upsert que reemplaza al mutex del origen:
--         insert into job_history (user_id, key, job, regions, last_seen, expires_at)
--         values (...)
--         on conflict (user_id, key) do update
--           set job = excluded.job, last_seen = now(), regions = ...
--       Es atómico: dos invocaciones serverless registrando la misma oferta al
--       mismo tiempo NO pueden pisarse, porque el segundo choca contra el
--       unique y resuelve por el DO UPDATE. Con el archivo JSON del origen
--       esto necesitaba el lock en memoria.
--    c) Es el acceso de "buscar esta oferta puntual" de /api/job y
--       /api/cover-letter por (user_id, key). Y como empieza por user_id, ya
--       cumple la regla de índice por usuario.
create unique index if not exists job_history_user_key_key on job_history (user_id, key);

-- 2) (user_id, last_seen desc): la lectura del historial, que es un filtro por
--    usuario + orden por "más recientes primero" + LIMIT. Al ser compuesto en el
--    mismo orden de la query, camina el índice y corta en el LIMIT, en vez de
--    traer todas las ofertas del usuario a memoria y ordenarlas.
--
--    OJO con la región: la query real filtra por `region = any(regions)`, y ese
--    predicado NO se puede indexar con este índice (regions es un array), así
--    que el planner camina las filas de este usuario en orden last_seen y
--    descarta las que no son de la región. Con la retención de 6 meses y el
--    orden por fecha, las más recientes son justamente las de la última
--    búsqueda, así que se resuelve rápido sin necesidad de un índice GIN extra.
create index if not exists job_history_user_last_seen_idx
  on job_history (user_id, last_seen desc);

-- ── LO QUE ESTÁ EN LA TABLA Y NO ES UNA COLUMNA ────────────────────────────
-- `active`. El origen lo derivaba comparando `lastSeen === history.lastRun`
-- (history.js:478), con un `lastRun` GLOBAL al que se leía entero cada vez.
-- En multiusuario eso no existe: no hay un "lastRun" único, hay uno por
-- usuario. Y guardar la última corrida del usuario... en dónde? No hay una
-- tabla de estado por usuario más allá de `profiles`, y meter un "última
-- búsqueda" en `profiles` sería mezclar semántica de perfil con semántica de
-- sesión de búsqueda.
--
-- La respuesta que se está proponiendo es NO GUARDAR la última corrida: se
-- deriva de `searches`. Una oferta está activa si
--     job_history.last_seen >= (select max(created_at) from searches where user_id = $1)
-- que es exactamente el `lastRun` del usuario, ya guardado y ya indexado, con
-- cero columnas de más. Y, si en algún momento molesta la subconsulta, el día
-- de las búsquedas se pasa como parámetro en la misma query.
--
-- La alternativa que NO se eligió es una columna `active boolean` que se
-- pone en true para las ofertas de la corrida y en false para las demás: obliga
-- a reescribir TODAS las filas del historial del usuario en cada búsqueda (con
-- 200 ofertas de LinkedIn por corrida, 200 updates) para volver a calcular algo
-- que ya está en la tabla de al lado. Vale la pena dejarlo anotado acá porque es
-- el tipo de detalle que un endpoint escrito de memoria resuelve con
-- `where active = true` y un campo que nunca se llena.
--
-- ── NO hay índice por expires_at ───────────────────────────────────────────
-- La purga es POR USUARIO (`where user_id = $1 and expires_at < now()`), y las
-- filas de un usuario están acotadas por la retención (semanas, no años), así
-- que la purga ya camina filas que están en caché. El índice extra se
-- mantendría en cada escritura para ahorrar unos microsegundos en un DELETE
-- que corre una vez por búsqueda. Si algún día la purga pasa a ser GLOBAL
-- (un cron que no es parte de este proyecto), ese sí es el momento de agregar
-- el índice por expires_at: ahí el recorrido sería seq scan de la tabla entera.
