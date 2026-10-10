// ============================================================================
// Verificación de sintaxis de TODO el backend, archivo por archivo.
// Comprueba la sintaxis del backend compartido y de los scripts.
//
// Por qué un script y no un comando suelto: `node --check` hay que pasarlo UN
// archivo a la vez (no acepta un patrón), y en Windows el globbing de PowerShell
// es distinto al de bash. Correrlo desde Node deja el mismo comportamiento en
// cualquier máquina y en CI.
//
// OJO con los .jsx: `node --check` NO sabe parsear JSX, así que los .jsx quedan
//   afuera. Esos los valida `npm run build` (Rspack), que además detecta imports
// rotos. Por eso el build no es opcional cuando se toca frontend/src.
// ============================================================================

// ↑ spawnSync ejecuta el comando y espera el resultado sin salir del proceso
import { spawnSync } from 'node:child_process';
// ↑ readdirSync + statSync para recorrer carpetas a mano, sin dependencias
import { readdirSync, statSync } from 'node:fs';
// ↑ join arma rutas separando con la barra correcta del sistema operativo
import { join } from 'node:path';
// ↑ fileURLToPath convierte la URL del módulo en una ruta real de disco
import { fileURLToPath } from 'node:url';

// ↑ La carpeta raíz del repo: el lugar donde vive package.json
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Carpetas que se chequean, en orden. Se recorren recursivamente.
const TARGETS = ['api', 'lib', 'scripts'];

// Carpetas que nunca se chequean, aunque estén adentro de las de arriba.
// ↑ `node_modules` son dependencias instaladas y `dist` es build artifact: si
//   algo está roto ahí, el problema es de otro lado y el ruido tapa el error real.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vercel', '.opencode']);

// Extensiones que se chequean. `.jsx` NO va: ver la nota de arriba.
const CHECKABLE = /\.(js|mjs|cjs)$/;

/**
 * Junta recursivamente todos los archivos chequeables de una carpeta.
 * @param {string} dir Carpeta a recorrer.
 * @param {string[]} acc Acumulador (se pasa por referencia para no copiar).
 * @returns {string[]} Rutas absolutas de los archivos .js encontrados.
 */
function collect(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // ↑ Si la carpeta no existe todavía, no es un error: el repo va creciendo
    //   de a pasos y este script tiene que correr también cuando `api/` todavía
    //   no fue creado. Devolver vacío es lo correcto.
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, acc);
    } else if (CHECKABLE.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// Recolecta los archivos de todas las carpetas objetivo
const files = TARGETS.flatMap((dir) => collect(join(ROOT, dir)));

// Si no hay nada que chequear, se avisa en vez de salir con éxito en silencio
if (files.length === 0) {
  console.log('No hay archivos .js para chequear todavía.');
  process.exit(0);
}

let failed = 0;

for (const file of files) {
  const rel = file.replace(ROOT, '');
  // ↑ `node --check` solo parsea: no ejecuta el archivo. Es seguro correrlo
  //   contra código que importa variables de entorno o abre conexiones de base
  //   de datos, porque nada de eso llega a pasar.
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status === 0) {
    console.log(`  OK  ${rel}`);
  } else {
    failed++;
    console.log(`  FALLA  ${rel}`);
    // ↑ Se imprime el error de Node porque dice la línea exacta del problema
    console.log((res.stderr || '').trim());
  }
}

console.log('');
if (failed) {
  console.log(`FALLARON ${failed} de ${files.length} archivos.`);
  // ↑ Sale con código distinto de 0 para que CI corte el pipeline. Sin esto, un
  //   job "verde" con un FALLA adentro sería un falso positivo.
  process.exit(1);
}
console.log(`OK: ${files.length} archivos.`);
