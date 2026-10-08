# ADR 003: Auth con Cookie HMAC + Dos Compuertas (401/403)

## Estado
Aceptada (2026-09-30)

## Contexto
El proyecto original no tenía autenticación. Para multiusuario se necesita registro, login, sesión y logout seguros.

## Decisión
- **Hash**: `bcryptjs` (JS puro, sin módulos nativos — evita fallos en runtime de Vercel).
- **Sesión**: Cookie firmada con HMAC-SHA256 (`v1.<user_id>.<exp>.<signature>`).
- **Cookie**: `HttpOnly; Secure; SameSite=Lax; Max-Age=604800` (7 días). `Secure` se omite solo en `localhost` HTTP.
- **Dos compuertas**:
  - **401** (sin cookie válida) → redirige a `/login`.
  - **403** (cookie válida pero sin perfil) → redirige a onboarding CV.
  - **200** (cookie + perfil) → acceso a la app.
- **`GET /api/me`**: Siempre 200, devuelve `{ user, profileComplete }` — es quien decide a dónde va el usuario.
- **Logout**: Cookie con `Max-Age=0` (no borra nada en servidor).
- **Borrado cuenta**: `DELETE /api/account` usa `requireSession` (no `requireProfile`) — una cuenta sin CV se puede borrar.
- **Rate limit login**: Tabla `login_attempts` con dos capas:
  - Por pareja (email + IP): 10 intentos / 15 min.
  - Por IP: 30 intentos / 15 min.
  - Timing pareado (bcrypt dummy) para no revelar si el email existe.
  - Login exitoso borra intentos de ese email.

## Consecuencias
- ✅ Sin token en localStorage (seguro contra XSS).
- ✅ Cookie HttpOnly evita robo por JS.
- ✅ 401 vs 403 evita bucle de login (403 = "sé quién sos, te falta CV").
- ✅ Rate limit en BD sobrevive a cold starts.
- ⚠️ `SESSION_SECRET` mínimo 32 chars (generar con `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
- ⚠️ Rotar `SESSION_SECRET` invalida todas las sesiones (avisar a usuarios reales).
- ⚠️ No hay `session_version` en BD: la revocación real es la fila de `users` (cookie de usuario borrado → 401).

## Alternativas consideradas
- **JWT en localStorage**: Rechazado (vulnerable a XSS).
- **Sesiones en Redis**: Rechazado (costo + complejidad, BD ya existe).
- **Argon2**: Queda como mejora futura (`@node-rs/argon2`).