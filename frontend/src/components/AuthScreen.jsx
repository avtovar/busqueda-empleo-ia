import { useState } from 'react';
import { login, register } from '../api.js';

// ════════════════════════════════════════════════════════════════════════════
// PANTALLA DE ACCESO (paso 8): login y registro en el mismo componente.
// ════════════════════════════════════════════════════════════════════════════
//
// UN componente con un modo interno y no dos (`LoginScreen` y `RegisterScreen`),
// por tres razones que no son de estilo:
//
//   1) Los dos formularios piden EXACTAMENTE lo mismo: un correo y una clave. Los
//      campos, el `autocomplete`, el markup y el manejo del Enter son idénticos.
//      Con dos componentes, cada cambio futuro (un `maxLength`, un autofocus, una
//      clase nueva) hay que hacerlo dos veces y es cuestión de tiempo que se
//      desincronicen.
//   2) Los dos errores vienen del mismo contrato (`apiError` LANZA, con `.status`)
//      y el 409 del registro convive con el 401 del login en la misma pantalla.
//   3) El modo se cambia con un click, y al cambiarlo hay que limpiar el error y
//      los campos: si el error de "ese correo ya existe" sobrevive al pasar a
//      "entrar", es un mensaje que no corresponde a la acción que se está por
//      hacer. Ese reset es más fácil de razonar en un solo componente.
//
// Lo que SÍ es deliberado: NO se valida el formato del correo ni el largo de la
// clave en el cliente antes de mandar. Se manda y se muestra lo que responda el
// backend, que es quien tiene las reglas (`readCredentials`). Un formulario que
// inventa su propia versión de "esto no es un correo" muestra un error distinto del
// que el servidor daría, y ahí hay dos verdades. La única validación local es la
// del botón deshabilitado mientras no haya nada escrito, que no es una regla del
// negocio sino evitar un 400 previsible.
//
// Las clases CSS son las MISMAS que usa `CvOnboarding.jsx` (`.cv-form`,
// `.cv-field`, `.cv-error`, `.panel`): dos pantallas de la misma familia deberían
// verse iguales, y reusar las clases evita que este componente se vuelva el
// primero con un formulario de otro ancho.

/**
 * Pantalla de acceso: entrar o crear la cuenta.
 *
 * @param {object} props
 * @param {(data: object) => void} props.onAuthed Se llama con la respuesta del
 *   backend (`{ ok, user, profileComplete }`) cuando la autenticación sale bien.
 *   El padre NO debería decidir el ruteo con lo que hay acá salvo por el caso
 *   obvio: lo normal es que recargue la sesión con `loadSession()` y deje que
 *   `sesion.estado` / `sesion.profileComplete` decidan, porque esos valores ya
 *   tienen la lógica de las dos compuertas (401 → login, 403 → CV) escrita y
 *   probada en `App.jsx`.
 */
