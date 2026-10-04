// ============================================================================
// ANALÍTICA DEL MERCADO Y PROPUESTA DE INTERÉS.
//
// De acá sale toda la data de la página "Propuesta de Interés". La idea es
// simple y no cambia: se juntan TODAS las ofertas detectadas, se cuenta cuántas
// veces el mercado pide cada habilidad del perfil, se cruza eso contra lo que la
// persona tiene, y de la diferencia salen recomendaciones accionables.
//
// Lo que cambia respecto del origen es DE QUÉ salen las habilidades y las
// recomendaciones:
//
//   · Antes `PROFILE` (el perfil hardcodeado de una persona) proveía las skills,
//     los `marketSkills`, los proyectos y hasta el nombre para la firma. Ahora
//     todo eso llega por parámetro.
//
//   · Antes las recomendaciones tenían PROFESIÓN DENTRO del texto: el cluster
//     `SKILL_CLUSTERS` agrupaba "cypress/playwright/selenium" bajo "E2E / Web UI",
//     y la recomendación 4 era sobre "banca/fintech/medios de pago" con el nombre
//     del producto de un banco ("Bantotal") hardcodeado en el regex. Para un
//     contador o una enfermera eso no es una recomendación poor: es una
//     recomendación FALSA. Las dos se reemplazaron por cosas derivadas de los
//     datos del usuario (ver REC 2 y REC 4).
//
//   · Antes `REGION_LABELS` tenía los siete países del origen. Ahora el label
//     sale de `regionLabel()` en regions.js, que es el único lugar del proyecto
//     donde se decide qué países existen.
//
// IMPORTANTE SOBRE `paymentPct` / `paymentCount`: se ELIMINARON del contrato.
// No los consumía ningún componente del frontend (verificado con grep sobre
// `frontend/src`), y mantenerlos obligaría a conservar el regex de banca, que es
// exactamente el hardcoding que este módulo vino a sacar. Si algún día se
// necesita "cuántas ofertas son de un sector", es una vertical nueva y se
// resuelve con `marketSkills`, no con una lista de palabras en el código.
//
// IGUAL QUE EN EL MATCHER: no se muta ningún objeto que venga de afuera, y no
// hay estado entre llamadas. `buildAnalytics` es una función pura: la misma
// entrada da la misma salida.
// ============================================================================

import { computeMatch } from './matcher.js';
import { emptyProfile } from './profile.js';
import { regionLabel } from './regions.js';
import { jobText, normalize, textHasSkill } from './text.js';

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Perfil utilizable o perfil vacío.
 *
 * Sin perfil, esta función igual devuelve la forma completa del contrato con
 * todos los contadores en cero. No se tira una excepción: `/api/analytics` ya
 * devuelve 403 sin perfil, así que el `null` acá solo aparece si un endpoint
 * llama mal, y en ese caso es preferible devolver una analítica vacía y bien
 * formada antes que un 500.
 *
 * @param {object|null|undefined} profile Perfil del contrato.
 * @returns {object} El perfil, o uno vacío.
 */
function profileOrEmpty(profile) {
  if (profile && typeof profile === 'object' && Array.isArray(profile.skills)) return profile;
  return emptyProfile();
}

/**
 * Junta las habilidades del perfil y las del mercado en una lista maestra.
 *
 * Las del mercado entran PRIMERO con su bandera `has` ("la tengo" / "no la
 * tengo"), que es el dato que separa una fortaleza de una brecha. Las del perfil
 * entran después y solo si no estaban ya: si una skill está en las dos, manda la
 * versión del mercado porque es la que sabe si la persona la tiene.
 *
 * Los aliases de las skills del perfil son `[name]`. Se podría usar el nombre
 * pelado como único alias (una skill del CV no trae synonyms), pero la lista
 * uniforme evita un `.if (a)` en cada consumidor.
 *
 * @param {object} profile Perfil normalizado.
 * @returns {Array<{name: string, has: boolean, aliases: string[]}>} La lista maestra.
 */
function candidateSkills(profile) {
  const map = new Map();
  for (const ms of profile.marketSkills) {
    if (!ms || !ms.name) continue;
    map.set(ms.name, { name: ms.name, has: ms.has === true, aliases: ms.aliases || [ms.name] });
  }
  for (const skill of profile.skills) {
    if (!map.has(skill.name)) map.set(skill.name, { name: skill.name, has: true, aliases: [skill.name] });
  }
  // ↑ `has: true` para las del perfil es correcto por definición: vinieron de la
  //   tabla `skills`, que es lo que el usuario declaró de su CV.
  return [...map.values()];
}

