// Página "Directorio de empleo": el catálogo de bolsas de empleo y consultoras de
// selección de Argentina, SIN scraping.
//
// ── QUÉ ES ESTA VISTA (y por qué la honestidad del rótulo es lo importante) ────
// No rastreamos ninguna de estas webs. El backend NO consulta sus tableros de
// ofertas: arma una URL por entrada y la abre el USUARIO, en su navegador y con su
// propia cuenta. Es el mismo criterio que ya usa el link de LinkedIn de la
// `Toolbar`, y por eso esta página no dice "acá están las ofertas": dice "acá están
// las puertas de entrada", y aclara entrada por entrada si esa puerta abre una
// búsqueda YA filtrada con el oficio del usuario o si no.
//
// Esa aclaración es lo único que hace que `searchKind` sea el campo central del
// contrato, y es la regla que esta vista NO puede negociar: si `searchKind` no es
// 'sitio', la tarjeta no puede presentar el link como una búsqueda filtrada. Es el
// mismo criterio que `_online` de `/api/jobs`: un rótulo no puede afirmar algo que
// el backend no verificó. Un "Buscar" sobre una URL que no está filtrada es una
// promesa falsa, y el usuario la descubre recién después de haber cargado la página.
//
// ── PROPS (las pasa `App.jsx`) ───────────────────────────────────────────────
//   · `data`    → el body de `GET /api/directorio`, o `null` si todavía no llegó
//                 (o si el backend no respondió: `loadDirectorio()` devuelve `null`
//                 y NO lanza, igual que `loadAnalytics`).
//   · `loading` → bandera del pedido en curso. Es LA que distingue "todavía no
//                 llegó" de "no hay nada": sin ella, un `data` en `null` durante la
//                 carga se pintaría como un directorio vacío, que es una mentira
//                 (mismo criterio que el `_online` del que habla arriba).
//   · `error`   → texto de error opcional. `App` NO lo pasa porque `loadDirectorio()`
//                 nunca lanza: el fallo ya está traducido en un `data` en `null`. Se
//                 acepta igual para no atar la firma de este componente a una sola
//                 fuente de datos.
//   · `onEditCv`→ callback OPCIONAL para abrir el editor del CV. Solo lo usa el
//                 aviso de "tu perfil todavía no tiene un oficio"; sin la prop, ese
//                 aviso es texto solo.
//
// Componente "tontito": sin estado propio. Todo lo que decide sale de las props.

import { usableUrl } from '../utils.js';
// ↑ Se REUSA el filtro de URL del proyecto en vez de repetir el regex acá:
//   `usableUrl` ya descarta '', '#' y lo que no sea http(s), así que una entrada
//   con un destino raro no puede terminar en un `href="javascript:..."`. La misma
//   razón por la que `JobDetailModal` no valida el link a mano.

const SEARCH_KINDS = {
  sitio: {
    pill: 'cat-qa',
    label: 'búsqueda filtrada',
    boton: 'Buscar',
    title: 'Se abre en una pestaña nueva con la búsqueda YA filtrada por tu oficio.',
  },
  google: {
    pill: 'cat-multi',
    label: 'vía Google',
    boton: 'Buscar',
    // ↑ OJO: el botón sigue diciendo "Buscar" porque ES una búsqueda, lo que cambia
    //   es quién la resuelve. No sabemos si el board de la consultora tiene una URL
    //   estable, así que la búsqueda se arma como `site:` de Google en vez de
    //   inventarse un link al portal. Decirlo acá es obligatorio: si la etiqueta no
    //   lo dijera, el usuario creería que es un buscador propio de la consultora.
    title: 'Abre una búsqueda de Google acotada al sitio de esta consultora. No rastreamos su board porque no sabemos si tiene una URL estable.',
  },
  ninguno: {
    pill: 'cat-gov',
    label: 'sin búsqueda filtrada',
    boton: 'Abrir el sitio',
    // ↓ El botón NO dice "Buscar" y la etiqueta NO dice lo mismo que en las otras
    //   dos: acá la URL es la portada o el listado, y el usuario tiene que filtrar
    //   a mano. Presentarlo como una búsqueda filtrada sería mentirle, y es además
    //   el caso más común: TODAS las entradas caen acá cuando el perfil no tiene
    //   ningún keyword con el que prellenar la URL.
    title: 'Esta web no tiene una URL de búsqueda confiable: se abre su portada o su listado y el filtrado queda a mano.',
  },
};
// ↑ Una entrada por `searchKind` del contrato, y SOLO las tres del brief. Lo que no
//   aparece (una entrada sin `searchKind`, o con un valor que alguien invente
//   mañana) se resuelve como 'ninguno' en `kindOf()`, no como 'sitio': el default
//   tiene que ser el que NO promete filtrado, porque un `searchKind` desconocido es
//   justo el caso en el que no sabemos qué se va a abrir.

