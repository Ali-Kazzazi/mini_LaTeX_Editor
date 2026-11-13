import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the PDF viewer and bundled worker open PDFs without native Uint8Array.toHex', () => {
  assert.ok(existsSync(new URL('../dist/pdf.worker.min.mjs', import.meta.url)), 'Run npm run build before testing the PDF worker.');
  // A fresh process prevents PDF.js polyfills and worker modules from being
  // cached by other tests. Test the worker actually served by the application.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', String.raw`
    import assert from 'node:assert/strict';
    delete Uint8Array.prototype.toHex;
    assert.equal(typeof Uint8Array.prototype.toHex, 'undefined');
    const { getDocument, GlobalWorkerOptions } = await import('./src/pdf.js');

    // The worker has its own global scope in a browser. Remove the viewer's
    // polyfill here too, before loading the worker in PDF.js's Node fallback.
    delete Uint8Array.prototype.toHex;
    GlobalWorkerOptions.workerSrc = new URL('./dist/pdf.worker.min.mjs', import.meta.url).href;
    let source = '%PDF-1.7\n';
    const offsets = [0];
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >>'
    ];
    for (const [index, object] of objects.entries()) {
      offsets.push(Buffer.byteLength(source));
      source += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    }
    const xref = Buffer.byteLength(source);
    source += 'xref\n0 4\n0000000000 65535 f \n';
    source += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    source += 'trailer\n<< /Size 4 /Root 1 0 R /ID [<0123456789abcdef0123456789abcdef><0123456789abcdef0123456789abcdef>] >>\nstartxref\n' + xref + '\n%%EOF\n';

    const task = getDocument({ data: new Uint8Array(Buffer.from(source)), useSystemFonts: false });
    try {
      const pdf = await task.promise;
      assert.equal(pdf.numPages, 1);
      assert.equal(pdf.fingerprints[0], '0123456789abcdef0123456789abcdef');
      const page = await pdf.getPage(1);
      assert.equal(page.getViewport({ scale: 1 }).width, 200);
      const { createCanvas } = await import('@napi-rs/canvas');
      const canvas = createCanvas(200, 300);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: 1 }) }).promise;
      assert.ok(canvas.toBuffer('image/png').length > 100);
    } finally {
      await task.destroy();
    }
  `], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
});
