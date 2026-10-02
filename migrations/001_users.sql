-- ============================================================================
-- 001_users.sql — identidad y credenciales del usuario.
--
-- Es la primera de las siete tablas y el ancla de todas las FK: profiles,
-- skills, searches, job_history, favorites y apify_usage cuelgan de users(id).
-- Por eso el runner la aplica primero (orden ascendente de nombre) y no existe
-- ninguna referencia hacia atrás.
--
-- ALTA EN DOS ETAPAS: acá se registra correo + clave. El perfil derivado del CV
-- se escribe después, en profiles, que puede no existir. NINGUNA columna de esta
-- tabla depende de que haya CV: users tiene que poder existir solo, o el alta
-- se vuelve un deadlock lógico (no podés crear el usuario hasta tener el
-- perfil, ni el perfil hasta tener el usuario).
--
-- Handoff para el que escriba scripts/migrate.js: schema_migrations NO se crea
-- desde acá, a propósito. La crea el runner con create table if not exists,
-- antes de consultar qué archivos ya están aplicados; si la tabla viviera en una
-- migración, el runner tendría que existir antes de poder preguntar si esa
-- migración corrió.
-- ============================================================================

create table if not exists users (
  -- ↑ gen_random_uuid() es núcleo de Postgres 13+ (antes vivía en el módulo
  --   pgcrypto, que es una extensión). Se usa justamente para no depender de
  --   ninguna: el proyecto no instala nada y neon sirve 14/15/16, donde la
  --   función ya está en el core. UUID y no bigserial porque este id viaja en la
  --   cookie de sesión y no debe regalar cuántos usuarios hay en la plataforma.
  id uuid primary key default gen_random_uuid(),

  -- ↑ El correo es la identidad lógica y el único dato de acceso.
  --   Se guarda SIEMPRE en minúsculas, y bajar a minúsculas es responsabilidad
  --   de la aplicación (email.trim().toLowerCase() antes del INSERT), no de la
  --   base. Por eso acá NO hay un check (email = lower(email)): sería un candado
  --   en la puerta de una capa que no le corresponde, y convertiría un error de
  --   casing —que se produce en el borde, donde se puede ver y loguear— en un
  --   500 opaco en el alta. El índice único de abajo es la red, y no necesita
  --   la normalización para existir.
  email text not null,

  -- ↑ bcrypt o argon2. SOLO el hash: nunca la contraseña en claro, nunca un
  --   token, nunca el CV. No hay columna para el CV a propósito (AGENTS.md):
  --   Vercel es efímero, y lo que se persiste es el perfil derivado, en profiles.
  password_hash text not null,

  created_at timestamptz not null default now()
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- (create index normal y NO concurrently, por el motivo que está dos secciones
--  más abajo. Es el mismo motivo que citan 005, 006 y 007.)
--
-- 1) users_email_key: unicidad del correo. Y no es solo "que no haya dos
--    usuarios con el mismo mail": dos registros concurrentes del mismo correo
--    (doble clic, doble request, retry de red) tienen que chocar contra la
--    restricción y no contra una comparación hecha en JavaScript. Sin esto el
--    login queda con dos candidatos y bcrypt.test() resuelve uno al azar.
--
-- 2) La primary key (id) cubre el otro acceso de esta tabla, que es como se
--    resuelve la cookie de sesión. No hace falta un índice más: cualquier otro
--    acceso a datos de usuario se filtra por user_id, y cada tabla hija tiene el
--    suyo.
create unique index if not exists users_email_key on users (email);

-- ── POR QUÉ NINGÚN ÍNDICE ES `concurrently` ────────────────────────────────
-- El runner (scripts/migrate.js) manda el archivo ENTERO en un solo
-- client.query(sql) y lo envuelve en su propia transacción. Eso deja dos
-- prohibiciones que este esquema tiene que respetar, y por eso los archivos son
-- lo que son:
--
--   · CREATE INDEX CONCURRENTLY no puede ir dentro de un bloque de transacción
--     ("CREATE INDEX CONCURRENTLY cannot run inside a transaction block").
--     Como el runner no puede abrir una conexión suelta fuera de transacción
--     por cada índice, concurrently no es una opción: o se cambia el runner
--     (un query por índice, con su propio commit) o se usa create index normal.
--     Se eligió normal.
--   · NADA de begin/commit explícitos dentro de los archivos. El runner ya abre
--     y cierra la transacción; un begin interno rompe el commit final de pg y
--     deja el archivo aplicado A MEDIAS, con el registro en schema_migrations
--     sin escribir: el peor estado posible, porque el siguiente run vuelve a
--     aplicar el archivo y choca contra lo que ya quedó.
--
-- El costo de create index normal es un lock que bloquea escrituras en la tabla
-- mientras dura. Aplicado sobre una base vacía —que es el caso de hoy— dura
-- milisegundos y no hay a quién bloquear. El día que esto se aplique sobre
-- tablas con millones de filas y usuarios reales, la respuesta no es magia: es
-- una migración en dos pasos o un runner con un modo "sin transacción" para los
-- índices. Queda anotado acá para que nadie lo descubra en el incidente.

-- ── POR QUÉ `on delete cascade` (revierte una regla de AGENTS.md) ─────────
-- AGENTS.md dice: "Borrar cuenta = borrar el usuario y todo lo suyo (profiles,
-- skills, searches, job_history, favorites). Sin cascada en la DB, son N DELETE
-- explícitos". Este esquema hace lo CONTRARIO y es una decisión deliberada, no
-- un descuido:
--
--  1. Una cascada no se puede dejar a medias; los N DELETE sí. Son N sentencias:
--     si la tercera falla (se corta la función en Vercel, Neon cierra una
--     conexión, aparece una constraint que nadie conocía), las dos primeras ya
--     quedaron escritas. El usuario desaparece de users y sus skills,
--     búsquedas y guardadas quedan huérfanas: filas con un user_id que ya no
--     apunta a nadie, que ninguna consulta va a volver a leer y que nadie va a
--     limpiar nunca. O sea, el peor resultado posible para alguien que pidió
--     ser borrado: los datos personales quedan, la cuenta no. Con la cascada,
--     el borrado es UNA sentencia, y una sentencia es todo o nada.
--  2. El sitio del error cambia de lugar. Los N DELETE explícitos son código de
--     aplicación: se escriben, se prueban a medias, se mergean, y el olvido no
--     avisa — el endpoint devuelve 200 igual. La cascada está declarada en la
--     misma línea que la tabla, junto a las columnas, donde no se puede agregar
--     una tabla nueva y olvidarse de ella sin que el esquema lo diga.
--  3. Es reversible si algún día hace falta. Cambiar a on delete restrict o
--     set null es un ALTER TABLE en una migración. Borrar código de aplicación
--     que ya está en producción es más difícil que al revés.
--
-- Y lo que la cascada NO resuelve, porque si no queda escrito parece que sí:
--  · No protege de borrar mal UNA cuenta. Un delete from users where id = $1 con
--    el id equivocado borra todo igual, y de una sola vez. Contra eso hace falta
--    otra cosa (soft delete o una tabla de bajas pendientes), y no es este
--    archivo.
--  · No deja rastro. La fila de users desaparece y no queda registro de que
--    existió ni de cuándo se pidió la baja. Si hay que responder "este usuario
--    pidió ser borrado el día X", ese evento hay que loguearlo en el endpoint
--    ANTES del delete; la base no lo va a guardar.