export default function AuthScreen({ onAuthed }) {
  const [modo, setModo] = useState('login');
  // ↑ 'login' | 'registro'. Arranca en login a propósito: el que ya tiene cuenta
  //   es el caso frecuente, y el que no la tiene ve el link a registro abajo.

  const [email, setEmail] = useState('');
  const [clave, setClave] = useState('');
  const [fase, setFase] = useState('inactivo');
  // ↑ 'inactivo' | 'enviando'. Es un string y no un booleano por la misma razón
  //   que el estado de `CvOnboarding`: el nombre dice qué está pasando.

  const [error, setError] = useState(null);
  // ↑ Un objeto `{ message, status, retryAfter }`, igual que en `CvOnboarding`, y
  //   por el mismo motivo: el `status` es lo que permite distinguir el 429 (hay
  //   que esperar) del resto, sin tocar el texto.

  const enviando = fase === 'enviando';

  function cambiarModo(nuevo) {
    setModo(nuevo);
    setError(null);
    setClave('');
    // ↑ La clave se borra y el error se limpia al cambiar de modo. La clave es lo
    //   único que no tiene sentido arrastrar: quien acaba de escribir una clave
    //   mala y se equivoca de botón va a escribir otra. El correo NO se borra,
    //   porque es casi siempre el mismo y volver a escribirlo es una molestia.
  }

  async function enviar(evento) {
    evento.preventDefault();
    if (enviando) return;
    setFase('enviando');
    setError(null);

    try {
      const datos = modo === 'registro'
        ? await register({ email, password: clave })
        : await login({ email, password: clave });
      // ↑ Ojo con el nombre de la variable del body: el backend espera
      //   `{ email, password }`, no `clave`. El campo se llama "clave" en la UI
      //   porque `password` en un `<input>` dispara los gestores de contraseña del
      //   navegador, que ofrecerían autocompletar la clave de otro sitio.
      onAuthed?.(datos);
    } catch (err) {
      setError({
        message: err?.message || 'No se pudo iniciar sesión.',
        status: err?.status ?? 0,
        retryAfter: err?.retryAfter,
      });
    } finally {
      setFase('inactivo');
    }
  }

  // El 429 se ve distinto del resto, y no por el texto sino por la clase: el
  // ícono y el color ámbar dicen "esperá", que es una instrucción, mientras que
  // un error rojo dice "algo está mal". Mismo criterio que el de `CvOnboarding`.
  const esLimite = error?.status === 429;
  const minutos = error?.retryAfter ? Math.max(1, Math.ceil(error.retryAfter / 60)) : 0;

  return (
    <div className="auth-wrap">
      <div className="panel auth-panel">
        <div className="cv-header">
          <div>
            <h2>{modo === 'registro' ? 'Creá tu cuenta' : 'Entrá a tu cuenta'}</h2>
            <p className="cv-help">
              {modo === 'registro'
                ? 'Con el correo y la clave alcanza para empezar. El CV lo subís en el paso siguiente.'
                : 'Con el correo y la clave con la que te registraste.'}
            </p>
          </div>
        </div>

        {error && (
          <p className={`cv-error ${esLimite ? 'limite' : ''}`} role="alert">
            {esLimite && <strong>⏳</strong>}
            {error.message}
            {esLimite && minutos > 0 && (
              <> Podés volver a intentarlo en {minutos} min.</>
            )}
            {/* ↑ Los minutos salen de `retryAfter`, que el backend pone en el body
                del 429 y `apiError` pasa a `.retryAfter`. Con `Math.max(1, ...)`
                porque un `Retry-After` menor a 60 s se redondearía a "0 min", que
                le dice al usuario que espere un minuto cuando en realidad es
                menos: mejor un minuto de más que un "ya está". */}
          </p>
        )}

        <form className="cv-form" onSubmit={enviar}>
          <div className="cv-field">
            <label htmlFor="auth-email">Correo</label>
            <input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              // ↑ `username` y no `email`: es el valor correcto según la spec de
              //   HTML para managers de contraseña, y es lo que hace que el
              //   navegador ofrezca "usar mi correo" en vez de guardar un dato
              //   inútil. El `type` sigue siendo `email` para la validación del
              //   navegador y el teclado con @ en el móvil.
              disabled={enviando}
              required
            />
          </div>

          <div className="cv-field">
            <label htmlFor="auth-clave">Clave</label>
            <input
              id="auth-clave"
              type="password"
              value={clave}
              onChange={(e) => setClave(e.target.value)}
              autoComplete={modo === 'registro' ? 'new-password' : 'current-password'}
              // ↑ Dos valores distintos según el modo, y no uno fijo: los gestores
              //   de contraseña necesitan distinguir "estoy creando una clave" de
              //   "estoy entrando con una que ya existe". Con `new-password` en el
              //   login, el navegador se niega a autocompletar; con
              //   `current-password` en el registro, ofrece generar una clave
              //   strong y se la mete al usuario sin querer.
              disabled={enviando}
              required
              minLength={8}
            />
            {modo === 'registro' && (
              <p className="cv-help">Mínimo 8 caracteres.</p>
            )}
            {/* ↑ El `minLength` del input es una ayuda, no una regla: el backend
                valida igual y su mensaje es el que se muestra si algo no cierra.
                Lo que evita es el 400 previsible de un formulario vacío. */}
          </div>

          <div className="cv-actions">
            <button type="submit" className="btn" disabled={enviando || !email || !clave}>
              {enviando
                ? 'Esperando…'
                : (modo === 'registro' ? 'Crear cuenta' : 'Entrar')}
            </button>
            {/* ↑ El botón se deshabilita con `!email || !clave` y NO se valida el
                formato: es la única guarda local, y sirve para no mandar un 400
                previsible. Deshabilitar con explicación es mejor que dejar que
                falle con un error después del click. */}

            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => cambiarModo(modo === 'login' ? 'registro' : 'login')}
              disabled={enviando}
            >
              {modo === 'login' ? 'No tengo cuenta' : 'Ya tengo cuenta'}
            </button>
            {/* ↑ `type="button"` OBLIGATORIO dentro de un `<form>`: sin esto el
                click dispara el submit y manda un login cuando el usuario
                solamente quería cambiar de modo. Es el default de `button`, así que
                omitirlo no es "menos código", es un bug. */}
          </div>
        </form>
      </div>
    </div>
  );
}
