#!/usr/bin/env bash
# ============================================================================
# SETUP DEL ENTORNO LOCAL
#
# Instala, levanta, configura y verifica TODO lo que hace falta para correr la
# app en local. Es idempotente a propósito: correrlo dos veces tiene que salir
# con 0 y no cambiar nada, porque el estado de esta máquina cambia todo el tiempo
# (el contenedor quedó parado, alguien borró el `.env`, se aplicó una migración
# nueva) y la respuesta a "Instalar, levantar la base, crear el .env y correr
# migraciones" no puede ser "andá a la terminal y hacelo vos a mano" cada vez.
#
# LO QUE NO HACE, Y ES LO MÁS IMPORTANTE DE TODO ESTE ARCHIVO:
#   · NO llama a /api/linkedin-search ni a /api/cv/parse. Uno ejecuta un actor de
#     Apify y se factura por ejecución, el otro cobra por token del LLM. Son los
#     dos únicos endpoints de este proyecto que cuestan plata, y el setup verifica
#     contra la base y contra `/api/health`, que son gratis.
#   · NO imprime ni escribe el valor de SESSION_SECRET, LLM_API_KEY ni
#     APIFY_API_TOKEN. Imprime la LONGITUD de la sesión y nada más.
#   · NO borra contenedores. Si el que encuentra no se puede usar, avisa y crea
#     otro con otro nombre: un `docker rm -f` sobre una base con datos es la peor
#     forma de "arreglar" un entorno de desarrollo.
#   · NO pisa un `.env` que ya existe. El `.env` es de la persona, no del script.
#
# Corre en Linux, macOS y Git Bash de Windows (que es donde se usa). Lo que hace
# que funcione en los tres es NO usar nada que sea específico de un SO: nada de
# `sed -i` (GNU vs BSD), nada de `readlink -f`, nada del binario `timeout`, y las
# rutas se resuelven con `cd` + `pwd -P`.
#
# Uso:  bash scripts/setup.sh      (o ./scripts/setup.sh si tiene el bit de exec)
# ============================================================================

# Abajo de todo y no en la cabecera: `set -euo pipefail` corta en el primer error,
# `-u` obliga a declarar cada variable, y `pipefail` hace que un `algo | grep`
# que no encuentra nada sea un error y no un "vacío" silencioso. Sin `pipefail`,
# medio proyecto de shell te miente sin querer.
set -euo pipefail

# ---------------------------------------------------------------------------
# El propio archivo tiene que estar en LF.
#
# Esta es la verificación más barata del script y la que más rápido encuentra un
# problema: en Windows, git con `core.autocrlf=true` (el default de hace años)
# convierte a CRLF en el checkout, y un `.sh` con CRLF falla con errores tipo
# `$'\r': command not found` que no dicen NADA de la causa real. Se mide en bytes
# y no con `grep` porque el archivo también puede estar en UTF-16 o UTF-8 con BOM,
# que es el otro final de línea que rompe bash.
#
# OJO: si el archivo llegó con CRLF, bash puede morir ANTES de llegar acá (la
# línea del shebang queda `#!/usr/bin/env bash\r`, y el intérprete no existe).
# Por eso el fix de verdad no es esta línea: es el `.gitattributes` del repo, con
# `*.sh text eol=lf`. Esta es la segunda red, para cuando alguien edita a mano.
# ---------------------------------------------------------------------------
ARCHIVO_SELF="$0"
CR_EN_ESTE_ARCHIVO="$(tr -cd '\r' < "$ARCHIVO_SELF" | wc -c | tr -d '[:space:]')"
if [ "$CR_EN_ESTE_ARCHIVO" != "0" ]; then
  printf 'FALLA: %s tiene %s byte(s) CR: está en CRLF y bash no lo corre.\n' "$ARCHIVO_SELF" "$CR_EN_ESTE_ARCHIVO" >&2
  printf '  · Convertilo a LF y volvé a correr.\n' >&2
  printf '  · Y sobre todo: agregá `*.sh text eol=lf` al .gitattributes del repo,\n' >&2
  printf '    porque si no, el próximo checkout de otra persona lo vuelve a romper.\n' >&2
  exit 70
fi

# ---------------------------------------------------------------------------
# Configuración. Todo lo que alguien tendría que cambiar está acá arriba, en un
# solo lugar, y no repartido en el cuerpo del script: el puerto de la base local
# aparece en el `docker run`, en el `.env` y en los mensajes, y son tres truths
# que tienen que ser la misma.
# ---------------------------------------------------------------------------
RAIZ="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

