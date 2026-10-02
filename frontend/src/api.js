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
// No hay timeout ni AbortController: si el backend se cuelga, la promesa queda
// esperando indefinidamente (eso sí, el resto de la UI sigue funcionando).

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
//   y.handleRefresh() recarga igual la región: cuando el POST fallaba (server
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
