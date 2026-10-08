# ADR 007: Borrado en Cascada + Auditoría sin FK

## Estado
Aceptada (2026-10-03)

## Contexto
El usuario debe poder borrar su cuenta y TODOS sus datos. 7 tablas dependen de `users`.

## Decisión
- **`DELETE FROM users WHERE id = $1`** — una sola sentencia.
- **7 FKs con `ON DELETE CASCADE`** (en `profiles` la FK además es PK):
  - `profiles.user_id` → `users.id` (PK + FK)
  - `skills.user_id`
  - `searches.user_id`
  - `job_history.user_id`
  - `favorites.user_id`
  - `apify_usage.user_id`
  - `cv_parses.user_id`
  - `login_attempts.email` (no FK, se limpia en login exitoso)
  - `cv_parses.user_id` → ya cubierto
- **Auditoría en `account_deletions` (migración 012)**:
  - Tabla **SIN FK a `users`** (si tuviera FK, la cascada la borraría).
  - Se inserta **ANTES** del `DELETE` en la **misma transacción**.
  - Guarda: `user_id`, `email`, `ip`, `user_agent`, `deleted_at`.
  - UI avisa que quedan (en `DeleteAccountModal`): una reserva de privacidad que omite IP es falsa.
- **Endpoint**: `DELETE /api/account` usa `requireSession` (NO `requireProfile`) — una cuenta sin CV se puede borrar.

## Consecuencias
- ✅ Un solo `DELETE` borra todo (atómico, transaccional).
- ✅ Auditoría sobrevive a la cascada (sin FK → no se borra).
- ✅ Cuenta sin CV se puede borrar (`requireSession` no `requireProfile`).
- ⚠️ `account_deletions` sin FK = no hay integridad referencial automática (aceptable: es solo auditoría).
- ⚠️ `account_deletions` guarda IP y User-Agent → UI lo avisa (privacidad honesta).
- ⚠️ Si la transacción falla en la auditoría → rollback → cuenta NO se borra (correcto).

## Alternativas consideradas
- **N `DELETE` explícitos sin cascada**: Rechazado (frágil, fácil olvidar una tabla).
- **FK en `account_deletions`**: Rechazado (la cascada borraría la auditoría).
- **Soft delete (`deleted_at`)**: Rechazado (complejidad en queries, GDPR pide borrado real).