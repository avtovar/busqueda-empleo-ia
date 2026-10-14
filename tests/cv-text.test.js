import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../lib/http.js';
import {
  MAX_CV_BYTES,
  MAX_CV_TEXT_CHARS,
  MIN_CV_TEXT_CHARS,
  normalizeCvText,
  validateCvFile,
  validatePastedCvText,
} from '../lib/cvText.js';

function assertHttpError(callback, status, messagePart) {
  assert.throws(callback, (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, status);
    assert.match(err.message, messagePart);
    return true;
  });
}

describe('cvText — validación de entrada', () => {
  it('separa archivo ausente, archivo sin Buffer y archivo de cero bytes', () => {
    assertHttpError(
      () => validateCvFile(null),
      400,
      /No encontramos el archivo/,
    );
    assertHttpError(
      () => validateCvFile({ filename: 'cv.pdf', mimetype: 'application/pdf' }),
      400,
      /llegó sin contenido/,
    );
    assertHttpError(
      () => validateCvFile({
        filename: 'cv.pdf',
        mimetype: 'application/pdf',
        size: 0,
        buffer: Buffer.alloc(0),
      }),
      400,
      /tiene 0 bytes/,
    );
  });

  it('mantiene el límite del archivo por debajo del máximo de request de Vercel', () => {
    assert.equal(MAX_CV_BYTES, 4 * 1024 * 1024);
    assert.ok(MAX_CV_BYTES + 64 * 1024 < 4.5 * 1024 * 1024);
  });

  it('normaliza saltos de línea y espacios del texto pegado', () => {
    assert.equal(normalizeCvText('  Perfil \r\n\r\n   QA   \rSkills  '), 'Perfil\n\nQA\nSkills');
  });

  it('rechaza el texto ausente, vacío o menor al mínimo antes del LLM', () => {
    assertHttpError(() => validatePastedCvText(undefined), 400, /No recibimos el texto/);
    assertHttpError(() => validatePastedCvText(' \r\n '), 400, /está vacío/);
    assertHttpError(
      () => validatePastedCvText('x'.repeat(MIN_CV_TEXT_CHARS - 1)),
      400,
      /demasiado corto/,
    );
  });

  it('acepta los límites inclusivos de 200 y 20.000 caracteres', () => {
    assert.equal(validatePastedCvText('x'.repeat(MIN_CV_TEXT_CHARS)).length, MIN_CV_TEXT_CHARS);
    assert.equal(validatePastedCvText('x'.repeat(MAX_CV_TEXT_CHARS)).length, MAX_CV_TEXT_CHARS);
    assertHttpError(
      () => validatePastedCvText('x'.repeat(MAX_CV_TEXT_CHARS + 1)),
      413,
      /20\.000 caracteres/,
    );
  });
});
