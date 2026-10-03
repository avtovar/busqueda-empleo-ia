-- ============================================================================
-- 012_account_deletions.sql — el rastro de las bajas, que la cascada se come.
--
-- `DELETE FROM users` es UNA sola sentencia y borra todo lo que el usuario tenía
-- (decisión 9, `001_users.sql:89-121`): perfil, skills, búsquedas, historial,
-- guardadas, uso de Apify y parseos de CV. Es la decisión correcta, y por eso
-- mismo NO deja rastro: después del `DELETE` no queda ni una fila de la que
-- decir "este usuario pidió ser borrado el día X". Esa es la limitación que la
-- cascada no arregla, escrita en `001_users.sql:113-121` y en MEMORIA.md §4.1.
--
-- ── POR QUÉ ESTA TABLA NO TIENE FOREIGN KEY A `users` ─────────────────────────
-- Es la misma razón que en `009_login_attempts.sql:21-32` y es DELIBERADA, y es
-- lo que hace que la fila sobreviva al borrado:
--
-- `user_id uuid references users(id) on delete cascade` sería la respuesta
-- automática, y sería un ERROR acá: la cascada borraría el registro de la baja en
-- el mismo instante en que se ejecuta, y la tabla quedaría para siempre vacía.
-- Un `account_deletions` que se autoborra no registra nada, que es exactamente lo
-- contrario de lo que está para hacer.
--
-- Por eso `user_id` es un `uuid` pelado, sin `references`. El tradeoff se acepta
-- con las dos consecuencias, que hay que dejar escritas:
--
--   1. No hay integridad referencial: nada impide escribir un `user_id` que no
--      existía. Para una bitácora append-only que escribe un solo endpoint, con
--      el id tomado de `requireSession` (o sea, de la cookie ya verificada), eso
--      no agrega riesgo real. El día que aparezca un segundo escritor, el
--      constraint se agrega en una migración nueva.
--   2. NO hay `on delete` que la proteja y por eso esta fila es INMUNE al
--      borrado: es exactamente la propiedad que se la pide.
--
-- ── POR QUÉ SE ESCRIBE ANTES DEL `DELETE` Y NO DESPUÉS ───────────────────────
-- Por la misma razón: después del `DELETE` el usuario ya no existe, y el INSERT
-- con su `user_id` y su `email` ya no se puede validar contra nada. El endpoint
-- (`api/account.js`) escribe la fila y borra la cuenta en la MISMA transacción,
-- así que tampoco existe el caso intermedio de "una baja que se anunció pero no
-- ocurrió" por un error de red en el medio.
--
-- ── POR QUÉ `email` Y NO SOLO `user_id` ──────────────────────────────────────
-- Porque la pregunta que alguien se va a hacer ("¿quién pidió la baja?") llega
-- mucho después de que el `users` haya desaparecido, y contestarla con un uuid
-- no sirve para nada. El correo es la etiqueta humana. Copia el valor que
-- devuelve `users.email` y es la evidencia de QUÉ dato se borró: es el único
-- pedazo de la cuenta que sobrevive, y por lo tanto el dato que más importa que
-- quede escrito.
--
-- ── ÍNDICES ─────────────────────────────────────────────────────────────────
-- Ninguno, y es una decisión. La tabla es append-only (nunca se actualiza ni se
-- borra) y crece a razón de una fila por baja, o sea una fila cada miles de
-- cuentas. El `primary key` alcanza para el único uso real —buscar una baja
-- puntual por id— y un índice por `deleted_at` sobre una tabla de ese tamaño es
-- mantenimiento de índices que no compra nada. Si algún día hay que contar bajas
-- por mes, se agrega acá y es un `create index`.
-- ============================================================================

create table if not exists account_deletions (
  id uuid primary key default gen_random_uuid(),

  -- ↑ El id de la cuenta que se dio de baja. SIN `references`, a propósito: ver
  --   el bloque de arriba. Un uuid y no un serial porque el resto del esquema usa
  --   uuid para todo y este valor se va a comparar con el `users.id` de otras
  --   tablas y con el `user_id` de los tokens de sesión.

  user_id uuid not null,

  -- ↑ not null, pero SIN foreign key. Es la única contradicción aparente de esta
  --   tabla y es deliberada: en las otras siete (`profiles`, `skills`, `searches`,
  --   `job_history`, `favorites`, `apify_usage`, `cv_parses`) la FK a `users` es lo
  --   que hace que el borrado sea una sola sentencia. En esta no puede, porque la
  --   fila tiene que sobrevivir al borrado. El NOT NULL sigue valiendo: un
  --   registro de baja que no dice a qué cuenta corresponde no registra nada.

  email text not null,

  -- ↑ El correo, tal como estaba en `users` (ya normalizado a minúsculas por
  --   `normalizeEmail` en el alta). `text` y no `citext`: es una etiqueta, no una
  --   clave, y no se busca por igualdad ni se deduplica.

  deleted_at timestamptz not null default now(),

  -- ↑ El momento de la baja. Lo pone el SERVIDOR (`now()`), no la aplicación: es
  --   el reloj de Postgres, el mismo que usan las otras tablas, y no el
  --   `Date.now()` de una invocación de Vercel que puede tener el reloj corrido.
  --   Es `not null` con default en vez de un `not null` a secas para que el
  --   INSERT del endpoint no tenga que acordarse: el dato que no se manda nunca
  --   se mete mal.

  -- ── Contexto de la petición ────────────────────────────────────────────────
  -- Estas dos NO son el motivo de la tabla: son lo único del request que
  -- sobrevive a la baja, y por eso se guardan. Un DELETE es la operación más
  -- destructiva de la API, y un log de auditoría de una operación destructiva sin
  -- saber de dónde vino es medio log: sirve para contar, no para investigar.
  --
  -- Las dos salen de headers que YA están en el `req` y de funciones que YA
  -- existen (`clientIp`, reexportada por `api/lib/auth.js:716-724` justamente para
  -- que un endpoint de este tipo no tenga que acordarse de cuál archivo la trae).
  -- No hay que inventar nada para llenarlas, y no se guardan si no vinieron:
  -- un `fetch` sin `User-Agent` deja la columna en `null`, que es la respuesta
  -- honesta.
  ip text,

  -- ↑ `text` y no `inet`: `clientIp()` devuelve el primer valor de
  --   `x-vercel-forwarded-for`, que es texto y que, detrás de un proxy raro, puede
  --   no ser una IP. Forzarlo a `inet` convertiría "no lo sé" en un 500 en el
  --   endpoint que borra cuentas. Ver `http.js:275-290`.

  user_agent text

  -- ↑ El `User-Agent` crudo, o `null`. Sin recortar a propósito: es evidencia, y
  --   recortarla es inventar un dato. Es la columna que más va a crecer y la que
  --   menos se va a leer, y está porque el registro de "quién pidió ser borrado"
  --   sin el navegador desde el que lo pidió se puede explicar de dos maneras.
);

-- ▲ No hay `created_at` ni `updated_at` aunque la tabla "tenga" una marca de
--   tiempo: `deleted_at` ES la marca de tiempo, y llamarla de otra forma sería
--   tener dos nombres para el mismo hecho. Y no hay `updated_at` porque esta tabla
--   no se actualiza nunca: es una bitácora, y una bitácora que se puede corregir
--   después no es una bitácora.