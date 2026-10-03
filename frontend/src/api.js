// Capa de acceso a la API del backend. Misma lógica que el app.js original:
// si el fetch falla (server caído durante desarrollo, por ejemplo), cae a
// datos de ejemplo para que la UI nunca quede vacía.
//
// PATRÓN DEL ARCHIVO: una función por endpoint del backend.
// Centralizar el acceso a la red en un solo lugar sirve para tres cosas:
//   1) Cambiar la URL base o el proxy (config de Vite) en un solo archivo.
//   2) Decidir UNA sola vez qué pasa si el servidor no responde (el FALLBACK).
//   3) Que los componentes no tengan que saber ni una URL: solo llaman
//      loadJobs('argentina') y reciben datos.
// Las URLs son relativas ("/api/..."): en desarrollo Vite las reenvía al
// backend (proxy de vite.config.js) y en producción las sirve el mismo server.
//
// OJO, este párrafo cambió con el alta (paso 7). Antes decía "no hay timeout ni
// AbortController". Sigue siendo cierto para las llamadas de LECTURA: si el
// backend se cuelga, la promesa queda esperando y el resto de la UI sigue
// funcionando (por eso las de lectura tienen FALLBACK). Para las dos
// ESCRITURAS del alta no: quedarse esperando en silencio significaría dejar el
// botón en "Analizando tu CV…" para siempre, sin poder reintentar ni cancelar,
// y en el caso del parseo se está esperando a un LLM de pago. Esas dos llevan
// `AbortSignal.timeout`, con el detalle de qué timeout en cada función.

// FALLBACK: datos de respaldo que se usan cuando el backend no responde.
// Así la pantalla nunca se queda en blanco, aunque no haya internet o server.
// ↑ Ojo con la FORMA: cada clave tiene que coincidir con lo que devuelve el
//   backend, porque estos objetos se mezclan con las respuestas reales sin que
//   el frontend distinga uno de otro.
// ↑ NO hay un perfil de respaldo acá, y es a propósito: la app es multiusuario y
//   cualquier profesión, así que un perfil inventado le mostraría a un contador el
//   CV de otra persona. loadProfile() devuelve null y cada consumidor ya lo banca.
export const FALLBACK = {
  jobs: {
    // ↑ Ofertas de ejemplo organizadas por región (mismas claves que usa la UI).
    argentina: [
      // ↑ Cada oferta demo tiene la misma forma que las reales: id, título, empresa,
      //   skills matcheados y score. Así la UI no distingue entre demo y online.
      { id: 'demo-ar-1', source: 'Demo', title: 'QA Automation Engineer', company: 'Ejemplo Fintech', location: 'Buenos Aires', regionGuess: 'argentina', applyUrl: '#', description: 'Automatización de pruebas API (REST/GraphQL) y mobile con JavaScript. Metodología Scrum y Jira.', tags: ['qa', 'automation', 'api', 'mobile'], matched: ['qa', 'automation', 'api testing', 'mobile testing', 'rest', 'postman', 'javascript', 'scrum', 'jira'], missed: [], requested: ['qa', 'automation', 'api testing', 'mobile', 'rest'], inTitle: true, score: 96 },
      // ↑ matched = skills que el perfil tiene y pide la oferta (se muestran
      //   como tags verdes); missed = los que pide y no tenés (brechas).
      { id: 'demo-ar-2', source: 'Demo', title: 'Backend/API Tester', company: 'Banco Digital', location: 'CABA', regionGuess: 'argentina', applyUrl: '#', description: 'Testing de APIs con Postman, SQL y bases de datos. Pruebas de regresión y caja negra.', tags: ['api', 'postman', 'sql', 'regression'], matched: ['api testing', 'regression', 'rest', 'postman', 'sql'], missed: [], requested: ['api testing', 'postman', 'sql', 'regression'], inTitle: true, score: 86 },
    ],
    // ↑ Las regiones que no estén acá devuelven una lista vacía si el server no
    //   está: es preferible a mostrar un error. Con el alcance actual (solo
    //   Argentina) queda solo esta clave; las de Europa y EEUU que había se
    //   borraron porque ofrecían ofertas de QA de otro país que la app ya no
    //   muestra. Sacar del todo `FALLBACK.jobs` (con su texto de "Modo demo")
    //   es un paso aparte, cuando el backend de ofertas exista.
  },
};

