// ============================================================================
// CvOnboarding — LA SEGUNDA ETAPA DEL ALTA, DEL LADO DEL NAVEGADOR
// ---------------------------------------------------------------------------
// El backend ya está entero (`POST /api/cv/parse` analiza el CV y devuelve un
// perfil DERIVADO sin guardarlo; `PUT /api/profile` lo escribe). Lo que faltaba
// era esta pantalla, y es la pieza que hace que el alta de dos etapas sea usable:
//
//   correo + clave  ──►  este formulario  ──►  ofertas con % de match real
//
// Un detalle del diseño que hay que entender antes de tocar nada: el `PUT` es un
// REEMPLAZO, no un parche. `api/profile.js` borra las skills y las reescribe
// enteras, y `market_skills` y `projects` se sobreescriben con lo que venga en el
// body. Por eso el borrador que se edita acá arrastra (`toDraft`) esos campos sin
// mostrarlos, y `buildPayload` los vuelve a mandar: si se dejaran fuera, guardar
// un perfil "bien guardado" BORRARÍA los proyectos que el LLM había FOUND
// desde el CV, y la Propuesta de Interés perdería tarjetas sin avisar.
//
// El componente se usa en DOS places, y por eso tiene un solo conjunto de
// estados:
//   · sin `profile` → es la COMPUERTA: ocupa la pantalla entera y no deja ver
//     ofertas (un perfil ausente matchea con score 0 en todas, y eso se ve como
//     "la app no encuentra nada" en vez de como "falta tu CV").
//   · con `profile` → es el EDITOR: se abre encima de la app, sin obligar a
//     volver a subir el CV. Eso importa por la cuota: corregir un peso de skill
//     no debería gastar un análisis de los que paga la clave del LLM.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
// ↑ `useEffect` para el atajo de Escape del editor y para que el foco entre al
//   formulario, `useRef` para el input de archivo y `useState` para los tres
//   estados del flujo (elegir → leyendo → revisar → guardando).

import { parseCv, saveProfile } from '../api.js';
// ↑ Las dos funciones de la capa de API del paso 7. El componente NO hace
//   `fetch`: si mañana cambia una URL o el manejo de errores, se cambia acá y no
//   en tres lugares.

import BorrarCuentaZona from './BorrarCuentaZona.jsx';
// ↑ La zona "borrar mi cuenta" del paso 11, compartida con `CvPanel` para que las
//   dos pantallas den acceso a la misma acción con el mismo texto.

import PrivacyNotice from './PrivacyNotice.jsx';
// ↑ Aviso de privacidad y consentimiento (Ley 25.326). Se muestra ANTES de subir
//   el CV por primera vez (cuando no hay perfil). El usuario debe leerlo y dar
//   su consentimiento para que el texto del CV viaje al LLM.

// ── El tope de tamaño, repetido acá a propósito ───────────────────────────────
// Es el MISMO número que `MAX_CV_BYTES` de `lib/cvText.js`. No se importa, y
// no es descuido: ese módulo es de Node (usa `Buffer`, streams y carga
// `pdf-parse`/`mammoth` al vuelo), así que meterlo en el bundle del navegador
// rompe el build del frontend. El valor está duplicado y el BACKEND vuelve a validarlo
// igual (`validateCvFile`): lo de acá es solo para dar el error al instante, sin
// subir 8 MB por la red para que el servidor diga lo mismo. El que manda es el
// del servidor; esta es cortesía.
const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_MB_LABEL = `${MAX_CV_BYTES / (1024 * 1024)} MB`;

// Extensiones y MIME que se aceptan. Mismos valores que
// `ACCEPTED_EXTENSIONS` / `ACCEPTED_MIME_TYPES` del backend, por el mismo motivo
// que el tope: el chequeo real es el del servidor, que además mira el contenido
// del archivo (los primeros bytes) y no solo lo que declara el cliente.
const EXTENSIONES = ['.pdf', '.docx'];
const ACCEPT_ATTR = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// ↑ El `accept` del input. No es una validación (el usuario puede elegir "todos
//   los archivos" en el explorador) pero filtra la lista en los navegadores
//   modernos, que es la mitad del trabajo de no tirar abajo a la persona.

// Un peso de skill en la escala 0–1, tolerando lo que devuelve el LLM.
// ↑ El LLM a veces responde `85` en vez de `0.85` (por eso la columna
//   `numeric(4,3)` no tiene check de rango). El backend lo corrige al guardar
//   (`clampWeight`), pero si el input mostrara `85` el usuario no entendería qué
//   está editando: se hace la misma lectura acá, en el cliente.
function toWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return Math.round((n / 100) * 1000) / 1000;
  return 1;
}