/**
 * Busca evidencia de las brechas en los proyectos del usuario (GitHub).
 *
 * Para cada habilidad que el mercado pide y la persona NO tiene, mira si alguno
 * de sus proyectos habla de esa habilidad. No es una certification: es la señal
 * de "esto ya lo tocaste, solo que sin framed como experiencia formal", que es
 * lo que después se proyecta como score.
 *
 * @param {object} profile Perfil normalizado.
 * @returns {Array<{name: string, projects: string[]}>} Brechas con evidencia.
 */
function githubSkillEvidence(profile) {
  const projects = profile.projects;
  return profile.marketSkills
    .filter((skill) => !skill.has)
    .map((skill) => ({
      name: skill.name,
      projects: projects
        .filter((project) => {
          // ↑ `normalize()` porque el texto del proyecto viene escrito por la
          //   persona (nombres de repos, descripciones) y las aliases del LLM
          //   pueden venir sin tilde. Mismo criterio que el match.
          const text = normalize(`${project.nombre} ${project.descripcion} ${project.lenguaje || ''}`);
          return skill.aliases.some((alias) => textHasSkill(text, alias));
        })
        .map((project) => project.nombre),
    }))
    .filter((skill) => skill.projects.length > 0);
}

/**
 * Elige el mejor par de brechas que aparecen juntas en las mismas ofertas.
 *
 * ESTO REEMPLAZA A `SKILL_CLUSTERS`, que era la razón principal por la que esta
 * página no funcionaba para nadie que no fuera QA: ocho listas fijas de
 * technologies de testing. Si la lista de skills de una profesión no estaba en
 * esas ocho listas, la recomendación 2 simplemente no existía para esa persona.
 *
 * Lo que hace esta función en vez de eso: mira las ofertas REALES y busca dos
 * brechas que se piden juntas. Si el 60% de las ofertas que piden "excel
 * avanzado" también piden "power bi", esas dos son en la práctica el mismo
 * aprendizaje y tiene sentido atacarlas juntas. El dato sale de las ofertas del
 * usuario, así que funciona para cualquier profesión y además es una
 * recomendación más precisa: describe lo que el mercado de ESTE usuario realmente
 * agrupa, no lo que alguien hardcodeó hace un año.
 *
 * @param {Array<{name: string, pct: number}>} gaps Brechas con su demanda.
 * @param {Map<string, Set<number>>} demandIndices Skill → índices de oferta que la piden.
 * @returns {{a: object, b: object, shared: number}|null} El mejor par, o null.
 */
function bestGapCluster(gaps, demandIndices) {
  // ↑ Se limita a las 12 brechas más demandadas: el resto tiene tan pocas ofertas
  //   que dos coincidencias son ruido. Y el costo es O(n²) con n acotado, así
  //   que no hay riesgo de que esto se vuelva lento con un perfil enorme.
  const candidates = gaps.slice(0, 12);
  let best = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i];
    const setA = demandIndices.get(a.name);
    if (!setA || setA.size < 2) continue;
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j];
      const setB = demandIndices.get(b.name);
      if (!setB || setB.size < 2) continue;
      let shared = 0;
      for (const idx of setA) {
        if (setB.has(idx)) shared += 1;
      }
      // ↑ El umbral doble evita el falso positivo clásico: dos brechas que
      //   aparecen juntas en 2 ofertas de 400 no son "el mismo aprendizaje", son
      //   coincidencia. Se exigen 2 ofertas compartidas Y al menos un 30% de la
      //   más buscada de las dos.
      const threshold = Math.max(2, Math.ceil(Math.min(setA.size, setB.size) * 0.3));
      if (shared >= threshold && (!best || shared > best.shared)) {
        best = { a, b, shared };
      }
    }
  }
  return best;
}