PUERTO_PG=5433                    # 5432 es el que usa el Postgres del sistema
BD=busqueda                        # el nombre que espera el resto del proyecto
IMAGEN_PG=postgres:16-alpine       # la que se usó siempre; 16 es la de las pruebas
CONT_PREFERIDO=pg-history-check    # el contenedor que ya existe en esta máquina
CONT_PROPIO=busqueda-empleo-pg     # el que crea este script si el anterior no sirve
ESPERA_PG_SEG=60                   # techo del healthcheck de Postgres
ARCHIVOS_CHECK_ESPERADOS=34        # lo que hoy dice `npm run check`
# Las 10 tablas de la app. `schema_migrations` NO va acá: es la tabla de control
# que crea el runner, y sumarla sería contar el inventario contra sí mismo.
TABLAS_APP="users profiles skills searches job_history favorites apify_usage login_attempts cv_parses account_deletions"

# ---------------------------------------------------------------------------
# Salida por pantalla. Los helpers existen para que cada paso del script tenga
# el mismo aspecto, y para que un error se distinga de una nota informativa a
# simple vista. `NO_COLOR` y el chequeo de TTY son el estándar de no-color.org:
# si no hay terminal, no hay color.
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_OK=$'\033[32m'; C_AVISO=$'\033[33m'
  C_ERROR=$'\033[31m'; C_PASO=$'\033[36m'; C_GRIS=$'\033[90m'
else
  C_RESET=''; C_OK=''; C_AVISO=''; C_ERROR=''; C_PASO=''; C_GRIS=''
fi

# Un archivo temporal para capturar la salida de `npm run check`, que se borra
# siempre. Se declara vacío para que el `trap` no se queje con `-u` si el script
# muere antes de crearlo.
TMP_SALIDA=''
limpiar() { [ -n "$TMP_SALIDA" ] && rm -f "$TMP_SALIDA"; return 0; }
trap limpiar EXIT

# El paso que está corriendo, en una sola línea arriba de todo.
paso()  { printf '\n%s━━ %s%s\n' "$C_PASO" "$*" "$C_RESET"; }
ok()    { printf '%s  ✓%s %s\n' "$C_OK" "$C_RESET" "$*"; }
aviso() { printf '%s  !%s %s\n' "$C_AVISO" "$C_RESET" "$*"; }
error() { printf '%s  ✗%s %s\n' "$C_ERROR" "$C_RESET" "$*" >&2; }
# El código de salida es DISTINTO por paso a propósito: si esto corre dentro de
# un CI o de otro script, "falló" sin decir QUÉ falló obliga a mirar la pantalla
# para adivinar. Las líneas siguientes (si las hay) son el detalle.
morir() {
  local codigo="$1"; shift
  error "$1"; shift
  [ $# -gt 0 ] && printf '%s\n' "$@" >&2
  exit "$codigo"
}

# ===========================================================================
# 0. ¿Estamos en el repo?
#
# Se verifica antes de nadaexpensive: un `npm install` en el directorio de al
# lado es un desastre lento, y `dirname` con un path raro (o correr el script
# copiándolo a otro lado) es más probable de lo que parece.
# ===========================================================================
paso '0/7 · Dónde estoy'
cd -- "$RAIZ"
for requerido in package.json migrations api scripts; do
  [ -e "$RAIZ/$requerido" ] || morir 1 "No encuentro '$requerido' en $RAIZ." \
    "Este script tiene que correr desde el repo (está en scripts/setup.sh)."
done
ok "repo: $RAIZ"

# ===========================================================================
# 1. Prerrequisitos
#
# Se chequean TODOS antes de fallar por el primero: si a alguien le falta Node y
# Docker, que lo lea en un solo intento es la diferencia entre un minuto y cinco.
# Y cada mensaje dice qué instalar, porque "command not found" no es una
# explicación.
# ===========================================================================
paso '1/7 · Prerrequisitos'

FALTAN=0

if ! command -v node >/dev/null 2>&1; then
  FALTAN=1
  error 'falta node'
  printf '%s\n' \
    '  · Windows: instalalo con winget install OpenJS.NodeJS.LTS (o nodejs.org)' \
    '  · macOS:   brew install node' \
    '  · Linux:   tu gestor de paquetes (apt install nodejs, dnf install nodejs)' >&2
fi

if ! command -v npm >/dev/null 2>&1; then
  FALTAN=1
  error 'falta npm'
  printf '%s\n' \
    '  · Viene con node. Si no está, es que instalaste node sin npm:' \
    '    en Windows, reinstalá marcando "npm package manager".' \
    '  · En Linux suele ser un paquete aparte (apt install npm).' >&2
fi

if ! command -v docker >/dev/null 2>&1; then
  FALTAN=1
  error 'falta docker'
  printf '%s\n' \
    '  · Windows: instalá Docker Desktop (docker.com/products/docker-desktop)' \
    '  · macOS:   Docker Desktop, o Colima (brew install colima docker)' \
    '  · Linux:   el motor (apt install docker.io) + permiso para docker' >&2
fi

[ "$FALTAN" -eq 0 ] || morir 1 'Faltan prerrequisitos. Instalá lo de arriba y volvé a correrlo.'

# Versión de Node, y el mínimo del proyecto. El piso es 20 por lo que dice
# `engines` en package.json, no por una preferencia: el proyecto usa ESM y
# `await` a nivel de módulo en `scripts/migrate.js`.
NODE_MAYOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAYOR" -lt 20 ]; then
  morir 1 "node v$(node -v) es demasiado viejo: el proyecto pide 20 o superior (package.json engines)."
fi
ok "node $(node -v) · npm v$(npm --version)"

# El binario de docker puede existir y el daemon no estar vivo: pasa cuando
# Docker Desktop está cerrado. Es el caso más común en Windows y el que da el
# error más críptico ("cannot connect to the Docker daemon"), así que se chequea
# explícitamente y con su propia explicación.
if ! docker info >/dev/null 2>&1; then
  morir 1 'Docker está instalado pero el daemon no responde.' \
    '  · Windows/macOS: abrí Docker Desktop y esperá a que diga "Engine running".' \
    '  · Linux: sudo systemctl start docker'
fi
ok "docker $(docker --version | sed 's/^Docker version //; s/,.*//')"

# ===========================================================================
# 2. Postgres en Docker
#
# El proyecto no tiene docker-compose a propósito: es UNA base de desarrollo, en
# UN puerto fijo, y un compose para eso es un archivo más que puede quedar
# desincronizado del puerto que dice el .env. Lo que hay que garantizar es que
# el contenedor que está arriba sea el que el .env apunta.
#
# El orden importa: el healthcheck va ANTES de tocar el .env y antes de migrar,
# y no es un detalle de forma.
# ===========================================================================
paso '2/7 · Postgres en Docker'

# --- Estado y configuración de un contenedor --------------------------------

# `docker inspect` sobre un nombre inexistente sale con código 1, no con un
# `{}`: por eso el `|| true`. Con `-euo pipefail` un comando que falla dentro de
# `$(...)` aborta el script entero si no se neutraliza.
cont_existe() { docker inspect -f '{{.State.Status}}' "$1" >/dev/null 2>&1; }
estado_cont() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || true; }