// Las skills del perfil, SIEMPRE como array `[{ name, weight }]`.
// ↑ La forma del array es la del contrato (decisión 1 de MEMORIA.md §4) y el modo
//   de falla de equivocarse es SILENCIOSO: un `Object.entries()` sobre el array
//   no tira error, y un `filter(s => s.weight >= 0.9)` sobre la forma mapa lee
//   `undefined` y deja la lista VACÍA sin un error en consola. Por eso la
//   comprobación no se queda en un `Array.isArray` mudo: si llega la forma vieja
//   se AVISA en la consola, porque blindar sin avisar deja la pantalla mostrando
//   cero skills y el resto de la app andando normal, que es el peor síntoma
//   posible para diagnosticar.
function readSkills(profile) {
  const raw = profile?.skills;
  if (Array.isArray(raw)) {
    return raw.map((s) => ({ name: String(s?.name ?? '').trim(), weight: toWeight(s?.weight) }));
  }
  if (raw && typeof raw === 'object') {
    console.warn(
      '[cv] el perfil llegó con `skills` como { nombre: peso } y no como array.'
      + ' Se convierte para mostrar, pero la API tiene que devolver [{ name, weight }].',
    );
    return Object.entries(raw).map(([name, weight]) => ({ name: String(name).trim(), weight: toWeight(weight) }));
  }
  return [];
}

// El borrador editable: los ocho campos del formulario más los dos que se
// arrastran sin editar.
// ↑ `keywords` es un STRING separado por comas en el borrador, y no el array, por
//   una razón de UI: son veinte palabras sueltas y el control natural para eso es
//   un campo de texto. El array vuelve a armarse en `buildPayload`, y es el
//   backend el que dedupe y recorta la lista (`cleanList`), no este archivo.
function toDraft(profile) {
  return {
    fullName: profile?.fullName || '',
    title: profile?.title || '',
    location: profile?.location || '',
    summary: profile?.summary || '',
    yearsExperience: profile?.yearsExperience ?? '',
    // ↑ `?? ''` y no `|| ''`: para un NÚMERO, 0 es un valor real (0 años) que
    //   un `||` convertiría en "sin dato" y se perdería al guardar.
    keywords: Array.isArray(profile?.keywords) ? profile.keywords.join(', ') : '',
    skills: readSkills(profile),
    links: {
      github: profile?.links?.github || profile?.github || '',
      // ↑ Se lee de `links` y, de respaldo, de la raíz: `normalizeProfile`
      //   DUPLICA los tres links en el perfil por compatibilidad con el frontend
      //   heredado (`profile.js:381-389`), así que los dos lugares son válidos.
      portfolio: profile?.links?.portfolio || profile?.portfolio || '',
      linkedin: profile?.links?.linkedin || profile?.linkedin || '',
    },
    // ↓ Los dos que NO se editan en este formulario y se arrastran tal cual.
    //   El `PUT` es un reemplazo: si no se mandan, se borran de la base.
    marketSkills: Array.isArray(profile?.marketSkills) ? profile.marketSkills : [],
    projects: Array.isArray(profile?.projects) ? profile.projects : [],
  };
}

// El body del `PUT /api/profile`, con la forma EXACTA que espera el endpoint.
// ↑ Se arma acá y no se manda el borrador tal cual por dos razones. Una: el
//   endpoint solo lee los campos que están en su `buildDraft`, así que mandar de
//   más no guarda de más, pero un body con `userId`, `headline` o `createdAt`
//   entra a un `readJsonBody` de 64 KB sin ganar nada. Dos: los strings vacíos
//   del formulario tienen que viajar como `null` y no como `''`, porque en toda
//   la capa de perfil `''` es "no hay dato" (`trimOrNull`) y mandarlos como
//   texto vacío los guardaría como un dato que dice que no se sabe nada.
function buildPayload(draft) {
  const anios = String(draft.yearsExperience).trim();
  // ↑ `anios` con S y en string: en el `<input type="number">` el valor SIEMPRE
  //   llega como texto (aunque se vea un número), y un número no tiene `.trim()`.
  //   `String(...)` además cubre el `null` del perfil sin años, que se escribe
  //   como `''` en el input.
  return {
    fullName: draft.fullName.trim(),
    title: draft.title.trim(),
    location: draft.location.trim() || null,
    summary: draft.summary.trim() || null,
    // ↑ El vacío explícito es `null`, no 0: "no declaraste los años" y "tenés 0
    //   años" son datos distintos, y la carta de presentación usa este número.
    yearsExperience: anios ? Number(anios) : null,
    keywords: draft.keywords.split(',').map((k) => k.trim()).filter(Boolean),
    skills: draft.skills
      .map((s) => ({ name: s.name.trim(), weight: toWeight(s.weight) }))
      .filter((s) => s.name),
    // ↑ El filtro por nombre vacío es solo para que el usuario no guarde una
    //   fila en blanco: el backend también los descarta (`normalizeSkills`), pero
    //   es más honesto que el error sea visible mientras se edita.
    links: {
      github: draft.links.github.trim() || null,
      portfolio: draft.links.portfolio.trim() || null,
      linkedin: draft.links.linkedin.trim() || null,
    },
    marketSkills: draft.marketSkills,
    projects: draft.projects,
  };
}

