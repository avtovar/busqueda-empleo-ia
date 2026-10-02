-- ============================================================================
-- 003_skills.sql — una fila por skill del usuario, con su peso.
--
-- Por qué una tabla y no un jsonb: la decisión del proyecto es que skills sea
-- un array [{ name, weight }] en el contrato de la API (así lo devuelve el LLM
-- y así lo consume analytics.js, que convierte map → array para la respuesta).
-- Guardarlo como jsonb sería inconsultable e inmutable: no se puede "agregar
-- una skill con peso 0.8", no se puede pedir las skills más pesadas de un
-- usuario, y un typo en una clave ("weigth") no lo detecta nadie. Una fila por
-- skill cuesta un insert más y compra update, order by, agregación y una
-- restricción de unicidad de verdad.
--
-- Por qué NO hay `market_skills` como tabla, aunque también sea [{ name, has,
-- aliases }]: market_skills describe el MERCADO, no lo que tiene la persona. Se
-- lee entero pegado al perfil y se reemplaza entero en cada carga de CV, así que
-- vive en profiles.market_skills (jsonb). La línea que separa las dos cosas:
-- skills es "la persona tiene esto" (se cruza contra cada oferta, se cuenta, se
-- pesa); market_skills es "esto es lo que el mercado pide" (se muestra, no se
-- cruza fila por fila).
-- ============================================================================

create table if not exists skills (
  id uuid primary key default gen_random_uuid(),

  -- ↑ user_id not null, sin excepción en ninguna tabla: si fuera nullable, un
  --   select sin filtro devolvería las skills de todos los usuarios y la UI no
  --   tendría forma de notarlo. La nullable sería la puerta abierta al error más
  --   probable al pasar de un JSON global a SQL.
  user_id uuid not null references users (id) on delete cascade,

  -- ↑ Nombre de la skill, YA NORMALIZADO por la aplicación (minúsculas, sin
  --   espacios al borde). La normalización es del borde de entrada, no un check:
  --   el mismo criterio de profiles y users, por el mismo motivo.
  name text not null,

  -- ↑ Peso NUMÉRICO, no texto: el código heredado ya guarda números
  --   (PROFILE.skills era { 'manual testing': 1, mobile: 0.9 }) y matcher.js los
  --   multiplica en la fórmula del score. Guardar '0.9' como text obligaría a un
  --   Number() defensivo en cada consumidor y haría que "0.9" > "0.80" fuera
  --   alfabético en cualquier comparación accidental.
  --
  --   numeric(4,3): exacto (los float no pueden representar 0.1), con tres
  --   decimales de precisión y espacio para un factor de escala accidental del
  --   LLM (hasta 9.999). DELIBERADAMENTE sin check (weight between 0 and 1): el
  --   peso sale de un LLM que a veces responde "85" en vez de "0.85", y un check
  --   convertiría eso en un insert que falla y deja al usuario sin perfil. Que lo
  --   recorte o lo normalice la app, que es donde ya se está parseando el JSON.
  --
  --   OJO PARA EL QUE ESCRIBA api/lib/db.js: el driver pg devuelve NUMERIC como
  --   STRING en JavaScript, no como number. Sin esto
  --     pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number)
  --   en el arranque, weight llega como '0.900' y cualquier .toFixed() o
  --   interpolación en la UI revienta. Es una línea, pero tiene que estar. Lo
  --   mismo aplica a profiles.years_experience.
  weight numeric(4,3) not null default 1.000
);

-- ── Índices ─────────────────────────────────────────────────────────────────
-- (create index normal y no concurrently: el runner mete cada archivo en su
--  propia transacción. Explicación completa en 001_users.sql.)
--
-- skills_user_name_key: unique (user_id, name). Tres trabajos:
--  1) Es lo que hace idempotente la re-carga del CV: el upsert por skill
--     (on conflict (user_id, name) do update set weight = excluded.weight) no
--     duplica nada y no hay que borrar y reinsertar la tabla entera para
--     corregir un peso.
--  2) Impide que dos filas con el mismo nombre inflen el puntaje: computeMatch
--     recorre las skills y SUMA, así que un duplicado pesa doble y deforma el
--     score en silencio, sin error visible en ninguna parte.
--  3) Como empieza por user_id, ya cumple la regla de índice por usuario:
--     "las skills de este usuario" es un prefijo de este índice. Por eso NO hay
--     un skills_user_id_idx aparte: mismo contenido, mismo costo de escritura,
--     cero ganancia. Ver profiles, que es el mismo caso.
create unique index if not exists skills_user_name_key on skills (user_id, name);

-- ▲ No hay created_at a propósito: esta tabla se borra y se reescribe completa en
--   cada carga de CV, y la marca de tiempo de una fila que existe desde hace dos
--   minutos no dice nada. Si algún día hay que mostrar "skill agregada el...", se
--   agrega la columna.