# OJO con esta función: imprime TODO el .Config.Env del contenedor, que incluye
# el POSTGRES_PASSWORD. Por eso nunca se llama sin capturar en `$(...)`, y por eso
# hay un comentario para que el próximo que la toque no la imprima por curiosidad.
entorno_cont() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null; }

# El valor de una variable del contenedor, o vacío. `sed -n 's/^X=//p'` es
# portable entre GNU y BSD, a diferencia de `sed -i`, que se evita en todo el
# script por lo mismo.
valor_cont() {
  entorno_cont "$1" | sed -n "s/^$2=//p" | head -n 1
}

# El puerto del HOST donde está publicado el 5432 del contenedor.
#
# Se lee de `.HostConfig.PortBindings` y NO de `docker port`, y la diferencia es
# una trampa real: `docker port` refleja el estado VIVO de la red del contenedor,
# así que sobre un contenedor PARADO responde "no publicaste el 5432". Un
# contenedor parado se vería como inservible por puerto, el script crearía un
# segundo contenedor para el mismo puerto y fallaría al bindearlo, cuando la
# solución era `docker start`. `HostConfig` es la CONFIGURACIÓN y no cambia con el
# estado. El `{{with}}` de la plantilla no es decorativo: es lo que hace que un
# puerto no publicado devuelva vacío en vez de un error de plantilla.
puerto_publicado() {
  docker inspect \
    -f '{{with index .HostConfig.PortBindings "5432/tcp"}}{{(index . 0).HostPort}}{{end}}' \
    "$1" 2>/dev/null || true
}

# Por qué un contenedor existente NO se puede usar. Imprime el motivo o nada.
# Existe para que el aviso sea específico ("publica el 5432, no el 5433") en vez
# de un genérico "algo está mal", que es la clase de mensaje que hace perder
# veinte minutos.
motivo_inservible() {
  local c="$1" img pub pw
  img="$(docker inspect -f '{{.Config.Image}}' "$c" 2>/dev/null || true)"
  case "$img" in
    postgres:*) ;;
    *) printf 'la imagen es "%s" y no es de Postgres' "${img:-<desconocida>}"; return 0 ;;
  esac
  pub="$(puerto_publicado "$c")"
  if [ "$pub" != "$PUERTO_PG" ]; then
    printf 'publica el 5432 en el puerto "%s" y el .env apunta al %s' "${pub:-<ninguno>}" "$PUERTO_PG"
    return 0
  fi
  pw="$(valor_cont "$c" POSTGRES_PASSWORD)"
  if [ -z "$pw" ]; then
    printf 'no tiene POSTGRES_PASSWORD: sin clave no hay forma de armar el DATABASE_URL'
    return 0
  fi
  printf ''
}

