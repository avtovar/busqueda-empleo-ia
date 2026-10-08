// ============================================================================
// TÉRMINOS DE BÚSQUEDA: con qué palabras se le pregunta a cada bolsa de empleo.
//
// POR QUÉ EXISTE ESTE ARCHIVO (es el bug de raíz que elimina)
// ----------------------------------------------------------
// En el proyecto origen los términos de búsqueda estaban repartidos en CINCO
// lugares distintos, y los CINCO estaban hardcodeados a QA:
//
//   · `BASE_KEYWORDS` en `jobSources.js:13`  → ['qa','quality','tester','test',
//     'automation','sdet']
//   · `REMOTIVE_TERMS` en `jobSources.js:63` → las 5 búsquedas a Remotive
//   · `?q=qa` clavado en la URL de Himalayas (`jobSources.js:139`)
//   · el filtro local sobre RemoteOK con `BASE_KEYWORDS` (`:166-170`)
//   · `?tag=qa` clavado en la URL de Jobicy (`:189`)
//
// Para el único usuario que tenía el origen (un QA) cuatro de los cinco
// acertaban. Para una enfermera o un contador, CUATRO DE LOS CINCO le mandaban a
// la bolsa una query que no era suya: le pedían "qa" y le devolvían la bolsa
// entera (RemoteOK) o literalmente nada (Himalayas, Jobicy).
//
// Y el modo de falla es el peor de todos: NO es un error, es un CERO SILENCIOSO.
// La pantalla muestra "no encontramos ofertas" y no queda nada en ningún log que
// diga por qué. Un bug que no se ve es un bug que se repite en cada bolsa nueva
// que se agrega.
//
// ESTE ARCHIVO ES EL ARREGLO DE RAÍZ: una sola función, y el criterio sale del
// PERFIL del usuario. Cuando aparezca una bolsa nueva, sus términos salen de acá
// y no de una constante nueva que alguien tiene que acordarse de mantener.
//
// LO QUE ESTE ARCHIVO NO HACE, y por qué está dicho:
//   · No decide en qué región está una oferta: eso es `regions.js`.
//   · No matchea skills contra el texto de una oferta: eso es `text.js`.
//   · No sabe nada de ninguna bolsa en particular (ni Remotive ni Jobicy ni qué
//     parámetro acepta cada una). Cada bolsa pide lo que necesita de la lista
//     que arma acá, y cada una recorta la cantidad que le conviene.
//   · No inventa un término por defecto. Sin perfil NO HAY términos, y eso es un
//     dato honesto: preferimos no traer nada antes que traer la bolsa entera
//     como si fuera de la profesión del usuario.
// ============================================================================

import { textHasSkill, toNumber } from './text.js';
// ↑ Son los dos únicos de `text.js` que hacen falta acá, y los dos por lo que
//   dicen en su propio JSDoc: `textHasSkill` es la comparación de términos contra
//   texto (que `matchesAnyTerm` no reimplementa) y `toNumber` es el reader de
//   valores raros, que acá son los pesos de las skills. Lo que NO se importa es
//   `normalize()` de `regions.js`, y es deliberado: ver la nota de `push` más
//   abajo, donde está el porqué entero.