// Trae el perfil del candidato desde el backend (/api/profile).
// ↑ `async` + `await`: la función devuelve una promesa y espera la respuesta del
//   servidor sin bloquear la pantalla. El `catch` va VACÍO a propósito: no hay
//   log ni aviso porque el objetivo es que la app siga andando igual.
export async function loadProfile() {
  try {
    const res = await fetch('/api/profile');
    // ↑ res.ok vale true en respuestas 2xx (o sea, "el server respondió bien").
    if (res.ok) return await res.json();
    // ↑ Si el server responde bien, devolvemos el JSON ya parseado.
  } catch {}
  return null;
  // ↑ SIN perfil de respaldo, a diferencia de las ofertas. La sesión puede existir
  //   sin perfil (el alta es correo+clave primero y el CV se sube después), así que
  //   null es un estado REAL y normal, no un error: cada consumidor (CvPanel,
  //   AnalysisPage, los helpers de utils) ya lo maneja con optional chaining.
}

// Trae las ofertas rankeadas de una región (/api/jobs?region=X).
// ↑ Devuelve { region, jobs: [...] }: la lista ya viene ordenada por % de match
//   desde el backend; el frontend solo la muestra y la pagina.
export async function loadJobs(region) {
  try {
    const res = await fetch(`/api/jobs?region=${region}`);
    // ↑ Backticks (``) permiten meter variables dentro del string de la URL.
    if (res.ok) return await res.json();
  } catch {}
  // Si el server no responde, devolvemos las ofertas demo de esa región.
  return { region, jobs: FALLBACK.jobs[region] || [], _online: false };
  // ↑ _online: false le avisa a la UI que estamos en "modo demo".
  //   El "_" adelante es una convención para marcar un campo interno.
}

// Trae el historial de ofertas vistas de una región (/api/history?region=X).
// A diferencia de loadJobs, acá no hay fallback con datos: si no hay server,
// simplemente devolvemos un historial vacío.
// ↑ ¿Por qué no hay datos demo acá? Porque el historial es algo personal del
//   usuario: inventar ofertas "vistas" sería mostrar información falsa.
export async function loadHistory(region) {
  try {
    const res = await fetch(`/api/history?region=${region}`);
    if (res.ok) return await res.json();
  } catch {}
  return { region, jobs: [] };
  // ↑ Lista vacía = el componente muestra su mensaje de "todavía no hay historial".
}

// Pide al backend que refresque la búsqueda YA, ignorando la caché de 30 min.
// No usa la respuesta: solo es un "disparador" (POST sin body).
// ↑ Devuelve el body parseado para que el llamador pueda distinguir una recarga
//   real de un fallo silencioso. Antes no miraba la respuesta (fire and forget),
//   y `App.handleRefresh()` recarga igual la región: cuando el POST fallaba (server
//   caído a mitad de la búsqueda) la pantalla mostraba los datos viejos con la
//   etiqueta de "recién actualizado", que es peor que avisar que no se pudo.
export async function refreshJobs() {
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    // ↑ El POST sin body le dice al backend "borra la caché y buscá de nuevo".
    return res.ok ? await res.json().catch(() => ({})) : { ok: false };
  } catch {
    return { ok: false };
    // ↑ No se lanza: refrescar la lista no es una acción que pueda "fallar" en
    //   pantalla de forma fatal. Lo que sí se hace es devolver ok:false para que
    //   el padre pueda avisar en vez de fingir que la lista está al día.
  }
}

// ↑ ÚNICA función de este archivo que NO cae al FALLBACK: si falla, lanza el
//   error. Motivo: esta búsqueda delega en un servicio externo (Apify), tarda y
//   cuesta plata; si falló, el usuario tiene que enterarse, y el componente que
//   llama es el que muestra el mensaje de error.
// ↑ `limit` es opcional: si viene, el backend lo usa (tiene prioridad sobre
//   APIFY_MAX_RESULTS). El backend lo acota a 20..1000 y PAGINA hasta 8 páginas,
//   así que el número es un piso: pedir 50 puede devolver 78. Se manda siempre
//   el valor del control de la toolbar para que lo que dice la pantalla sea
//   exactamente lo que se ejecutó.
export async function searchLinkedInJobs(region, limit) {
  let response;
  // ↑ `let` porque se asigna adentro del try y se usa después del catch.
  try {
    response = await fetch('/api/linkedin-search', {
      method: 'POST',
      // ↑ method: 'POST' = enviamos datos (una región), no solo pedimos.
      headers: { 'Content-Type': 'application/json' },
      // ↑ Le decimos al server que lo que va en el body es JSON, no texto plano.
      body: JSON.stringify(limit ? { region, limit } : { region }),
      // ↑ El body viaja como TEXTO: por eso hay que convertir el objeto con
      //   JSON.stringify. El server lo vuelve a convertir en objeto al recibirlo.
    });
  } catch {
    // ↑ Ni siquiera hubo respuesta (server apagado o no hay internet).
    throw new Error('No se pudo conectar con el backend local.');
  }

  // ↑ Si el body de error no es JSON (por ejemplo, es un HTML de error), el
  //   .catch(() => ({})) evita que el parseo reviente y nos da un objeto vacío.
  const data = await response.json().catch(() => ({}));
  // ↑ response.ok false + cuerpo con { error } = el server nos explicó qué pasó.
  if (!response.ok) throw new Error(data.error || `La búsqueda falló (HTTP ${response.status}).`);
  // ↑ Si el server no mandó mensaje, mostramos al menos el código HTTP (500, 404...).
  return data;
}

