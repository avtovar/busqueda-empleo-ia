-- ============================================================================
-- 009_login_attempts.sql — el contador que hace que el rate limit del login
-- exista de verdad en serverless.
--
-- EL PUNTO 4 DEL PEDIDO PIDE "rate limit de login". Sin ella, cualquiera puede
-- probar contraseñas en serio contra una cuenta ajena, y contra una base con
-- contraseñas reutilizadas eso es un diccionario entero.
--
-- ── POR QUÉ UNA TABLA Y NO UN `Map` EN MEMORIA ───────────────────────────────
-- Un rate limit en memoria es la respuesta obvia y ACA ESTÁ PROHIBIDA: en Vercel
-- cada invocación es un PROCESO DISTINTO. Un `Map` declarado a nivel de módulo
-- empieza vacío en cada invocación, así que un atacante que manda 1000 intentos
-- seguidos los reparte entre 1000 procesos que no comparten nada, y cada uno ve
-- "primer intento". El límite no limita: se ve que funciona, da sensación de que
-- está, y no detiene a nadie. Es el peor tipo de bug, el que pasa los tests.
--
-- Lo mismo aplica a los 3 límites del origen que usaban memoria (`cache`,
-- `lastApifyJobs`, `refreshing`) y que MEMORIA.md §3.5 ya había marcado para
-- eliminar. Esta tabla es la versión de este límite que sí sobrevive.
--
-- ── POR QUÉ ESTA TABLA NO TIENE FOREIGN KEY A `users` ───────────────────────
-- Y esto NO es un olvido, es la razón por la que la tabla existe: el intento
-- fallido se registra SIEMPRE, incluso cuando el correo NO corresponde a ninguna
-- cuenta. Si la tabla tuviera `references users(id)` (o guardara el id en vez del
-- correo), el INSERT de un intento contra `inventado@example.com` fallaría con
-- una violación de FK, y el atacante podría usar el 500 como oráculo para saber
-- qué correos existen. El atacante que quiere encontrar una contraseña prueba
-- contra correos que probablemente no existen, y esa es justo la capa del
-- ataque que este contador tiene que ver.
--
-- Por la misma razón el `email` es `text` y no una FK: es una etiqueta para
-- agrupar intentos, no una referencia.
--
-- ── LOS LÍMITES Y POR QUÉ SON DOS ───────────────────────────────────────────
-- Los números NO están en esta tabla: son variables de entorno
-- (LOGIN_LIMIT_MAX_PER_PAIR, LOGIN_LIMIT_MAX_PER_IP, LOGIN_LIMIT_WINDOW_MINUTES,
-- ver `api/lib/rateLimit.js`), y el retention también. Es la misma decisión que
-- tomó 007 con APIFY_DAILY_LIMIT: cambiar un límite tiene que ser cambiar una
-- variable y redesplegar, no una migración sobre datos.
--
-- Capa 1 — por (correo, IP): 10 intentos fallidos en 15 minutos.
--   Es la que frena al atacante que se concentra con UNA cuenta. Se cuenta la
--   PAREJA y no solo el correo, y esa es una decisión de seguridad, no de
--   simplicidad: si el límite fuera solo por correo, cualquiera podría bloquear
--   la cuenta de una víctima real con 10 intentos fallidos desde 10 IP
--   distintas, y el usuario se quedaría sin poder entrar 15 minutos sin entender
--   por qué. Es un denial of service contra usuarios reales, contra un atacante
--   que no tiene nada que perder. El límite por IP cubre el caso simétrico.
--
-- Capa 2 — por IP, cualquier correo: 30 intentos fallidos en 15 minutos.
--   Es la que frena el spray: un atacante que prueba 500 contraseñas contra 500
--   cuentas distintas desde una sola máquina. Sin esto, la capa 1 nunca se
--   activa, porque cada cuenta recibe UN intento.
--
-- ── LA LIMITACIÓN QUE ESTO NO CUBRE, y por qué no se tapa ────────────────────
-- Un atacante DISTRIBUIDO contra UNA sola cuenta (muchas IP, mismo correo) no
-- choca contra ninguna de las dos capas: la 1 exige la misma IP y la 2 exige la
-- misma IP. La forma de taparlo es una tercera capa "por correo, desde cualquier
-- IP", y NO se agregó a propósito por el bloqueo de FALSEOS POSITIVOS que
-- acabamos de describir: un atacante podría dejar a un usuario real sin poder
-- entrar 15 minutos con diez pedidos HTTP.
--
-- Para una app de empleo, donde el usuario es una persona que entra a ver ofertas
-- y tiene la contraseña de su correo en el teléfono, ese falso positivo es más
-- caro que el agujero que tapa. Si algún día hay que cerrarlo, la forma correcta
-- NO es subir el límite por correo: es un límite por correo con EXENCIÓN para los
-- intentos que no llegan a un umbral (por ejemplo, alertar y no bloquear) más un
-- captcha, o mover la defensa a un servicio externo. Queda anotado para que
-- nadie lo "arregle" subiendo un número.
--
-- ── LA IP QUE SE GUARDA ─────────────────────────────────────────────────────
-- Viene de `x-vercel-forwarded-for` / `x-real-ip` / `x-forwarded-for`, en ese
-- orden (ver `clientIp()` en api/lib/http.js). El `x-forwarded-for` es el único
-- que un cliente puede mandar por su cuenta: los otros dos los pone el edge de
-- Vercel. Con un CDN adelante que NO sobreescriba ese header, un atacante elige
-- su propia IP y se lleva por delante la capa 2 (la capa 1 sigue valiendo). Por
-- eso la columna es `text` y no `inet`: se comparan y se agrupan por igualdad de
-- string, y no hace falta interpretar nada.
-- ============================================================================