function kindOf(entry) {
  // ↑ Un solo lugar decide qué se le dice a cada entrada. Si el `searchKind` no está
  //   en la tabla, cae en 'ninguno' (ver el comentario de arriba): sin dato, la
  //   postura honesta es no prometer.
  return SEARCH_KINDS[entry?.searchKind] || SEARCH_KINDS.ninguno;
}

// Una entrada del directorio: nombre, la nota de una línea y el link. La tarjeta
// reusa `.job-card`, que ya tiene el fondo, el borde, la sombra y el hover con
// `translateY` de las ofertas: es la misma caja con otro contenido.
function DirectorioCard({ entrada }) {
  const kind = kindOf(entrada);
  const url = usableUrl(entrada.searchUrl);

  return (
    <article className="job-card directorio-card">
      <div className="directorio-card-top">
        <h4 className="directorio-name">{entrada.name || entrada.site || 'Sitio sin nombre'}</h4>
        <span className={`cat-pill ${kind.pill}`} title={kind.title}>{kind.label}</span>
        {/* ↑ La etiqueta va PRIMERO que el link y dice qué se va a abrir, no qué
            hay del otro lado. El `title` repite la explicación larga para quien
            pasa el mouse, porque una chiapa de tres palabras no alcanza. */}
      </div>

      {entrada.note && <p className="directorio-note">{entrada.note}</p>}
      {/* ↑ La nota es una línea del backend: para qué sirve esa web. Se muestra tal
          cual y solo si vino: una tarjeta sin nota es más chica, no un error. */}

      <div className="directorio-foot">
        <span className="directorio-site">{entrada.site}</span>
        {/* ↑ El dominio en texto chiquito: le dice al usuario a dónde lo mandan
            ANTES de apretar, que es lo que hace un link externo poco conocido. */}
        {url ? (
          <a
            className="btn small secondary directorio-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            // ↑ `rel="noopener noreferrer"` NO es opcional en un link externo: sin
            //   `noopener`, la pestaña que abre el sitio recibe una referencia a
            //   nuestra ventana y con `window.opener` puede navegar esta app. Es el
            //   mismo `rel` que ya usan el link de LinkedIn de la Toolbar y el de
            //   AnalysisPage.
            title={kind.title}
          >
            {kind.boton}<span className="sr-only"> en {entrada.name}</span>
            {/* ↑ El `sr-only` agrega a qué sitio se va. Visualmente el botón dice
                solo "Buscar", y trece botones iguales en una grilla son
                indistinguibles para quien navega con lector de pantalla. */}
          </a>
        ) : (
          // ↓ Sin URL utilizable: se DIBUJA el botón igual, atenuado y con el
          //   texto de por qué. Es el mismo `.disabled-note` que usa el modal de
          //   detalle para la oferta sin link, y por el mismo motivo: un botón que
          //   aparece y desaparece hace pensar que la app se rompió.
          <span className="btn small disabled-note directorio-link">Sin link</span>
        )}
      </div>
    </article>
  );
}

// Una de las dos secciones (bolsas / consultoras). Está aparte porque las dos son el
// mismo markup y duplicarlo deja media chance de que una quede con el `h3` viejo y
// la otra con el nuevo.
function Seccion({ titulo, entradas, vacio }) {
  const lista = Array.isArray(entradas) ? entradas : [];
  // ↑ El backend manda arrays, pero `.map` sobre `undefined` revienta el render
  //   entero de la app. Blindar acá es lo que hace que un body raro se vea como
  //   "no hay entradas" en vez de una pantalla blanca.

  return (
    <section className="directorio-section">
      <h3>{titulo} <span className="directorio-count">{lista.length}</span></h3>
      {/* ↑ El número va en el título aunque la lista esté vacía: "Bolsas de empleo (0)"
          más el mensaje de vacío dicen "el catálogo se cargó y no tiene entradas", que
          es distinto de "todavía no sabemos cuántas hay". */}
      {lista.length === 0 ? (
        <div className="empty">{vacio}</div>
      ) : (
        <div className="directorio-grid">
          {lista.map((entrada, index) => (
            <DirectorioCard key={entrada?.id || entrada?.name || index} entrada={entrada} />
            // ↑ `key` por `id`; el índice solo como último recurso para una entrada
            //   sin id, que no debería pasar pero no puede romper el render.
          ))}
        </div>
      )}
    </section>
  );
}