// Trae el detalle enriquecido de una oferta (/api/job?q=ID) con resumen de empresa y skills.
export async function loadJobDetail(id) {
  try {
    const res = await fetch(`/api/job?q=${encodeURIComponent(id)}`);
    // ↑ encodeURIComponent limpia el id por si trae caracteres especiales.
    if (res.ok) return await res.json();
  } catch {}
  return null;
  // ↑ null = no se pudo; quien llama decide qué hacer (ej. usar la oferta del listado).
}

// Pide la carta de presentación generada por el backend (/api/cover-letter).
// ↑ Recibe los DOS datos que necesita el endpoint: la región (para saber el
//   idioma) y el id de la oferta (para escribir sobre ese puesto).
export async function loadCoverLetter(region, id) {
  try {
    const res = await fetch(`/api/cover-letter?region=${region}&id=${encodeURIComponent(id)}`);
    if (res.ok) return await res.json();
  } catch {}
  return null;
  // ↑ Sin carta no se abre el modal: el frontend simplemente no muestra nada.
}

// Trae el agregado de analítica del mercado (/api/analytics): KPIs, brechas, etc.
export async function loadAnalytics() {
  // ↑ Devuelve null si falla (no hay demo de analítica): es un agregado que
  //   tendría que inventarse con datos falsos, así que la página lo oculta.
  try {
    const res = await fetch('/api/analytics');
    if (res.ok) return await res.json();
  } catch {}
  return null;
}

// Trae el catálogo de bolsas de empleo y consultoras de una región
// (/api/directorio?region=X): el directorio de Argentina, sin scraping.
export async function loadDirectorio(region = 'argentina') {
  // ↑ Sin `AbortSignal.timeout` por la misma razón que `loadHistory` y
  //   `loadAnalytics`: son LECTURAS y tienen default, así que si el backend se cuelga
  //   lo peor que pasa es que la vista quede esperando; el resto de la app (las
  //   ofertas, que es lo que el usuario vino a buscar) sigue funcionando y el
  //   usuario puede cambiar de pestaña. Un timeout propio solo agregaría un texto
  //   más para el mismo problema.
  // ↑ El default es la ÚNICA región del proyecto, así que el llamador puede no
  //   pasar nada. Cuando se agreguen más países, el parámetro pasa a ser obligatorio
  //   y este default se saca: acá es cómodo, no un atajo para no pasar `region`.
  try {
    const res = await fetch(`/api/directorio?region=${region}`);
    if (res.ok) return await res.json();
  } catch {}
  return null;
  // ↑ null Y NO un catálogo vacío, y esa diferencia es el punto: la respuesta del
  //   endpoint ya trae `searchKind` por entrada y el componente decide el rótulo a
  //   partir de eso. Devolver `{ bolsas: [], consultoras: [] }` al fallar haría que
  //   una caída del backend se viera como "no hay bolsas cargadas", que es un dato
  //   falso, y con `keyword: ''` además dispararía el aviso de "tu perfil no tiene
  //   oficio". `null` hace que la página diga que no se pudo cargar.
}

