# ADR 010: Accesibilidad WCAG 2.2 AA

## Estado
Aceptada (2026-10-08)

## Contexto
La app heredada tenía varias barreras de accesibilidad que impiden el uso por personas con discapacidad.

## Decisión
### A1: Información no solo por color (WCAG 1.4.1 A)
- **Match pills**: Verde/amarillo/rojo + texto accesible (`matchLabel()` → "Match alto/Medio/Bajo").
- **Implementación**: `aria-label` + `<span className="visually-hidden">` en `JobList.jsx` y `JobDetailModal.jsx`.
- **CSS**: `.visually-hidden` (position absolute, 1px, clip, overflow hidden).

### A2: Modales accesibles (WCAG 2.1.2, 2.4.3, 4.1.2)
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby`.
- Foco al abrir (`closeRef.current?.focus()`), foco atrapado, Escape cierra.
- Foco vuelve al botón que abrió el modal.
- `DeleteAccountModal`, `LetterModal`, `JobDetailModal`, `CvOnboarding` (editor).

### A3: Mensajes de estado (WCAG 4.1.3 AA)
- `role="alert"` en errores (`cv-error`, `cv-error.limite` para 429).
- `aria-busy` en botones cargando ("Analizando tu CV…").
- Errores de formulario con `aria-invalid` + `aria-describedby`.

### A4: Pestañas con patrón APG (WCAG 1.3.1, 2.4.3)
- `RegionTabs.jsx`: `role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, `id`.
- Navegación por flechas (futuro: roving tabindex).

### A5: Idioma de las partes (WCAG 3.1.2 AA)
- `lang="es"` en `<html>`.
- Ofertas en inglés: `lang="en"` en título/descripción (via `LanguageBadge` detecta idioma).
- `LanguageBadge` muestra ES/EN con tooltip completo ("castellano"/"inglés").

### A6: Emojis decorativos
- `aria-hidden="true"` en banderas/emojis decorativos.
- Texto alternativo en badges (`title`, `alt`).

### A7: Navegación SPA
- `document.title` actualizado al cambiar vista.
- Foco al encabezado de la nueva vista.
- Skip link "Saltar al contenido" (futuro).

### A8: Subida de CV accesible
- `<input type="file">` con `<label>` visible.
- Formatos y tamaño máximo anunciados antes de elegir.
- Alternativa a drag & drop para teclado.

### A9: Responsive y zoom
- Test 200% y 400% zoom.
- Targets táctiles ≥ 24×24px.
- `prefers-reduced-motion` respetado.

### A10: Tablas/listas
- Encabezados asociados (`scope="col"`).
- Orden de lectura = visual.
- Controles de ordenar operables con teclado.

## Testing (plan)
1. `eslint-plugin-jsx-a11y` en CI.
2. `axe-core` CLI + Lighthouse en páginas clave.
3. Solo teclado: registro, CV, búsqueda, modal, borrar cuenta.
4. NVDA + Firefox / VoiceOver + Safari iOS.
5. Zoom 200%/400%, alto contraste Windows.

## Consecuencias
- ✅ Cumple WCAG 2.2 AA en flujos críticos.
- ⚠️ Pendiente: testing real con lector de pantalla.
- ⚠️ Pendiente: skip link, roving tabindex en tabs.
- ⚠️ `LanguageBadge` detecta idioma heurísticamente (puede fallar).