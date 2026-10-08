# ADR 008: Build con Rspack/SWC (No esbuild)

## Estado
Aceptada (2026-10-08)

## Contexto
El build original usaba Vite + esbuild. esbuild tiene bugs conocidos en su parser JSX con:
- Condicionales complejos en nivel superior (`&&`, `||`, `? :`).
- Fragmentos `<>...</>`.
- Comentarios JSX `{/* ... */}`.
- Ternarios en nivel superior.
- Componentes tras condicionales.

Estos bugs causaban errores de parsing falsos ("Unexpected token", "Unterminated regexp", "Expected ')'") en código válido.

## Decisión
- **Migrar de Vite + esbuild a Rspack + SWC**.
- **Rspack**: Bundler compatible con ecosistema Webpack, escrito en Rust, usa SWC nativamente.
- **SWC**: Compilador Rust que parsea JSX/TS correctamente (sin los bugs de esbuild).
- **Configuración**: `rspack.config.js` con `builtin:swc-loader` + `@rspack/plugin-react-refresh`.
- **Plugins**: `ReactRefreshPlugin` solo en dev (`isDev ? new ReactRefreshRspackPlugin() : null`).
- **Configuración SWC**: `jsc.parser.syntax: "ecmascript", jsx: true`, `jsc.transform.react.runtime: "automatic", development: isDev, refresh: isDev`.

## Consecuencias
- ✅ Build funciona sin errores de parsing falsos.
- ✅ SWC parsea JSX complejo correctamente (condicionales, fragmentos, ternarios, comentarios).
- ✅ Fast Refresh en dev (equivalente a Vite HMR).
- ✅ Build de producción optimizado (tree-shaking, minificación, code splitting).
- ✅ Configuración similar a Vite (entry, output, resolve, devServer, proxy).
- ⚠️ Configuración más verbosa que Vite (Rspack usa configuración estilo Webpack).
- ⚠️ `style-loader` + `css-loader` necesarios (Rspack no incluye CSS por defecto).
- ⚠️ `@rspack/plugin-react-refresh` exporta `ReactRefreshRspackPlugin` (no `ReactRefreshPlugin`).

## Comandos actualizados
```json
{
  "build": "rspack build --config rspack.config.js",
  "dev": "rspack dev --config rspack.config.js"
}
```

## Alternativas consideradas
- **Vite + @vitejs/plugin-react-swc**: Rechazado (Vite usa esbuild para transformaciones internas, no solo plugins).
- **Rollup + @rollup/plugin-swc**: Rechazado (más configuración manual, menos features built-in).
- **Webpack 5 + swc-loader**: Rechazado (más lento, config más compleja).
- **Mantener esbuild + workarounds**: Rechazado (workarounds frágiles, código feo, mantenimiento permanente).