// ════════════════════════════════════════════════════════════════════════════
// EL ALTA EN DOS ETAPAS, VISTA DESDE EL NAVEGADOR
// ---------------------------------------------------------------------------
// Las tres funciones de esta sección son las que cierran el paso 7 (el frontend
// del onboarding) y son las ÚNICAS además de `searchLinkedInJobs` que NO caen
// al FALLBACK: si fallan, LANZAN el error. El motivo es compartido y es el del
// proyecto, no una excepción: son la parte del alta donde un fallo silencioso es
// una pérdida de datos. Un `null` deFallback en `loadProfile` está bien porque
// "todavía no hay perfil" es un estado REAL; acá en cambio, un error de red
// disfrazado de "sin perfil" dejaría al usuario mirando un formulario vacío sin
// saber que su CV no se pudo leer, y un 429 disfrazado de nada lo dejaría
// pensando que la app anda mal en vez de que tiene que esperar.
//
// Y hay un detalle de seguridad que se respeta sin que el componente lo sepa:
// el `user_id` sale SIEMPRE de la cookie firmada, nunca del body. Por eso
// `saveProfile` manda el perfil tal cual y no "limpia" el `userId` que vino
// dentro: el backend ni lo mira (`api/profile.js`, bloque de `user_id`).
// ════════════════════════════════════════════════════════════════════════════

// El techo de espera de `parseCv`. Holgado a propósito: el backend da 25 s al
// proveedor del LLM y su función de serverless tiene `maxDuration: 60`, así que
// cualquier respuesta válida entra acá con margen. Lo que pasa de esto ya no es un
// LLM lento, es un backend colgado, y en ese caso lo que hay que hacer es dejar de
// esperar y dejar que el usuario reintente (que además es lo único que puede
// hacer: el parseo no guarda nada hasta el `PUT`).
const PARSE_TIMEOUT_MS = 75_000;

// El techo de `saveProfile`. Más corto porque acá no hay nadie pensando: es un
// `PUT` a la base. 30 s es muchísimo para una transacción.
const SAVE_TIMEOUT_MS = 30_000;

// El techo de `deleteAccount`. El mismo número y por el mismo motivo: es un
// `DELETE` contra la base con la cascada, o sea dos sentencias de la misma
// transacción (ver `api/account.js`). Si los 30 s se cumplen, la transacción o
// commiteó o no, y el usuario puede reintentar sin riesgo: el `DELETE` es
// idempotente y la única forma de duplicar el registro de baja es tener DOS
// requests vivos a la vez, que es justo lo que el timeout descarta.
const DELETE_TIMEOUT_MS = 30_000;

/**
 * La `signal` de un `fetch` que se corta solo pasado un rato.
 *
 * `AbortSignal.timeout(ms)` y no el `setTimeout` + `clearTimeout` de manual, por
 * una razón que vale la pena: la signal no solo deja de esperar, ABORTA la
 * request. Si lo único que hiciera fuera fallar la promesa, el upload del CV
 * seguiría ocupando el socket del navegador en el fondo y la conexión al backend
 * quedaría viva.
 *
 * `undefined` como valor de retorno NO es un error: es lo que reciben los
 * navegadores que no tengan `AbortSignal.timeout` (ninguno de los soportados
 * hoy; está en Chrome 103+, Firefox 100+ y Safari 16+). Pasar `signal: undefined`
 * es exactamente lo mismo que no pasar `signal`, así que en ese caso se conserva
 * el comportamiento de antes en vez de romper el alta entera.
 *
 * @param {number} ms El techo, en milisegundos.
 * @returns {AbortSignal|undefined}
 */
function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * Convierte una respuesta fallida en un `Error` con la información que la UI
 * necesita para mostrarla bien.
 *
 * Los errores del backend SIEMPRE vienen con `{ error: "<mensaje en español>" }`
 * (`http.js` los arma así), y ese mensaje se muestra TAL CUAL: es texto escrito
 * para la persona, con el motivo y el próximo paso. Reescribirlo en el cliente
 * significa mantener dos versiones de la misma explicación y que una quede vieja.
 *
 * Lo que se le AGREGA son dos datos, no texto:
 *   · `status`: para distinguir los casos que el mensaje solo no dice (401 = la
 *     sesión se cayó, 429 = hay que esperar, 0 = ni siquiera hubo respuesta).
 *   · `retryAfter`: los segundos que dice el 429, y salen SOLO del body.
 *
 * Sobre por qué el header `Retry-After` no se lee (aunque `cv/parse.js` también
 * lo mande): el número del body y el del header son el mismo, y leer el header
 *Obligaría a pasar el `Response` entero a esta función. Si alguna vez un proxy
 * (Vercel, un balanceador) contestara 429 con un body que no es el del backend,
 * el mensaje tampoco estaría y el 429 se vería como un error genérico igual, así
 * que el header no compra un caso real.
 *
 * @param {number} status El status HTTP, o 0 si no hubo respuesta.
 * @param {object} [data] El body ya parseado (puede ser `{}`).
 * @param {string} fallbackMessage Lo que se muestra si el body no trajo `error`.
 * @returns {Error} El error para lanzar.
 */