// ════════════════════════════════════════════════════════════════════════════
// RECOMENDACIONES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Genera las recomendaciones automáticas (reglas de negocio sobre los cálculos).
 *
 * Son seis reglas y quedan seis. Lo que cambió es el CONTENIDO de dos: la 2 (que
 * estaba atada a `SKILL_CLUSTERS`) y la 4 (que era sobre banca digital). Las
 * otras cuatro son Profession-neutrales y se conservan tal cual.
 *
 * @param {object} data Los cálculos ya hechos: skillStats, missingSkills, total,
 *   englishCount, demandIndices.
 * @returns {Array<{priority: string, icon: string, text: string}>} Las recomendaciones.
 */
function buildRecommendations({ skillStats, missingSkills, total, englishCount, demandIndices }) {
  const recs = [];

  const gaps = [...missingSkills].sort((a, b) => b.pct - a.pct);
  if (gaps.length && total > 0) {
    // REC 1: las brechas más grandes por demanda. Se nombran solo 3: una
    // recomendación con 12 nombres adentro no se lee y no se cumple.
    const names = gaps.slice(0, 3).map((g) => g.name).join(', ');
    recs.push({
      priority: 'ALTA',
      icon: '🔥',
      // ↑ "habilidades" y no "tecnologías": la palabra del origen excluía media
      //   profesión sin querer. Un contador no tiene tecnologías.
      text: `Fortalecé estas habilidades que el mercado más pide y tu CV no muestra: ${names}. Son las brechas más grandes respecto a las ${total} vacantes detectadas.`,
    });
  }

  // REC 2: el reemplazo de SKILL_CLUSTERS. Ver `bestGapCluster`.
  const cluster = total > 0 ? bestGapCluster(gaps, demandIndices) : null;
  if (cluster) {
    recs.push({
      priority: 'MEDIA',
      icon: '🎯',
      text: `Las brechas "${cluster.a.name}" y "${cluster.b.name}" se piden juntas en ${cluster.shared} de las ofertas que ves: el mercado las trata como un mismo aprendizaje. Atacarlas como bloque rinde más que una por una.`,
    });
  }

  // REC 3: inglés. Se conserva con el mismo umbral del origen (20%).
  const englishPct = total ? Math.round((englishCount / total) * 100) : 0;
  if (englishPct >= 20) {
    recs.push({
      priority: 'MEDIA',
      icon: '🗣️',
      text: `El inglés aparece como requisito en el ${englishPct}% de las ofertas (conversacional/bilingüe). Reflejá tu nivel real en el CV y preparate para una entrevista en inglés.`,
    });
  }

  // REC 4: el reemplazo de la recomendación de banca digital.
  //
  // Qué hace de útil esta versión: en vez de decirle al usuario "tu background
  // en banca es una ventaja" (una afirmación fija sobre una profesión que
  // quizás ni sea la suya), mira la skill de MAYOR peso de SU perfil y calcula
  // cuánto la pide el mercado. Si el 70% de las ofertas pide la habilidad que más
  // pesa en tu CV, la conclusión correcta es "no sumes otra cosa al perfil: lo
  // que tenés es lo que el mercado pide", y la segunda parte es "sumá la brecha
  // más cercana para dejar de depender de una sola habilidad".
  //
  // Se calcula con `skillStats`, no con un regex: `skillStats` ya se midió contra
  // el texto de las ofertas una vez por skill, así que no hay ni una búsqueda más.
  const topOwn = [...skillStats].filter((s) => s.has && s.pct > 0).sort((a, b) => b.pct - a.pct)[0];
  if (topOwn && topOwn.pct >= 40) {
    const nearestGap = gaps[0];
    const second = nearestGap
      ? ` Sumá ${nearestGap.name} como segunda pata, así no dependés de una sola habilidad para que el puesto sea tuyo.`
      : ' No tenés brechas que cerrar: aprovechá la que más rinde.';
    recs.push({
      priority: 'MEDIA',
      icon: '🧭',
      text: `Tu habilidad mejor ponderada (${topOwn.name}) es lo que más pide el mercado: el ${topOwn.pct}% de las ofertas la piden. Ponela primero en el CV y en la carta de presentación.${second}`,
    });
  }

  // REC 5 (la del origen): "autoanálisis por región". SE ELIMINA, y es la única
  // recomendación que se borra entera en vez de reescribirse. El motivo es que el
  // alcance del proyecto es un solo país (Argentina): con una región, "tu región
  // con mejor match promedio es Argentina" no le dice NADA a nadie, porque no hay
  // hacia dónde apuntar. La función es correcta; el dato dejó de existir. Cuando
  // se agregue un segundo país (skill `agregar-pais`), esta recomendación vuelve
  // tal cual, con `byRegion` en vez de hardcodear labels.

  // REC 6: fortalezas. Se conserva: es la recomendación más accionable de la
  // página (qué poner arriba del CV) y no depende de la profesión.
  const strong = skillStats.filter((s) => s.has && s.pct >= 50).slice(0, 5);
  if (strong.length) {
    recs.push({
      priority: 'BAJA',
      icon: '💪',
      text: `Tus skills con mayor demanda y que ya dominás: ${strong.map((s) => s.name).join(', ')}. Asegurate de que aparezcan en el título y en los primeros renglones de tu CV.`,
    });
  }

  return recs;
}

