import { useEffect } from 'react';

// Paginación: componente separado para evitar problemas de parsing con esbuild
// al usar condicionales complejos en el nivel superior del JSX.
export default function Pagination({ safePage, visibleTotalPages, visibleJobs, setPage }) {
  // No se renderiza nada si no hay ofertas o solo hay una página.
  if (visibleJobs.length === 0 || visibleTotalPages <= 1) return null;

  return (
    <div className="pagination">
      <button
        className="btn small secondary"
        disabled={safePage <= 1}
        onClick={() => setPage(safePage - 1)}
      >
        ← Anterior
      </button>
      {/* ↑ disabled en la primer página: el botón no hace nada y se ve apagado. */}
      <span className="pagination-info">
        Página {safePage} de {visibleTotalPages} · {visibleJobs.length} ofertas
      </span>
      {/* ↑ setPage cambia el estado y React re-renderiza con la página nueva. */}
      <button
        className="btn small secondary"
        disabled={safePage >= visibleTotalPages}
        onClick={() => setPage(safePage + 1)}
      >
        Siguiente →
      </button>
    </div>
  );
}