function apiError(status, data, fallbackMessage) {
  const body = data && typeof data === 'object' ? data : {};
  const error = new Error(body.error || fallbackMessage);
  // ↑ `body.error || fallbackMessage`: el mensaje del backend gana siempre. El
  //   fallback es solo para el caso de que la respuesta no sea JSON (el HTML de
  //   error de un proxy, por ejemplo), donde sin esto se vería "[object Object]".

  error.status = status;

  // El 429 del parseo del CV. Se lee el body primero y el header después: el
  // backend manda los dos, y el body gana porque es el mismo que ya se parseó.
  const retry = Number(body.retryAfter ?? body.retryAfterSeconds);
  if (Number.isFinite(retry) && retry > 0) error.retryAfter = retry;
  // ↑ `??` y no `||`: los dos campos vienen con el mismo número, así que da igual
  //   acá, pero `retryAfter: 0` tiene que poder existir como dato (o sea, "no
  //   esperes") y con `||` se leería como ausente.

  return error;
}

/**
 * Dice quién es el usuario y si ya completó el alta (`GET /api/me`).
 *
 * Es el endpoint que DECIDE A DÓNDE VA LA PANTALLA, y por eso devuelve un
 * resultado con motivo, no un booleano. La distinción que importa es entre las
 * tres respuestas posibles:
 *
 *   · 200 → hay sesión. `{ ok: true, user, profileComplete }`.
 *   · 401 → el backend respondió y dice que no hay sesión: `reason: 'sin-sesion'`.
 *   · no hubo respuesta → `reason: 'sin-respuesta'`.
 *
 * Las dos últimas se parecen en que no hay sesión, pero NO son lo mismo y la UI
 * las trata distinto a propósito: con un 401 se sabe que hay backend y que hay
 * que iniciar sesión; sin respuesta, avisarle a alguien "iniciá sesión" cuando en
 * realidad el server está caído lo manda a un login que tampoco va a funcionar.
 * Por eso `null` no alcanza como respuesta única (que es lo que devuelve
 * `loadProfile`, donde el null sí es un estado real y no una duda).
 *
 * Ojo con el 404: cae en `sin-respuesta`, NO en `sin-sesion`. Un backend viejo
 * sin la ruta `/api/me` no es "el usuario no tiene sesión", y tratar ese caso
 * como un 401 mostraría un aviso de sesión inválida a alguien que solo tiene
 * que esperar a que se despliegue el backend.
 *
 * @returns {Promise<{ok: true, user: object|null, profileComplete: boolean}
 *                  | {ok: false, reason: 'sin-sesion'|'sin-respuesta'}>}
 */
export async function loadSession() {
  try {
    const res = await fetch('/api/me');
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        ok: true,
        user: data.user || null,
        // `=== true` y no truthy: este valor decide si la app muestra el
        // formulario de CV o las ofertas, así que un "1" suelto no puede abrir
        // la compuerta de "ya completaste el alta".
        profileComplete: data.profileComplete === true,
      };
    }
    if (res.status === 401) return { ok: false, reason: 'sin-sesion' };
  } catch {}
  // ↑ Sin respuesta (server caído, sin internet, o la ruta /api/me no existe
  //   todavía). Es el mismo caso que `loadJobs` maneja con el FALLBACK, pero acá
  //   NO hay fallback: solo se informa el motivo.
  return { ok: false, reason: 'sin-respuesta' };
}

/**
 * Manda el CV al backend y devuelve el PERFIL DERIVADO, sin guardar
 * (`POST /api/cv/parse`).
 *
 * Los tres detalles que no son obvios de este endpoint:
 *
 *   · El campo del formulario tiene que llamarse `cv` (`parse.js:FIELD_NAME`), y
 *     es multipart con el archivo crudo.
 *   · NO se pone `Content-Type`. El navegador tiene que poner el `boundary` del
 *     multipart en ese header, y si se lo pone a mano (por ejemplo
 *     `multipart/form-data` a secas) el backend no encuentra el archivo y
 *     responde 400. Es el error clásico de este endpoint, y por eso el `body` va
 *     pelado: un `FormData` se manda solo.
 *   · SÍ lleva timeout, y es el único `fetch` del archivo que lo lleva. Acá se
 *     espera a un LLM de pago: el backend da 25 s al proveedor y su función de
 *     serverless tiene `maxDuration: 60`, así que 75 s es holgado para cualquier
 *     respuesta válida. Lo que va más allá de eso ya no es un LLM lento, es un
 *     backend colgado, y dejarlo esperando para siempre dejaría el botón en
 *     "Analizando tu CV…" sin salida.
 *
 * La respuesta 200 es `{ ok, profile, kind, saved: false }`. El `saved: false`
 * es lo importante: este perfil NO está en la base, existe solo en esta pantalla
 * hasta que el usuario revise y mande el `PUT /api/profile`.
 *
 * @param {File} file El `.pdf` o `.docx` elegido por el usuario.
 * @returns {Promise<{ok: true, profile: object, kind: string, saved: false}>}
 * @throws {Error} Con `status` 401, 400, 413, 415, 429, 502, 504 o 0.
 */
