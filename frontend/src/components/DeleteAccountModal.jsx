import { useEffect, useRef, useState } from 'react';

import { deleteAccount } from '../api.js';

// ════════════════════════════════════════════════════════════════════════════
// CONFIRMACIÓN DE BORRADO DE CUENTA (paso 11).
// ════════════════════════════════════════════════════════════════════════════
//
// Componente con su estado enteramente propio y un solo propósito: que nadie borre
// su cuenta con un click de más. Es lo único en la app que pide una confirmación
// escrita, y las decisiones del diseño están abajo porque ninguna se deduce del
// markup.
//
// ── POR QUÉ SE ESCRIBE UNA FRASE Y NO UN `confirm()` ──────────────────────────
// `window.confirm('¿Borrar?')` es un click de más, no una confirmación: el botón
// está siempre a la misma distancia del de "no", y un `Enter` a ciegas lo acepta.
// Acá el botón destructivo arranca DESHABILITADO y solo se habilita después de que
// la persona escriba la frase entera. El costo es tipear 16 caracteres una vez en
// la vida; el beneficio es que el borrado es algo que se decidió, no algo que se
// pasó por encima.
//
// ── POR QUÉ UNA FRASE Y NO EL CORREO ─────────────────────────────────────────
// Pedir el correo sería más estricto, y es lo que hacen algunos servicios. Se
// eligió una frase porque el correo YA está a la vista (el botón del header dice
// "Salir (tu@correo)") y copiarlo no demuestra nada: quien está frente a la
// pantalla tiene la sesión abierta. La frase tiene que salir de la cabeza, no de
// la memoria visual de un correo que alguien puede tener abierta en otra pestaña.
//
// ── POR QUÉ NO HAY "SÍ, SEGUÍ" / "NO, VOLVER" ───────────────────────────────
// "No, volver" es el texto de un `confirm()` del navegador. Acá hay TRES caminos
// de volver atrás y uno solo de seguir: el botón de "Cancelar" (a la izquierda),
// el click en el fondo, y Escape. El desbalance es intencional en una acción
// irreversible, y por eso el foco inicial NO está en el botón destructivo ni en
// "Cancelar": está en el input de la frase (ver el `useEffect` de más abajo), que
// es el único lugar donde se escribe algo sin consecuencias.
//
// ── POR QUÉ ES SU PROPIO COMPONENTE Y NO UN `editando` MÁS ───────────────────
// `App.jsx` ya tiene tres modales con el mismo patrón (`editando`, `selectedJob`,
// `letter`) y este es el cuarto. Lo que cambia, y es lo que justifica el archivo
// aparte, es que este TIENE que llamar a la API y manejar el error: un modal que
// cierra solo con éxito es un modal que puede perder un error. Por eso el estado
// de fase y de error viven acá y no en `App.jsx`, y `App.jsx` solo recibe un
// `onDeleted()` para cuando ya no hay nada que limpiar del lado del servidor.
//
// ── EL ERROR SE MUESTRA TAL CUAL ─────────────────────────────────────────────
// `deleteAccount()` tira un `Error` cuyo mensaje es el que escribió `http.js`, y se
// muestra sin reescribirlo, por la misma regla que `AuthScreen` y `CvOnboarding`:
// si el cliente reescribiera el texto habría dos versiones de la misma
// explicación. Lo que se le agrega es el `status`, que acá no se usa para nada
// (este endpoint no tiene 429) pero que se mantiene en el objeto para que quien
// lea los tres formularios de la app vea la misma forma.

// La frase, como constante y no escrita dentro del JSX: es el valor contra el que
// se compara la entrada, y si estuviera en el markup habría que cambiarlo en dos
// lugares. Va arriba del todo porque se usa en el render, y un `const` usado antes
// de su declaración es un `ReferenceError` esperando que alguien lo lea mal.
const FRASE = 'BORRAR MI CUENTA';