// ════════════════════════════════════════════════════════════════════════════
// LA FUNCIÓN PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

/**
 * Junta todas las regiones y arma la analítica completa.
 *
 * @param {Record<string, object[]>} regions Ofertas por región (el resultado de
 *   `rankByRegion`). Las regiones vacías se omiten del promedio.
 * @param {object} [profile] Perfil del contrato (el de `loadProfile`). Opcional:
 *   sin perfil devuelve la analítica vacía, bien formada.
 * @returns {object} El paquete completo que consume el frontend.
 */
export function buildAnalytics(regions, profile) {
  const p = profileOrEmpty(profile);

  const entries = Object.entries(regions || {}).filter(([, list]) => Array.isArray(list) && list.length);
  const allJobs = [];
  const byRegion = [];
  let sum = 0;

  for (const [region, list] of entries) {
    const scores = list.map((j) => j.score || 0);
    byRegion.push({
      region,
      // ↑ El label sale de regions.js, no de un mapa local. Si mañana se agrega
      //   un país, este label aparece sin tocar este archivo.
      label: regionLabel(region),
      count: list.length,
      avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      maxScore: scores.length ? Math.max(...scores) : 0,
    });
    for (const job of list) {
      // ↑ `_region` en una COPIA. El original de la oferta lo comparten
      //   `withPortal` y el historial; mutarlo filtraría datos entre llamadas.
      allJobs.push({ ...job, _region: region });
      sum += job.score || 0;
    }
  }

  const total = allJobs.length;
  const avgScore = total ? Math.round(sum / total) : 0;

  // ── Texto de cada oferta, UNA vez ──────────────────────────────────────────
  // El origen armaba el texto de cada oferta DENTRO del loop de cada skill:
  // skills × ofertas concatenaciones de template strings. Con 40 skills y 300
  // ofertas son 12.000 concatenaciones por request, todas idénticas entre sí.
  // Acá se calcula una vez por oferta y se reusa para todas las skills.
  const jobTexts = allJobs.map((job) => jobText(job));

  // ── Proyección de score ────────────────────────────────────────────────────
  // "Si sumaras las habilidades que ya tocaste en un proyecto, ¿cuánto mejor te
  // iría?". Es una simulación, y por eso se hace con un peso inventado (0.5): no
  // es una promesa de score, es un "hacia dónde".
  const githubEvidence = githubSkillEvidence(p);
  const evidenceNames = new Set(githubEvidence.map((skill) => skill.name));

  const declared = new Set(p.skills.map((s) => s.name));
  const projectedProfile = {
    ...p,
    // ↑ Array, no mapa. El origen hacía `{...PROFILE.skills, ...evidencia}` sobre
    //   mapas: como el segundo spread gana, una skill que la persona YA declaraba
    //   con peso 0.9 perdía su peso y pasaba a 0.5. Con arrays hay que filtrar a
    //   mano, y ese filtro es el que mantiene el peso real de lo declarado.
    skills: [
      ...p.skills,
      ...[...evidenceNames]
        .filter((name) => !declared.has(name))
        .map((name) => ({ name, weight: 0.5 })),
    ],
    marketSkills: p.marketSkills.map((skill) => (evidenceNames.has(skill.name) ? { ...skill, has: true } : skill)),
  };

  const projectedScores = allJobs.map((job) => {
    // ↑ Se recalcula el match contra el perfil proyectado. La alternativa barata
    //   (sumar un delta fijo) mentiría: el efecto real de una skill depende de
    //   qué otras pide la misma oferta.
    return computeMatch(job, projectedProfile).score;
  });
  const projectedAvgScore = total
    ? Math.round(projectedScores.reduce((s, n) => s + n, 0) / total)
    : 0;

  // ── Demanda por habilidad en todo el mercado detectado ────────────────────
  const skills = candidateSkills(p);
  // `demandIndices` guarda, por skill, QUÉ ofertas la piden. Sirve para dos cosas:
  // el conteo de `skillStats` y el agrupamiento de brechas de REC 2, sin volver a
  // recorrer las ofertas.
  const demandIndices = new Map();
  const skillStats = skills
    .map((s) => {
      const indices = new Set();
      for (let i = 0; i < total; i += 1) {
        if (s.aliases.some((a) => textHasSkill(jobTexts[i], a))) indices.add(i);
      }
      demandIndices.set(s.name, indices);
      const requested = indices.size;
      const pct = total ? Math.round((requested / total) * 100) : 0;
      return { name: s.name, has: s.has, requested, pct };
    })
    // ↑ Una skill que no aparece en NINGUNA oferta no es una habilidad
    //   "marginal": es ruido del CV. Filtrarla acá evita que la lista de brechas
    //   recommendadas contenga cosas que el mercado no pidió nunca.
    .filter((s) => s.requested > 0)
    .sort((a, b) => b.requested - a.requested);

  const strongSkills = skillStats.filter((s) => s.has).slice(0, 12);
  const missingSkills = skillStats
    .filter((s) => !s.has)
    .map((s) => ({ name: s.name, jobsRequesting: s.requested, pct: s.pct }))
    .sort((a, b) => b.pct - a.pct);

  // ── Conteo de inglés ──────────────────────────────────────────────────────
  let englishCount = 0;
  for (const text of jobTexts) {
    // ↑ Este regex es de IDIOMA, no de profesión, así que se conserva tal cual.
    //   Se recorre `jobTexts` (ya calculado) en vez de volver a armar cada texto.
    if (/\b(ingl|english|bilingual|ingles)\b/i.test(text)) englishCount += 1;
  }

  const recommendations = buildRecommendations({
    skillStats,
    missingSkills,
    total,
    englishCount,
    demandIndices,
  });

  return {
    generatedAt: new Date().toISOString(),
    // ▲ `candidato` mantiene los nombres en español porque `AnalysisPage.jsx` los
    //   lee así (`candidato.experienciaAños`, `candidato.skillCount`,
    //   `candidato.proyectos`). El resto del contrato es camelCase; este bloque
    //   es la excepción documentada, como `projects[].nombre` en profile.js.
    candidato: {
      nombre: p.fullName,
      titulo: p.title,
      headline: p.headline,
      experienciaAños: p.yearsExperience || 0,
      // ↑ `|| 0` porque la UI usa `candidato.experienciaAños || '—'` para
      //   mostrar "—": null o 0 dan el mismo resultado visual y 0 no rompe la
      //   aritmética si alguien lo suma.
      location: p.location,
      summary: p.summary,
      linkedin: p.linkedin,
      github: p.github,
      // ↑ Ya es el array del contrato: se copia para que un consumidor que lo
      //   ordene o le haga push no toques el perfil en memoria.
      skills: p.skills.map((s) => ({ name: s.name, weight: s.weight })),
      skillCount: p.skills.length,
      projectCount: p.projects.length,
      proyectos: p.projects,
    },
    githubEvidence,
    matchProjection: {
      currentAvgScore: avgScore,
      estimatedAvgScore: projectedAvgScore,
      // ↑ `delta` NEGATIVO es posible y está bien: la proyección agrega skills con
      //   peso 0.5, así que el score de CADA oferta no sube necesariamente. Que el
      //   promedio total suba es lo que importa, y el "mejorado" de abajo es lo
      //   que le da sentido al número.
      delta: projectedAvgScore - avgScore,
      improvedJobs: projectedScores.filter((score, index) => score > (allJobs[index].score || 0)).length,
      modeledSkills: [...evidenceNames],
    },
    total,
    avgScore,
    byRegion,
    skillStats,
    strongSkills: strongSkills.slice(0, 10),
    missingSkills,
    englishPct: total ? Math.round((englishCount / total) * 100) : 0,
    // ▲ No hay `paymentPct`: ver la nota de la cabecera del archivo.
    recommendations,
  };
}
