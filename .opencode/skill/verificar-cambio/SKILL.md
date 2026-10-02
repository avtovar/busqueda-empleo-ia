---
name: verificar-cambio
description: Corrige y valida cambios en busqueda-empleo-ia ejecutando el ciclo de verificación seguro (npm run check por archivo, npm run build, /api/health). Usar SIEMPRE después de editar código, antes de dar por terminado cualquier trabajo, o cuando el usuario pida "verificá", "probá", "testeá", "comprobá que ande". Prohíbe explícitamente llamar a /api/linkedin-search porque se factura.
---

# Verificar un cambio en busqueda-empleo-ia

Este proyecto **no tiene linter, ni typecheck, ni framework de tests**. No los busques ni los
agregues. La única verificación es manual y son estos tres pasos, en este orden.

## El orden importa

```bash
npm run check    # 1. sintaxis de TODOS los .js, sin ejecutar nada
npm run build    # 2. que el JSX compila -> detecta imports rotos (el error más común)
# 3. que las funciones responden (ver abajo)
```

`npm run check` es `node --check` **por archivo**. No existe un chequeo global del proyecto:
por eso el script recorre `server/`, `api/` y `frontend/src/`. Si agregás un archivo fuera de
esas carpetas, agregalo al script, o queda sin verificar.

`npm run build` es **obligatorio** si tocaste `frontend/src`. Sin build estás verificando
código que no está en pantalla: el navegador sigue viendo el bundle viejo de `dist/`.

## Paso 3: los endpoints

```bash
curl -fsS localhost:3000/api/health
curl -fsS localhost:3000/api/me             # { user, profileComplete }: rutea el frontend
curl -fsS localhost:3000/api/jobs           # necesita sesión CON perfil
curl -fsS localhost:3000/api/directorio     # sin sesión, si quedó público
```

- **`/api/health` no toca la base de datos ni Apify.** Por eso es el smoke test: si falla,
  el deploy ni arrancó. **No le agregues un `SELECT 1`** — si la DB está caída, dejás de poder
  diferenciar "la función no arrancó" de "la DB no responde", que son dos caídas distintas.
- **El login y el CV son dos etapas separadas** (ver `MEMORIA.md` §4.1). Para probar
  `/api/jobs` no alcanza con tener cookie: hace falta también el perfil, o devuelve **403**.
  Un 403 ahí no es un bug de sesión, es el código correcto.
- `npm run dev` **no levanta el backend**: es solo Vite en el 5173. Para tocar `/api` usá
  `npx vercel dev`, o levantá el server a mano.
- El proxy de `/api` de Vite apunta a `localhost:3000`.

## NUNCA llamar a `/api/linkedin-search`

Esa función **ejecuta un actor de Apify y se factura por ejecución**. No es como las demás.

- No la llames para "probar que anda", ni en un test, ni en un smoke test, ni en CI.
  **Todos los demás endpoints son gratis y verifican lo mismo.**
- `jobSources.js` (Remotive, Arbeitnow, Himalayas, RemoteOK, Jobicy) es el camino gratis.
  Ese módulo **no menciona Apify en ningún lado**, y por eso se puede pegarle a `/api/jobs`
  sin riesgo de cobro. **No lo "conectes" a Apify.**
- `npm run check` y `npm run build` **no ejecutan código**: son seguros. `vercel dev` tampoco
  cobra nada por sí solo.

### La trampa que casi cuesta plata

En el proyecto origen se quiso probar que `/api/linkedin-search` da 503 sin token, y se puso
`APIFY_API_TOKEN=''` en el proceso **cliente**. No sirvió de nada: el servidor hacía
`import 'dotenv/config'`, o sea que **el token se leía del `.env` al arrancar el server**. La
petición salió con el token real y arrancó a facturar una ejecución.

**La única forma de probar el camino sin token es arrancar el proceso SIN la variable**, nunca
mandarla vacía desde otro proceso. En Vercel esto se resuelve solo (la función serverless es la
que tiene la variable), pero no lo reproduzcas con un test que "simule" la ausencia del token.

Nunca leas, imprimas ni commitees el valor de `APIFY_API_TOKEN`.

## Si tocaste la base de datos

`npm run check` y `npm run build` **no validan SQL**. Después de cambiar una migración:

- aplicá las migraciones contra una base de prueba y confirmá que corren.
- Verificá que **toda** query que toque datos de usuario lleva `WHERE user_id = $1`. Es el
  error más probable al migrar de un JSON global a SQL, y es una fuga entre usuarios.
- El repo nuevo **no tiene** el historial real de Ali: no hay `data/` que respaldar ni
  `HISTORY_DATA_DIR` que sobreescribir. Si algo escribe en disco, es un bug.

## Checklist antes de dar algo por terminado

- [ ] `npm run check` pasa
- [ ] `npm run build` pasa (si toqué `frontend/src`)
- [ ] `/api/health` responde sin DB y sin Apify
- [ ] Sin cookie, lo que necesita perfil da **401**
- [ ] Con cookie pero **sin perfil**, da **403** (no 401), y `/api/me` dice `profileComplete: false`
- [ ] Con cookie **y** perfil, lo que necesita perfil da 200 y devuelve datos del usuario correcto
- [ ] Ninguna query nueva quedó sin `WHERE user_id`
- [ ] No invoqué `/api/linkedin-search`
- [ ] Los comentarios `// ↑` en español siguen estando (convención del proyecto, no decoración)

Si un paso no se puede correr, **decí cuál y por qué** en vez de dar por verde. No prometas
resultados que no verificaste.