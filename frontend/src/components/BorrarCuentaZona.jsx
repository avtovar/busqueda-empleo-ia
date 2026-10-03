// ============================================================================
// BorrarCuentaZona — EL TRIGGER de "borrar la cuenta"
// ---------------------------------------------------------------------------
// Es un componente entero para CINCO líneas de JSX, y esa es la decisión: el
// markup del aviso está en DOS lugares (el panel del CV y la compuerta del
// alta), y si estuviera escrito dos veces las dos copias empezarían a divergir
// sin que nada falle — la típica divergencia silenciosa entre "la puerta de
// entrada" y "el panel de la cuenta".
//
// LA ZONA DE PELIGRO EXISTE POR DOS RAZONES CONCRETAS:
//
//   1. NO está junto al botón "Salir" del header. "Salir" es una acción que la
//      gente hace seguido y por eso vive arriba, a la vista, junto al toggle de
//      tema. Borrar la cuenta es lo contrario de ambas cosas: es rara, es
//      irreversible y equivocarse duele. Lo que se busca es que la ruta hacia
//      ella sea un poco más larga que la de cerrar sesión.
//
//   2. El texto NO promete nada que no se cumpla, y por eso menciona lo que
//      queda: una fila de auditoría con el correo, la fecha y los datos técnicos
//      de la petición (IP y User-Agent), que sí se guardan —
//      `migrations/012_account_deletions.sql`. Decir "se borra todo" y dejar un
//      registro con la IP sería una mentira chica que alguien descubre después.
//
// Un link y no un botón de acción a propósito: no compite con "Editar perfil"
// (que sí es lo que se hace seguido) y no usa el degradado acento de `.btn`, que
// en esta app significa "esto es lo principal de la pantalla".
// ============================================================================

export default function BorrarCuentaZona({ onDeleteAccount }) {
  // ↑ `onDeleteAccount` es obligatorio y no opcional: un link que no hace nada es
  //   peor que ningún link. Si el padre no lo pasa, es que no tiene sesión y en
  //   ese caso el componente no se dibuja (no hay nada que borrar).

  return (
    <div className="cuenta-zona">
      <p className="cv-help">
        Tu perfil viene de tu CV. Si querés que no quede nada tuyo en la base,
        podés borrar la cuenta entera.
      </p>
      <button type="button" className="btn-link-peligro" onClick={onDeleteAccount}>
        Borrar mi cuenta
      </button>
      {/* ↑ Un `<button>` y no un `window.confirm()`: la confirmación con la frase
          escrita la hace `DeleteAccountModal`, y un modal necesita algo que lo
          abra. El `type="button"` explícito porque esta app vive dentro de
          etiquetas que por defecto son `submit`. */}
    </div>
  );
}