es_servible() { [ -z "$(motivo_inservible "$1")" ]; }

# --- Elegir el contenedor ----------------------------------------------------

CONT="$CONT_PREFERIDO"
if cont_existe "$CONT"; then
  if es_servible "$CONT"; then
    ok "reutilizo el contenedor existente '$CONT'"
  else
    aviso "'$CONT' existe pero no sirve: $(motivo_inservible "$CONT")."
    aviso "No lo borro: puede tener datos y no es de este script. Creo '$CONT_PROPIO'."
    CONT="$CONT_PROPIO"
  fi
fi

if [ "$CONT" = "$CONT_PROPIO" ] && cont_existe "$CONT"; then
  # Si el que creó ESTE script está inservible, algo se rompió o alguien lo
  # editó a mano. Sigue sin tocarse: avisar y seguir con la base como está es
  # mejor que un `docker rm -f` de algo que no creamos en esta corrida.
  if es_servible "$CONT"; then
    ok "reutilizo '$CONT'"
  else
    morir 2 "'$CONT' existe y no sirve: $(motivo_inservible "$CONT")." \
      "  · No lo borro. Si querés uno limpio: docker rm -f $CONT y volvé a correr."
  fi
fi

# --- Crearlo si no está -----------------------------------------------------

PG_USUARIO=postgres
PG_PASS=''
if ! cont_existe "$CONT"; then
  ok "no existe: creo '$CONT'"
  # La clave se genera al azar y NO se imprime. Podría ser una fija tipo
  # "postgres" y no lo es por una razón concreta del proyecto: una clave escrita
  # en un script es una clave escrita en el repo, y la regla de secretos de
  # AGENTS.md no tiene excepción para "es una base de desarrollo". El .env que
  # se genera más abajo lleva esta misma clave, así que el entorno funciona sin
  # que nadie tenga que inventarse una.
  PG_PASS="$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("hex"))')"
  # `-p 127.0.0.1:PORT:5432` y no `-p PORT:5432`: atado a loopback la base de
  # desarrollo no queda escuchando en la red local ni en la VPN del trabajo. El
  # contenedor que ya existía en esta máquina publica en 0.0.0.0, y no por eso
  # el script lo cambia: no es suyo.
  #
  # OJO: el `-e POSTGRES_PASSWORD=` queda en el historial del shell y en
  # `docker inspect`. Es una limitación de la imagen oficial, no una decisión
  # nuestra: la clave tiene que existir para que la imagen arranque. Lo que sí
  # depende de este archivo es no imprimirla nunca y no commitear nunca el .env.
  docker run -d \
    --name "$CONT" \
    -e POSTGRES_USER="$PG_USUARIO" \
    -e POSTGRES_DB="$BD" \
    -e POSTGRES_PASSWORD="$PG_PASS" \
    -p "127.0.0.1:${PUERTO_PG}:5432" \
    "$IMAGEN_PG" >/dev/null
  ok "contenedor creado (imagen $IMAGEN_PG, puerto $PUERTO_PG)"
fi

# --- Leverantarlo si está parado ---------------------------------------------

# Se distinguen los casos porque `docker start` no sirve para todos: sobre un
# contenedor PAUSADO dice "already running" y no lo levanta, y sobre uno en
# RESTARTING no hay que hacer nada, solo esperar.
ESTADO="$(estado_cont "$CONT")"
case "$ESTADO" in
  running)
    ok "'$CONT' ya estaba corriendo" ;;
  paused)
    ok "'$CONT' estaba pausado; lo reanudo"
    docker unpause "$CONT" >/dev/null ;;
  restarting)
    ok "'$CONT' se está reiniciando; espero a que quede arriba" ;;
  *)
    ok "'$CONT' estaba parado ($ESTADO); lo levanto"
    docker start "$CONT" >/dev/null ;;
esac