/**
 * Modal de confirmación del borrado de la cuenta.
 *
 * @param {object} props
 * @param {() => void} props.onCancel Se llama si la persona se arrepiente (Escape,
 *   click en el fondo, "Cancelar"). No toca el backend.
 * @param {() => void} props.onDeleted Se llama SOLO después de que el backend
 *   confirmó el borrado. Es el que limpia el estado de `App.jsx` y manda a la
 *   pantalla de acceso.
 */
export default function DeleteAccountModal({ onCancel, onDeleted }) {
  const [confirmacion, setConfirmacion] = useState('');
  const [fase, setFase] = useState('inactivo');
  // ↑ 'inactivo' | 'borrando'. String y no booleano por la misma razón que en
  //   `AuthScreen` y `CvOnboarding`: el nombre dice qué está pasando.

  const [error, setError] = useState(null);
  // ↑ Un `{ message, status }` o null. Cuando hay error el modal NO se cierra, que
  //   es lo único sensato: si se cerrara, la persona vería la app como si nada y
  //   su cuenta seguiría entera sin que nadie le haya dicho nada.

  const inputRef = useRef(null);
  // ↑ Para que el foco entre solo al abrir. Va al INPUT y no al botón de
  //   "Cancelar" como en los otros modales de la app, y esa es la excepción que
  //   importa: acá el elemento "seguro" por defecto no es el de cancelar, porque
  //   la acción por defecto del teclado en un input es escribir, y en un botón es
  //   activar. Con el foco en "Cancelar", un `Enter` a ciegas cerraba el modal
  //   (inofensivo) y con el foco en "Borrar mi cuenta para siempre" lo ejecutaba
  //   (no). Sin foco en ninguno, el `Enter` no hace nada hasta que la persona
  //   elige, que es lo único aceptable acá.

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // ↑ Sin dependencias: corre solo al montar, que es exactamente lo que se quiere
  //   (el foco entra UNA vez al abrir, no se lo roba a quien está escribiendo).

  useEffect(() => {
    // Escape cierra. Va con `keydown` en `document` y no en el input porque el
    // foco puede estar en el botón de borrar, y sin esto un usuario de teclado
    // queda atrapado adentro de un modal que no puede confirmar.
    //
    // Durante `borrando` NO cierra: si el DELETE ya está en el servidor, cerrar el
    // modal no lo cancela, solo oculta el resultado. Un backend lento se ve como un
    // modal que no hace nada, que es mejor que uno que se cierra y deja al
    // usuario con la app entera y la cuenta todavía viva.
    const alPulsar = (e) => {
      if (e.key === 'Escape' && fase === 'inactivo') onCancel();
    };
    document.addEventListener('keydown', alPulsar);
    return () => document.removeEventListener('keydown', alPulsar);
  }, [fase, onCancel]);

  // El botón destructivo se habilita SOLO con la frase completa. El `toUpperCase()`
  // es para que "borrar mi cuenta" en minúscula cuente: la intención es evidente
  // en cualquier caja, y obligar a respetar mayúsculas agrega una chance más de
  // que alguien se frustre en una pantalla que ya lo asustó.
  const coincide = confirmacion.trim().toUpperCase() === FRASE;
  const borrando = fase === 'borrando';

  async function confirmar() {
    if (borrando || !coincide) return;
    setFase('borrando');
    setError(null);

    try {
      await deleteAccount();
      // ↑ Un 200 y nada más. No hay `logout()` después: el backend YA mandó el
      //   `Set-Cookie` con `Max-Age=0` en la misma respuesta, así que pedirle un
      //   logout sería un request extra para borrar una cookie que ya no está.
      onDeleted?.();
    } catch (err) {
      // El modal sigue abierto con el texto escrito: la persona puede volver a
      // apretar sin retipear la frase. Perder 16 caracteres de tipeo después de un
      // error de red es una molestia que no aporta nada.
      setError({
        message: err?.message || 'No se pudo borrar la cuenta.',
        status: err?.status ?? 0,
      });
      setFase('inactivo');
    }
  }

  return (
    <div className="modal" onClick={(e) => e.target === e.currentTarget && !borrando && onCancel()} onKeyDown={(e) => e.key === 'Escape' && !borrando && onCancel()}>
      {/* ↑ Click en el fondo oscuro cierra, como en los otros modales de la app
          (`LetterModal`, `JobDetailModal`, el editor de `CvOnboarding`). Mismo
          criterio en toda la UI. La diferencia es el `!borrando`: mientras el
          DELETE está en vuelo, el fondo no cierra nada. */}
      <div className="modal-content cuenta-modal" role="dialog" aria-modal="true" aria-labelledby="cuenta-modal-title">
        {/* ↑ `cv-modal` (los 720px de `CvOnboarding`) NO se reusa: este modal es
            un formulario de una sola frase y a 720px el input queda estirado. Es
            su propia clase, más angosta. */}
        <h3 id="cuenta-modal-title">Borrar tu cuenta</h3>

        <p className="cv-help">
          Se borra todo: tu perfil, tus skills, tus búsquedas guardadas y el historial
          de ofertas que viste. <strong>No se puede deshacer</strong> y después no
          queda ningún acceso para recuperar nada.
        </p>
        {/* ↑ El texto DICE qué pasa, en vez de un "esto no se puede deshacer"
            suelto: la amenaza sola no informa, y quien no sabe qué se está borrando
            no puede decidir si le importa. La lista sale de las 7 tablas que se
            lleva la cascada, las mismas de `001_users.sql:89-121`. */}

        <p className="cv-help">
          Lo único que queda es un registro interno de auditoría con tu correo, la
          fecha de la baja y los datos técnicos de la conexión (la IP y el
          navegador desde el que la borraste). No sirve para volver a entrar ni
          para reconstruir tu perfil.
        </p>
        {/* ↑ Se declara el rastro porque la tabla `account_deletions` existe
            justamente por eso, y porque "no queda nada" sería una mentira: queda
            una fila. El detalle de la IP y el User-Agent NO es un refinamiento:
            `api/account.js` los saca de la petición real y los escribe, así que
            omitirlos acá sería una reserva de privacidad falsa. */}

        <div className="cv-field">
          <label htmlFor="cuenta-confirmacion">
            Escribí <strong>“{FRASE}”</strong> para confirmar
          </label>
          <input
            id="cuenta-confirmacion"
            ref={inputRef}
            type="text"
            value={confirmacion}
            onChange={(e) => { setConfirmacion(e.target.value); setError(null); }}
            disabled={borrando}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck="false"
            // ↑ `autoComplete="off"` porque el gestor de contraseñas del navegador
            //   lo trata como un campo más y lo completa solo, y "BORRAR MI CUENTA"
            //   autocompletado es una confirmación que nadie escribió.
            //   `autoCapitalize="characters"` es la ayuda, no la regla: el match
            //   real es el `toUpperCase()` de arriba.
          />
        </div>

        {error && (
          <p className="cv-error" role="alert">
            {error.message}
            {/* ↑ Sin ícono ni clase `limite`: el 429 del login es un caso real
                con un tiempo de espera que hay que comunicar, y este endpoint no
                tiene ninguno. La clase se agrega cuando hay algo DISTINTO que
                comunicar, no por costumbre. */}
          </p>
        )}

        <div className="cv-actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={borrando}>
            Cancelar
          </button>

          <button
            type="button"
            className="btn btn-peligro"
            onClick={confirmar}
            disabled={borrando || !coincide}
          >
            {borrando ? 'Borrando…' : 'Borrar mi cuenta para siempre'}
          </button>
          {/* ↑ El `disabled` por `!coincide` ES la confirmación: no hay forma de
              llegar a este botón sin haber escrito la frase. Y el texto dice "para
              siempre" porque es la única forma honesta de describir lo que hace. */}
        </div>
      </div>
    </div>
  );
}