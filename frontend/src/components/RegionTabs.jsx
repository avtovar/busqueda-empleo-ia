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
          Cada una vive en su propio espacio (pestaña separada). */}
      <div className="region-tabs-secondary">
        <button
          className={`region-tab analisis-tab${current === 'analisis' ? ' active' : ''}`}
          onClick={() => onSelect('analisis')}
        >
          📊 Propuesta de Interés
        </button>
      </div>
    </div>
  );
}