// ════════════════════════════════════════════════════════════════════════════
// SINÓNIMOS ES/EN PARA TÉRMINOS COMUNES
// ════════════════════════════════════════════════════════════════════════════
// Esto ayuda a que búsquedas en español matcheen ofertas en inglés y viceversa.
// Se usa en `expandTermsWithSynonyms` para agregar el término opuesto a cada query.
//
// Formato: { es: ['término en español'], en: ['término en inglés'] }
// Los arrays permiten múltiples variantes (ej. "enfermera" -> "nurse", "rn").
const SYNONYMS_ES_EN = [
  // Salud
  { es: ['enfermera', 'enfermera', 'enfermería', 'enfermero', 'licenciada en enfermería'], en: ['nurse', 'rn', 'registered nurse', 'nursing'] },
  { es: ['médico', 'médica', 'doctor', 'doctora', 'médico general', 'médico de familia'], en: ['doctor', 'physician', 'gp', 'general practitioner'] },
  { es: ['farmacéutico', 'farmacéutica', 'farmacia'], en: ['pharmacist', 'pharmacy'] },
  { es: ['psicólogo', 'psicóloga', 'psicología'], en: ['psychologist', 'psychology'] },
  { es: ['odontólogo', 'odontóloga', 'dentista'], en: ['dentist', 'dental'] },
  { es: ['kinesiólogo', 'kinesióloga', 'fisioterapeuta'], en: ['physiotherapist', 'physical therapist', 'pt'] },
  { es: ['nutricionista', 'nutrición'], en: ['nutritionist', 'dietitian'] },
  { es: ['paramédico', 'paramédica', 'técnico en emergencias'], en: ['paramedic', 'emt', 'emergency medical technician'] },
  { es: ['auxiliar de enfermería', 'ayudante de enfermería'], en: ['nursing assistant', 'cna', 'certified nursing assistant'] },
  { es: ['obstetra', 'matrona'], en: ['midwife', 'obstetrician'] },
  { es: ['bioquímico', 'bioquímica', 'laboratorio clínico'], en: ['biochemist', 'clinical laboratory', 'lab technician'] },
  { es: ['radiología', 'técnico en radiología', 'radiología médica'], en: ['radiology', 'radiologic technologist', 'x-ray technician'] },

  // Gastronomía / Hotelería
  { es: ['chef', 'cocinero', 'cocinera', 'chef de cuisine', 'chef ejecutivo'], en: ['chef', 'cook', 'executive chef', 'sous chef'] },
  { es: ['panadero', 'panadera', 'pastelero', 'pastelera', 'panadería'], en: ['baker', 'pastry chef', 'bakery'] },
  { es: ['camarero', 'camarera', 'mozo', 'moza', 'mesero', 'mesera'], en: ['waiter', 'waitress', 'server'] },
  { es: ['bartender', 'barman', 'barmaid', 'coctelero'], en: ['bartender', 'mixologist'] },
  { es: ['gerente de restaurante', 'jefe de sala', 'maître'], en: ['restaurant manager', 'floor manager', 'maitre d'] },
  { es: ['recepcionista de hotel', 'front desk'], en: ['hotel receptionist', 'front desk agent'] },
  { es: ['gobernanta', 'ama de llaves', 'housekeeping'], en: ['housekeeper', 'room attendant', 'housekeeping'] },

  // Contabilidad / Finanzas / Administración
  { es: ['contador', 'contadora', 'contador público', 'contadora pública'], en: ['accountant', 'cpa', 'certified public accountant'] },
  { es: ['analista contable', 'asistente contable', 'auxiliar contable'], en: ['accounting analyst', 'accounting assistant', 'bookkeeper'] },
  { es: ['auditor', 'auditora', 'auditoría'], en: ['auditor', 'auditing'] },
  { es: ['analista financiero', 'analista de finanzas', 'finanzas'], en: ['financial analyst', 'finance analyst'] },
  { es: ['tesorero', 'tesorera', 'tesorería'], en: ['treasurer', 'treasury'] },
  { es: ['controlador de gestión', 'controller', 'controlling'], en: ['controller', 'management controller'] },
  { es: ['impuestos', 'tributario', 'impositivo', 'declaraciones juradas'], en: ['tax', 'taxation', 'tax compliance'] },
  { es: ['conciliaciones', 'conciliación bancaria', 'conciliar'], en: ['reconciliation', 'bank reconciliation'] },
  { es: ['facturación', 'facturador', 'facturadora'], en: ['billing', 'invoicing'] },
  { es: ['administrativo', 'administrativa', 'asistente administrativo'], en: ['administrative', 'administrative assistant', 'admin assistant'] },
  { es: ['secretaria', 'secretario', 'secretariado', 'asistente ejecutivo'], en: ['secretary', 'executive assistant', 'executive secretary'] },

  // IT / Desarrollo / QA
  { es: ['programador', 'programadora', 'desarrollador', 'desarrolladora', 'dev'], en: ['developer', 'programmer', 'software engineer'] },
  { es: ['frontend', 'front-end', 'desarrollador frontend'], en: ['frontend', 'front-end developer', 'ui developer'] },
  { es: ['backend', 'back-end', 'desarrollador backend'], en: ['backend', 'back-end developer', 'api developer'] },
  { es: ['fullstack', 'full stack', 'desarrollador full stack'], en: ['fullstack', 'full stack developer'] },
  { es: ['qa', 'q.a.', 'tester', 'quality assurance', 'control de calidad'], en: ['qa', 'quality assurance', 'tester', 'qe', 'quality engineer'] },
  { es: ['automatización', 'automatizador', 'automation', 'qa automation'], en: ['automation', 'test automation', 'automation engineer', 'sdq'] },
  { es: ['devops', 'ingeniero devops', 'infraestructura'], en: ['devops', 'devops engineer', 'site reliability engineer', 'sre'] },
  { es: ['sysadmin', 'administrador de sistemas', 'system admin'], en: ['sysadmin', 'system administrator', 'systems engineer'] },
  { es: ['dba', 'administrador de base de datos', 'base de datos'], en: ['dba', 'database administrator', 'database engineer'] },
  { es: ['arquitecto de software', 'software architect'], en: ['software architect', 'solution architect'] },
  { es: ['scrum master', 'agile coach', 'metodologías ágiles'], en: ['scrum master', 'agile coach'] },
  { es: ['product owner', 'product manager', 'gestor de producto'], en: ['product owner', 'product manager'] },
  { es: ['data scientist', 'científico de datos', 'data analyst', 'analista de datos'], en: ['data scientist', 'data analyst'] },
  { es: ['machine learning', 'ml', 'inteligencia artificial', 'ia'], en: ['machine learning', 'ml engineer', 'ai', 'artificial intelligence'] },
  { es: ['ciberseguridad', 'seguridad informática', 'pentesting', 'ethical hacking'], en: ['cybersecurity', 'information security', 'pentesting', 'ethical hacker'] },

  // Ventas / Marketing / Atención al cliente
  { es: ['vendedor', 'vendedora', 'ventas', 'comercial', 'representante de ventas'], en: ['sales', 'sales representative', 'sales executive', 'account executive'] },
  { es: ['marketing', 'marketing digital', 'community manager', 'social media'], en: ['marketing', 'digital marketing', 'community manager', 'social media manager'] },
  { es: ['atención al cliente', 'soporte', 'customer service', 'soporte técnico'], en: ['customer service', 'customer support', 'technical support', 'help desk'] },
  { es: ['gestor de cuentas', 'account manager', 'key account manager'], en: ['account manager', 'key account manager', 'customer success manager'] },
  { es: ['telemarketing', 'teleoperador', 'teleoperadora'], en: ['telemarketing', 'call center agent', 'outbound sales'] },

  // Logística / Operaciones / Supply Chain
  { es: ['logística', 'logístico', 'supply chain', 'cadena de suministro'], en: ['logistics', 'supply chain', 'supply chain manager'] },
  { es: ['depósito', 'almacén', 'bodega', 'almacenero', 'almacenera'], en: ['warehouse', 'warehouse worker', 'stocker'] },
  { es: ['chofer', 'conductor', 'camionero', 'repartidor', 'repartidora'], en: ['driver', 'truck driver', 'delivery driver'] },
  { es: ['operario', 'operaria', 'operario de producción', 'producción'], en: ['operator', 'production operator', 'manufacturing operator'] },
  { es: ['supervisor de producción', 'jefe de turno', 'jefa de turno'], en: ['production supervisor', 'shift supervisor', 'shift leader'] },
  { es: ['calidad', 'control de calidad', 'quality control', 'qa industrial'], en: ['quality control', 'quality assurance', 'qc', 'qa'] },

  // Educación
  { es: ['docente', 'profesor', 'profesora', 'maestro', 'maestra'], en: ['teacher', 'professor', 'instructor'] },
  { es: ['profesor universitario', 'profesora universitaria', 'docente universitario'], en: ['university professor', 'lecturer', 'academic'] },
  { es: ['educador', 'educadora', 'educación'], en: ['educator', 'education'] },
  { es: ['tutor', 'tutora', 'tutoría'], en: ['tutor', 'tutoring'] },

  // Legal / RRHH
  { es: ['abogado', 'abogada', 'abogacía', 'asesor legal'], en: ['lawyer', 'attorney', 'legal counsel', 'legal advisor'] },
  { es: ['recursos humanos', 'rrhh', 'human resources', 'gestión de talento'], en: ['human resources', 'hr', 'talent acquisition', 'hr business partner'] },
  { es: ['reclutador', 'reclutadora', 'headhunter', 'talent acquisition'], en: ['recruiter', 'talent acquisition', 'headhunter'] },
  { es: ['nóminas', 'payroll', 'liquidación de sueldos'], en: ['payroll', 'payroll specialist', 'compensation and benefits'] },

  // Construcción / Ingeniería / Mantenimiento
  { es: ['ingeniero civil', 'ingeniera civil', 'obra civil'], en: ['civil engineer', 'civil engineering'] },
  { es: ['ingeniero industrial', 'ingeniera industrial'], en: ['industrial engineer'] },
  { es: ['ingeniero mecánico', 'ingeniera mecánica'], en: ['mechanical engineer'] },
  { es: ['ingeniero eléctrico', 'ingeniera eléctrica'], en: ['electrical engineer'] },
  { es: ['arquitecto', 'arquitecta', 'arquitectura'], en: ['architect', 'architecture'] },
  { es: ['maestro mayor de obras', 'capataz', 'encargado de obra'], en: ['construction foreman', 'site supervisor', 'foreman'] },
  { es: ['electricista', 'electricista industrial'], en: ['electrician', 'industrial electrician'] },
  { es: ['plomero', 'plomera', 'gasista', 'sanitarista'], en: ['plumber', 'pipefitter', 'gas fitter'] },
  { es: ['mantenimiento', 'técnico de mantenimiento', 'mantenimiento industrial'], en: ['maintenance', 'maintenance technician', 'maintenance engineer'] },

  // Diseño / Creativo
  { es: ['diseñador', 'diseñadora', 'diseño gráfico', 'graphic design'], en: ['designer', 'graphic designer', 'visual designer'] },
  { es: ['diseñador ux', 'diseñadora ux', 'ux design', 'user experience'], en: ['ux designer', 'user experience designer', 'ux researcher'] },
  { es: ['diseñador ui', 'diseñadora ui', 'ui design', 'user interface'], en: ['ui designer', 'user interface designer', 'visual designer'] },
  { es: ['ilustrador', 'ilustradora', 'ilustración'], en: ['illustrator', 'illustration'] },
  { es: ['editor de video', 'video editor', 'postproducción'], en: ['video editor', 'post-production', 'motion graphics'] },
  { es: ['fotógrafo', 'fotógrafa', 'fotografía'], en: ['photographer', 'photography'] },
  { es: ['redactor', 'redactora', 'copywriter', 'contenidos'], en: ['copywriter', 'content writer', 'content creator'] },

  // Otros oficios
  { es: ['veterinaria', 'veterinario', 'veterinaria', 'clínica veterinaria'], en: ['veterinary', 'veterinarian', 'vet clinic'] },
  { es: ['agronomo', 'agronoma', 'ingeniero agrónomo'], en: ['agronomist', 'agricultural engineer'] },
  { es: ['periodista', 'comunicador', 'comunicación'], en: ['journalist', 'communications', 'media'] },
  { es: ['traductor', 'traductora', 'traducción', 'intérprete'], en: ['translator', 'interpreter', 'translation'] },
];

