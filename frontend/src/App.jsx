import { useEffect, useState, useCallback, useMemo } from 'react';
// ↑ Hooks de React: useState (memoria del componente), useEffect (efectos como
//   cargar datos al inicio), useCallback (funciones "memorizadas" que no se
//   recrean en cada render, cosa que los hijos no se re-rendericen de más) y
//   useMemo (guardar el RESULTADO de un cálculo para no repetirlo en cada render).

import CvPanel from './components/CvPanel.jsx';
// ↑ Panel lateral con el perfil del usuario (avatar, sobre mí, skills, enlaces).

import CvOnboarding from './components/CvOnboarding.jsx';
// ↑ La segunda etapa del alta: subir el CV y revisar el perfil derivado antes de
//   guardarlo. Es el mismo componente que hace de compuerta (sin perfil) y de
//   editor (con perfil), y se apoya en el estado `profile` de este componente.

import AuthScreen from './components/AuthScreen.jsx';
// ↑ La PRIMERA compuerta del alta: entrar o crear la cuenta. Se dibuja en vez de
//   hacer un redirect a /login porque la app no tiene router, y un condicional que
//   devuelve el mismo componente siempre resuelve el caso del F5 sobre /login.

import RegionTabs, { esSeccion } from './components/RegionTabs.jsx';
// ↑ Pestañas para cambiar de región (países) o de sección (Propuesta de Interés y
//   Directorio de empleo). `esSeccion` viene del MISMO archivo a propósito: la lista
//   de pestañas que no son países se declara una sola vez, acá adentro, y este
//   componente la usa para preguntar "¿estoy en una sección o en una región con
//   ofertas?" sin volver a escribir `region === 'analisis' || …` en cinco ramas.

import Toolbar from './components/Toolbar.jsx';
// ↑ Barra de acciones: actualizar búsqueda, historial y buscar en LinkedIn.

import JobList from './components/JobList.jsx';
// ↑ Lista de ofertas de la región actual, con paginación y badge de historial.

import AnalysisPage from './components/AnalysisPage.jsx';
// ↑ Página "Propuesta de Interés": gráficos que comparan el mercado vs. el CV.

import DirectorioPage from './components/DirectorioPage.jsx';
// ↑ Página "Directorio de empleo": catálogo de bolsas y consultoras de Argentina
//   con la búsqueda ya filtrada por el oficio del usuario. Es una sección más, no
//   una región: no devuelve ofertas, devuelve links.

import JobDetailModal from './components/JobDetailModal.jsx';
// ↑ Modal con el detalle de una oferta (skills, descripción, copiar resumen).

import LetterModal from './components/LetterModal.jsx';
// ↑ Modal que muestra la carta de presentación generada y la deja copiar/descargar.

import DeleteAccountModal from './components/DeleteAccountModal.jsx';
// ↑ Cuarto modal, y el único que llama a la API por su cuenta: pide una frase
//   escrita antes de mandar el DELETE y se ocupa del error sin cerrar (el error
//   de un borrado que NO ocurrió no puede perderse). Ver el componente.

import { linkedinProfileKeywords, timeAgo } from './utils.js';
// ↑ linkedinProfileKeywords arma la query de la búsqueda de LinkedIn;
//   timeAgo convierte el `checkedAt` del backend en "actualizado hace X".

import { regionLabel } from '../../lib/regions.js';
// ↑ El nombre visible de cada región, de la configuración compartida con el
//   backend: la UI no tiene su propia lista de países (ver la nota de más abajo).

import {
  loadProfile, loadJobs, loadHistory, refreshJobs,
  loadJobDetail, loadCoverLetter, loadAnalytics, searchLinkedInJobs,
  loadSession, logout, loadDirectorio,
} from './api.js';
// ↑ Importamos las funciones de la capa de API. Cada una hace un fetch al backend
//   y, si falla, devuelve datos de respaldo para que la UI nunca quede vacía. Las
//   únicas excepciones son las del ALTA —`loadProfile()` (devuelve null y lo
//   dice, porque inventar un perfil de relleno sería mostrarle a un contador el
//   CV de otra persona), `loadSession()`, `parseCv()`, `saveProfile()`, y las tres
//   de auth (`login`, `register`, `logout` en `AuthScreen.jsx`)—: devuelven el
//   motivo del fallo en vez de disimularlo, porque en el alta un error silencioso
//   es una pérdida de datos.
// ↑ `login` y `register` NO se importan acá: los usa el componente de la pantalla
//   de acceso, que es quien tiene el formulario. Acá solo hace falta `logout`, y
//   hasta él podría haberlo encapsulates el propio header; ver `handleLogout`.

// Nombres de las regiones para poder hablar de "otras regiones" sin mostrar claves
// internas como 'argentina' en un texto que lee el usuario.
// ↑ No hay ninguna tabla acá: se usa `regionLabel()` de la configuración compartida
//   (`api/lib/regions.js`), que ya devuelve el label y, si la clave no existe, la
//   propia clave. Antes eran 7 países escritos a mano en este archivo (el cuarto de
//   los cinco lugares repetidos de AGENTS.md), y cualquier región que no estuviera
//   en la lista se leía cruda al usuario.

// Traduce el objeto `stats` del backend a las filas que muestra el <details>.
// ↑ ¿POR QUÉ EXISTE ESTA TABLA? Porque `stats` viene en inglés y en claves cortas
//   (recibidos, sinLink, viejas, sinMatch, otrasRegiones): mostrarlo crudo sería
//   "recibidos 100 / sinLink 3", que no responde la pregunta del usuario ("¿por
//   qué veo 60 y no 200?"). Cada fila tiene su etiqueta en castellano y una
//   frase corta que explica POR QUÉ se perdió cada cosa.
//   Se devuelve el total perdido además del detalle, porque la pregunta del
//   <summary> se arma con esa resta y no con `stats.total` (que no existe).
function buildStatsReport(meta) {
  const stats = meta?.stats;
  if (!stats) return null;

  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  // ↑ Number() con Number.isFinite: el backend manda números, pero un stats
  //   viejo o truncado no debe romper el render con "NaN ofertas perdidas".

  const otras = Object.entries(meta.regions || {})
    // ↓ Se recorren los buckets para poder NOMBRAR las otras regiones con
    //   ofertas, no solo contarlas. `stats.otrasRegiones` ya viene calculado;
    //   esto solo agrega el detalle de dónde quedaron.
    .filter(([key, list]) => key !== meta.origin && Array.isArray(list) && list.length > 0)
    .sort((a, b) => b[1].length - a[1].length);

  const items = [
    { label: 'Le pedimos a LinkedIn', value: num(stats.recibidos), hint: 'ofertas crudas' },
    { label: 'Sin link directo', value: num(stats.sinLink), hint: 'no se pueden mostrar' },
    { label: 'Muy viejas', value: num(stats.viejas), hint: 'fuera de la ventana de 30 días' },
    { label: 'Repetidas', value: num(stats.duplicados), hint: 'la misma oferta en dos páginas' },
    { label: 'Sin match con tu CV', value: num(stats.sinMatch), hint: 'no coinciden con tu perfil' },
    {
      label: 'En otra región',
      value: num(stats.otrasRegiones),
      hint: otras.length ? otras.map(([key, list]) => `${regionLabel(key)} (${list.length})`).join(', ') : 'ninguna',
    },
  ].map((item) => ({ ...item, zero: item.value === 0 }));
  // ↑ `zero` marca las filas en cero para que el CSS las atenúe: lo que vale la
  //   pena mirar es dónde se perdieron ofertas, no una lista de ceros.

  const perdidas = num(stats.sinLink) + num(stats.viejas) + num(stats.duplicados) + num(stats.sinMatch) + num(stats.otrasRegiones);
  // ↑ Los cinco motivos de descarte, sumados. La resta del <summary> es
  //   guardados - perdidas, NO recibidos - pedidas: los recibidos incluyen los
  //   duplicados, que también se descartaron, y con la otra cuenta el número del
  //   summary no cerraba con ninguna de las filas de la tabla.
  // ↑ La resta del <summary> se hace con ESTOS cinco, no con recibidos - pedido:
  //   `stats.recibidos` incluye duplicados que sí se descartaron, y pedir - recibidas
  //   daba un número que no cerraba con ninguna de las filas de arriba.

  return {
    pedidas: num(meta.resultLimit) || 0,
    guardados: num(stats.guardados),
    perdidas,
    items,
  };
  // ↑ No se manda la cantidad que quedó en pantalla a propósito: esa lista pasa
  //   por el filtro de % de match, así que su número mezcla dos cosas (lo que
  //   descartó Apify y lo que filtró el usuario). Por eso el <summary> habla de
  //   la corrida, y el total filtrado ya está en el texto de estado de arriba.
}

