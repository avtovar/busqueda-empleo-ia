// Componente de presentación: muestra el perfil del usuario en el panel lateral.
// Recibe el perfil por props (lo manda App) y lo "pinta" sin guardar estado propio.

import BorrarCuentaZona from './BorrarCuentaZona.jsx';
// ↑ La zona de peligro del paso 11. Se importa (y no se escribe el markup acá)
//   porque el mismo aviso aparece también en la compuerta del alta: son las dos
//   pantallas donde un usuario con sesión puede estar, y las dos necesitan poder
//   borrar la cuenta.

export default function CvPanel({ profile, onEdit, onDeleteAccount }) {
  // ↑ Desestructuración de props: sacamos `profile` directamente en la firma,
  //   como si fuera un parámetro normal de la función.
  //   `onEdit` y `onDeleteAccount` son OPCIONALES a propósito: el panel no depende
  //   del formulario ni del modal, solo avisa que los hay. Así los botones aparecen
  //   si y solo si el padre sabe abrirlos, y este componente no importaría ni el
  //   formulario ni la confirmación para dos funciones que no usa.

  if (!profile) return null;
  // ↑ Guardia temprana: si el perfil todavía no cargó (null), no renderizamos nada.
  //   Es un "render condicional" simple para no explotar accediendo a null.
  //   Con la compuerta del alta, además, este caso es el normal: con sesión y sin
  //   CV el panel lateral no llega a renderizarse nunca.

  const skills = Array.isArray(profile.skills) ? profile.skills : [];
  // ↑ `skills` es un ARRAY de { name, weight }, no el mapa { 'qa': 1 } del origen
  //   (decisión 1 de MEMORIA.md §4: es la forma del LLM, la de la tabla `skills` y
  //   la que la API ya exponía). El Array.isArray no es desconfianza gratuitita:
  //   una respuesta con la forma vieja no rompe el panel, se muestra sin tags.

  const initials = (profile.fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
  // ↑ Iniciales sacadas del nombre del PROPIO usuario. Antes eran "AT" fijas: a
  //   todo el que abría la app le mostrábamos el nombre de otra persona.

  return (
    <aside className="cv-panel panel">
      {/* ↑ <aside> es el contenedor semántico del panel lateral. Lleva las clases
          cv-panel (para el layout) y panel (para el estilo común). */}

      <div className="cv-header">
        <div className="avatar">{initials}</div>
        {/* ↑ Avatar con las iniciales del usuario (el círculo lo dibuja el CSS). */}
        <div>
          <h2 id="cv-name">{profile.fullName}</h2>
          <p className="cv-role">{profile.headline || profile.title}</p>
          {/* ↑ Operador || : si no hay headline, usamos el title como respaldo. */}
          <p className="cv-loc">📍 {profile.location || ''}</p>
        </div>
      </div>

      <div className="cv-section">
        <h3>Sobre mí</h3>
        <p className="cv-summary">{profile.summary || ''}</p>
        {/* ↑ Al estar entre llaves, el valor de JS se inyecta en el texto del JSX. */}
      </div>

      <div className="cv-section">
        <h3>Skills clave (peso)</h3>
        <div className="skill-tags">
          {skills.map(({ name, weight }) => (
            // ↑ .map() recorre cada skill y genera un <span> por elemento. Antes
            //   venía un par [nombre, peso] del mapa y había que separarlo con
            //   `[k, v]`; ahora el objeto ya viene con los dos campos con nombre.
            <span className="tag" key={name}>{name} ({Math.round(Number(weight) * 100)}%)</span>
            // ↑ key={name} le da a React una identidad única a cada skill: el nombre es
            //   único por usuario (unique(user_id, name) en la base). Number(weight)
            //   es defensivo: el peso es numérico, pero si llegara como texto
            //   ("0.9") el * lo coerciona igual y no vemos "NaN%".
          ))}
        </div>
      </div>

      <div className="cv-section">
        <h3>Enlaces</h3>
        <div className="links">
          <a href={profile.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a>
          {/* ↑ target="_blank" abre en pestaña nueva; rel="noopener noreferrer"
              evita que la pestaña nueva pueda manipular la anterior (seguridad). */}
          <a href={profile.github} target="_blank" rel="noopener noreferrer">GitHub</a>
          {/* ↑ ↑ No hay link al CV en PDF: la app no guarda el archivo (decisión 5
              del proyecto), solo el perfil derivado, así que no existe una URL
              del CV por usuario. */}
        </div>
      </div>

      {onEdit && (
        <button type="button" className="btn secondary cv-edit-btn" onClick={onEdit}>
          Editar perfil
        </button>
        // ↑ Abre el MISMO formulario del onboarding en modo modal, con el perfil
        //   ya cargado. El motivo de que sea un modal y no un "subir CV" nuevo es la
        //   cuota: `POST /api/cv/parse` llama a un LLM de pago y cada parseo cuenta
        //   contra un límite por hora, así que corregir un peso de skill no puede
        //   pasar por ahí.
      )}

      {onDeleteAccount && <BorrarCuentaZona onDeleteAccount={onDeleteAccount} />}
      {/* ↑ La zona de peligro va AL FINAL del panel, después de "Editar perfil", y
          no junto al "Salir" del header. El texto y el botón viven en
          `BorrarCuentaZona` y no acá: los mismos cinco renglones aparecen también
          en la compuerta del alta, y dos copias del mismo aviso divergen sin que
          nada falle. La razón completa de la posición está en ese componente. */}
    </aside>
  );
}