export default function DirectorioPage({ data, loading, error, onEditCv }) {
  // ↑ Ver la cabecera del archivo: el shape de cada prop y por qué existe.

  if (loading) {
    return <div className="empty">Cargando el directorio de empleo…</div>;
    // ↑ Se devuelve ANTES del chequeo de `data`: sin esto, mientras carga el
    //   backend se vería "no hay entradas en el catálogo", que es un dato falso.
  }

  if (error) return <div className="empty">{error}</div>;
  // ↑ Ruta que `App` no usa hoy (`loadDirectorio` no lanza), dejada para que el
  //   componente sirva con cualquier otra fuente sin cambiar su firma.

  if (!data) {
    return (
      <div className="empty">
        No se pudo cargar el directorio de empleo. Volvé a entrar en la sección para reintentarlo.
      </div>
    );
    // ↑ `data` en `null` después de `loading` es el caso "no se pudo obtener": NO
    //   se dibuja un catálogo vacío, porque indistinguible de "todavía no cargó".
  }

  const keyword = typeof data.keyword === 'string' ? data.keyword.trim() : '';
  const terms = Array.isArray(data.terms) ? data.terms.filter((t) => typeof t === 'string' && t.trim()) : [];

  return (
    <div className="directorio">
      <div className="directorio-head">
        <h2>Directorio de empleo</h2>
        {/* ↑ El mismo título con texto degradado que la Propuesta de Interés y el
            header: es la misma jerarquía de "página dentro de la columna". */}
        <p className="directorio-lead">
          Bolsas de empleo y consultoras de selección de <strong>Argentina</strong>.{' '}
          <strong>No rastreamos estas webs</strong>: no se consulta ningún tablero de ofertas.
          Lo que hay abajo es una puerta de entrada a cada sitio,{' '}
          {keyword
            ? `con la búsqueda ya filtrada por “${keyword}”.`
            : 'y el filtrado queda a mano en cada sitio.'}
          {' '}Vos la abrís y la revisás con tu propia cuenta.
        </p>
        {/* ↑ El encabezado dice lo mismo que dice `searchKind` tarjeta por tarjeta,
            y no lo contradice: ninguna de las dos mitades promete una búsqueda
            filtrada cuando no la hay. Con `keyword` vacío la primera oración ya
            aclara que el filtrado es manual, así que el aviso de abajo no es la
            única señal. */}
      </div>

      {!keyword && (
        <div className="directorio-aviso" role="status">
          <p>
            <strong>Tu perfil todavía no tiene un oficio</strong>, así que las búsquedas salen
            {' '}SIN filtrar: abrís cada sitio y filtrás a mano. Subí o actualizá tu CV y las
            direcciones abren con tu oficio ya escrito.
          </p>
          {onEditCv && (
            <button className="btn small secondary directorio-link" onClick={onEditCv}>
              Actualizar mi CV
            </button>
          )}
          {/* ↑ El botón es OPCIONAL (`onEditCv`): sin la prop el aviso queda en
              texto. Es mejor un aviso sin botón que un botón que no haga nada, que
              es el modo de falla de "la acción existe pero no está conectada". */}
        </div>
      )}

      {terms.length > 0 && (
        <p className="directorio-terms">
          Términos con los que se prellenó la búsqueda:{' '}
          <strong>{terms.join(', ')}</strong>
        </p>
      )}
      {/* ↑ Se muestran porque explican de dónde sale el filtro de las URLs. Si el
          perfil tuviera otros sinónimos, el link abriría con estos y no con lo que
          el usuario espera de su oficio. Solo informational: no es un control. */}

      <Seccion
        titulo="Bolsas de empleo"
        entradas={data.bolsas}
        vacio="No hay bolsas cargadas en el catálogo de esta región."
      />
      <Seccion
        titulo="Consultoras y selección"
        entradas={data.consultoras}
        vacio="No hay consultoras cargadas en el catálogo de esta región."
      />
    </div>
  );
}