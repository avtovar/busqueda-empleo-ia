# ADR 006: Rate Limits en Base de Datos

## Estado
Aceptada (2026-10-02)

## Contexto
Tres servicios pagos/riesgosos necesitan rate limit por usuario, y en serverless no hay memoria compartida:
1. **Login** — evitar fuerza bruta.
2. **CV Parse (LLM)** — evitar vaciar clave `LLM_API_KEY`.
3. **Apify (LinkedIn)** — cada búsqueda cobra plata (`APIFY_API_TOKEN`).

## Decisión
**Tres tablas separadas, una por servicio** (no reutilizar `rateLimit.js`):

| Servicio | Tabla | Límite | Ventana | Purga |
|---|---|---|---|---|
| Login | `login_attempts` | 10 por (email+IP) / 30 por IP | 15 min | 24h (oportunista en intento fallido) |
| CV Parse | `cv_parses` | 5 por usuario | 60 min | 24h (oportunista en parseo concedido) |
| Apify | `apify_usage` | 3 por usuario/día (UTC) | 1 día | 60 días (oportunista en búsqueda concedida) |
| Global | `global_usage` | 100 CV / 10 Apify / 50 signups por día | 1 día | 60 días |

**Patrón común (advisory lock + transacción)**:
```js
await withTransaction(async (client) => {
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
  // 1. Leer contador actual
  // 2. Verificar límite
  // 3. Si ok: INSERT/UPDATE contador
  // 4. Throw 429 DENTRO de la transacción (rollback = no cuenta)
});
// Purga oportunista AFUERA de la transacción
```

**Reglas clave**:
- **429 NO cuenta**: El `throw` dentro de la transacción hace rollback → contador no incrementa.
- **`Retry-After`** en header Y body (RFC 6585).
- **Login**: Cuenta intentos fallidos TAMBIÉN para emails inexistentes (si no, atacante prueba emails inventados sin límite).
- **CV Parse**: Límite se chequea ANTES de llamar al LLM (chequeos de archivo gratis no consumen cuota).
- **Global limits**: Tabla `global_usage` (día UTC + 3 contadores) protege el bolsillo aunque haya miles de cuentas falsas.

## Consecuencias
- ✅ Rate limits persisten entre invocaciones y usuarios concurrentes.
- ✅ Advisory lock por usuario serializa sin bloquear a otros usuarios.
- ✅ 429 no consume cuota (rollback en transacción).
- ✅ Tope global (`global_usage`) protege el bolsillo aunque haya cuentas falsas.
- ⚠️ Configuración por variables de entorno (`LOGIN_LIMIT_*`, `CV_PARSE_LIMIT*`, `APIFY_DAILY_LIMIT`, `GLOBAL_DAILY_*`).
- ⚠️ Tests usan `*_LIMIT=0` para desactivar límites.

## Alternativas consideradas
- **Un solo módulo `rateLimit.js` para todo**: Rechazado (semántica distinta: login=fallas, CV=éxitos pagados, Apify=ejecuciones pagadas, global=suma).
- **Rate limit en memoria**: Rechazado (no funciona en serverless).
- **Rate limit por IP solo**: Rechazado (fácil de evadir con VPN/proxy).