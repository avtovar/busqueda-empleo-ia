# ADR 004: Perfil por Usuario (No Global)

## Estado
Aceptada (2026-10-02)

## Contexto
El proyecto original tenía un `const PROFILE` global en `cvProfile.js` con datos de una sola persona (Ali Tovar, QA). Todos los módulos lo importaban. Para multiusuario y cualquier profesión, esto hay que romperlo.

## Decisión
- **El perfil es un parámetro, no un import**. `computeMatch(job, profile)`, `rankByRegion(jobs, profile)`, `generateCoverLetter(job, region, profile)`, `buildAnalytics(profile, jobs)` — todos reciben el perfil como argumento obligatorio (sin default).
- **Fuente de verdad**: Tabla `profiles` + tabla `skills` (una fila por skill con `weight` numeric).
- **Normalización**: `lib/profile.js` expone `loadProfile(userId)` → `normalizeProfile(row, skillRows)` → objeto del contrato API (`skills: [{name, weight}]` array, pesos numéricos).
- **Forma canónica**: `skills` es **array** `[{name, weight}]` (pesos numéricos 0-1), no mapa `{qa: 1}`. El LLM devuelve array; la BD guarda filas; `profile.js:normalizeSkills()` convierte mapa → array si llega forma vieja.
- **Lugares donde estaba hardcodeado (ya resueltos)**:
  - `matcher.js:56` → `computeMatch(job, profile)` (ya parametrizado)
  - `analytics.js` → `candidateSkills(profile)`, `githubSkillEvidence(profile)`
  - `apifyLinkedin.js` → `buildProfileKeywords(profile)` (regex QA eliminado)
  - `coverLetter.js` → `generateCoverLetter(job, region, profile)`
  - `frontend/src/api.js` → `FALLBACK.profile` eliminado
  - `lib/profile.js` → nuevo, reemplaza a `cvProfile.js`

## Consecuencias
- ✅ Mismo código rankea para contador, enfermera, QA, etc.
- ✅ Perfil editable por usuario (PUT `/api/profile` es reemplazo total).
- ✅ Skills con peso numérico (0-1) en array — forma canónica en ambos lados.
- ⚠️ Forma vieja (mapa `{qa: 1}`) se degrada silenciosamente a array vacío si llega al frontend → vigilar en `profile.js:normalizeSkills()`.
- ⚠️ `marketSkills` y `projects` se arrastran en el editor (no se editan) para no perderlos al guardar (PUT es reemplazo total).

## Alternativas consideradas
- **Perfil global con namespace por usuario**: Rechazado (falla en serverless, fuga de datos).
- **Default en `computeMatch(job, profile = defaultProfile)`**: Rechazado (oculta bug de perfil faltante).