function getSavedTheme() {
  try {
    return localStorage.getItem('buscaempleo-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

// Clave del almacenamiento del navegador donde vive el % de match mínimo elegido.
// ↑ Sigue el mismo patrón que el tema ('buscaempleo-theme'): es una preferencia
//   de ESTA computadora, no del backend. Con el prefijo 'bt_' no chocamos con
//   otras apps que compartan el mismo dominio.
const MIN_SCORE_STORAGE_KEY = 'bt_min_score';

// Lee del navegador el % de match mínimo con el que quedó la sesión anterior.
// ↑ Mismo patrón perezoso que el tema: se le pasa la FUNCIÓN a useState, que la
//   ejecuta una sola vez al montar. Si no hay nada guardado, arranca en 0 (ver
//   todo). Si lo que hay guardado está corrupto ("abc", "NaN", un objeto), se
//   devuelve 0 en vez de romper: la app nunca crashea al cargar.
function getSavedMinScore() {
  try {
    const raw = localStorage.getItem(MIN_SCORE_STORAGE_KEY);
    if (raw === null) return 0;
    // ↑ null = nunca se guardó nada: es el primer arranque, devolvemos el default.
    const parsed = Number(raw);
    // ↑ localStorage guarda TEXTO. Number() lo vuelve número: "82" -> 82, y "abc"
    //   -> NaN, que es justamente el caso que hay que descartar.
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) return 0;
    // ↑ Solo aceptamos un entero de 0 a 100. Cualquier otra cosa (NaN, 82.5, 500,
    //   -3) se trata como "no había nada guardado" y vuelve al 0 por defecto.
    return parsed;
  } catch {
    return 0;
  }
}

export default function App() {
  // ↑ Este es el componente padre: acá vive casi todo el estado global de la app y
  //   desde acá se le pasan datos y funciones (callbacks) a los hijos por props.

  const [profile, setProfile] = useState(null);
  // ↑ Perfil del usuario (skills, contacto, etc.), o null si todavía no subió su
  //   CV. Empieza en null porque aún no llegó la respuesta de la API.

  const [sesion, setSesion] = useState({ estado: 'desconocido' });
  // ↑ Qué sabe el frontend de la sesión. Un string y no un booleano porque hay
  //   TRES respuestas distintas de `/api/me` y la UI las trata distinto:
  //     'desconocido'  → todavía no respondió (o no hay backend): la app se
  //                      dibuja como antes, con el FALLBACK de ofertas.
  //     'logueado'     → hay cookie: si falta el perfil, se muestra la compuerta
  //                      del CV (401 → /login y 403 → onboarding, según AGENTS).
  //     'sin-sesion'   → el backend respondió 401: avisar, no mandar a subir un CV.
  //     'sin-respuesta'→ no hubo respuesta: NO se puede culpar a la sesión.
  //   La última distinción es la que importa: sin ella, con el server caído se
  //   le diría a alguien "iniciá sesión" y el login tampoco iba a funcionar.

  const [editando, setEditando] = useState(false);
  // ↑ Si el editor de perfil está abierto. Es un modal (no una compuerta) porque
  //   el perfil ya existe: corregir un peso de skill no debería obligar a subir
  //   el CV otra vez y gastar otro análisis de la cuota del LLM.

  const [borrandoCuenta, setBorrandoCuenta] = useState(false);
  // ↑ Si el modal de confirmación del borrado está abierto. Vive acá y no dentro
  //   del modal, por la misma razón que `editando`: el modal se monta y se
  //   desmonta, así que su estado interno se pierde en cada cierre. Si el "¿estás
  //   seguro?" viviera adentro, abrir y cerrar el modal borraría la frase escrita
  //   —que es justo lo que alguien que se arrepiente quiere conservar—.

  const [region, setRegion] = useState('argentina');
  // ↑ Región seleccionada. Arranca en Argentina y cambia al hacer click en las tabs.

  const [viewMode, setViewMode] = useState('live'); // 'live' | 'history'
  // ↑ Vista actual: 'live' muestra las ofertas recién buscadas y 'history' las ofertas
  //   vistas desde enero 2026 (con badge de activas/inactivas).

  const [jobsData, setJobsData] = useState({ jobs: [], _online: false });
  // ↑ Objeto que guarda las ofertas de la región y si vienen online o demo.
  //   _online nos permite mostrar un mensaje distinto según el origen de los datos.

  const [minScore, setMinScore] = useState(getSavedMinScore);
  // ↑ Filtro de "% de match mínimo" (0 = mostrar todas). Es un estado GLOBAL de
  //   la app, no por región: el usuario lo elige una vez y se mantiene al cambiar
  //   de pestaña o de vista (live/historial). Se inicializa con la función
  //   getSavedMinScore, que lee el valor de la sesión anterior del navegador.

  const [analytics, setAnalytics] = useState(null);
  // ↑ Datos agregados del mercado para la página "Propuesta de Interés" (KPIs, barras, brechas).

  const [directorio, setDirectorio] = useState(null);
  // ↑ Catálogo de bolsas y consultoras de la página "Directorio de empleo".
  //   `null` = todavía no se pidió (o el backend no respondió: `loadDirectorio()`
  //   devuelve null y no lanza). NO se inicializa con un catálogo vacío: la
  //   diferencia entre "no llegó" y "no hay" la hace `directorioCargado`.

  const [directorioCargado, setDirectorioCargado] = useState(false);
  // ↑ ¿Ya se pidió el directorio en esta sesión? Existe para no pegarle al
  //   endpoint cada vez que se entra y sale de la pestaña: el catálogo NO depende de
  //   la región que se está viendo ni de la vista live/historial, así que volver a
  //   pedirlo devolvería exactamente lo mismo. Se reinicia en dos momentos que sí lo
  //   cambian: al guardar el perfil (cambia el keyword con el que se prellenan las
  //   URLs) y al limpiar la sesión.

  const [loading, setLoading] = useState(true);
  // ↑ Bandera que indica si se está cargando. Sirve para mostrar "Cargando…" en la toolbar.

  const [refreshing, setRefreshing] = useState(false);
  // ↑ Bandera del botón "Actualizar búsqueda": se pone en true mientras el refetch corre.

  const [searchingLinkedIn, setSearchingLinkedIn] = useState(false);
  const [linkedinSearchError, setLinkedInSearchError] = useState('');
  // ↑ Mensaje de error de la búsqueda de Apify, si la hubo. Va aparte de
  //   `linkedinMeta` a propósito: un error pertenece a UNA corrida, y si se
  //   mezclara con los metadatos el error viejo aparecería junto a los datos
  //   nuevos de la corrida que sí funcionó.

  const [apifyLimit, setApifyLimit] = useState(() => Number(localStorage.getItem('apifyLimit') || 200));
  // ↑ Persiste en localStorage para que el usuario no tenga que reponerlo
  //   cada sesión. El default 200 coincide con APIFY_MAX_RESULTS del backend.

  const [refreshNote, setRefreshNote] = useState('');
  // ↑ Aviso del botón "Actualizar búsqueda". Existe porque ese botón NO llama a
  //   Apify: solo re-consulta las fuentes gratuitas. Sin esta nota, tocarlo
  //   reemplazaba en silencio la lista de Apify por la de las gratuitas.

  const [linkedinMeta, setLinkedinMeta] = useState(null);
  // ↑ Metadatos de la ÚLTIMA corrida de Apify: { saved, stats, checkedAt,
  //   resultLimit, regions }. Antes no se guardaba nada de esto, y por eso el
  //   usuario no tenía forma de saber si lo que veía se había guardado.
  //   `regions` además sirve para no perder las ofertas que el backend metió en
//   OTRO bucket que el pedido: la respuesta trae un bucket por región y
      //   `jobs` es solo el pedido, así que guardar solo `jobs` perdía parte de lo
      //   que se pagó.

  const [selectedJob, setSelectedJob] = useState(null); // { job, summary, region }
  // ↑ Oferta seleccionada para abrir el modal de detalle. null = modal cerrado.
  //   Cuando hay valor, guarda la oferta, su resumen y la región de la que vino.

  const [letter, setLetter] = useState(null);
  // ↑ Carta de presentación generada. null = modal de carta cerrado.

  const [theme, setTheme] = useState(getSavedTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('buscaempleo-theme', theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(MIN_SCORE_STORAGE_KEY, String(minScore));
      // ↑ Se guarda como texto (localStorage solo guarda strings) y se vuelve a
      //   leer con Number() en getSavedMinScore. El try/catch cubre el caso de
      //   navegación privada o almacenamiento lleno: el filtro sigue funcionando
      //   en memoria, solo no sobrevive al F5.
    } catch {}
  }, [minScore]);
  // ↑ Cada vez que cambia el filtro se persiste. Con el filtro en 0 también se
  //   guarda: así "volver a 0" se recuerda entre sesiones, que es lo esperado.

  // Al montar el componente (corre UNA sola vez porque el array de dependencias está vacío),
  // traemos el perfil y las ofertas de Argentina en paralelo con Promise.all.
  useEffect(() => {
    (async () => {
      const [s, p, j] = await Promise.all([loadSession(), loadProfile(), loadJobs('argentina')]);
      // ↑ Desestructuración de promesas: s = sesión, p = perfil, j = ofertas. Todas
      //   corren a la vez, así no esperamos una para empezar la otra. `/api/me` va
      //   en el mismo Promise.all aunque no pinte nada por sí solo: la compuerta
      //   del CV depende de él, y encadenarlo sería esperar una request de más.

      setSesion(s.ok
        ? { estado: 'logueado', user: s.user, profileComplete: s.profileComplete }
        : { estado: s.reason });
      setProfile(p);
      setJobsData(j);
      setLoading(false);
      // ↑ Una vez que llegan los datos, los guardamos en estado y apagamos el loading.
    })();
  }, []);
  // ↑ Dependencias vacías: este efecto NO vuelve a ejecutarse en los re-renders.

  // Recibe el perfil que el backend GUARDÓ y lo pone en el estado global. Es el
  // callback que usa `CvOnboarding` en los dos casos (alta y edición).
  // ↑ Se pasa el perfil LEÍDO de la base, no el borrador del formulario: así el
  //   `headline` derivado, el orden de las skills por peso y el redondeo de los
  //   años son los mismos que va a leer el próximo `GET /api/profile`, y el resto
  //   de la app (el panel, las ofertas, la analítica) matchea contra lo que está
  //   en la base y no contra lo que el usuario escribió.
const handleProfileSaved = useCallback((guardado) => {
    setProfile(guardado);
    setSesion((actual) => ({ ...actual, profileComplete: true }));
    setEditando(false);
    setDirectorioCargado(false);
    // ↑ El directorio se invalida SOLO acá y no en cada cambio de perfil: es el único
    //   momento en que puede cambiar el keyword con el que el backend prellena las
    //   URLs de las bolsas. Sin esto, un usuario que sube su CV y después lo corrige
    //   vería las URLs construidas con el keyword viejo, y el aviso de "tu perfil no
    //   tiene oficio" le diría lo contrario de lo que su perfil dice. Los datos
    //   siguen cacheados: la próxima entrada a la pestaña los vuelve a pedir.
    // ↑ El `profileComplete` se actualiza acá porque **sí** se usa para rutear: la
    //   compuerta del alta se abre con `sesion.profileComplete === false` (§4.6 de
    //   MEMORIA.md), así que sin esta línea, guardar el perfil cerraría el modal
    //   del editor pero dejaría la compuerta del alta dibujada atrás, con un perfil
    //   ya cargado.
  }, []);
  // ↑ useCallback con dependencias vacías: la función no cambia nunca, así que el
  //   formulario no se re-renderiza de más por culpa de este callback.

  // Función que se ejecuta cuando el usuario elige una región/tab. useCallback la
  // "memoriza": solo se recrea si cambia viewMode, evitando renders innecesarios.
  const goToRegion = useCallback(async (nextRegion) => {
    setRegion(nextRegion);
    setLinkedInSearchError('');
    // ↑ Limpiamos el error de búsqueda de LinkedIn al cambiar de región:
    //   el error pertenece a la corrida anterior y no debe mostrarse junto
    //   a los datos de la nueva región.
    // ↑ Actualizamos la región elegida en el estado para que la tab quede "activa".

    if (nextRegion === 'analisis') {
      // ↑ La pestaña "Propuesta de Interés" carga el agregado de analítica.
      setLoading(true);
      setAnalytics(await loadAnalytics());
      setLoading(false);
      return;
    }

    if (nextRegion === 'directorio') {
      // ↑ El Directorio va ANTES de la rama de las regiones y hace un `return`
      //   temprano, a propósito. `/api/directorio` NO devuelve ofertas, así que si
      //   cayera en el camino de abajo haría `loadJobs('directorio')`: el backend
      //   normalizaría esa clave inexistente a la región por defecto (nunca 400) y
      //   se mostraría la lista de ofertas de Argentina al lado de un catálogo de
      //   links. Es el mismo error de "el 400 del query param es un problema del
      //   cliente" que aparece en AGENTS.md, del revés: acá el problema es no
      //   preguntar antes de pegarle a un endpoint.
      // ↓ Y NO llama a `loadHistory` por el mismo motivo: el historial son las
      //   ofertas que el usuario vio, no tiene nada que ver con un catálogo.
      if (directorioCargado) return;
      // ↑ Ya se pidió en esta sesión: no se vuelve a pegarle al endpoint. Es un
      //   catálogo, no una búsqueda: la respuesta no cambia con el tiempo.
      setLoading(true);
      setDirectorio(await loadDirectorio());
      setDirectorioCargado(true);
      // ↑ Se marca incluso si volvió `null`: `loadDirectorio` no lanza, así que la
      //   única forma de "volver a intentar" es entrar y salir de la pestaña, y
      //   ponerlo acá evita un bucle infinito de requests si algún día cambia.
      setLoading(false);
      return;
    }

    // Cualquier otra tab es un país: buscamos las ofertas según la vista activa
    // (live = resultados frescos, history = historial guardado).
    setLoading(true);
    const apifyBucket = viewMode === 'live' ? linkedinMeta?.regions?.[nextRegion] : null;
    // ↓ Si la última corrida de Apify dejó ofertas PARA ESTA REGIÓN, se muestran
    //   esas y no se vuelve a pegarle al backend. Motivo: son más frescas que
    //   /api/jobs (que no incluye Apify) y el usuario ya las pagó. Sin esto, el
    //   aviso "Además hay N en Europa" del status sería mentira apenas se cambia
    //   de pestaña: la lista se reemplazaba por las fuentes gratuitas.
    if (apifyBucket && apifyBucket.length) {
      setJobsData({
        region: nextRegion,
        jobs: apifyBucket,
        _online: true,
        source: 'LinkedIn / Apify',
        checkedAt: linkedinMeta.checkedAt,
        fromApify: true,
      });
      setRefreshNote('');
    } else {
      setJobsData(viewMode === 'history' ? await loadHistory(nextRegion) : await loadJobs(nextRegion));
    }
    setLoading(false);
  }, [viewMode, linkedinMeta, directorioCargado]);
  // ↑ `directorioCargado` entra en las dependencias por el mismo motivo que las otras
  //   dos: el callback lee esa bandera para NO volver a pedir el catálogo, así que si
  //   no fuera una dependencia, `goToRegion` cerraría sobre el `false` de siempre y
  //   cada visita a la pestaña pegaría un request de más.

  // Callback que recibe el % de match mínimo elegido en la toolbar. Es la
  // SEGUNDA capa de validación: el Toolbar ya no deja pasar valores fuera de
  // 80-100 desde el campo, pero acá se vuelve a acotar el rango para que el
  // estado nunca pueda quedar en un número imposible (aunque el valor venga de
  // un botón, de una extensión o de un futuro control).
  const handleMinScoreChange = useCallback((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    // ↑ Si no es un número (NaN, texto vacío) se ignora: el filtro sigue como
    //   estaba y no se toca el listado.
    const rounded = Math.round(parsed);
    setMinScore(Math.min(100, Math.max(0, rounded)));
    // ↑ Math.min/max "aprieta" el valor al rango 0-100. Es la garantía de que
    //   minScore siempre es un entero válido, venga de donde venga.
  }, []);
  // ↑ useCallback con dependencias vacías: la función no cambia nunca, así que
  //   Toolbar no se re-renderiza de más por culpa de este callback.

  // Callback para el límite de Apify: valida, acota y persiste en localStorage.
  const handleApifyLimitChange = useCallback((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    // ↑ Si no es un número (NaN, texto vacío) se ignora.
    const clamped = Math.min(1000, Math.max(20, Math.round(parsed)));
    // ↑ Acota entre 20 y 1000 (el backend también valida, pero acá evitamos
    //   mandar valores imposibles).
    setApifyLimit(clamped);
    localStorage.setItem('apifyLimit', String(clamped));
    // ↑ Persiste para que sobreviva al F5 y a nuevas sesiones.
  }, []);
  // ↑ useCallback con dependencias vacías: la función no cambia nunca.

  // Acción del botón "Actualizar búsqueda": fuerza al backend a re-consultar las fuentes
  // (ignorando la caché de 30 min) y recarga la región actual.
  async function handleRefresh() {
    // El Directorio tiene su propia rama, y va PRIMERO: ni siquiera llega al
    // `POST /api/refresh`, que existe para saltear el TTL de la caché de OFERTAS
    // (ver AGENTS.md). Llamarlo desde acá sería pedirle al backend una corrida
    // contra las cinco bolsas gratuitas para, después, no usar ni una de esas
    // ofertas: trabajo de red que se paga con tiempo del usuario y no cambia lo que
    // ve. "Actualizar" en esta vista significa volver a pedir el catálogo, que es lo
    // único que esta pantalla puede tener fresco.
    if (region === 'directorio') {
      setRefreshing(true);
      setDirectorio(await loadDirectorio());
      setDirectorioCargado(true);
      setRefreshing(false);
      // ↑ Se vuelve a marcar como cargado porque ya lo está: lo que se reintenta es el
      //   request, no el flag.
      return;
    }

    setRefreshing(true);
    const result = await refreshJobs();
    // ↑ refreshJobs() ahora devuelve { ok }. Antes era fire-and-forget: si el
    //   POST fallaba, la lista se recargaba igual y la pantalla juraba que
    //   estaba actualizada cuando en realidad seguía con lo viejo.
    if (result && result.ok === false) {
      setRefreshNote('No se pudo actualizar: el backend no respondió. La lista que ves es la anterior.');
    }
    // ↑ Aviso explícito en vez de dejar la pantalla mintiendo con "recién
    //   actualizado". No bloquea nada: los datos que ya están siguen sirven.
    // En la pestaña Propuesta de Interés, el refresh debe recalcular la analítica
    // (no hay ofertas de una región que recargar como en las pestañas de países).
    if (region === 'analisis') {
      setAnalytics(await loadAnalytics());
    } else if (viewMode === 'history') {
      setJobsData(await loadHistory(region));
    } else if (jobsData.fromApify) {
      // ↓ CASO QUE ANTES PERDÍA DATOS: "Actualizar búsqueda" llama a
      //   POST /api/refresh, que re-consulta SOLO las fuentes gratuitas. La lista
      //   en pantalla venía de Apify, así que recargarla la reemplazaba entera
      //   por las gratuitas y las ofertas que el usuario pagó desaparecían de la
      //   vista (seguían en el historial, pero en pantalla no había rastro).
      //   Ahora se respeta lo que se está viendo y se explica qué pasó.
      setRefreshNote('Se actualizaron las fuentes gratuitas, pero la lista que ves viene de Apify y se mantiene: las ofertas de Apify no se vuelven a traer sin pagar otra ejecución. Ya están guardadas en tu base, así que las podés ver con "Desde enero 2026".');
      // ↑ NO se reemplaza jobsData. Reemplazarla era justo lo que hacía
      //   desaparecer de la pantalla lo que el usuario había pagado. Los datos
      //   frescos de las gratuitas quedan disponibles en cuanto el usuario
      //   vuelva a una lista normal (cambiar de región o tocar Apify).
    } else {
      setJobsData(await loadJobs(region));
    }
    setRefreshing(false);
  }

  async function handleLinkedInSearch() {
    setSearchingLinkedIn(true);
    setLinkedInSearchError('');
    setRefreshNote('');
    // ↑ Se borra la nota del refresh anterior: con la corrida nueva queda
    //   obsoleto un mensaje que decía "esto no lo toqué".
    try {
      const data = await searchLinkedInJobs(region, apifyLimit);
      // ↑ Se manda el limit de la toolbar. Ojo con el contrato: la respuesta
      //   trae MÁS de lo pedido (el backend pagina hasta 8 páginas), así que
      //   `total` NO tiene que coincidir con lo que dice el botón.

      // ↓ Se guarda la respuesta COMPLETA en `linkedinMeta` y NO en jobsData.
      //   Antes era al revés y por eso la lista se perdía: `jobs` es solo el
      //   bucket pedido, mientras que `regions` trae todos los buckets configurados.
      //   Guardar solo `jobs` descartaba las ofertas que matchRegion() metió en
      //   otro bucket (una de location "Berlin" en una búsqueda de Argentina, que
      //   matchRegion() descarta hoy), que es exactamente el dato que el usuario
      //   pagó y no veía.
      setLinkedinMeta({
        saved: data.saved || null,
        stats: data.stats || null,
        checkedAt: data.checkedAt || null,
        resultLimit: data.resultLimit || null,
        regions: data.regions || {},
        origin: region,
        // ↑ `origin`: la región para la que se buscó. Sirve para distinguir
        //   "el usuario pidió Argentina" de "el bucket se llama Argentina".
      });

      // ↓ Y la lista visible sale del bucket pedido, para no mezclar de golpe
      //   78 ofertas con las de las fuentes gratuitas.
      setJobsData({
        region: data.region,
        jobs: data.jobs || [],
        _online: data._online,
        source: data.source,
        checkedAt: data.checkedAt,
        fromApify: true,
        // ↑ Marca de que esta lista viene de Apify. La usa handleRefresh() para
        //   NO pisar esta lista con las fuentes gratuitas sin avisar.
      });
      setViewMode('live');
    } catch (error) {
      setLinkedInSearchError(error.message || 'No se pudo buscar en LinkedIn.');
    } finally {
      setSearchingLinkedIn(false);
    }
  }

  // Alterna entre vista live e historial, y recarga los datos que correspondan.
  // OJO: al volver de historial a "live" NO se sobreescribe lo que hay: si la
  // última búsqueda fue la de Apify, esa lista sigue en pantalla y las ofertas
  // ya están en el historial, así que no hay nada que recargar.
  async function handleToggleHistory() {
    const next = viewMode === 'history' ? 'live' : 'history';
    setViewMode(next);
    if (esSeccion(region)) return;
    // ↑ Todas las secciones, no solo la de análisis: en Propuesta de Interés y en el
    //   Directorio solo cambia la vista global, porque su contenido no depende del
    //   historial. Sin esta línea, tocar "Desde enero 2026" desde el Directorio haría
    //   `loadHistory('directorio')` — un endpoint de ofertas con una clave de región
    //   que no existe — y debajo quedaría una lista vacía al lado del catálogo. Es el
    //   mismo modo de falla que el de `goToRegion`: no preguntar antes de pegarle a un
    //   endpoint. El botón está oculto en las secciones (`Toolbar` usa este mismo
    //   `esSeccion`), así que hoy la rama es una barrera, no un arreglo visible.
    setLoading(true);
    if (next === 'history') {
      setJobsData(await loadHistory(region));
    } else if (jobsData.fromApify && region === linkedinMeta?.origin) {
      // ↓ Al volver a "live" después de mirar el historial: si lo que se estaba
      //   viendo era la corrida de Apify, NO se toca jobsData. Antes se llamaba a
      //   loadJobs() siempre, y eso reemplazaba las ofertas de Apify por las de
      //   las fuentes gratuitas cada vez que se alternaba la vista: de ahí la
      //   sensación de "se me pierden". Acá ya están en el historial igual, pero
      //   en pantalla tiene que seguir viéndose lo que el usuario_BUSCÓ.
    } else {
      setJobsData(await loadJobs(region));
    }
    setLoading(false);
  }

  // Abre el modal de detalle de una oferta. Primero pide el detalle enriquecido
  // (resumen de empresa y skills); si no lo consigue, usa la oferta del listado.
  async function openDetail(id) {
    const data = await loadJobDetail(id);
    if (data) {
      setSelectedJob({ job: data.job, summary: data.summary, region });
    } else {
      const fallback = (jobsData.jobs || []).find((j) => j.id === id);
      // ↑ find() recorre el arreglo y devuelve la primer oferta cuyo id coincida.
      setSelectedJob({ job: fallback, summary: null, region });
    }
  }

  // Genera la carta de presentación para una oferta. Si la API falla, arma una
  // carta básica en el cliente usando el título, la empresa y el perfil.
  async function handleGenerateLetter(id, letterRegion) {
    const data = await loadCoverLetter(letterRegion, id);
    if (data) {
      setLetter(data);
    } else {
      const job = (jobsData.jobs || []).find((j) => j.id === id) || selectedJob?.job;
      // ↑ Optional chaining: si selectedJob está null, no explota, devuelve undefined.
      setLetter({
        subject: `Postulación - ${job?.title || ''}`,
        // ↑ Sin perfil no firmamos con el nombre de nadie: este cuerpo se copia al
        //   portapapeles y se manda a la empresa, así que va sin firma antes que con
        //   la de otra persona.
        body: `Hola equipo de ${job?.company || ''},\n\nMe postulo a la vacante con mi CV adjunto.${profile?.fullName ? `\n\nSaludos,\n${profile.fullName}` : ''}`,
      });
    }
  }

  // Lista de ofertas YA filtrada por % de match: solo las que llegan al mínimo.
  // ↑ Se calcula con useMemo porque es un filtro sobre un arreglo que puede
  //   tener cientos de ofertas: sin memo se repetiría en CADA re-render (al
  //   cambiar de tema, al abrir un modal, etc.) aunque el filtro no cambie.
  const visibleJobs = useMemo(
    () => (jobsData.jobs || []).filter((job) => Number(job.score ?? 0) >= minScore),
    [jobsData.jobs, minScore],
  );
  // ↑ El ?? 0 trata una oferta sin score como 0% de match, que es lo mismo que
  //   "sin filtro": así nunca desaparecen ofertas por un dato que no vino.
  //   El .filter NO modifica el arreglo original: devuelve uno nuevo.

  // Resumen de la última corrida de Apify para la toolbar: confirmación de
  // guardado, "actualizado hace X" y las estadísticas plegables.
  // ↑ Se arma acá y no en Toolbar porque necesita saber si la corrida fue la que
  //   se está mirando: mostrar "se guardaron N ofertas" mientras se ve otra
  //   región sería mentir.
  const linkedinReport = useMemo(() => {
    if (!linkedinMeta) return { saved: null, checkedAgo: '', stats: null, effectiveLimit: null };
    // ↑ Sin corrida todavía no hay nada que mostrar: cero banner, cero stats.

    const saved = linkedinMeta.saved
      ? {
        ok: Boolean(linkedinMeta.saved.ok),
        // ↑ El backend ya manda un `message` en español; se usa ese texto y
        //   solo se agrega el prefijo con el ícono, para no tener dos frases
        //   distintas diciendo lo mismo.
        text: linkedinMeta.saved.message || (linkedinMeta.saved.ok
          ? `Se guardaron ${linkedinMeta.saved.total} ofertas en tu base.`
          : 'La búsqueda funcionó pero las ofertas NO se guardaron.'),
      }
      : null;
    // ↑ null cuando el backend no mandó `saved`: es un caso distinto de "se
    //   guardaron 0" y tiene que verse distinto (nada vs. "no se pudo guardar").

    return {
      saved,
      checkedAgo: timeAgo(linkedinMeta.checkedAt) || '',
      effectiveLimit: linkedinMeta.resultLimit || null,
      stats: buildStatsReport(linkedinMeta),
    };
  }, [linkedinMeta]);
  // ↑ useMemo porque se recalcula en cada render y solo depende de la corrida.
  // visibleJobs.length no es dependencia real: el objeto retornado no lo usa.

  // Frase que se le agrega al texto de estado para que se vea qué hizo el filtro.
  function filterSummary() {
    if (minScore <= 0) return '';
    // ↑ Con el filtro en 0 no se dice nada: la app se ve exactamente igual que
    //   antes de que este filtro existiera.
    const total = (jobsData.jobs || []).length;
    if (!visibleJobs.length) {
      // ↑ Caso "el filtro dejó la lista vacía": el mensaje tiene que explicar que
      //   las ofertas SÍ existen pero ninguna llega al % pedido, porque decir
      //   solamente "0 ofertas" haría pensar que la región no tiene resultados.
      return ` Ninguna de las ${total} ofertas llega al ${minScore}% de match: bajá el filtro o volvé al preset 0%.`;
    }
    return ` Filtro activo: ${visibleJobs.length} de ${total} ofertas con ${minScore}% de match o más.`;
  }

  // Texto de estado que se muestra en la toolbar, según qué se esté viendo.
  function statusText() {
    if (region === 'analisis') {
      return loading ? 'Calculando la propuesta de interés…' : 'Mercado relevado en todas las regiones, comparado contra tu CV.';
    }
    if (region === 'directorio') {
      // ↑ Mismo criterio que la línea de arriba, y por el mismo motivo: el return va
      //   ANTES del `if (loading)` y antes de todo lo que habla de ofertas. Lo que
      //   sigue cuenta ofertas, mira `_online` y cuenta las que aprobaron el filtro de
      //   % de match: nada de eso es cierto en un catálogo de links, y el texto de
      //   abajo llegaría a decir "Conexión exitosa con las fuentes de empleo" al lado
      //   de una lista que no tiene ninguna oferta. Es el mismo criterio que `_online`
      //   en `jobs.js:612`: el rótulo describe lo que LA PANTALLA muestra, no lo que
      //   pasó en la corrida anterior.
      return loading
        ? 'Armando el directorio de empleo…'
        : 'Catálogo de bolsas y consultoras de Argentina. No rastreamos estas webs: cada link se abre en el sitio, con la búsqueda ya filtrada cuando el portal la soporta.';
    }
    if (loading) return 'Cargando…';
    if (searchingLinkedIn) return `Consultando LinkedIn con Apify (desde ${apifyLimit} ofertas; puede devolver más)…`;
      // ↑ El "máximo 50" de antes era mentira: el backend pagina hasta 8 páginas.
        //   Y no dice "cuántas vas a ver" sino "desde cuántas", porque el número
        //   pedido es un piso (en la prueba real: pedí 50, quedaron 78).
    if (linkedinSearchError) return `Búsqueda de LinkedIn: ${linkedinSearchError}`;
    if (refreshNote) return refreshNote;
      // ↑ El aviso del refresh va antes que el conteo porque explica una
        //   anomalía de la lista actual: si no, se lee como que la pantalla está
        //   rota. Es un return temprano solo cuando hay nota.
    if (jobsData.fromApify) {
      const otras = Object.entries(linkedinMeta?.regions || {}).filter(
        // ↓ Se excluye la región QUE SE ESTÁ VIENDO, no la que se pidió en la
        //   corrida: si el usuario ya está en la pestaña Europa, el aviso tiene
        //   que ofrecerle las demás, no las de Europa que ya está mirando.
        ([key, list]) => key !== region && Array.isArray(list) && list.length > 0,
      );
      // ↑ Aviso de las ofertas que el backend metió en OTROS buckets. No se
      //   pierden: están en `regions` y se ven al cambiar de pestaña (goToRegion
      //   las restaura), pero antes no había forma de saber que existían.
      const extra = otras.length
        ? ` Además hay ${otras.reduce((acc, [, list]) => acc + list.length, 0)} en ${otras.map(([key]) => regionLabel(key)).join(', ')}.`
        : '';
      return `${visibleJobs.length} ofertas de LinkedIn (Apify) de ${regionLabel(region)}, de los últimos 30 días.${extra}${filterSummary()}`;
      // ↑ El conteo usa la lista YA filtrada: el usuario ve cuántas quedan, no
      //   cuántas hay, y filterSummary() aclara el total por si quedó duda.
    }
    if (viewMode === 'history') {
      return `Historial de los últimos 6 meses · ${visibleJobs.length} ofertas · las más viejas se purgan solas. “No aparece” no confirma cobertura.${filterSummary()}`;
    }
    return (jobsData._online
      ? 'Conexión exitosa con las fuentes de empleo.'
      : 'Modo demo: no se pudo contactar las fuentes en línea. Mostrando ofertas de ejemplo.') + filterSummary();
    // ↑ Los paréntesis encierran el ternario para poder sumarle el filterSummary()
    //   con el operador +. Con el filtro en 0, filterSummary() devuelve '' y el
    //   texto queda idéntico al de antes.
  }

  const linkedinKeywords = linkedinProfileKeywords(profile);
  // ↑ Sin perfil todavía (o sin keywords usables) esto devuelve '': es preferible un
  //   link de LinkedIn sin filtros a uno que busque la profesión de otra persona.

  // ── Las dos compuertas, y por qué dependen de conocer la sesión ─────────────
  // `faltaCv` NO es "no hay perfil": es "hay sesión y no hay perfil", que es el 403
  // con `profileComplete: false` de la tabla de compuertas de AGENTS.md. La
  // diferencia no es cosmética: con un 401 hay que mandar a /login, y con un 403
  // hay que pedir el CV. Mostrar el formulario de CV a alguien sin sesión lo
  // dejaría subir un archivo que el `POST /api/cv/parse` le va a rechazar con 401.
  const sinSesion = sesion.estado === 'sin-sesion';
  const faltaCv = sesion.estado === 'logueado' && sesion.profileComplete === false;
  // ↑ Con `estado: 'desconocido'` o `'sin-respuesta'` NO se muestra ninguna de las
  //   dos: la app se dibuja como siempre, con las ofertas del FALLBACK. Antes de
  //   este paso eso era lo único que pasaba; ahora, cuando el backend responde de
  //   verdad, el alta se vuelve una compuerta de verdad.
  // ↑ Y por qué el otro condiciones es `profileComplete === false` y NO `!profile`:
  //   `loadProfile()` devuelve `null` tanto si el backend respondió 403 (de verdad
  //   no hay perfil) como si la llamada falló (no hay backend, se cortó la red, un
  //   500). Con `!profile`, un problema de red pintaba el formulario de "subí tu
  //   CV" a alguien que ya lo subió hace una semana, y el único botón de esa
  //   pantalla consumía otro análisis de la cuota. `profileComplete` viene del
  //   `/api/me`, que sí distingue los dos casos, y con la doble condición (que el
  //   backend diga que falta Y que de verdad no haya perfil) no se abre la
  //   compuerta ni cuando el `/api/me` dio `true` y el perfil tardó en bajar.

  // Recibe la respuesta de `AuthScreen` cuando el login o el registro salieron
  // bien, y deja la app en el estado que corresponde.
  //
  // El nombre del prop es `onAuthed` y no `onRegistered` a propósito: el registro
  // y el login devuelven el MISMO shape (`{ ok, user, profileComplete }`) y
  // llevan al mismo lado. Un solo handler para los dos, si no aparecen dos
  // funciones idénticas que alguien va a cambiar en uno y olvidar en el otro.
  const handleAuthed = useCallback(async (datos) => {
    setSesion({
      estado: 'logueado',
      user: datos.user,
      profileComplete: datos.profileComplete,
    });
    // ↑ Se usa el `profileComplete` que VINO, y no un `false` hardcodeado: es lo
    //   que permite que un login (donde sí puede ser true) entre directo a la app
    //   en vez de mandar a alguien que ya tiene CV a subirlo otra vez. La regla de
    //   la compuerta sigue siendo la misma: 401 → login, 403 → CV, y acá
    //   `profileComplete: false` cae en la misma rama `faltaCv` de siempre.

    if (!datos.profileComplete) return;
    // ↑ Sin perfil no hay nada que recargar: `loadProfile()` devolvería 403 y las
    //   ofertas saldrían matcheadas contra nada. La compuerta del CV se encarga.

    // Con perfil hay que recargar TODO lo que se cargó al montar, y no solo el
    // perfil: las ofertas,% de match y la analítica son de ESTE usuario. Si se
    // dejara lo que había, la persona vería los datos de la sesión anterior (o
    // del FALLBACK de ejemplo) con su nombre arriba.
    const [p, j] = await Promise.all([loadProfile(), loadJobs('argentina')]);
    setProfile(p);
    setJobsData(j);
  }, []);
  // ↑ `useCallback` con deps vacías. No hay Circular: este callback solo llama
  //   setters de estado.

  // Vaciar TODO lo que es de la sesión actual, y poner el estado en `sin-sesion`.
  //
  // Es una función y no un bloque repetido porque hay DOS callers que necesitan
  // exactamente lo mismo y ya se vio lo que cuesta: `handleLogout` y
  // `handleAccountDeleted` limpian exactamente la misma lista, y lo que se borró
  // entre una versión y otra de este archivo fue el `profile` de una de las dos.
  // La lista corta, y el motivo de vaciarla una por una (y no con un "reset" de
  // la app) es que las formas importan: `jobsData` con `_online: false` es lo
  // que hace que la app muestre el aviso de "modo demo" si alguien fuerza la
  // vista, y `analytics: null` es lo que la pestaña de análisis interpreta como
  // "no cargado". Un estado con la forma equivocada rompe el render en silencio.
  // Y lo mismo vale para el directorio: `directorio: null` con
  // `directorioCargado: false` es lo que hace que la pestaña vuelva a pedir el
  // catálogo con el keyword del perfil que entre ahora, y no con el del anterior.
  const limpiarSesion = useCallback(() => {
    setSesion({ estado: 'sin-sesion' });
    // ↑ `'sin-sesion'` y NO `'sin-respuesta'`: acá SÍ sabemos que no hay sesión,
    //   y no es una conjetura. En el logout pasa lo mismo (el backend confirmó), y
    //   en el borrado de cuenta es todavía más claro: la fila de `users` ya no
    //   existe, así que cualquier cookie que ande suelta da 401 en el próximo
    //   request. Los tres estados siguen siendo tres: `'desconocido'` (el
    //   `/api/me` todavía no respondió) y `'sin-respuesta'` (no hubo backend) NO
    //   abren la pantalla de acceso a propósito, para no mandar a un login
    //   imposible a alguien a quien lo que le falta es que el server vuelva.
    setProfile(null);
    setAnalytics(null);
    setDirectorio(null);
    setDirectorioCargado(false);
    // ↑ El directorio NO es un dato privado: el catálogo de bolsas y consultoras es el
    //   mismo para cualquiera y solo cambia con el keyword del PERFIL. Se limpia igual,
    //   y por una razón concreta: el keyword con el que se prellenan las URLs ES del
    //   usuario que se está yendo. Dejarlo cacheado haría que la próxima sesión viera
    //   un catálogo armado con el oficio de la anterior, con su perfil sin keyword y
    //   un aviso de "sin búsqueda filtrada" sin explicación. `limpiarSesion` es la
    //   lista de TODO lo que pertenece a la sesión saliente, no solo lo privado.
    setEditando(false);
    setBorrandoCuenta(false);
    setJobsData({ jobs: [], _online: false });
    setSearchingLinkedIn(false);
    setLinkedinMeta(null);
    setLinkedInSearchError('');
    // ↑ Limpia el estado de la búsqueda de Apify: la sesión que se va tenía
    //   sus propias corridas y metadatos; la siguiente sesión empieza limpia.
  }, []);

  // Cerrar sesión. El logout del backend NO borra nada del servidor (no hay tabla
  // de sesiones: manda la cookie con Max-Age=0), y por eso acá hay que limpiar
  // el estado local sí o sí.
  const handleLogout = useCallback(async () => {
    await logout();
    // ↑ Se IGNORA el resultado a propósito. `logout()` nunca lanza y devuelve
    //   `false` si no hubo backend; si el server estaba caído, la cookie sigue
    //   viva en el navegador y el logout se ve igual. Es la decisión correcta
    //   porque la alternativa (dejar al usuario en la app con un botón que no
    //   hace nada) es peor que un logout optimista que se corrige en el próximo
    //   `GET /api/me`, que devuelve 401 y vuelve a pintar el acceso.
    limpiarSesion();
  }, [limpiarSesion]);

  // Se llamó al DELETE y el backend respondió 200: la cuenta ya no existe. No hay
  // NADA que pedirle al servidor después (no hay logout, la cookie ya vino con
  // `Max-Age=0` en la misma respuesta), así que este handler es solo el limpieza.
  //
  // Es exactamente lo mismo que un logout, y por eso comparte `limpiarSesion` en
  // vez de reescribir las cinco líneas: la diferencia entre las dos acciones es
  // lo que pasa en el servidor, y después de eso la UI está en el mismo lugar.
  const handleAccountDeleted = useCallback(() => {
    limpiarSesion();
  }, [limpiarSesion]);

  // Abrir y cerrar los modales de perfil. Van en `useCallback` porque son props
  // de componentes que se suscriben a `keydown` en `document`: si la función
  // cambiara de identidad en cada render, el listener se desuscribiría y se
  // volvería a suscribir en cada cambio de estado de la app, por abrir un modal
  // que casi no escucha nada.
  const abrirEditor = useCallback(() => setEditando(true), []);
  const cerrarEditor = useCallback(() => setEditando(false), []);
  const abrirBorrado = useCallback(() => setBorrandoCuenta(true), []);
  const cerrarBorrado = useCallback(() => setBorrandoCuenta(false), []);
  // ↑ `abrirBorrado`/`cerrarBorrado` son `useCallback` por lo mismo que
  //   `abrirEditor`/`cerrarEditor`: son props de `CvPanel` y del modal, y con una
  //   arrow function en el JSX se recrearían en cada render.

  return (
    <div className="app">
      {/* ↑ Contenedor general de la app (máximo ancho y centrado). */}

      <header className="app-header">
        <div className="header-inner">
          <div className="brand-copy">
            <h1>🎯 BuscaEmpleo</h1>
            <p className="subtitle">
              Las mejores ofertas para <strong>{profile?.fullName || 'tu perfil'}</strong>
              {profile?.title ? ` · ${profile.title}` : ''}
            </p>
            {/* ↑ Sin perfil no mostramos nombre ni profesión, porque no hay ninguno:
                poner un nombre o un cargo inventados sería el de otra persona. */}
          </div>
          <div className="header-actions">
            <button
              className="theme-toggle"
              type="button"
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? '☀️ Modo claro' : '🌙 Modo oscuro'}
            </button>

            {/* ↑ Con `sesion.estado === 'logueado'` y no sin condición: el header
                vive FUERA del condicional de las compuertas (line 747), así que sin
                este chequeo el botón "Salir" también se le mostraría a un visitante
                que no tiene sesión, que es un botón que no hace nada. El tema sí
                queda siempre: cambiar el fondo tiene sentido también en el login. */}
            {sesion.estado === 'logueado' && (
              <button className="theme-toggle" type="button" onClick={handleLogout}>
                {/* ↑ Va junto al toggle de tema y no abajo de la pantalla: salir de la
                    sesión es un estado del chrome, no una acción de contenido. Es el
                    mismo `theme-toggle` a propósito (mismo tamaño, misma forma) y no
                    un `btn` común, para que no parezca la acción principal de la app:
                    cerrar sesión es algo que se hace de vez en cuando. */}
                {sesion.user?.email ? `Salir (${sesion.user.email})` : 'Salir'}
                {/* ↑ Con el correo al lado, para que quien tiene la sesión abierta en
                    una computadora compartida sepa a quién está por cerrar. Sale del
                    `user` que ya está en el estado y no de un fetch nuevo. */}
              </button>
            )}
          </div>
        </div>
      </header>

      {sinSesion ? (
        <AuthScreen onAuthed={handleAuthed} />
        // ↑ El 401 de la tabla de compuertas: sin cookie válida. Se DIBUJA la
        //   pantalla de acceso acá, en vez de hacer un redirect a una ruta: la app
        //   es de una sola página, no hay router, y una ruta /login de verdad
        //   tendría que resolver el caso del refresh del navegador (F5 sobre
        //   /login tiene que volver a pintar el login, no la app). Un condicional
        //   que devuelve el mismo componente siempre resuelve eso sin router.
        //   El error NO se muestra en un banner de la app: con la pantalla de
        //   acceso delante no hay nada más que leer, y el mensaje va adentro del
        //   formulario, que es donde está el campo que hay que corregir.
      ) : faltaCv ? (
        <main className="layout">
          {/* ↑ El 403 con `profileComplete: false`: hay sesión, falta el CV. La
              compuerta del alta, y ocupa la pantalla entera porque un perfil
              ausente matchea con 0% contra TODAS las ofertas: dejarla ver la lista
              sería mostrarle "no encontramos nada" en vez de "subí tu CV". */}
          <CvOnboarding onSaved={handleProfileSaved} onDeleteAccount={abrirBorrado} />
          {/* ↑ `onDeleteAccount` va ACÁ también, y no es redundante: esta pantalla
              es la única que ve alguien que se registró pero nunca subió el CV, y
              `DELETE /api/account` acepta justo ese caso (usa `requireSession`).
              Sin esta prop, esa cuenta se podría crear pero no borrar desde la
              interfaz. El EDITOR de perfil (el mismo componente con `profile`) no
              la lleva a propósito: atrás está el panel del CV con su zona. */}
        </main>
      ) : (
      <main className="layout">
        {/* ↑ Layout de dos columnas: a la izquierda el CV y a la derecha las ofertas. */}

        <CvPanel profile={profile} onEdit={abrirEditor} onDeleteAccount={abrirBorrado} />
        {/* ↑ Le pasamos el perfil por prop; CvPanel lo muestra en el panel lateral.
            El `onEdit` es opcional: sin él el panel no muestra el botón, y con él
            abre el MISMO formulario del onboarding en modo modal. Corregir un peso
            de skill no debería pasar por un parseo del LLM que se paga.
            `onDeleteAccount` es opcional por el mismo motivo y abre el modal de
            confirmación del borrado, que es un cuarto modal más y vive acá para que
            `limpiarSesion` tenga un solo lugar desde donde ejecutarse. */}

        <section className="jobs-panel">
          <RegionTabs current={region} onSelect={goToRegion} />
          {/* ↑ current = región activa, onSelect = función que se dispara con cada click. */}

          <Toolbar
            region={region}
            statusText={statusText()}
            viewMode={viewMode}
            refreshing={refreshing}
            searchingLinkedIn={searchingLinkedIn}
            onRefresh={handleRefresh}
            onLinkedInSearch={handleLinkedInSearch}
            onToggleHistory={handleToggleHistory}
            linkedinKeywords={linkedinKeywords}
            minScore={minScore}
            onMinScoreChange={handleMinScoreChange}
            apifyLimit={apifyLimit}
            onApifyLimitChange={handleApifyLimitChange}
            // ↑ El select de cuántas ofertas pedir: el estado vive en App porque
            //   es App la que hace el POST. La toolbar solo avisa el valor nuevo.
            //   El callback valida, acota y persiste en localStorage.
            effectiveLimit={linkedinReport.effectiveLimit}
            // ↑ El límite REAL de la última corrida (`resultLimit` del backend),
            //   que puede diferir del elegido si el backend lo acota.
            savedMessage={linkedinReport.saved}
            checkedAgo={linkedinReport.checkedAgo}
            stats={linkedinReport.stats}
            // ↑ Los tres reportes de la corrida (guardado, hora y estadísticas).
            //   Ya venían en la respuesta del backend y nadie los leía.
          />
          {/* ↑ La toolbar recibe por props el estado y los callbacks; los hijos no
              modifican el estado del padre directamente, solo "avisan" con eventos.
              minScore + onMinScoreChange son el filtro de % de match: el valor va
              de bajada y el callback avisa cuando el usuario elige uno nuevo. */}

          {/* Render condicional: la sección derecha muestra un componente u otro
              según la región elegida (análisis u ofertas). */}
          {region === 'analisis' ? (
            <AnalysisPage
              data={analytics}
              profile={profile}
              viewMode={viewMode}
              refreshing={refreshing}
              onRefresh={handleRefresh}
              onToggleHistory={handleToggleHistory}
              linkedinKeywords={linkedinKeywords}
            />
            // ↑ Propuesta de Interés: recibe los datos de analítica, el perfil y los
            //   controles de búsqueda (actualizar / desde enero / LinkedIn).
          ) : region === 'directorio' ? (
            <DirectorioPage
              data={directorio}
              loading={loading}
              error=""
              onEditCv={abrirEditor}
            />
            // ↑ El Directorio es la TERCERA rama, y va antes del `JobList` por la
            //   misma razón que la de análisis: la columna derecha muestra UNA cosa y
            //   esta no es una lista de ofertas. Por eso NO lleva `viewMode` ni
            //   `onRefresh`: la toolbar esconde los controles de ofertas en las
            //   secciones, y la vista tiene su propio estado (`loading`) para poder
            //   decir "cargando" en vez de "no hay entradas".
            //   `error=""` explícito porque `loadDirectorio()` no lanza nunca (devuelve
            //   `null`); la prop existe para que el componente no quede atado a esta
            //   única fuente de datos. `onEditCv` es el MISMO `abrirEditor` del panel
            //   del CV: el aviso de "tu perfil no tiene oficio" abre el editor, que es
            //   donde se actualiza el perfil, y no un segundo formulario de CV.
          ) : (
            <JobList key={`${region}-${viewMode}`} jobs={visibleJobs} viewMode={viewMode} minScore={minScore} onOpen={openDetail} />
            // ↑ Ofertas de la región YA filtradas por % de match (visibleJobs): el
            //   componente no sabe nada del filtro, solo recibe lo que tiene que
            //   mostrar. minScore lo recibe aparte SÓLO para poder explicar en el
            //   mensaje de "no hay nada" que el filtro dejó la lista vacía.
            //   Ojo: el key NO incluye minScore a propósito. Si lo incluyera, cada
            //   cambio de filtro remontaría la lista y perderías el orden elegido;
            //   el `safePage` de JobList ya se encarga de corregir la paginación
            //   cuando el filtro deja menos páginas.
          )}
        </section>
      </main>
      )}
      {/* ↑ Fin del `layout` normal. Lo de arriba es un ternario de TRES ramas —
          sin sesión, sin CV, o la app de siempre — y solo se dibuja una. El
          `<main>` se abre y se cierra en cada rama a propósito: no es duplicado
          que sobre, y evita un fragmento que escondería la estructura real. */}

      {editando && (
        <CvOnboarding
          profile={profile}
          onSaved={handleProfileSaved}
          onCancel={cerrarEditor}
        />
        // ↑ El MISMO componente del alta, pero con `profile` y `onCancel`: con las
        //   dos props sabe que es un editor y se muestra como modal sobre la app.
        //   `onSaved` es el mismo `handleProfileSaved`, así que guardar desde acá
        //   actualiza el perfil global y cierra el modal en un solo paso.
      )}

      {selectedJob && (
        /* ↑ Render condicional: si hay una oferta seleccionada, aparece el modal de detalle. */
        <JobDetailModal
          job={selectedJob.job}
          summary={selectedJob.summary}
          region={selectedJob.region}
          profile={profile}
          onClose={() => setSelectedJob(null)}
          // ↑ El padre le da la función para cerrar el modal con una arrow function.
          onGenerateLetter={handleGenerateLetter}
        />
      )}

      {letter && <LetterModal letter={letter} onClose={() => setLetter(null)} />}
      {/* ↑ Igual que el anterior: solo renderiza la carta si ya fue generada. */}

      {borrandoCuenta && (
        <DeleteAccountModal
          onCancel={cerrarBorrado}
          onDeleted={handleAccountDeleted}
        />
        // ↑ Se dibuja SOLO con sesión y perfil (`borrandoCuenta` arranca en false
        //   y nadie más lo pone en true), pero el condicional explícito es lo que
        //   lo mantiene así: si alguien lo abriera en un estado sin sesión, el
        //   `DELETE` recibiría un 401 y el modal mostraría "Necesitás iniciar
        //   sesión.", que es un mensaje honesto pero una pantalla inútil.
        //
        //   `onDeleted` se llama SOLO cuando el backend confirmó. Es la diferencia
        //   con `onCancel`: acá ya no se puede volver atrás, y por eso el handler
        //   no hace ninguna llamada de red (la cookie ya vino borrada en la misma
        //   respuesta) y solo limpia el estado local.
      )}
    </div>
  );
}