export default function CvOnboarding({ profile, onSaved, onCancel, onDeleteAccount }) {
  // ↑ `profile`: el perfil a editar, o null cuando es el alta de cero.
  //   `onSaved`: recibe el perfil LEÍDO de la base (no el borrador) para que el
  //   padre lo ponga en su estado global. `onCancel`: si viene, el componente se
  //   muestra como modal y se puede cerrar; si no viene, es la compuerta a pantalla
  //   completa y no se puede cerrar (no hay nada que ver atrás).
  //   `onDeleteAccount`: abre el modal de borrado. Solo lo usa la compuerta (el
  //   editor ya tiene el panel del CV detrás, con su propia zona de peligro), y es
  //   opcional justamente por eso: sin él, el editor no duplica el aviso.

  const esEditor = Boolean(onCancel);
  // ↑ Un solo componente, dos usos. La diferencia de comportamiento son tres
  //   cosas: si arranca en el formulario o en el selector de archivo, si se puede
  //   cerrar, y si aparece encima de la app o en lugar de ella.

  const [fase, setFase] = useState(profile ? 'revisar' : 'elegir');
  // ↑ 'elegir' (buscador de archivo) | 'leyendo' (pidiendo el análisis al LLM)
  //   | 'revisar' (el formulario) | 'guardando' (mandando el PUT). Son cuatro
  //   estados y no un booleano `cargando` porque "está leyendo" y "está
  //   guardando" muestran textos distintos en el botón y un usuario que espera 25
  //   segundos por el LLM necesita saber cuál de las dos cosas está esperando.

  const [mostrarPrivacidad, setMostrarPrivacidad] = useState(!profile && !esEditor);
  // ↑ Solo se muestra en la compuerta del alta (sin perfil, no editor).
  //   El usuario debe aceptar para poder subir el CV.

  const [archivo, setArchivo] = useState(null);
  const [borrador, setBorrador] = useState(() => toDraft(profile));
  // ↑ `toDraft(profile)` como función perezosa de useState: corre SOLO al
  //   montar. Con un objeto literal el cálculo correría en cada render.

  const [error, setError] = useState(null);
  // ↑ Un objeto `{ message, status, retryAfter }` (lo que arma `apiError`) en
  //   vez de un string suelto: el mensaje va tal cual, pero el status y el
  //   `retryAfter` son los que permiten que un 429 se vea como "esperá" y no como
  //   una app rota.

  const inputArchivo = useRef(null);
  const primerCampo = useRef(null);
  // ↑ Los dos refs que hacen falta: el input para poder abrir el explorador
  //   desde un botón, y el primer campo del formulario para que el foco entre
  //   solo al abrir (si no, el teclado arranca en el <body> y el formulario
  //   parece no existir).

  // Escape cierra el editor. Va con `keydown` en `document` porque un modal puede
  // tener el foco en cualquier lado, y sin esto un usuario de teclado queda
  // atrapado adentro.
  useEffect(() => {
    if (!esEditor) return undefined;
    const alPulsar = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', alPulsar);
    return () => document.removeEventListener('keydown', alPulsar);
  }, [esEditor, onCancel]);
  // ↑ El `return` del `if` devuelve `undefined`, que es lo que React espera para
  //   "no limpies nada". Devolver `false` o `null` acá no es lo mismo.

  useEffect(() => {
    if (fase === 'revisar') primerCampo.current?.focus();
    // ↑ El foco entra al formulario cuando se llega a la revisión, que es el
    //   momento en que la persona tiene que leer lo que el LLM entendió.
  }, [fase]);

  // ── Elegir el archivo ───────────────────────────────────────────────────────
  function elegirArchivo(evento) {
    if (mostrarPrivacidad) return; // No permitir elegir archivo sin consentimiento
    
    const elegido = evento.target.files?.[0] || null;
    setArchivo(elegido);
    setError(null);
    // ↑ Cada archivo nuevo borra el error anterior: si no, seguiría viendo
    //   "El CV es demasiado grande" con el archivo nuevo ya elegido al lado.

    if (!elegido) return;

    // Los dos cortes de cliente. Existen para no gastar la subida ni la cuota en
    // un archivo que el servidor va a rechazar igual; la validación que manda es
    // la de `cvText.js`, que además mira los bytes del archivo.
    const nombre = elegido.name.toLowerCase();
    if (!EXTENSIONES.some((ext) => nombre.endsWith(ext))) {
      rechazar('Elegí un PDF o un Word .docx. Lo que elegiste no es ninguno de los dos.', 415);
      return;
    }
    if (elegido.size > MAX_CV_BYTES) {
      rechazar(
        `Ese archivo pesa ${(elegido.size / (1024 * 1024)).toFixed(1)} MB y el máximo son ${MAX_MB_LABEL}.`,
        413,
      );
    }
  }

  // Descarta el archivo recién elegido y deja el input VACÍO, con el motivo a la vista.
  // ↑ El `input.value = ''` es la parte que parece un detalle y es la que hace que
  //   esto sea recuperable: con el valor puesto, elegir de nuevo el MISMO archivo
  //   no dispara `onChange` (el valor no cambió) y el usuario queda trabado con un
  //   input lleno y el botón deshabilitado, sin forma de seguir.
  function rechazar(mensaje, status) {
    setArchivo(null);
    setError({ message: mensaje, status });
    if (inputArchivo.current) inputArchivo.current.value = '';
  }

  // ── Pedir el análisis del CV ────────────────────────────────────────────────
  async function analizar() {
    if (!archivo || fase === 'leyendo') return;
    setFase('leyendo');
    setError(null);
    // ↑ El error se borra al reintentar: si no, el mensaje del intento anterior
    //   queda abajo del botón de "volver a intentar" y parece el error nuevo.

    try {
      const data = await parseCv(archivo);
      setBorrador(toDraft(data.profile));
      setFase('revisar');
      // ↑ `data.profile`, NO el `draft` que se arme acá: lo que vuelve del LLM ya
      //   viene normalizado con la forma del contrato (`parseCvToProfile`), que
      //   es la misma que espera el `PUT`. Re-normalizar del lado del cliente
      //   sería una segunda implementación de la misma regla.
    } catch (err) {
      // ↑ Se conserva el archivo en el estado a propósito: el 429 dice "esperá
      //   N minutos", y en ese caso el botón tiene que volver a analizar el MISMO
      //   archivo sin obligar a que la persona vaya a buscarlo de nuevo.
      setError({
        message: err?.message || 'No se pudo analizar tu CV.',
        status: err?.status ?? 0,
        retryAfter: err?.retryAfter,
      });
      setFase('elegir');
    }
  }

  // ── Guardar ─────────────────────────────────────────────────────────────────
  async function guardar(evento) {
    evento.preventDefault();
    if (fase === 'guardando') return;
    setFase('guardando');
    setError(null);

    try {
      const data = await saveProfile(buildPayload(borrador));
      onSaved(data.profile);
      // ↑ Se pasa el perfil que volvió de la BASE, no el borrador: así el
      //   `headline` derivado, el orden de las skills por peso y el redondeo de
      //   los años son los mismos que va a leer el próximo `GET /api/profile`.
      //   Con el borrador, la pantalla mostraría datos que la base no tiene.
    } catch (err) {
      setError({
        message: err?.message || 'No se pudo guardar tu perfil.',
        status: err?.status ?? 0,
        retryAfter: err?.retryAfter,
      });
      setFase('revisar');
    }
  }

  // ── Cambios de un campo del borrador ────────────────────────────────────────
  // ↑ Un solo `set` para los siete campos de texto: son todos el mismo tipo de
  //   dato y separarlos en siete manejadores haría el archivo el doble de largo
  //   sin ganar nada. Lo que NO se unifica son las skills, que son una lista.
  function cambiar(campo, valor) {
    setBorrador((actual) => ({ ...actual, [campo]: valor }));
  }

  function cambiarLink(campo, valor) {
    setBorrador((actual) => ({ ...actual, links: { ...actual.links, [campo]: valor } }));
  }

  function cambiarSkill(indice, valor) {
    setBorrador((actual) => ({
      ...actual,
      skills: actual.skills.map((s, i) => (i === indice ? { ...s, ...valor } : s)),
      // ↑ `map` con el índice: reemplaza SOLO la fila editada. Un `push` o un
      //   splice sobre el array del estado mutaría el objeto del render anterior,
      //   que es el error clásico de React.
    }));
  }

  const agregarSkill = () => setBorrador((actual) => ({
    ...actual,
    // ↑ Peso 1 = "la tengo". Es el default del backend (`DEFAULT_SKILL_WEIGHT`),
    //   y la razón de que no sea 0 es que 0 significa "no la tengo", que es lo
    //   OPPOSTO de lo que el usuario está por escribir.
    skills: [...actual.skills, { name: '', weight: 1 }],
  }));

  const quitarSkill = (indice) => setBorrador((actual) => ({
    ...actual,
    skills: actual.skills.filter((_, i) => i !== indice),
  }));

  // Volver al selector de archivo desde la revisión: descarta el borrador.
  // ↑ Hay que avisar que gasta cuota, porque es un parseo más del LLM pagado.
  const volverAEmpezar = () => {
    setBorrador(toDraft(profile));
    setArchivo(null);
    setError(null);
    setFase('elegir');
    if (inputArchivo.current) inputArchivo.current.value = '';
    // ↑ Se limpia el value del input a mano: si no, elegir el MISMO archivo otra
    //   vez no dispara el `onChange` (el valor no cambió) y el botón quedaría
    //   deshabilitado sin explicación.
  };

  // ── Lo que se muestra ───────────────────────────────────────────────────────

  const ocupado = fase === 'leyendo' || fase === 'guardando';
  // ↑ Un solo booleano para los dos estados "esperar": mientras está ocupado no
  //   se puede tocar nada, porque una doble pulsación en el `PUT` mandaría el
  //   perfil dos veces y en el `POST` pagaría dos análisis.

  // Un 429 tiene que verse como lo que es: "esperá un ratito", no "se rompió". El
  // texto del backend NO se reescribe (ver la nota de `apiError`): lo único que
  // se le agrega es cuánto falta, y el ícono cambia de ⚠ a ⏳ para que el mensaje
  // se lea distinto al de un error de verdad sin tocar una palabra de su texto.
  const esLimite = error?.status === 429;
  const espera = error?.retryAfter ? ` Podés volver a intentarlo en ${Math.ceil(error.retryAfter / 60)} min.` : '';
  // ↑ `retryAfter` viene en SEGUNDOS y se redondea a minutos para el texto: nadie
  //   cuenta 1.700 segundos, y con el 429 el usuario tiene que saber más o menos
  //   cuánto falta.

  const faltan = [];
  if (!borrador.fullName.trim()) faltan.push('tu nombre');
  if (!borrador.title.trim()) faltan.push('el puesto al que te postulás');
  if (!borrador.skills.some((s) => s.name.trim())) faltan.push('al menos una skill');
  // ↑ Las MISMAS tres condiciones que hacen el 400 del backend
  //   (`api/profile.js:337-339`). Se repiten acá para avisar sin gastar un PUT
  //   en un body que va a ser rechazado, y no se redacta como error: es una
  //   ayuda de contexto del botón, porque el error de verdad, si llega, se
  //   muestra arriba con el texto del backend.

  const ocultos = [];
  if (borrador.projects?.length) ocultos.push(`${borrador.projects.length} ${borrador.projects.length === 1 ? 'proyecto' : 'proyectos'}`);
  if (borrador.marketSkills?.length) ocultos.push(`${borrador.marketSkills.length} ${borrador.marketSkills.length === 1 ? 'habilidad' : 'habilidades'} que pide el mercado`);
  // ↑ Los campos que se guardan aunque no se editen. Se nombran uno por uno para
  //   poder decirlo: si el usuario guarda y de golpe desaparecen las tarjetas de
  //   proyectos de la Propuesta de Interés, sin una línea que lo explique, lo
  //   primero que va a pensar es que la app se rompió.
  // ↑ Se arma como LISTA y no con un contador ("3 datos") ni con una cadena
  //   condicional pegada: las dos versiones dejaban un paréntesis desbalanceado o
  //   una palabra pegada cuando venía una sola de las dos collections. La lista
  //   tiene `join`, que arma la enumeración correcta para 1, 2 y 0.

  const avisoPrivacidad = mostrarPrivacidad && (
    <PrivacyNotice
      onAccept={() => setMostrarPrivacidad(false)}
      onDecline={() => {
        setMostrarPrivacidad(false);
        if (inputArchivo.current) inputArchivo.current.value = '';
        setArchivo(null);
      }}
      providerName={import.meta.env?.VITE_LLM_PROVIDER_NAME || 'el proveedor configurado (OpenAI-compatible)'}
    />
  );

  const cuerpo = (
    <>
      {error && (
        <div className={`cv-error${esLimite ? ' limite' : ''}`} role="alert">
          {/* ↑ `role="alert"`: el lector de pantalla interrumpe y lee el error
              apenas aparece. Sin esto el mensaje queda en un nodo más de la
              página y un usuario ciego no se entera de que falló el guardado. */}
          <strong>{esLimite ? '⏳' : '⚠'}</strong>
          {error.message}
          {esLimite && espera}
          {/* ↑ El `strong` solo cambia el ícono, y la clase `limite` el color: el
              429 tiene que leerse como "esperá" y no como "se rompió", pero el
              texto del backend no se reescribe nunca (ver la nota de `apiError`). */}
        </div>
      )}

      {fase === 'elegir' ? (
        <div className="cv-step">
          <p className="cv-help">
            Subí tu CV en PDF o Word (.docx). No se guarda el archivo: se lee en el
            momento para armar tu perfil, y lo único que queda guardado son los
            datos de abajo.
            {/* ↑ Se dice explícitamente que el archivo NO se guarda: es la
                decisión de privacidad del proyecto (no hay almacenamiento de CVs)
                y es lo que la persona espera que pase. */}
          </p>

          <label className="cv-file-label" htmlFor="cv-file">Archivo del CV</label>
          <input
            id="cv-file"
            ref={inputArchivo}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={elegirArchivo}
            disabled={ocupado}
            className="cv-file"
          />
          {/* ↑ El `accept` NO es una validación: el explorador deja elegir
              "todos los archivos" igual. Por eso `elegirArchivo` vuelve a mirar
              la extensión. El backend es el que de verdad valida. */}

          {archivo && (
            <p className="cv-file-info">
              {archivo.name} · {(archivo.size / 1024 / 1024).toFixed(2)} MB
              {/* ↑ Se muestra el tamaño REAL del archivo elegido, porque el
                  único error que se ve al instante es "demasiado grande" y el
                  explorador de archivos del navegador no lo dice. */}
            </p>
          )}

          <button
            type="button"
            className="btn"
            onClick={analizar}
            disabled={!archivo || ocupado}
            aria-busy={fase === 'leyendo'}
          >
            {fase === 'leyendo' ? '⏳ Analizando tu CV…' : 'Analizar mi CV'}
          </button>
          {/* ↑ `aria-busy` en el botón que está trabajando: es lo que le dice al
              lector de pantalla que la espera es de verdad y no un botón muerto. */}
          {fase === 'leyendo' && (
            <p className="cv-help">
              Esto puede tardar hasta medio minuto: el CV se está leyendo y
              armando tu perfil. No cierres la página.
              {/* ↑ Un parseo es una llamada a un LLM de pago con timeout de 25
                  segundos (`llm.js`). Decir cuánto va a tardar es la diferencia
                  entre "la app se colgó" y "está leyendo". */}
            </p>
          )}
        </div>
      ) : (
        <form className="cv-form" onSubmit={guardar}>
          <p className="cv-help">
            Revisá lo que entendimos de tu CV y corregí lo que haga falta. Nada
            se guarda hasta que aprietes <strong>Guardar perfil</strong>.
            {/* ↑ Es la respuesta a la pregunta que se hace todo el mundo en esta
                pantalla: el perfil que se ve acá todavía no existe en ningún
                lado (`POST /api/cv/parse` devuelve `saved: false`). */}
          </p>

          <div className="cv-field">
            <label htmlFor="cv-fullName">Nombre y apellido</label>
            <input
              id="cv-fullName"
              ref={primerCampo}
              type="text"
              value={borrador.fullName}
              onChange={(e) => cambiar('fullName', e.target.value)}
              maxLength={120}
              autoComplete="name"
              disabled={ocupado}
            />
            {/* ↑ `maxLength` = `MAX_NAME_CHARS` del endpoint. No es un capricho:
                lo que se recorta en el backend es texto que el usuario escribió
                y no vuelve a ver, así que mejor no dejar que escriba de más. */}
          </div>

          <div className="cv-field">
            <label htmlFor="cv-title">Puesto al que te postulás</label>
            <input
              id="cv-title"
              type="text"
              value={borrador.title}
              onChange={(e) => cambiar('title', e.target.value)}
              maxLength={160}
              disabled={ocupado}
            />
            {/* ↑ Es el campo que más se malinterpreta: el LLM lo llena con el
                puesto del último trabajo o con el título del CV, y lo que
                alimenta `deriveHeadline` y la carta de presentación. */}
          </div>

          <div className="cv-row">
            <div className="cv-field">
              <label htmlFor="cv-years">Años de experiencia</label>
              <input
                id="cv-years"
                type="number"
                min="0"
                max="99.9"
                step="0.5"
                value={borrador.yearsExperience}
                onChange={(e) => cambiar('yearsExperience', e.target.value)}
                disabled={ocupado}
              />
              {/* ↑ `type="number"`: el teclado numérico del celular y las flechas
                  para ajustar. El vacío se guarda como `null` (ver `buildPayload`),
                  no como 0. */}
            </div>

            <div className="cv-field">
              <label htmlFor="cv-location">Ubicación</label>
              <input
                id="cv-location"
                type="text"
                value={borrador.location}
                onChange={(e) => cambiar('location', e.target.value)}
                maxLength={160}
                autoComplete="address-level2"
                disabled={ocupado}
              />
            </div>
          </div>

          <div className="cv-field">
            <label htmlFor="cv-summary">Resumen</label>
            <textarea
              id="cv-summary"
              rows={4}
              value={borrador.summary}
              onChange={(e) => cambiar('summary', e.target.value)}
              maxLength={2000}
              disabled={ocupado}
            />
            {/* ↑ `rows` y no `height`: el textarea crece con el contenido en los
                navegadores modernos, y una caja fija obliga a scrollear por
                dentro de un campo que el usuario está corrigiendo. */}
          </div>

          <div className="cv-field">
            <label htmlFor="cv-keywords">Palabras clave</label>
            <input
              id="cv-keywords"
              type="text"
              value={borrador.keywords}
              onChange={(e) => cambiar('keywords', e.target.value)}
              placeholder="automatización, testing, sql, scrum"
              disabled={ocupado}
            />
            <p className="cv-help">
              Separadas por comas. Se usan para armar la búsqueda en LinkedIn.
              {/* ↑ Se explica para qué sirve algo que el usuario no ve en
                  pantalla: sin esto el campo parece decoración. */}
            </p>
          </div>

          <fieldset className="cv-fieldset">
            <legend>Skills y tu nivel con cada una</legend>
            {/* ↑ `fieldset`/`legend` y no un `div` con un `<h3>`: es un grupo de
                controles, y el lector de pantalla necesita enter el grupo para
                anunciar la cantidad de campos que tiene. */}
            {borrador.skills.map((skill, i) => (
              <div className="cv-skill-row" key={i}>
                {/* ↑ `key={i}` y no el nombre: el nombre se EDITA, así que si fuera
                    la key, escribir en el input la borraría y el foco saltaría a
                    otra fila en cada tecla. El índice es estable acá porque las
                    filas solo se agregan o se borran, nunca se reordenan. */}
                <input
                  type="text"
                  value={skill.name}
                  onChange={(e) => cambiarSkill(i, { name: e.target.value })}
                  maxLength={80}
                  placeholder="nombre de la skill"
                  aria-label={`Skill ${i + 1}: nombre`}
                  disabled={ocupado}
                />
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={skill.weight}
                  onChange={(e) => cambiarSkill(i, { weight: e.target.value })}
                  aria-label={`Skill ${i + 1}: peso, de 0 a 1`}
                  disabled={ocupado}
                />
                <span className="cv-skill-pct">{Math.round(toWeight(skill.weight) * 100)}%</span>
                {/* ↑ El porcentaje al lado del input es lo que hace entendible un
                    número entre 0 y 1. Sin esto, "¿0.85?" obliga a hacer cuentas
                    en la cabeza para decidir si está bien. */}
                <button
                  type="button"
                  className="cv-skill-del"
                  onClick={() => quitarSkill(i)}
                  aria-label={`Quitar ${skill.name || `la skill ${i + 1}`}`}
                  disabled={ocupado}
                >
                  &times;
                </button>
              </div>
            ))}
            <button type="button" className="btn secondary" onClick={agregarSkill} disabled={ocupado}>
              + Agregar skill
            </button>
            <p className="cv-help">
              El peso es tu nivel: 1 es que la manejas a diario y 0.5 es que la
              tocaste algo. Se usa para calcular el % de match de cada oferta.
            </p>
          </fieldset>

          <fieldset className="cv-fieldset">
            <legend>Links</legend>
            <div className="cv-field">
              <label htmlFor="cv-linkedin">LinkedIn</label>
              <input
                id="cv-linkedin"
                type="url"
                value={borrador.links.linkedin}
                onChange={(e) => cambiarLink('linkedin', e.target.value)}
                maxLength={300}
                placeholder="linkedin.com/in/tunombre"
                disabled={ocupado}
              />
            </div>
            <div className="cv-field">
              <label htmlFor="cv-github">GitHub</label>
              <input
                id="cv-github"
                type="url"
                value={borrador.links.github}
                onChange={(e) => cambiarLink('github', e.target.value)}
                maxLength={300}
                placeholder="github.com/tunombre"
                disabled={ocupado}
              />
            </div>
            <div className="cv-field">
              <label htmlFor="cv-portfolio">Portfolio o web</label>
              <input
                id="cv-portfolio"
                type="url"
                value={borrador.links.portfolio}
                onChange={(e) => cambiarLink('portfolio', e.target.value)}
                maxLength={300}
                placeholder="tusitio.com.ar"
                disabled={ocupado}
              />
              {/* ↑ `type="url"` en los tres: el `cleanUrl` del backend
                  descarta cualquier esquema que no sea http(s) y le pone el
                  `https://` al que falte, así que acá se puede escribir sin
                  esquema y el link guardado va a funcionar igual. */}
            </div>
          </fieldset>

          {faltan.length > 0 && (
            <p className="cv-help cv-falta">
              Para guardar faltan: {faltan.join(', ')}.
              {/* ↑ Mismo criterio que las tres validaciones del backend, y en el
                  mismo orden, para que el mensaje de ayuda y el 400 no se
                  contradigan. */}
            </p>
          )}

          {ocultos.length > 0 && (
            <p className="cv-help">
              {`También se guardan ${ocultos.join(' y ')} del CV, que no se editan acá. `
                + 'Se conservan porque el guardado reemplaza el perfil entero.'}
            </p>
          )}
          {/* ↑ Los dos campos que se arrastran sin editar, contados y nombrados.
              Sin esta línea, guardar un perfil bien guardado BORRARÍA los
              proyectos del CV (el `PUT` es un reemplazo) y las tarjetas de la
              Propuesta de Interés desaparecerían sin que nadie entienda por
              qué. Decirlo acá es la diferencia entre un bug y una decisión. */}

          <div className="cv-actions">
            <button type="submit" className="btn" disabled={faltan.length > 0 || ocupado} aria-busy={fase === 'guardando'}>
              {fase === 'guardando' ? '⏳ Guardando…' : 'Guardar perfil'}
            </button>
            {esEditor && (
              <button type="button" className="btn secondary" onClick={onCancel} disabled={ocupado}>
                Cancelar
              </button>
            )}
            {/* ↑ El botón de guardar queda deshabilitado mientras falte algo, y
                el motivo está escrito arriba. Es mejor que dejar que se mande y
                que el servidor conteste 400: la validación del cliente es una
                ayuda, no la autoridad. */}
          </div>

          <div className="cv-again">
            <button type="button" className="link-button" onClick={volverAEmpezar} disabled={ocupado}>
              {esEditor ? 'Analizar otro CV' : 'Elegir otro archivo'}
            </button>
            <span className="cv-help">
              Volver a analizar usa otro análisis de tu cuota por hora.
              {/* ↑ Aviso explícito del costo, en LOS DOS usos del componente, y no
                  solo en el editor: en el alta el parseo ya se pagó una vez, así
                  que un segundo intento por un error de tipeo también es plata.
                  Por eso el editor existe aparte: corregir un peso de skill no
                  debería obligar a volver a pasar por acá. */}
            </span>
          </div>
        </form>
      )}
      {avisoPrivacidad}
    </>
  );

  if (esEditor) {
    return (
      <div 
        className="modal" 
        onClick={(e) => e.target === e.currentTarget && onCancel()} 
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        tabIndex={0}
        role="button"
        aria-label="Cerrar modal"
      >
        {/* ↑ Click en el fondo oscuro cierra, como en los otros modales de la app
            (`LetterModal`, `JobDetailModal`). Mismo criterio en toda la UI. */}
        <div className="modal-content cv-modal" role="dialog" aria-modal="true" aria-labelledby="cv-modal-title">
          <button className="modal-close" onClick={onCancel} aria-label="Cerrar">&times;</button>
          <h3 id="cv-modal-title">Editar tu perfil</h3>
{cuerpo}

        </div>
      </div>
    );
  }

  return (
    <section className="cv-gate panel" aria-labelledby="cv-gate-title">
      {/* ↑ No es un modal: es la compuerta. Va en el flujo del documento (el foco
          y el scroll lo encuentran solos) y no tiene cierre, porque atrás no hay
          nada que mostrar. */}
      <h2 id="cv-gate-title">Subí tu CV para empezar</h2>
      <p className="cv-help">
        Necesitamos tu CV para armar tu perfil y calcular el % de match de cada
        oferta. Es el paso que falta después de crear tu cuenta.
      </p>
      {cuerpo}

      {onDeleteAccount && <BorrarCuentaZona onDeleteAccount={onDeleteAccount} />}
      {/* ↑ La MISMA zona de peligro que en `CvPanel`, y está por un motivo
          concreto: `DELETE /api/account` usa `requireSession` y NO
          `requireProfile`, justamente para que una cuenta a medio crear (correo
          y clave listos, CV nunca subido) se pueda borrar. Si el único trigger
          estuviera en el panel del CV, esa compuerta sería un callejón sin
          salida: la cuenta se puede crear, pero no se puede deshacer desde la
          única pantalla donde ese usuario puede estar. Un endpoint que permite
          algo que la UI no ofrece es la mitad de unfeature roto. */}
    </section>
  );
}