export async function parseCv(file) {
  const form = new FormData();
  // ↑ `new FormData()` sin argumentos: la lista de partes se arma con `append`.
  form.append('cv', file);
  // ↑ El nombre de la parte ES el contrato con el backend. Con `File` entero
  //   (no un string) para que vaya el archivo con su nombre y su tipo.

  let response;
  try {
    response = await fetch('/api/cv/parse', {
      method: 'POST',
      body: form,
      // ↑ SIN `headers`. Ver la nota de arriba: el `Content-Type` lo pone el
      //   navegador con el `boundary` correcto, y pisarlo rompe el parseo.
      signal: timeoutSignal(PARSE_TIMEOUT_MS),
      // ↑ `AbortSignal.timeout` (no `setTimeout` + `clearTimeout`) porque además
      //   ABORTA la request: si solo dejara de esperar, el upload seguiría
      //   ocupando el socket en el fondo. Ver `timeoutSignal()`.
    });
  } catch (err) {
    // ↑ Ni siquiera hubo respuesta. `status: 0` para que la UI lo distinga de un
    //   rechazo del backend (415, 429...) y no le pida al usuario que arregle un
    //   archivo que el problema no es el archivo.
    if (err?.name === 'TimeoutError') {
      // El 504 se elige para que el cliente y el servidor usen el MISMO código
      // para "el proveedor no respondió a tiempo": `cv/parse.js` devuelve 504 en
      // ese caso, y así el frontend no necesita dos textos para lo mismo.
      throw apiError(504, null, 'El análisis del CV tardó demasiado y lo cortamos. Volvé a intentarlo en un momento.');
    }
    throw apiError(0, null, 'No se pudo conectar con el backend. ¿Está corriendo el server?');
  }

  const data = await response.json().catch(() => ({}));
  // ↑ El `.catch` porque un 502 de un proxy puede venir como HTML, y sin esto el
  //   error que vería el usuario sería un error de parseo del JSON.
  if (!response.ok) {
    throw apiError(response.status, data, 'No se pudo analizar tu CV.');
  }
  return data;
}

/**
 * Guarda el perfil completo y devuelve el que quedó LEÍDO de la base
 * (`PUT /api/profile`).
 *
 * OJO con el verbo: es un REEMPLAZO, no un parche (`api/profile.js` y el JSDoc de
 * `saveProfile`). Lo que no viene en el body se BORRA, y `skills` se borra y se
 * reescribe entera. Por eso el componente que arma el body tiene que mandar el
 * perfil ENTERO (incluidos los campos que no se editan, como `marketSkills` y
 * `projects`), y no un par de campos cambiados.
 *
 * @param {object} profile El perfil completo con la forma del contrato.
 * @returns {Promise<{ok: true, profileComplete: true, profile: object}>}
 * @throws {Error} Con `status` 401, 400, 413, 500, 504 o 0.
 */
export async function saveProfile(profile) {
  let response;
  try {
    response = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
      // ↑ JSON sí lleva el `Content-Type` explícito, al revés que el multipart:
      //   acá no hay `boundary` que el navegador tenga que inventar.
      signal: timeoutSignal(SAVE_TIMEOUT_MS),
      // ↑ También con techo, por el mismo motivo que el parseo pero más corto: un
      //   "Guardando…" infinito deja el formulario trabado y, peor todavía, hace
      //   CREER que se guardó algo que en realidad no se guardó. Un 504 con texto
      //   explícito es la única forma honesta de cerrar ese caso.
    });
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw apiError(504, null, 'El guardado tardó demasiado y lo cortamos. No se guardó nada: volvé a intentarlo.');
    }
    throw apiError(0, null, 'No se pudo conectar con el backend. ¿Está corriendo el server?');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiError(response.status, data, 'No se pudo guardar tu perfil.');
  }
  return data;
}