# --- EL HEALTHCHECK ----------------------------------------------------------
#
# Un Postgres recién arrancado ACEPTA CONEXIONES antes de estar listo para que le
# apliquen el esquema. El entrypoint de la imagen oficial levanta un servidor
# temporal mientras corre el initdb, y hay una ventana (y en una máquina lenta,
# bastante ancha) en la que un `psql` o un `npm run migrate` se conecta y se
# lleva un error que no dice nada del problema real: "the database system is
# starting up".
#
# Por eso el loop con `pg_isready` y NO un `sleep 5` a ciegas. El sleep es la
# versión que funciona el 95% de las veces y falla el 5% restante, siempre en la
# máquina del que no puede probarlo.
#
# `pg_isready` sale con 0 cuando acepta conexiones, 1 si rechaza y 2 si no
# contesta, así que un solo `if` alcanza. El techo está en iteraciones y no con
# el binario `timeout`, que no existe en macOS.
#
# `-d postgres` y NO `-d busqueda`: el healthcheck tiene que poder pasar antes
# de que la base de la app exista, y es exactamente lo que se comprueba más abajo.
# `pg` siempre crea la base `postgres`, así que es un blanco seguro. Preguntar por
# `busqueda` convertiría este loop en un deadlock esperando algo que este mismo
# script todavía no creó.
i=0
LISTO=0
while [ "$i" -lt "$ESPERA_PG_SEG" ]; do
  if docker exec "$CONT" pg_isready -U "$PG_USUARIO" -d postgres >/dev/null 2>&1; then
    LISTO=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$LISTO" -ne 1 ]; then
  error "Postgres no respondió en ${ESPERA_PG_SEG} s."
  printf '%s\n' \
    '  · Última línea del log del contenedor (por si se quedó sin memoria o:' \
    '    falto una variable de la imagen):' >&2
  docker logs --tail 20 "$CONT" >&2 || true
  exit 2
fi
ok "Postgres acepta conexiones ($i s de espera)"

# --- Usuario, clave y base ---------------------------------------------------
#
# Usuario y clave se LEEN del contenedor, no se inventan. Es lo que hace que
# este script sea idempotente sobre una máquina que ya tenía la base de otra
# persona con otra clave: si escribiera `postgres/postgres` a ciegas, el
# DATABASE_URL del .env no coincidiría con la base y `npm run migrate` moriría con
# 28P01, que es un error de credenciales traducido a un problema de entorno.
PG_USUARIO="$(valor_cont "$CONT" POSTGRES_USER)"
PG_USUARIO="${PG_USUARIO:-postgres}"
PG_PASS="$(valor_cont "$CONT" POSTGRES_PASSWORD)"

# La base la crea sola la imagen (POSTGRES_DB), pero SOLO si el contenedor se
# creó con ella. Si se reutiliza uno que se armó sin POSTGRES_DB, `busqueda` no
# está, y `npm run migrate` se muere con 3D000 ("la base no existe"), que de nuevo
# es un problema de configuración disfrazado de error de Postgres.
if [ -z "$(docker exec "$CONT" psql -U "$PG_USUARIO" -d postgres -Atc \
    "select 1 from pg_database where datname = '$BD'" 2>/dev/null | tr -d '[:space:]')" ]; then
  aviso "la base '$BD' no estaba: la creo"
  # `createdb` y no `psql -c 'create database'`: un CREATE DATABASE no se puede
  # meter adentro de una transacción, y el `-c` simple de psql lo respeta.
  docker exec "$CONT" createdb -U "$PG_USUARIO" "$BD" >/dev/null
fi
ok "base '$BD' lista (usuario '$PG_USUARIO')"

# La clave va percent-encoded en la URL. Sin esto, una clave con `@` o `/` parte
# la connection string en el lugar equivocado y el error es 28000 ("no se pudo
# autenticar") en vez de algo que diga "tu clave tiene un arroba".
# Por stdin y no por argv: un argumento queda visible en `ps` para cualquier
# proceso de la máquina mientras el comando corre.
PASS_URL="$(printf '%s' "$PG_PASS" | node -e 'let d = ""; process.stdin.on("data", (c) => { d += c; }).on("end", () => { process.stdout.write(encodeURIComponent(d)); });')"
# 127.0.0.1 y no `localhost`: en Windows y en macOS `localhost` puede resolver a
# ::1, y Postgres atado a 127.0.0.1 no contesta por IPv6. Además `db.js` trata
# 127.0.0.1 como local sin mirar nada más.
#
# `?sslmode=disable` NO es opcional y no es por comfort: `pg` no degrada a texto
# plano solo (`pg/lib/connection.js` contesta N al pedido de TLS y cierra), así
# que sin esto la conexión falla con "The server does not support SSL
# connections". Un Postgres de Docker local no habla TLS. Está explicado en el
# `.env.example` y en el bloque de TLS de `api/lib/db.js`.
DATABASE_URL="postgres://${PG_USUARIO}:${PASS_URL}@127.0.0.1:${PUERTO_PG}/${BD}?sslmode=disable"

# ===========================================================================
# 3. Dependencias
#
# `npm install` EN LA RAÍZ y nunca adentro de `frontend/`. No es una preferencia
# de orden: la raíz declara `"workspaces": ["frontend"]`, así que npm hoistea
# todo al `node_modules` de la raíz y `frontend/node_modules` NO EXISTE. Peor: en
# Vercel solo corren los scripts de la raíz, así que si el frontend fuera una
# carpeta independiente, `vite` no estaría instalado y el `buildCommand` fallaría
# en cada deploy.
# ===========================================================================
paso '3/7 · Dependencias (npm install en la raíz, una sola vez para los dos lados)'
npm install
ok 'node_modules listo'

