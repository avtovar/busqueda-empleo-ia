import { useState } from 'react';
// ↑ useState para el feedback visual "✓ Copiada" del botón de copiar.

// Modal que muestra la carta de presentación generada por el backend.
// Recibe por props `letter` (la carta con subject y body) y `onClose` (cerrar).
export default function LetterModal({ letter, onClose }) {
  // ↑ Desestructuración de props en la firma, como siempre en los componentes.

  const [copied, setCopied] = useState(false);
  // ↑ True por 1.5 segundos cuando se copia la carta (cambia el texto del botón).

  if (!letter) return null;
  // ↑ Guardia: sin carta no hay modal que mostrar.

  // Copia subject + cuerpo al portapapeles con la API moderna de clipboard.
  function copy() {
    navigator.clipboard.writeText(letter.subject + '\n\n' + letter.body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      // ↑ Después de 1.5s vuelve el texto original del botón.
    });
  }

  // Generamos un link "data:" que codifica la carta como texto plano: el navegador
  // lo interpreta como un archivo .txt descargable, sin servidor de por medio.
  const href = `data:text/plain;charset=utf-8,${encodeURIComponent(letter.subject + '\n\n' + letter.body)}`;
  // ↑ encodeURIComponent convierte la carta a una URL segura (espacios, tildes, etc.).

  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      {/* ↑ Click en el fondo oscuro (target = currentTarget) cierra el modal. */}
      <div className="modal-content letter">
        {/* ↑ Clase `letter` extra: el CSS le da más ancho a este modal. */}
        <button className="modal-close" onClick={onClose} aria-label="Cerrar">&times;</button>
        <h3>{letter.subject}</h3>
        <div className="letter-body">{letter.body}</div>
        {/* ↑ El body se muestra tal cual, respetando saltos de línea por white-space. */}
        <div className="letter-actions">
          <button className="btn" onClick={copy}>{copied ? '✓ Copiada' : 'Copiar carta'}</button>
          {/* ↑ Ternario: cambia el texto cuando la carta ya se copió. */}
          <a className="btn secondary" download="carta_presentacion.txt" href={href}>Descargar .txt</a>
          {/* ↑ El atributo download le dice al navegador que descargue en vez de abrir. */}
        </div>
      </div>
    </div>
  );
}