/**
 * Dado un término, devuelve sus sinónimos en el otro idioma.
 * @param {string} term Término a buscar.
 * @returns {string[]} Sinónimos (puede estar vacío).
 */
function getSynonyms(term) {
  const lower = term.toLowerCase().trim();
  for (const entry of SYNONYMS_ES_EN) {
    if (entry.es.some(s => s.toLowerCase() === lower)) return entry.en;
    if (entry.en.some(s => s.toLowerCase() === lower)) return entry.es;
  }
  return [];
}

/**
 * Agrega sinónimos es/en a una lista de términos.
 * Se usa ANTES de mandar a las bolsas para que una búsqueda en español también
 * busque en inglés y viceversa.
 * @param {string[]} terms Términos originales.
 * @returns {string[]} Términos + sinónimos (deduplicados).
 */
export function expandTermsWithSynonyms(terms) {
  if (!Array.isArray(terms)) return [];
  const out = [...terms];
  const seen = new Set(out.map(t => t.toLowerCase()));
  for (const term of terms) {
    for (const syn of getSynonyms(term)) {
      const key = syn.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(syn);
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// LÍMITES DE UN TÉRMINO
// ════════════════════════════════════════════════════════════════════════════

/**
 * Largo máximo de un término, en caracteres.
 *
 * 40 y no 120 como en `portal.js`: acá el término va DENTRO de la URL de la bolsa
 * (`?q=`, `?tag=`, `?search=`), y hay dos razones para que sea más corto que el
 * `queryOf` del portal. Una: algunas bolsas tienen límite de largo de query y
 * cortan en silencio (devuelven 200 con cero resultados y no dicen por qué). Dos:
 * un término de 120 caracteres es una FRASE, y una frase matchea casi cualquier
 * oferta, así que la bolsa devuelve el catálogo entero y se pierde el sentido de
 * "estoy buscando este puesto".
 */
const TERM_MAX_LENGTH = 40;

/**
 * Largo mínimo de un término, en caracteres.
 *
 * El piso existe por `textHasSkill`, no por la URL: `text.js:178` ya corta el
 * término vacío porque un patrón con el término en blanco matchea CASI cualquier
 * texto. Acá el corte es previo, para que un keyword de un carácter (que el LLM
 * del CV produce más seguido de lo que uno creería: "C", "R", "I") ni llegue a la
 * bolsa ni entre en `matchesAnyTerm`.
 */
const TERM_MIN_LENGTH = 2;

/**
 * Cuántos términos se devuelven por defecto.
 *
 * 5 es un presupuesto, no una bolsa de datos: el que llama decide cuántos quiere
 *   y para qué. Remotive, que abre UNA petición HTTP por término, se queda con los
 *   primeros 3 (ver `jobSources.js`). Los otros no.
 */
const DEFAULT_MAX_TERMS = 5;

// ════════════════════════════════════════════════════════════════════════════
// LOS TÉRMINOS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Los términos de búsqueda de un usuario, en orden de prioridad.
 *
 * EL ORDEN ES EL CRITERIO, y está pensado así:
 *
 *   1. `profile.title` PRIMERO, siempre. Es el puesto al que la persona se
 *      postula, escrito por ella o por el LLM del CV: es el término más preciso
 *      que existe, y las bolsas lo entienden literal ("Enfermera" trae
 *      enfermeras, "Auxiliar de enfermería" trae auxiliares).
 *   2. `profile.keywords`, en el orden en que los dio el LLM del CV.
 *   3. Los `profile.skills` con más peso, de mayor a menor.
 *
 * Por qué las skills van AL FINAL y no antes que los keywords: un keyword es
 * texto que el LLM eligió como "lo que define a esta persona" y ya viene
 * deduplicado y limpio (`profile.js:normalizeKeywords`). Un nombre de skill es
 * una palabra suelta, muchas veces una tecnología ("Postgres") que sola no
 * describe ningún puesto. Es el mejor relleno que hay, pero es relleno.
 *
 * OJO con el criterio de pesos: `normalizeSkills` YA devuelve el array ordenado
 * por peso descendente, así que acá el `sort` es redundante para los perfiles que
 * salen de la base. Se hace igual, y con `.map` primero para no mutar el array
 * del perfil: esta función es pura y no puede reordenar el objeto del usuario.
 *
 * @param {object|null} profile Perfil del contrato (`api/lib/profile.js`), o null.
 * @param {{max?: number}} [options] `max` = cuántos términos devolver como
 *   máximo. `0` o negativo devuelve `[]`, que es un corte válido (una bolsa que
 *   solo puede hacer una petición y no quiere gastar el presupuesto en una).
 * @returns {string[]} Términos limpios, sin repetidos, de a lo sumo `max`. `[]`
 *   si el perfil no tiene nada usable: NO hay término por defecto.
 */
export function searchTerms(profile, options = {}) {
  const max = Math.floor(toNumber(options?.max, DEFAULT_MAX_TERMS));
  // ↑ `toNumber` y no `options.max || DEFAULT`: un `max: 0` explícito vale, y con
  //   `||` el 0 caería al default y "no me pases términos" sería indistinguible de
  //   "no me dijiste cuántos". `Math.floor` porque un `2.7` de un número que viene
  //   de un query param no puede devolver tres términos.

  const out = [];
  const seen = new Set();

  // ↑ Un `Set` para la deduplicación en vez de `out.includes(...)`: la lista es
  //   corta, pero el criterio acá NO puede ser `normalize()` (ver la nota de
  //   `push`), así que la comparación es por minúsculas y una lista corta con
  //   `includes` sería un O(n²) por nada.

  /**
   * Agrega un término si sirve y si todavía hay lugar. No tira: si no entra, no
   * entra.
   * @param {unknown} raw El término crudo del perfil.
   */
  const push = (raw) => {
    if (out.length >= max) return;
    const term = collapseTerm(raw);
    if (!term) return;
    // ↑ `toLowerCase()` y NO `normalize()` de `regions.js`, y la diferencia no es
    //   cosmetics. `normalize()` saca acentos: "atención" y "atencion" pasarían a
    //   ser el MISMO término, y acá dos términos que se diferencian SOLO por la
    //   tilde son dos búsquedas distintas para el usuario. Peor: estos términos
    //   van dentro de una URL, y una bolsa que compare literal ("atención" con
    //   tilde contra su índice) encuentra una cosa y sin tilde otra. La
    //   normalización para COMPARAR vive en `textHasSkill`, que normaliza los dos
    //   lados; acá solo hace falta no repetir la misma búsqueda dos veces.
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };

  push(profile?.title);

  if (Array.isArray(profile?.keywords)) {
    for (const keyword of profile.keywords) push(keyword);
  }
  // ↑ El `Array.isArray` es defensivo y NO por desconfianza del normalizador:
  //   `profile.js` garantiza el array, pero este archivo también se puede llamar
  //   con un perfil armado a mano desde un endpoint o un test, y `for...of` sobre
  //   un string recorre letras (mandaría "a","t","e"... a la bolsa) y sobre `null`
  //   tira. El corte es acá porque es el lugar donde el tipo importa.

  for (const name of skillNamesByWeight(profile?.skills)) push(name);

  return out;
}

/**
 * El término más preciso de una lista, o `''` si no hay ninguno.
 *
 * Existe para las bolsas que aceptan UN solo término y no varios: el parámetro
 * `?q=` de Himalayas y el `?tag=` de Jobicy son de a uno, así que la pregunta no
 * es "con cuál de estos" sino "mandá el que más chance tiene", y ese es el
 * primero (el título, por `searchTerms`). Las demás bolsas, que aceptan texto
 * libre, pueden usar la lista entera.
 *
 * Pasa el valor por `collapseTerm` otra vez: es idempotente y así el que llama no
 * tiene que asumir que la lista que le pasaron ya venía normalizada.
 *
 * @param {string[]} [terms] Lista de términos.
 * @returns {string} El primero, o `''`.
 */
export function primaryTerm(terms) {
  if (!Array.isArray(terms)) return '';
  return collapseTerm(terms[0]);
}

/**
 * ¿El texto de una oferta menciona ALGUNO de los términos?
 *
 * Para el FILTRADO LOCAL de las bolsas que no aceptan parámetro de búsqueda (hoy
 * RemoteOK, que devuelve el feed completo). Es el reemplazo del filtro de QA del
 * origen: en vez de "estas son las palabras de la profesión", son "las palabras
 * de ESTE usuario".
 *
 * Delega en `textHasSkill`, que normaliza los DOS lados y exige PALABRA COMPLETA
 * (que "qa" no entre adentro de "quality"). No se reimplementa: es exactamente el
 * mismo criterio con el que `matcher.js` matchea skills, y dos copias de esa
 * comparación pueden divergir sin que nadie se entere.
 *
 * CONTRATO DEL PARÁMETRO `text`: tiene que venir de `jobText()` o de
 * `normalize()`. `textHasSkill` normaliza el término, no el texto, y romper el
 * contrato da `false` en silencio (es la nota de `text.js:159-164`).
 *
 * @param {string} text Texto YA normalizado de la oferta.
 * @param {string[]} [terms] Los términos del usuario.
 * @returns {boolean} Si alguno aparece.
 */
export function matchesAnyTerm(text, terms) {
  if (!Array.isArray(terms)) return false;
  for (const term of terms) {
    if (textHasSkill(text, term)) return true;
    // ↑ `continue` implícito: con 5 términos el `||` acumulado se leería igual de
    //   bien, pero el loop corta en el primer acierto y es lo que se quiere: se
    //   compara contra el texto de una oferta UNA vez, no cinco.
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// Ayudantes
// ════════════════════════════════════════════════════════════════════════════

/**
 * Deja un término presentable en una URL: espacios colapsados, sin vacío, con un
 * tope de largo.
 *
 * El corte por palabra y no a los 40 caracteres exactos: un keyword del LLM
 * puede ser "Diseño e implementación de pipelines de datos para análisis de" y
 * cortarlo en seco deja "...para análisis de", que es una búsqueda distinta (y
 * peor) de la que quería el usuario. Si hay una palabra completa reasonably cerca
 * del límite, se corta ahí; si no hay ninguna (una sola palabra enorme), se corta
 * donde sea. El piso del último corte evita "Enferm" o "Inge".
 *
 * @param {unknown} raw Lo que haya en el perfil.
 * @returns {string} El término, o `''` si no sirve.
 */
function collapseTerm(raw) {
  // ↑ `raw == null` y no `asText()`: acá `null`, `undefined` y `''` significan
  //   todos lo mismo (no hay término), y `0` o `false` tampoco son términos. Un
  //   keyword numérico del LLM ("5 años de experiencia") SÍ es texto válido y
  //   entra por el `String()`.
  if (raw === null || raw === undefined) return '';
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (text.length < TERM_MIN_LENGTH) return '';
  if (text.length <= TERM_MAX_LENGTH) return text;

  const cut = text.lastIndexOf(' ', TERM_MAX_LENGTH);
  // ↑ `lastIndexOf` con el segundo argumento es el último espacio que cabe DENTRO
  //   del límite. Si ese corte queda muy al principio (una sola palabra larga), no
  //   sirve: "Enferm" es peor que "Enfermera profesional".
  if (cut >= Math.floor(TERM_MAX_LENGTH / 2)) return text.slice(0, cut).trim();
  return text.slice(0, TERM_MAX_LENGTH).trim();
}

/**
 * Los nombres de las skills del perfil, de la que más pesa a la que menos.
 *
 * Ordena una COPIA y no el array del perfil: esta función es pura y no puede
 * reordenar el objeto de otro usuario (y en serverless, el objeto compartido
 * entre llamadas). El `filter` de objetos es porque `skills` es
 * `[{name, weight}]` y un elemento raro (un string suelto) no tiene `.name`.
 *
 * @param {unknown} skills El `profile.skills`.
 * @returns {string[]} Nombres, ordenados por peso descendente.
 */
function skillNamesByWeight(skills) {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((skill) => skill && typeof skill === 'object')
    .map((skill) => ({ name: skill.name, weight: toNumber(skill.weight, 0) }))
    .sort((a, b) => b.weight - a.weight)
    // ↑ `toNumber(w, 0)` y no `toNumber(w)`: el default de `toNumber` sin
    //   segundo argumento ya es 0, pero dejarlo explícito dice que el default
    //  ACA es "no pesó nada". Un peso no numérico (el LLM respondió `"alta"`)
    //   manda al final en vez de romper el `sort` con un NaN.
    .map((skill) => skill.name);
}