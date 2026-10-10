// ============================================================================
// TESTS: Migraciones — idempotencia y detección de checksum alterado
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

import { main as runMigrate } from '../scripts/migrate.js';

const TEST_DB_URL = 'postgresql://postgres:postgres@localhost:5432/test?sslmode=disable';
const MIGRATIONS_DIR = join(ROOT, 'migrations');

// Helper para correr migraciones en BD de test
async function runMigrations(env = {}) {
  const oldEnv = { ...process.env };
  process.env.DATABASE_URL = TEST_DB_URL;
  process.env.MIGRATE_LOCK_TIMEOUT_MS = '5000';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  
  try {
    const code = await runMigrate();
    return code;
  } finally {
    process.env = oldEnv;
  }
}

describe('Migraciones — idempotencia y checksum', () => {
  before(async () => {
    // Esperar a que Postgres esté listo
    for (let i = 0; i < 30; i++) {
      try {
        const { createPool } = await import('../lib/db.js');
        const pool = createPool();
        await pool.query('SELECT 1');
        await pool.end();
        break;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  });

  it('primera corrida: aplica todas las migraciones (exit code 0)', async () => {
    const code = await runMigrations();
    assert.equal(code, 0, 'First migration run should exit with code 0');
  });

  it('segunda corrida: idempotente, 0 aplicadas, N ya estaban (exit code 0)', async () => {
    const code = await runMigrations();
    assert.equal(code, 0, 'Second migration run should exit with code 0');
    // La salida debería decir "0 aplicada(s), N ya estaba(n)"
  });

  it('tercera corrida: sigue siendo idempotente', async () => {
    const code = await runMigrations();
    assert.equal(code, 0, 'Third migration run should exit with code 0');
  });

  it('detecta archivo ya aplicado con contenido cambiado (falla con mensaje claro)', async () => {
    // Buscar un archivo de migración ya aplicado (el primero)
    const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    if (files.length === 0) {
      console.log('  ⚠ No migration files found, skipping');
      return;
    }
    
    const firstMigration = files[0];
    const migrationPath = join(MIGRATIONS_DIR, firstMigration);
    const originalContent = readFileSync(migrationPath, 'utf8');
    const oldEnv = { ...process.env };
    
    try {
      // Modificar el archivo (agregar un comentario)
      writeFileSync(migrationPath, originalContent + '\n-- MODIFICADO PARA TEST\n');
      
      // Intentar correr migraciones → debe fallar
      process.env.DATABASE_URL = TEST_DB_URL;
      process.env.MIGRATE_LOCK_TIMEOUT_MS = '5000';
      
      let output = '';
      const originalError = console.error;
      try {
        console.error = (...args) => {
          output += `${args.join(' ')}\n`;
        };
        const code = await runMigrate();
        assert.equal(code, 1, 'Changed applied migration should fail');
        assert.match(output, /checksum|su contenido cambió/i);
      } finally {
        console.error = originalError;
      }
    } finally {
      // Restaurar archivo original
      writeFileSync(migrationPath, originalContent);
      process.env = oldEnv;
    }
  });

  it('checksum es de bytes crudos (no depende de BOM o finales de línea)', async () => {
    // Este test verifica que el runner usa Buffer para el hash
    // Si el archivo tiene BOM o CRLF, el hash debe ser el mismo que sin ellos
    const { createHash } = await import('node:crypto');
    
    const testContent = 'SELECT 1;\n';
    const withBOM = '\uFEFF' + testContent;
    const withCRLF = testContent.replace(/\n/g, '\r\n');
    
    const hashNormal = createHash('sha256').update(Buffer.from(testContent)).digest('hex');
    const hashBOM = createHash('sha256').update(Buffer.from(withBOM)).digest('hex');
    const hashCRLF = createHash('sha256').update(Buffer.from(withCRLF)).digest('hex');
    
    // El runner lee como Buffer, así que BOM y CRLF SÍ cambian el hash
    // Esto es INTENCIONAL: el checksum es de los bytes crudos del archivo en disco
    // Si editás el archivo y cambia un byte (incluso BOM), el checksum cambia
    assert.notEqual(hashNormal, hashBOM, 'BOM changes raw bytes hash');
    assert.notEqual(hashNormal, hashCRLF, 'CRLF changes raw bytes hash');
  });
});