if [ -d "$RAIZ/frontend/node_modules" ]; then
  aviso "existe frontend/node_modules, y no debería."
  aviso "  Con 'workspaces' todo queda hoisted en la raíz. Eso pasa si alguien"
  aviso "  corrió 'npm install' adentro de frontend/: borralo con"
  aviso "    rm -rf frontend/node_modules"
  aviso "  y volvé a correr 'npm install' en la raíz. NO lo borro yo."
fi

# ===========================================================================
# 4. El `.env`
#
# Se genera desde `.env.example` y no desde cero, por una razón que va a seguir
# importa cuando `.env.example` crezca: los defaults del pool y del rate limit
# están comentados ahí, con el porqué de cada número. Un `.env` escrito a mano por
# el script se desincroniza de `.env.example` en la primera migración que agrega
# una variable, y nadie se da cuenta hasta que un endpoint usa un default que
# nadie eligió.
# ===========================================================================
paso '4/7 · Archivo .env'

VARIABLES_ESPERADAS='DATABASE_URL SESSION_SECRET PG_POOL_MAX PG_POOL_IDLE_MS MIGRATE_LOCK_TIMEOUT_MS LLM_API_KEY LLM_MODEL CV_PARSE_LIMIT CV_PARSE_LIMIT_WINDOW_MINUTES CV_PARSE_RETENTION_HOURS APIFY_API_TOKEN APIFY_MAX_RESULTS APIFY_DAILY_LIMIT'

if [ -f "$RAIZ/.env" ]; then
  # Nunca se pisa un .env que ya existe. El .env es de la persona: puede estar
  # apuntando a Neon, no a la base local, y un script que "lo arregla" le cambia
  # la base de datos debajo sin que nadie lo haya pedido.
  aviso 'ya existe .env: no lo toco (seguí)'
  # Solo nombres y un sí/no por valor. Imprimir un valor acá metería
  # SESSION_SECRET o un token de Apify en la terminal y en el scrollback.
  FALTAN_VAR=''
  for v in $VARIABLES_ESPERADAS; do
    grep -q "^$v=" "$RAIZ/.env" 2>/dev/null || FALTAN_VAR="$FALTAN_VAR $v"
  done
  [ -n "$FALTAN_VAR" ] && aviso "  no están en el .env (si el default te sirve, no es problema):$FALTAN_VAR"
  VALOR_DB="$(sed -n 's/^DATABASE_URL=//p' "$RAIZ/.env" | head -n 1)"
  if [ -z "${VALOR_DB//[[:space:]]/}" ]; then
    error 'el .env existe pero DATABASE_URL está vacía: sin ella no hay migrate ni API'
    exit 4
  fi
  ok "DATABASE_URL tiene valor (no se muestra)"
else
  [ -f "$RAIZ/.env.example" ] || morir 4 'No existe .env.example: no hay de dónde sacar el esqueleto del .env.'
  # El mismo generador que documentan `.env.example` y el README. 32 bytes en hex
  # son 64 caracteres; `auth.js` exige 32 y devuelve 500 con ConfigError si falta
  # o es corta, así que generar una corta "para probar" deja la app sin login.
  SESSION_SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  # Lectura línea por línea con sustitución de tres variables. No se usa `sed -i`
  # porque su sintaxis cambia entre GNU y BSD, y este script tiene que correr en
  # los tres sistemas.
  #
  # El `${linea%$'\r'}` está porque `.env.example` puede llegar con CRLF del
  # checkout de Windows, y sin esa corrección cada valor generado arrastra un
  # `\r` invisible al final. `migrate.js` lo toleraría (hace `trim()`), pero
  # `vercel dev` no tiene por qué.
  while IFS= read -r linea || [ -n "$linea" ]; do
    linea="${linea%$'\r'}"
    case "$linea" in
      DATABASE_URL=*)
        printf '%s\n' "DATABASE_URL=$DATABASE_URL" ;;
      SESSION_SECRET=*)
        printf '%s\n' "SESSION_SECRET=$SESSION_SECRET" ;;
      LLM_API_KEY=*)
        printf '%s\n' \
          '# Vacía a propósito: el parseo del CV llama a un LLM y SE PAGA POR TOKEN con' \
          '# esta clave, que es del dueño de la app. Sin ella el registro y el login' \
          '# funcionan igual; lo único que no se puede hacer es subir el CV.' \
          'LLM_API_KEY=' ;;
      APIFY_API_TOKEN=*)
        printf '%s\n' \
          '# Vacía a propósito: cada búsqueda de LinkedIn EJECUTA un actor de Apify y se' \
          '# cobra. El endpoint /api/linkedin-search ni existe todavía. No lo llames para' \
          '# "verificar que anda".' \
          'APIFY_API_TOKEN=' ;;
      *)
        printf '%s\n' "$linea" ;;
    esac
  done < "$RAIZ/.env.example" > "$RAIZ/.env"

  ok ".env creado (base local en 127.0.0.1:$PUERTO_PG)"
  # Solo el largo. El valor de SESSION_SECRET no sale de acá nunca: ni por
  # pantalla, ni por un `set -x`, ni por el log de este script.
  ok "SESSION_SECRET: ${#SESSION_SECRET} caracteres (no se muestra)"
