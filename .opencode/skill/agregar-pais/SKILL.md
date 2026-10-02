---
name: agregar-pais
description: Agrega un país (además de Argentina) a la configuración única de regiones de busqueda-empleo-ia, incluyendo su URL de búsqueda en LinkedIn. Usar cuando el usuario pida "agregar México", "soportar Chile", "expandir a otro país", "cuántos países más", o cuando haya que cambiar o corregir los datos de una región existente.
---

# Agregar un país a la configuración de regiones

El alcance inicial de este proyecto es **solo Argentina**. La razón por la que existe esta
skill es que el punto 9 del pedido pide explícitamente dejar las regiones en **una sola
configuración**, para que agregar un país sea agregar una entrada y no editar cinco archivos.

En el proyecto origen las 7 regiones estaban repetidas en 5 lugares distintos, y agregar un
país obligaba a tocar todos. **Ese error no hay que repetirlo acá.**

## La regla

**Todo pasa por `api/lib/regions.js`** (el archivo de configuración único de regiones).
No hardcodear nombres de países, ni listas de ciudades, ni URLs de búsqueda en ningún otro
archivo. Si te ves escribiendo el nombre de un país literal en otro lado, es que falta algo en
la config.

Cada región declara:

```js
argentina: {
  label: 'Argentina',        // nombre visible en la UI
  lang: 'es',                // idioma de las cartas de presentación de esa región
  countries: ['Argentina', 'Buenos Aires', 'CABA', 'Córdoba'],
  linkedinLocation: 'Argentina',  // lo que se pasa a la búsqueda de LinkedIn
  portals: { ... },          // bolsas y consultoras del país (ver skill agregar-directorio)
}
```

## Los 5 consumidores, y por qué todos leen de la config

Para cambiar o agregar una región, **tocá solo `regions.js`**. Estos son los consumidores,
y ninguno debe volver a hardcodear nada:

| Consumidor | Qué saca de la config |
|---|---|
| `api/lib/matcher.js` | `countries` para detectar en qué región cae una oferta |
| `api/lib/apifyLinkedin.js` | `linkedinLocation` para armar la query de búsqueda |
| `api/lib/coverLetter.js` | `lang` para decidir carta ES/EN |
| `api/analytics.js` | `label` para los contadores por región |
| `frontend/src/utils.js` | `label` para las pestañas y el `REGION_LOCATION` de la UI |

Si tocás uno de esos archivos a mano para agregar un país, la próxima región va a volver a
exigir el mismo cambio. Ese es el bug.

## Detectar la región de una oferta

`matcher.assignRegion()` en el origen era una cadena de 7 `if`, uno por país, comparando
`location` + `regionGuess`. Eso no escala y es lo que hay que reemplazar.

Ahora la detección recorre la config: para cada región, si el texto de la oferta matchea
algún elemento de su `countries`, es de esa región. Al agregar un país, la detección lo
agarra **automáticamente** porque lee la misma tabla.

Ojo con la prioridad que ya existe en el origen y hay que conservar: **`regionGuess` (la
región que se buscó) tiene prioridad sobre la detección por texto de `location`**. Se puso
así porque una oferta buscada para Argentina con `location: "Berlin"` caía en el bucket de
Europa y se perdía. No lo reviertas sin pensarlo.

## Checklist

- [ ] La región nueva está en `api/lib/regions.js`, con los 5 campos
- [ ] `countries` incluye las variantes que la gente escribe de verdad (con y sin acento,
      abreviaturas como "CABA", nombres de las provincias o estados principales)
- [ ] `linkedinLocation` es **el texto que LinkedIn espera**, no el nombre del país en
      español. Verificá contra una búsqueda real de LinkedIn.
- [ ] `lang` es correcto: define el idioma de la carta, no el de la búsqueda
- [ ] Las bolsas del país están en su `portals`, con **cada URL verificada** (ver la skill
      `agregar-directorio`)
- [ ] `npm run check` y `npm run build` pasan
- [ ] Una búsqueda de prueba trae ofertas de la región nueva y `assignRegion` las clasifica
      bien

## Trampa

`jobSources.js` (Remotive, Arbeitnow, Himalayas, RemoteOK, Jobicy) son APIs de empleo
**globales y gratuitas**: devuelven ofertas de cualquier país y ahí la región se decide por
el texto de `location`. No necesitás una fuente nueva para cada país. Agregar un país es
configuración, no integración.

Y no toques `/api/linkedin-search` para probar la región nueva: **se factura por ejecución**.
Verificá con `/api/jobs`, que es gratis.