// ════════════════════════════════════════════════════════════════════════════
// AUTENTICACIÓN (paso 8)
// ════════════════════════════════════════════════════════════════════════════
//
// Los tres helpers de abajo son los únicos que hacen `POST` con body chico de JSON
// o sin body, y a diferencia de las lecturas NO tienen FALLBACK: acá no hay una
// app que mostrar con datos inventados. Si el backend no responde, lo que hay que
// poder mostrar es "no pudimos conectarnos", y un login que devuelve un usuario
// falso sería PEOR que un error.
//
// OJO con las cookies: la de sesión es HttpOnly, así que ni este código ni la UI la
// ven. Por eso no hay `credentials: 'include'` explícito — el mismo origen (el proxy
// de Vite en desarrollo, el rewrite en producción) ya envía la cookie sola. Ponerla
// no arregla nada y en un dominio distinto sí mandaría una petición CORS que el
// backend no responde.
//
// Y OJO con el contrato de error: estos LANZAN (no devuelven `{error}`), igual que
// `parseCv` y `saveProfile`. El motivo está en el JSDoc de `apiError`.

/**
 * Crea la cuenta y deja la sesión abierta (`POST /api/register`).
 *
 * Devuelve `profileComplete: false` SIEMPRE, y eso no es una suposición: el backend
 * lo sabe porque acaba de insertar la fila en `users` y no existe perfil todavía.
 * El frontend NO tiene que deducirlo, pero igual usa lo que vino en vez de
 * hardcodear `false`, para que el día de mañana el endpoint pueda devolver otra
 * cosa sin que el ruteo se quede mintiendo.
 *
 * El 409 (correo repetido) es un oráculo de enumeración que el backend acepta a
 * conciencia: el mensaje "Ya existe una cuenta con ese correo" ayuda más de lo que
 * filtra, porque acáEnumerar correos no sirve para robar una clave (para eso está
 * el login, que responde siempre con el mismo 401). Por eso el mensaje se muestra
 * tal cual, sin convertirlo en un error genérico.
 *
 * @param {{email: string, password: string}} credenciales
 * @returns {Promise<{ok: true, user: object, profileComplete: boolean}>}
 * @throws {Error} Con `status` 400, 409, 429 o 0.
 */
export async function register({ email, password }) {
  let response;
  try {
    response = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    // ↑ `catch` sin binding: no se usa el error y no se quiere la variable.
    //   El 0 es el que separa "el backend dijo que no" de "no hubo backend": con
    //   server caído la UI tiene que decir "no pudimos conectarnos" y no
    //   "revisá tu correo", que sería un consejo inútil.
    throw apiError(0, null, 'No se pudo conectar con el backend. ¿Está corriendo el server?');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw apiError(response.status, data, 'No se pudo crear la cuenta.');
  }
  return data;
}

/**
 * Entra con correo y clave (`POST /api/login`).
 *
 * El 401 es SIEMPRE el mismo texto, esté o no el correo, y eso no es un descuido
 * del backend: si distinguiera los dos casos, cualquiera podría usar el login para
 * descubrir qué correos tienen cuenta. Por eso el frontend no intenta "mejorar" el
 * mensaje ni completar con un "¿registrarte?" según el status: el 401 no dice nada
 * de qué lado está el problema.
 *
 * OJO con el `profileComplete` del login: NO es siempre `false` como en el
 * registro. Quien vuelve a entrar ya tiene perfil, y mandar a esa persona al
 * onboarding del CV la haría subir el CV otra vez y gastar otra vez la cuota del
 * LLM. Por eso `loadSession()` consulta el valor y el ruteo lo usa tal cual.
 *
 * @param {{email: string, password: string}} credenciales
 * @returns {Promise<{ok: true, user: object, profileComplete: boolean}>}
 * @throws {Error} Con `status` 400, 401, 429 o 0.
 */
export async function login({ email, password }) {
  let response;
  try {
    response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      // ↑ Sin `AbortSignal.timeout` a propósito, y es una excepción consciente: acá
      //   no hay ni LLM ni upload, es un login contra la base. El peor caso de colgar
      //   es esperar el `maxDuration` de la función y recibir un 5xx, que se muestra
      //   como error normal. Un timeout propio solo agregaría un texto más.
    });
  } catch {
    throw apiError(0, null, 'No se pudo conectar con el backend. ¿Está corriendo el server?');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // El 429 del login trae `Retry-After`, y `apiError` lo pasa a `.retryAfter`:
    // la pantalla de acceso lo muestra como "esperá un ratito" en vez de error.
    throw apiError(response.status, data, 'No se pudo iniciar sesión.');
  }
  return data;
}