fi

# Que el .env siga siendo un secreto. Se verifica con la herramienta de git en
# lugar de leer el .gitignore a ojo: la regla que importa es la que git APLICA,
# y además hay que descartar que alguien lo haya agregado a propósito con
# `git add -f`.
#
# Y se verifica SOLO si estamos dentro de un work tree. Fuera de un repo (un zip
# descargado, una carpeta de pruebas) `git check-ignore` falla, y confundir ese
# fallo con "el .env no está ignorado" produce un error que miente: ahí no hay
# ningún repo que pueda commitear nada.
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git check-ignore -q "$RAIZ/.env" 2>/dev/null; then
    ok '.env está en .gitignore: no se commitea'
  else
    error '.env NO está en .gitignore. Agregá `.env` antes de hacer commit.'
    exit 4
  fi
  # Y que además no esté trackeado: estar en .gitignore no sirve si ya está en el
  # índice. Un archivo trackeado sigue en .gitignore para siempre.
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    error '.env está trackeado por git. Hacé `git rm --cached .env` YA.'
    exit 4
  fi
else
  aviso 'esto no es un work tree de git: me salto la verificación del .gitignore.'
fi

# ===========================================================================
# 5. Migraciones
# ===========================================================================
paso '5/7 · Migraciones (npm run migrate)'

# `npm run migrate` lee el `.env` él mismo (`loadEnvFile` en scripts/migrate.js)
# y NO pisa lo que ya está en el entorno. O sea que no hace falta exportar
# DATABASE_URL acá, y que si alguien la tenía exportada en la terminal, esa gana.
#
# Es idempotente: correrlo sobre una base ya migrada no hace nada y sale con 0.
if npm run migrate; then
  ok 'migraciones aplicadas'
else
  error 'npm run migrate falló'
  printf '%s\n' \
    '' \
    '  Lo más probable NO es un problema de este script. Son dos cosas, y la' \
    '  primera es la que más despista:' \
    '' \
    '  1. "ya fue aplicado pero su contenido cambió": un .sql de migrations/ se' \
    '     editó después de aplicado. El runner guarda el sha256 de los BYTES' \
    '     CRUOS y aborta a propósito, porque este proyecto no tiene rollback y' \
    '     reaplicar el contenido nuevo sobre un esquema ya construido produce un' \
    '     estado que nadie eligió. Si el cambio es de formato: restaurá el' \
    '     archivo. Si es de esquema real: escribí una migración NUEVA.' \
    '     (Pista: si pasa en Windows y no tocaste ningún .sql, puede ser que el' \
    '      checkout los pasó a CRLF, y el checksum es de los bytes exactos.)' \
    '' \
    '  2. Error de conexión: casi siempre es un DATABASE_URL que no coincide con' \
    '     la base de arriba. El runner traduce el código de pg a una explicación.' \
    '' \
    '  El mensaje completo está arriba.' >&2
  exit 5
fi

# ===========================================================================
# 6. Verificación
#
# Los dos comandos de siempre, y nada más: este proyecto no tiene linter, ni
# formateador, ni typecheck, ni framework de tests, y no se los agrega.
# `npm run check` solo PARSEA (no ejecuta código), así que es seguro; `npm run
# build` es el que valida los .jsx, que node --check no sabe parsear.
# ===========================================================================
paso '6/7 · Verificación (npm run check y npm run build)'

