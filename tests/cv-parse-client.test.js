import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCvText } from '../frontend/src/api.js';

describe('parseCvText — cliente API', () => {
  it('envía JSON al endpoint y conserva el error recibido del backend', async (context) => {
    const fetchOriginal = globalThis.fetch;
    context.after(() => {
      globalThis.fetch = fetchOriginal;
    });

    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        ok: true,
        profile: { fullName: 'Ada Lovelace' },
        kind: 'text',
        saved: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const data = await parseCvText('Texto de CV de prueba');
    assert.equal(request.url, '/api/cv/parse');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), { text: 'Texto de CV de prueba' });
    assert.equal(data.kind, 'text');
    assert.equal(data.saved, false);

    globalThis.fetch = async () => new Response(JSON.stringify({
      error: 'El texto del CV está vacío.',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(parseCvText(''), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.message, 'El texto del CV está vacío.');
      return true;
    });
  });
});
