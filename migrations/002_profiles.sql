-- ============================================================================
-- 002_profiles.sql — el perfil derivado del CV (segunda etapa del alta).
--
-- Un user_id → 0 o 1 filas. Esa es toda la razón de que user_id sea la clave
-- primaria y no una foreign key única suelta: la unicidad la impone la base, así
-- que re-subir el CV puede ser un insert ... on conflict (user_id) do update y
-- nunca queda una fila duplicada.
--
-- Por qué casi todas las columnas son nullable: el LLM devuelve lo que
-- entiende del CV, no lo que se le pidió. Si full_name o title fueran not null,
-- un CV escaneado mal se convertiría en un 500 en el alta y el usuario no
-- podría registrarse. Y acá no hay ningún dato que dependa del CV para existir,
-- más allá de la fila misma: la app tiene que tratar "no lo encontró" como null,
-- igual que hoy hace con el PROFILE global en memoria.
-- ============================================================================

create table if not exists profiles (
  -- ↑ La primary key ES la foreign key hacia users. on delete cascade porque si
  --   se borra la cuenta el perfil cae con ella (el porqué completo está en
  --   001_users.sql). Ojo con la asimetría: acá el cascade va en la FK que
  --   DEFINE la fila, no en una tabla hija como en las otras seis.
  user_id uuid primary key references users (id) on delete cascade,

  -- ↑ Nombre para firmar la carta de presentación (coverLetter.js interpola
  --   fullName). Con el perfil ausente la carta sale SIN firma a propósito: no se
  --   muestra ni se manda el nombre de nadie.
  full_name text,

  -- ↑ Título profesional ("QA Engineer", "Contadora"), tal como lo devuelve el
  --   LLM del CV.
  title text,

  -- ↑ Años de experiencia. numeric(3,1) y no integer porque un CV puede decir
  --   "cinco años y medio" y truncar a 5 pierde información real; numeric(3,1)
  --   llega a 99.9 años y guarda el decimal EXACTO (float no puede representar
  --   0.1). OJO: el driver pg devuelve numeric como STRING en JavaScript, no
  --   como number — ver la nota de peso en 003_skills.sql, es la misma cosa.
  years_experience numeric(3,1),

  -- ↑ Resumen en texto libre: lo usan la UI y las cartas de presentación.
  summary text,

  -- ▲ Reservada por el plan del proyecto, pero SIEMPRE NULL. El CV no se guarda
  --   en disco (Vercel es efímero) y una foto real obligaría a decidir el
  --   almacenamiento (Vercel Blob, con su cuenta, su costo y su limpieza). La
  --   columna existe para que el contrato de /api/me no cambie el día que se
  --   decida eso; mientras tanto, escribirla es un error de desarrollo, y por eso
  --   es nullable y no not null default ''.
  photo text,

  location text,

  -- ↑ keywords (punto 7 del plan): la lista de búsqueda que después arma
  --   apifyLinkedin.buildProfileKeywords() a partir de las skills del usuario.
  --   Antes vivía hardcodeada en PROFILE.keywords y además se le aplicaba un
  --   filtro por regex de QA (/(qa|quality|test|automation|sdet)/i) que hoy se
  --   elimina: acá va lo que devolvió el LLM del CV de ESTE usuario.
  --
  --   market_skills: [{ name, has, aliases }], generado en el mismo prompt del
  --   CV. Antes era un artefacto del análisis del CV de Ali, y para un usuario
  --   nuevo hay que derivarlo del perfil o eliminarlo; por eso se persiste acá y
  --   no en código. El motivo de que sea jsonb y no tabla está arriba del
  --   create table, en 003_skills.sql.
  --
  --   projects: para cruzar brechas contra evidencia de GitHub
  --   (analytics.js:githubSkillEvidence() leía PROFILE.projects).
  --
  --   links: { github, portfolio, linkedin }.
  --
  --   Los cuatro son ESTRUCTURA, no un valor plano: no son columnas escalares
  --   (un "projects text" con JSON adentro es un jsonb escrito a mano), ni tablas
  --   separadas (nadie consulta "el proyecto llamado X"; se lee y se escribe
  --   entero, siempre pegado al resto del perfil).
  --
  --   Por qué jsonb y no json: json es texto plano, no deduplica claves
  --   repetidas, preserva el orden original y hay que reparsearlo en cada
  --   lectura. jsonb es binario, parsea directo y — esto es lo importante — se
  --   puede indexar con gin (jsonb_path_ops) si algún día hay que buscar
  --   "usuarios que tienen la skill X en su perfil" sin recorrer toda la tabla.
  --
  --   Por qué los defaults NO son null: un array vacío es un estado con
  --   sentido ("el LLM no encontró proyectos") y le ahorra un if (!x) a cada
  --   consumidor. Un default por columna es barato; diez null-check en el
  --   frontend, no.
  keywords jsonb not null default '[]'::jsonb,
  market_skills jsonb not null default '[]'::jsonb,
  projects jsonb not null default '[]'::jsonb,
  links jsonb not null default '{}'::jsonb,

  -- ▲ Los check de abajo validan el CONTENEDOR (array contra objeto), no el
  --   contenido: no cierran el formato, no bloquean una clave nueva y no obligan
  --   a migrar nada cuando el LLM devuelve algo que no se le ocurrió pedir. Lo
  --   único que evitan es que un objeto se cuele donde la app espera una lista y
  --   reviente un .map() en el frontend con un error de runtime.
  --   Contraste con region en 004_searches.sql, que sí queda abierta a propósito
  --   porque hay que poder agregar países sin migración.
  constraint profiles_keywords_array check (jsonb_typeof(keywords) = 'array'),
  constraint profiles_market_skills_array check (jsonb_typeof(market_skills) = 'array'),
  constraint profiles_projects_array check (jsonb_typeof(projects) = 'array'),
  constraint profiles_links_object check (jsonb_typeof(links) = 'object'),

  created_at timestamptz not null default now(),

  -- ▲ Sin trigger de updated_at, a propósito: el backend hace el upsert y escribe
  --   esta columna explícitamente. Un trigger agregaría una función en la base y
  --   una escritura extra en cada update, para algo que la única aplicación que
  --   toca esta tabla ya sabe cuándo ocurre. updated_at sirve para responder
  --   "¿este usuario volvió a subir el CV?", y eso se LEE, no se dispara.
  updated_at timestamptz not null default now()
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- NINGUNO aparte, y no es un olvido: la primary key ya es un índice sobre
-- user_id (de hecho, es UN índice sobre user_id, porque la columna es la
-- primary key), y duplicarlo sería pagar una escritura extra en cada re-upload
-- del CV para no ganar nada. Regla de Postgres que conviene tener escrita una
-- vez: un índice que es prefijo de otro no aporta.
--
-- No hay gin sobre keywords a propósito: hoy nadie busca perfiles por skill. Ese
-- es el índice a agregar el día que exista "buscar usuarios que saben React",
-- y agregarlo antes sería escribir de más en cada carga de CV.