TMP_SALIDA="$(mktemp)"
if npm run check 2>&1 | tee "$TMP_SALIDA"; then
  CHECK_N="$(sed -n 's/^OK: \([0-9][0-9]*\) archivos\.$/\1/p' "$TMP_SALIDA" | head -n 1)"
  if [ -z "$CHECK_N" ]; then
    aviso 'no reconocí la línea "OK: N archivos." en la salida de check'
  elif [ "$CHECK_N" != "$ARCHIVOS_CHECK_ESPERADOS" ]; then
    # No es un error: el número cambia solo, cada vez que se agrega un endpoint.
    # Pero el número es la ÚNICA forma de notar que quedó un archivo fuera de las
    # carpetas que `scripts/check.js` recorre (api/ y scripts/), así que si
    # cambia hay que saber por qué. Y `setup.sh` NO cuenta: check.js solo mira
    # .js/.mjs/.cjs.
    aviso "npm run check dijo $CHECK_N archivos y el número de referencia es $ARCHIVOS_CHECK_ESPERADOS."
    aviso "  Si agregaste endpoints, es lo esperado. Si NO, puede quedar un .js"
    aviso "  fuera de api/ y scripts/, que son las dos carpetas que check recorre."
  else
    ok "check: $CHECK_N archivos (el número de referencia)"
  fi
else
  error 'npm run check falló: hay un .js de api/ o scripts/ que no parsea (salida arriba)'
  exit 6
fi

if npm run build; then
  ok 'build: el frontend compila (esto es lo que valida los .jsx)'
else
  error 'npm run build falló: hay un .jsx o un import roto en frontend/src'
  exit 6
fi

# Las tablas, contadas contra la base y no contra el papel. Es el único chequeo
# que demuestra que las migraciones DE VERDAD quedaron aplicadas: `npm run
# migrate` puede salir con 0 y dejar el esquema a medias si el DATABASE_URL
# apunta a otra base, y el síntoma de eso es un 500 en la primera función que
# consulta.
#
# `tr -d '\r'` y NO `tr -d '[:space:]'`: sacar los espacios junta TODOS los
# nombres en una sola línea y después la comparación por nombre no puede
# encontrar ninguno. El salto de línea es el separador que se necesita acá.
TABLAS="$(docker exec "$CONT" psql -U "$PG_USUARIO" -d "$BD" -Atc \
  "select table_name from information_schema.tables where table_schema = 'public' order by 1" 2>/dev/null | tr -d '\r')"
if [ -n "$TABLAS" ]; then
  # Se comparan los 10 nombres de la app uno por uno con `grep -x`, y no contando:
  # el total cambia cada vez que entra una migración, así que un número fijo
  # avisaría de más (hoy hay 11 tablas: las 10 de la app más `schema_migrations`,
  # que es la tabla de control del runner y no cuenta como de la app).
  FALTAN_TABLAS=''
  for t in $TABLAS_APP; do
    printf '%s\n' "$TABLAS" | grep -qx "$t" || FALTAN_TABLAS="$FALTAN_TABLAS $t"
  done
  if [ -n "$FALTAN_TABLAS" ]; then
    error "faltan tablas en '$BD':$FALTAN_TABLAS"
    error '  El DATABASE_URL puede estar apuntando a otra base, o quedó una'
    error '  migración sin aplicar. Mirá el nombre de la base en el .env.'
    exit 6
  fi
  ok "esquema completo: 10 tablas de la app (+ schema_migrations) en '$BD'"
else
  aviso "no pude contar las tablas por docker exec; si el migrate salió con 0, el esquema está."
fi

# ===========================================================================
# 7. Resumen
#
# Lo que sigue son DOS comandos y no uno, y la diferencia entre ellos es la
# primera causa de "no me anda la API" en este proyecto.
# ===========================================================================
printf '\n%s✓ Entorno listo.%s\n\n' "$C_OK" "$C_RESET"
cat <<RESUMEN
  Base de datos   $BD en 127.0.0.1:$PUERTO_PG (contenedor '$CONT')
  Dependencias    node_modules en la raíz (raíz + frontend, es un workspace)
  Configuración   .env en la raíz, con DATABASE_URL y SESSION_SECRET
  Esquema         migraciones aplicadas

  Para correr la app hacen falta DOS terminales:

    ${C_PASO}1) backend${C_RESET}   npx vercel dev      ${C_GRIS}:3000, sirve /api${C_RESET}
    ${C_PASO}2) frontend${C_RESET}  npm run dev         ${C_GRIS}:5173, proxy /api a :3000${C_RESET}

  ${C_AVISO}npm run dev NO levanta el backend${C_RESET}: es solo Vite. Para tocar
  /api de verdad necesitás ${C_PASO}npx vercel dev${C_RESET} en la otra terminal (lee solo el
  .env). Sin backend, el frontend entra en modo demo con las ofertas FALLBACK.

  Smoke test (gratis: no toca la base ni a Apify):

    curl -fsS http://localhost:3000/api/health

  ${C_AVISO}Ojo con los endpoints de pago${C_RESET}: /api/linkedin-search ejecuta un actor
  de Apify y se factura, y /api/cv/parse cobra tokens del LLM. No los uses para
  verificar nada. Para el CV hay un LLM falso local: la idea está en AGENTS.md.
RESUMEN
