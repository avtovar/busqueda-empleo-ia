-- ============================================================================
-- 007_apify_usage.sql — el contador de búsquedas de LinkedIn por usuario por día.
--
-- ESTA TABLA NO ESTABA EN EL PLAN ORIGINAL Y HACE FALTA. El punto 12 del pedido
-- pide "límite diario de búsquedas de LinkedIn por usuario (configurable)", y la
-- lista de tablas del punto 2 no incluía ninguna para contarlo. Sin esta tabla
-- no hay forma de hacerlo: en Vercel cada invocación es un proceso distinto, no
-- hay memoria entre requests ni archivo que sobreviva, así que cualquier
-- contador en memoria contaría cero y el límite no existiría.
--
-- Y NO es una tabla "de stats": es la que evita que la app pague plata sola.
-- Cada llamada a /api/linkedin-search EJECUTA un actor de Apify y SE COBRA
-- (AGENTS.md tiene una sección entera sobre esto). Un límite que no se puede
-- contar no es un límite.
--
-- EL LÍMITE EN SÍ NO ESTÁ ACÁ: es `APIFY_DAILY_LIMIT`, una variable de entorno
-- (ver .env.example). Que sea configuración y no una columna es lo correcto: es
-- una decisión del dueño de la app y no del usuario, así que cambiar el límite
-- tiene que ser cambiar una variable y redeployar, no una migración sobre datos.
--
-- `count` es el CONTADOR, no el límite. Guardar el límite en una columna haría
-- que bajarlo dejara a los usuarios trabados con la cuenta a medio consumir, y
-- que subirlo requiriera reescribir una fila por usuario por día.
-- ============================================================================

create table if not exists apify_usage (
  -- ↑ No hay columna `id`. La clave natural de esta fila ES (usuario, día), y va
  --   como primary key compuesta más abajo. Un uuid suelto sería una columna y
  --   un índice más para no decir nada.
  user_id uuid not null references users (id) on delete cascade,

  -- ↑ El DÍA (no la fecha con hora) al que pertenece este contador, en UTC.
  --
  --   El día lo tiene que calcular Postgres, no el código:
  --     where user_id = $1 and day = (now() at time zone 'utc')::date
  --   Si lo arma la app (new Date().toISOString().slice(0, 10)), el bucket del
  --   día depende del reloj y del timezone del runtime de Vercel, y un error de
  --   una hora crea dos filas para el mismo día o ninguna. Acá el cálculo es
  --   una expresión de Postgres: determinista y en el mismo lugar para todos.
  --
  --   UTC y no hora Argentina: `now()` ya está en UTC y es lo menos sorprendente.
  --   Si algún día se quiere el día de Argentina (que va 3 horas atrás), es
  --   cambiar el `at time zone` de la expresión de arriba en el endpoint, no
  --   migrar esta tabla.
  day date not null,

  -- ↑ Cuántas búsquedas de LinkedIn hizo este usuario HOY. Empieza en 0 y se
  --   sube con un upsert en cada ejecución. Cuando se pasa el límite, el
  --   endpoint responde 429 ANTES de llamar a Apify: si cuenta después, la
  --   ejecución ya está pagada y el límite llega tarde.
  --
  --   `count` es un nombre de columna perfectamente legal: COUNT es palabra NO
  --   reservada en Postgres (solo no puede usarse como nombre de función), así
  --   que `select count from apify_usage where user_id = $1` y `count(*)`
  --   conviven sin conflicto. Igual que `key` en las otras tablas, no lleva
  --   comillas: entrecomillarla hace que la columna deje de existir, y el error
  --   que sale no dice nada de eso.
  count integer not null default 0,

  updated_at timestamptz not null default now(),

  -- ▲ PRIMARY KEY COMPUESTA (user_id, day) y no un id uuid suelto. La clave
  --   natural ES (usuario, día): es lo que hace única a la fila, y ponerla como
  --   PK garantiza que no existan dos filas del mismo usuario para el mismo
  --   día, que es la forma exacta de decir "el contador no se duplica". Además
  --   el índice de la PK ES el índice por user_id que pide la regla del
  --   proyecto: "cuántas búsquedas hice hoy" y "cuántas hice esta semana" son
  --   ambas cosas que son prefijos de este índice, así que no hace falta otro.
  --
  --   Este es el otro UNIQUE del esquema que hace de objetivo de upsert:
  --     insert into apify_usage (user_id, day, count) values ($1, ..., 1)
  --     on conflict (user_id, day) do update set count = apify_usage.count + 1
  --   El `count = apify_usage.count + 1` lee la fila YA bloqueada por el
  --   conflicto, así que dos requests simultáneos del mismo usuario no pueden
  --   perder un incremento. Con "leer, sumar en JavaScript, escribir", en
  --   cambio, sí: dos invocaciones leen 2 y las dos escriben 3. Que la suma esté
  --   DENTRO del upsert y no afuera es el motivo por el que un contador de
  --   búsquedas de Apify nunca pierde ejecuciones.
  primary key (user_id, day)
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- (`create index` normal y no concurrently: el runner mete cada archivo en su
--  propia transacción. La explicación completa está en 001_users.sql.)
--
-- Índice por `day` (no por user_id: ese ya lo da la primary key de arriba).
--
-- Por qué hace falta: esta es la ÚNICA tabla del esquema que CRECE SOLA. Cada
-- usuario que use la búsqueda de LinkedIn agrega una fila por día, para
-- siempre, y no hay ninguna pantalla donde se vea ni forma de borrarla desde la
-- UI. Sin un `delete ... where day < current_date - 60` la tabla se infla de
-- forma invisible: no rompe nada, solo se paga el almacenamiento de más y la
-- tabla se pone más lenta de leer.
--
-- Esa purga es GLOBAL (por día, no por usuario), así que necesita su propio
-- índice: sin él es un seq scan de toda la tabla. Con este índice es un range
-- scan que además puede correr sin bloquear a los usuarios que están contando.
--
-- ▲ ¿Un trigger que purgue solo? NO, y a propósito: en esta app no hay cron
--   (las Vercel Functions no corren por sí solas, y traer un cron suma
--   configuración y una factura). La purga se dispara desde el propio endpoint
--   que cuenta, que es el único que visita esta tabla: cuando el primer insert
--   del día de un usuario encuentra filas viejas, las borra. Es una purga
--   oportunista —con dos o tres visitas al día alcanza y sobra para 60 días de
--   retención— y no necesita que nadie se acuerde de correrla.
--
-- ▲ ¿Y el rate limit del LOGIN, que también pide AGENTS.md? Le pasa lo mismo
--   (serverless sin memoria entre requests) y le falta su tabla. No se agregó
--   acá porque no estaba en el spec y es una decisión de otro paso: si se
--   agrega, NO es esta tabla (esta cuenta APIs que cuestan plata), es algo tipo
--   `login_attempts (email, ip, attempted_at)` con un índice por `ip` y otro
--   por `email`.
create index if not exists apify_usage_day_idx on apify_usage (day);
