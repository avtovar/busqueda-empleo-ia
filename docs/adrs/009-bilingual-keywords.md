# ADR 009: Keywords Bilingües + Sinónimos ES/EN

## Estado
Aceptada (2026-10-08)

## Contexto
Las 5 bolsas gratuitas son globales y mayormente en inglés. Perfiles en español (ej. "enfermería") no matchean ofertas en inglés ("nursing"). Resultado: 0 ofertas para Enfermera, 13 para Chef, 118 para QA.

## Decisión
### 1. LLM genera keywords en ES + EN
- Prompt del CV pide **dos arrays**: `keywords` (ES) + `keywords_en` (EN).
- Máximo 12 cada uno.
- Si la profesión es mayormente en inglés (IT, ciencia), priorizar EN; si local (salud, gastronomía), priorizar ES.

### 2. Tabla de sinónimos ES/EN (`SYNONYMS_ES_EN` en `searchTerms.js`)
- 50+ entradas para profesiones comunes: salud, gastronomía, contabilidad, IT, ventas, logística, educación, legal, construcción, diseño, etc.
- Formato: `{ es: ['término_es', ...], en: ['término_en', ...] }`.
- Función `expandTermsWithSynonyms(terms)` agrega sinónimos del otro idioma antes de mandar a bolsas.

### 3. Integración en `searchTerms()`
- `searchTerms(profile)` ya devuelve términos priorizados (title → keywords → skills pesadas).
- `expandTermsWithSynonyms()` se aplica ANTES de mandar a bolsas.
- Deduplicación case-insensitive.

## Consecuencias
- ✅ "enfermería" → también busca "nursing", "rn", "registered nurse".
- ✅ "contador" → también busca "accountant", "cpa", "bookkeeper".
- ✅ "chef" → también busca "cook", "executive chef", "sous chef".
- ✅ Sin cambios en bolsas ni frontend (cambio interno en `searchTerms.js`).
- ✅ Deduplicación evita queries repetidas.
- ⚠️ Mantenimiento manual de `SYNONYMS_ES_EN` (agregar profesiones nuevas).
- ⚠️ LLM a veces devuelve keywords redundantes → deduplicación en `normalizeKeywords()`.

## Alternativas consideradas
- **Solo keywords EN del LLM**: Rechazado (pierde cobertura para profesiones locales en español).
- **Traducir keywords en runtime**: Rechazado (costo + latencia + errores de traducción).
- **Diccionario automático**: Rechazado (complejidad, mejor curado manual para profesiones clave).