/**
 * Cierra la sesión (`POST /api/logout`).
 *
 * No borra nada del servidor: no hay tabla de sesiones. El backend manda la misma
 * cookie con `Max-Age=0`, que es lo que la hace desaparecer del navegador.
 *
 * Por eso esta función NO lanza cuando el backend no responde, y el comentario es
 * el que explica por qué: si el logout falló porque no hay conexión, la cookie
 * sigue viva del lado del browser, y la UI igual tiene que volver a la pantalla de
 * acceso. Tirar el error dejaría al usuario trabado en una sesión que ya no quiere,
 * esperando un reintento de algo que no hace falta. La cookie sola no alcanza para
 * volver a entrar: el `GET /api/me` siguiente la invalida si el servidor no la
 * reconoce, y la UI igual fuerza el estado local.
 *
 * @returns {Promise<boolean>} `true` si el backend confirmó, `false` si no respondió.
 */
export async function logout() {
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Borra la cuenta (`DELETE /api/account`).
 *
 * Es la ÚNICA función de la capa de red que se parece a `logout` y aun así LANZA
 * cuando el backend no responde. La diferencia no es un detalle de implementación
 * sino el motivo por el que existen dos funciones y no una con un parámetro:
 *
 *   · `logout()` NO tira y devuelve `false`. Cerrar sesión no borra nada del
 *     servidor: manda la cookie con `Max-Age=0`. Si el server estaba caído, la
 *     cookie sigue viva, la UI tiene que volver al login igual, y el próximo
 *     `GET /api/me` corrige el estado con un 401. Un logout optimista es lo
 *     correcto ahí.
 *   · `deleteAccount()` TIENE que tirar. El borrado sí destruye datos, y la
 *     diferencia entre "se borró" y "no se borró" es la diferencia entre una app
 *     que respeta lo que le pidieron y una que le dice a alguien que su perfil se fue
 *     cuando sigue entero en la base. Por eso no hay ni un `catch` que se trague
 *     la respuesta: el componente tiene que poder mostrar el error y dejar el
 *     modal abierto.
 *
 * El mensaje de error se muestra TAL CUAL lo escribió `http.js`, por la misma
 * regla de `parseCv` y `saveProfile`: el backend es el que dice el motivo y el
 * próximo paso, y el cliente solo le AGREGA `status` y `retryAfter` (datos, no
 * texto). Acá el caso real es el 401: si la sesión ya se había caído, el backend
 * contesta "Necesitás iniciar sesión." y tiene que ser eso lo que se lea, no un
 * "no se pudo borrar la cuenta" genérico que haría pensar que el backend está
 * caído cuando lo que pasó es que la cookie venció.
 *
 * @returns {Promise<{ok: true}>} La respuesta del backend.
 * @throws {Error} Con `status` 401, 0, 504 o 500. El mensaje es el del backend.
 */
export async function deleteAccount() {
  let response;
  try {
    response = await fetch('/api/account', {
      method: 'DELETE',
      signal: timeoutSignal(DELETE_TIMEOUT_MS),
      // ↑ Sin body, y sin headers: el endpoint no lee ninguno de los dos y el
      //   `user_id` sale de la cookie que el navegador manda solo. Mandar un
      //   `Content-Type` acá sería mentir sobre un body que no existe.
    });
  } catch {
    // No hubo respuesta: se cortó la red, no hay backend, o vencieron los 30 s.
    throw apiError(0, null, 'No se pudo conectar con el backend. ¿Está corriendo el server?');
    // ↑ El timeout cae en ESTE catch y no tiene mensaje propio (a diferencia de
    //   `parseCv` y `saveProfile`, que distinguen 504 de "no hubo conexión").
    //   Es a propósito: acá las dos cosas son lo mismo para el usuario —no se
    //   borró nada y hay que reintentar— y un 504 "el borrado tardó demasiado"
    //   sugeriría que el servidor está lento, cuando lo que se cortó fue nuestra
    //   espera. Un 504 solo se mandaría si el backend lo decide.
  }

  const data = await response.json().catch(() => ({}));
  // ↑ `.catch(() => ({}))` y no dejar que un body no-JSON reviente: un 502 del
  //   proxy de Vercel suele venir en HTML, y sin esto el error que vería el
  //   usuario sería "Unexpected token <" en vez del mensaje del backend.
  if (!response.ok) {
    throw apiError(response.status, data, 'No se pudo borrar la cuenta.');
  }
  return data;
}
