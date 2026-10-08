// Pestañas de región: se generan de la configuración de regiones del backend, así
// que la lista de países de la UI es exactamente la que el backend soporta.
// Importante: NO incluye "analisis" porque no es un país: es una sección especial
// que se agrega como botón aparte, más abajo.
import { REGIONS, regionLabel } from '../../../lib/regions.js';
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
      {/* Fila 1: los países. Cada uno tiene su bandera y su clave de región.
          ARIA tablist pattern para accesibilidad (WCAG 1.3.1, 2.4.3). */}
      <div role="tablist" className="region-tabs" aria-label="Regiones">
        {TABS.map((t) => (
          // ↑ .map() convierte el arreglo TABS en una lista de pestañas.
          <button
            key={t.region}
            role="tab"
            aria-selected={current === t.region}
            aria-controls={`panel-${t.region}`}
            id={`tab-${t.region}`}
            className={`region-tab${current === t.region ? ' active' : ''}`}
            onClick={() => onSelect(t.region)}
          >
            {t.label}
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
      <div role="tablist" className="region-tabs-secondary" aria-label="Secciones">
        <button
          role="tab"
          aria-selected={current === 'analisis'}
          aria-controls="panel-analisis"
          id="tab-analisis"
          className={`region-tab analisis-tab${current === 'analisis' ? ' active' : ''}`}
          onClick={() => onSelect('analisis')}
        >
          📊 Propuesta de Interés
        </button>
        <button
          role="tab"
          aria-selected={current === 'directorio'}
          aria-controls="panel-directorio"
          id="tab-directorio"
          className={`region-tab directorio-tab${current === 'directorio' ? ' active' : ''}`}
          onClick={() => onSelect('directorio')}
        >
          🔗 Directorio de empleo
        </button>
      </div>
    </div>
  );
}