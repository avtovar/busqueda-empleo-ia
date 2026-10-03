// Pestañas de región: se generan de la configuración de regiones del backend, así
// que la lista de países de la UI es exactamente la que el backend soporta.
// Importante: NO incluye "analisis" porque no es un país: es una sección especial
// que se agrega como botón aparte, más abajo.
import { REGIONS, regionLabel } from '../../../api/lib/regions.js';
// ↑ La MISMA configuración que usa el matcher para decidir en qué región cae una
//   oferta. Antes eran 7 países escritos a mano acá; agregar un país obligaba a
//   editar esta lista, la de `utils.js`, la de `App.jsx` y las del backend (los 5
//   lugares repetidos de los que habla AGENTS.md). Ahora es UNA entrada en
//   `api/lib/regions.js` y las cuatro se enteran solas.
//   OJO al path: este archivo está en `frontend/src/components/`, un nivel más
//   abajo que `src/`, así que necesita tres `..` para llegar a la raíz del repo.
import { regionFlag } from '../utils.js';

const TABS = Object.keys(REGIONS).map((key) => ({
  region: key,
  label: `${regionFlag(key)} ${regionLabel(key)}`,
  // ↑ El nombre sale de la config compartida; la bandera es la única parte
  //   presentacional que vive en el frontend, con un globo como respaldo.
}));

// Las pestañas que NO son países: son SECCIONES de la app (una pantalla propia que
// se abre en la misma columna de las ofertas). Viven aparte de `REGIONS` porque
// `REGIONS` es la lista de países que el backend rankea, y "Propuesta de Interés" o
// "Directorio" no son lugares: si entraran ahí, `matcher` trataría de asignar
// ofertas a una región que no existe.
//
// ESTE ES EL ÚNICO LUGAR QUE DECLARA CUÁLES SON, y `App.jsx` y `Toolbar.jsx` lo
// importan en vez de repetir la comparación con `region === 'analisis' || …`:
// esa lista repetida es exactamente el modo de falla de este archivo. Con una
// tercera sección olvidada en Toolbar, el botón "Actualizar búsqueda" aparecería en
// una vista que no tiene ofertas y llamaría a un endpoint que no le corresponde —
// un botón que existe y no hace nada (o peor, borra la caché de otro).
export const SECCIONES = ['analisis', 'directorio'];

// ¿La pestaña activa es una sección (no una región con ofertas)?
export function esSeccion(region) {
  return SECCIONES.includes(region);
  // ↑ El nombre NO dice cuál: la pregunta que hacen los tres consumidores es siempre
  //   la misma ("¿esto es una lista de ofertas?"), y las tres respuestas distintas
  //   que hay se manejan con un `switch` en cada uno, no con tres booleanos.
}

// Componente "tontito" (sin estado): solo recibe la región actual y la función
// que avisa al padre cuando el usuario elige otra región.
export default function RegionTabs({ current, onSelect }) {
  // ↑ Props desestructurados: current = región activa, onSelect = callback que se
  //   dispara al hacer click. Los datos "bajan" del padre, los eventos "suben".

  return (
    <div>
      {/* Fila 1: los países. Cada uno tiene su bandera y su clave de región. */}
      <div className="region-tabs">
        {TABS.map((t) => (
          // ↑ .map() convierte el arreglo TABS en una lista de botones.
          <button
            key={t.region}
            // ↑ key única para que React sepa diferenciar cada botón de la lista.
            className={`region-tab${current === t.region ? ' active' : ''}`}
            // ↑ Template literal: si esta región es la actual, le agrega la clase
            //   'active' (que la pinta con el degradado) vía CSS.
            onClick={() => onSelect(t.region)}
            // ↑ onClick llama a la función del padre pasándole la región elegida.
          >
            {t.label}
            {/* ↑ Muestra la etiqueta (bandera + nombre) guardada en TABS. */}
          </button>
        ))}
      </div>

      {/* Fila 2 (debajo de los países): secciones especiales, escritas a mano.
          Cada una vive en su propio espacio (pestaña separada).
          Van acá y NO en la fila de arriba porque esa fila se GENERA de `REGIONS`
          (son los países que el backend rankea) y estas dos no son países: agregarlas
          a la lista de arriba las haría desaparecer en el próximo cambio de
          `regions.js`, que es el mecanismo que hace que la fila de arriba no pueda
          quedar vieja sola. */}
      <div className="region-tabs-secondary">
        <button
          className={`region-tab analisis-tab${current === 'analisis' ? ' active' : ''}`}
          onClick={() => onSelect('analisis')}
        >
          📊 Propuesta de Interés
        </button>
        <button
          className={`region-tab directorio-tab${current === 'directorio' ? ' active' : ''}`}
          onClick={() => onSelect('directorio')}
        >
          🔗 Directorio de empleo
        </button>
        {/* ↑ Mismo patrón exacto que el de arriba, con su propio modificador de
            clase (`.directorio-tab`) aunque hoy NO tenga regla de CSS: el
            modificador es el lugar donde colgaría un ajuste visual de esta pestaña
            cuando haga falta, y hoy no hace falta ninguno porque hereda todo de
            `.region-tab`. La que sí lo tenía era `.consultoras-tab`, y se borró con
            el tracker de outreach en el paso 3. */}
      </div>
    </div>
  );
}