create table if not exists login_attempts (
  -- ↑ `bigint generated always as identity` y NO `uuid default gen_random_uuid()`
  --   como las otras tablas, y la diferencia es deliberada: esta es la ÚNICA tabla
  --   del esquema que se BORRA y se reescribe cada 24 horas, con escrituras
  --   potencialmente altas (un ataque genera miles por minuto) y que nunca se lee
  --   por id. Un int64 monotónico tiene el índice más chico y es más barato de
  --   insertar que un uuid de 16 bytes aleatorios.
  --   Que el driver devuelva `int8` como string (ver la nota de db.js §2.4) es
  --   IRRELEVANTE acá: el id no se selecciona nunca, las consultas son
  --   agregados por ip/email. No es un bug, es una columna que no se usa.
  id bigint generated always as identity primary key,

  -- ↑ El correo que se intentó, YA normalizado a minúsculas (ver
  --   `normalizeEmail()` en api/lib/auth.js). Guardarlo crudo haría que
  --   "Ada@x.com" y "ada@x.com" tuvieran contadores distintos y el límite se
  --   podría evadir simplemente alternando mayúsculas. Se guarda aunque NO
  --   exista la cuenta: ver arriba, por qué no hay foreign key.
  email text not null,

  -- ↑ La IP del cliente, como texto. Sin sentido de red, sin geography: solo
  --   igualdad. Ver la nota de arriba sobre `x-forwarded-for`.
  ip text not null,

  -- ↑ CUÁNDO se intentó, no "la hora del día": la ventana del rate limit es
  --   relativo ("más viejo que ahora - 15 minutos"), y la comparación con
  --   `now()` la hace Postgres. Si la ventana la calculara el runtime de Vercel,
  --   dos invocaciones con relojes distintos aplicarían criterios distintos.
  --   `default now()` y no `clock_timestamp()` a propósito: `now()` es el
  --   timestamp de la TRANSACCIÓN, así que el insert y la lectura posterior de la
  --   capa 1 ven la misma hora aunque la transacción dure un rato.
  attempted_at timestamptz not null default now()
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- (`create index` normal y no concurrently: el runner mete cada archivo en su
--  propia transacción. La explicación completa está en 001_users.sql.)
--
-- Los DOS PRIMEROS son los que usa el rate limit, y cada uno está en el orden
-- exacto que necesita la query de `assertLoginAllowed()`:
--
--   where ip = $2 and attempted_at > now() - 15 minutes
--
-- Con (ip, attempted_at DESC) eso es un range scan que además puede devolver el
-- `min(attempted_at)` (el `Retry-After`) sin ORDER BY ni sort: el índice ya
-- está ordenado por fecha. Y el count por PAREJA es el mismo índice con un
-- filtro más, o sea que el login hace UNA sola query con UN solo índice.
--
-- El tercero (por email) existe por la otra operación: `delete from
-- login_attempts where email = $1`, que se corre después de un login
-- EXITOSO para que a un usuario que se equivocó tres veces y entró bien no le
-- queden los intentos contados. Sin índice, esa limpieza sería un seq scan.
--
-- ▲ Y este es el índice que hace que la tabla NO crezca para siempre: la purga
--   `delete ... where attempted_at < now() - 24 hours` (que se dispara sola, en
--   el mismo endpoint que registra un fallo, porque en serverless no hay cron) es
--   un range scan en vez de un recorrido completo. Mismo argumento que el
--   `apify_usage_day_idx` de 007.
create index if not exists login_attempts_ip_time_idx
  on login_attempts (ip, attempted_at desc);

create index if not exists login_attempts_email_time_idx
  on login_attempts (email, attempted_at desc);

create index if not exists login_attempts_time_idx
  on login_attempts (attempted_at);

-- ▲ No hay índice por `user_id` acá, y no es que esta tabla se haya olvidado de la
--   regla del proyecto: la regla es "toda tabla con datos de un usuario va
--   filtrada por user_id", y esta tabla no guarda datos de un usuario, sino
--   intentos de acceso. El `email` es una etiqueta de agrupación (ver arriba por
--   qué no puede ser una FK), y borrarla con el usuario no corresponde: los
--   intentos de un correo que se dio de baja son justamente los que importan
--   para decidir si ese correo estaba siendo atacado.
