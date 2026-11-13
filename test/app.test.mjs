import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp, ROOT, validateFile, safeFile, detectEngines } from '../server/app.mjs';

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(ROOT, '.test-data-'));
  const app = await createApp({ dataDir, engines: [], ...options });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dataDir, { recursive: true, force: true }); });
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(origin + '/api' + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const { data: project } = await request('/projects', 'POST', { name: 'Integration test' });
  return { request, project, origin, dataDir };
}

test('project files persist, nested imports round-trip in ZIP, and renaming updates the main file', async t => {
  const { request, project, origin, dataDir } = await fixture(t), route = '/projects/' + project.id;
  assert.equal((await request(route)).data.files[0].name, 'main.tex');
  assert.equal((await request(route + '/file', 'PUT', { name: 'chapters/intro.tex', content: 'A local chapter.', createOnly: true })).status, 200);
  assert.equal((await request(route + '/file', 'PUT', { name: 'chapters/intro.tex', content: 'overwrite', createOnly: true })).status, 409);
  assert.equal((await request(route + '/file?name=chapters%2Fintro.tex')).data.content, 'A local chapter.');
  const binary = Buffer.from([137,80,78,71,0,255]);
  await request(route + '/file', 'PUT', { name: 'figures/diagram.png', content: binary.toString('base64'), encoding: 'base64' });
  const zip = unzipSync(new Uint8Array(await (await fetch(origin + '/api' + route + '/source')).arrayBuffer()));
  assert.equal(strFromU8(zip['chapters/intro.tex']), 'A local chapter.'); assert.deepEqual(Buffer.from(zip['figures/diagram.png']), binary);
  assert.ok(!Object.keys(zip).some(name => name.startsWith('.')));
  assert.equal((await request(route + '/rename-file', 'POST', { from: 'main.tex', to: 'paper.tex' })).data.mainFile, 'paper.tex');
  const savedMeta = JSON.parse(await fs.readFile(path.join(dataDir, 'projects', project.id, '.project.json'), 'utf8')); assert.equal(savedMeta.mainFile, 'paper.tex');
  await request(route + '/file?name=chapters%2Fintro.tex', 'DELETE');
  assert.equal((await request(route + '/file?name=chapters%2Fintro.tex')).status, 404);
});

test('path traversal, private files, Windows device names, symlinks, and foreign origins are rejected', async t => {
  for (const name of ['../secret.tex', '/etc/passwd', '.project.json', 'x/.hidden', 'C:/file.tex', 'x\\file.tex', 'NUL.tex', 'x/../../y', 'trailing.']) assert.throws(() => validateFile(name));
  assert.equal(validateFile('chapters/introduction.tex'), 'chapters/introduction.tex');
  const { request, project, origin, dataDir } = await fixture(t), route = '/projects/' + project.id;
  assert.equal((await request(route + '/file', 'PUT', { name: '../outside.tex', content: 'escape' })).status, 400);
  assert.equal((await request(route + '/file?name=.project.json')).status, 400);
  const foreign = await fetch(origin + '/api/projects', { headers: { Origin: 'https://example.org' } }); assert.equal(foreign.status, 403);
  const rebound = await new Promise((resolve, reject) => { http.get(origin + '/api/projects', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); }); assert.equal(rebound, 403);
  const outside = path.join(dataDir, 'outside'); await fs.mkdir(outside);
  const directory = path.join(dataDir, 'projects', project.id);
  await fs.symlink(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(safeFile(directory, 'linked/escape.tex'), /Symbolic links/);
});

test('missing compiler is actionable, not a fake successful preview', async t => {
  const { request, project } = await fixture(t), route = '/projects/' + project.id;
  const result = await request(route + '/compile', 'POST', {});
  assert.equal(result.status, 503);
  assert.match(result.data.error, process.platform === 'win32' ? /setup:compiler/ : /Install TeX Live/);
  assert.equal((await request(route + '/pdf')).status, 404);
});

test('compilation snapshots input, keeps last good PDF after failure, and blocks concurrent builds', async t => {
  let succeed = true, release, started, hold = false;
  const runner = async (_command, args, options) => {
    assert.ok(args.includes('--untrusted')); assert.equal(await fs.readFile(path.join(options.cwd, 'main.tex'), 'utf8'), 'snapshot input');
    if (hold) { started(); await new Promise(resolve => release = resolve); }
    if (succeed) { const output = args[args.indexOf('--outdir') + 1]; await fs.writeFile(path.join(output, 'main.pdf'), '%PDF-1.7\nverified'); }
    return { code: succeed ? 0 : 1, log: succeed ? 'Output written to main.pdf' : '! Undefined control sequence.', timedOut: false };
  };
  const { request, project, origin } = await fixture(t, { engines: [{ id: 'tectonic', available: true, command: 'mock' }], runner }), route = '/projects/' + project.id;
  await request(route + '/file', 'PUT', { name: 'main.tex', content: 'snapshot input' });
  assert.equal((await request(route + '/compile', 'POST', {})).data.ok, true);
  const good = await (await fetch(origin + '/api' + route + '/pdf')).text(); assert.match(good, /^%PDF/);
  succeed = false; const failed = await request(route + '/compile', 'POST', {}); assert.equal(failed.data.ok, false); assert.match(failed.data.log, /Undefined control sequence/);
  assert.equal(await (await fetch(origin + '/api' + route + '/pdf')).text(), good);
  hold = true; const waiting = new Promise(resolve => started = resolve); const build = request(route + '/compile', 'POST', {}); await waiting;
  assert.equal((await request(route + '/compile', 'POST', {})).status, 409); assert.equal((await request(route, 'DELETE')).status, 409);
  release(); await build;
});

test('real local compiler builds a multi-file document and reports LaTeX errors', { skip: process.env.TEXDESK_TEST_COMPILER !== '1', timeout: 240000 }, async t => {
  const engines = await detectEngines(); assert.ok(engines.some(e => e.available), 'Install a compiler first.');
  const { request, project, origin } = await fixture(t, { engines }), route = '/projects/' + project.id;
  await request(route + '/file', 'PUT', { name: 'main.tex', content: String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
\section{Verified locally}
\input{chapter}
\[e^{i\pi}+1=0\]
\end{document}` });
  // End the paragraph in the included file so TeX Live attributes the line to it.
  await request(route + '/file', 'PUT', { name: 'chapter.tex', content: String.raw`A real multi-file compilation.\par` });
  const result = await request(route + '/compile', 'POST', {}); assert.equal(result.data.ok, true, result.data.log);
  const built = (await request(route)).data;
  assert.equal(built.pdf.hasSync, true);
  const sync = route + '/sync?build=' + built.pdf.jobId;
  const forward = await request(sync + '&file=chapter.tex&line=1');
  assert.equal(forward.status, 200);
  assert.equal(forward.data.page, 1);
  const reverse = await request(sync + '&page=1&x=' + forward.data.x + '&y=' + (forward.data.y + 3));
  assert.equal(reverse.data.file, 'chapter.tex');
  const output = Buffer.from(await (await fetch(origin + '/api' + route + '/pdf')).arrayBuffer()); assert.equal(output.subarray(0,5).toString(), '%PDF-'); assert.ok(output.length > 1000);
  await request(route + '/file', 'PUT', { name: 'chapter.tex', content: String.raw`\undefinedTexdeskCommand` });
  const broken = await request(route + '/compile', 'POST', {}); assert.equal(broken.data.ok, false); assert.match(broken.data.log, /Undefined control sequence|undefinedTexdeskCommand/i);
  assert.ok(broken.data.diagnostics.some(issue => issue.file === 'chapter.tex' && issue.line === 1), broken.data.log);
  assert.equal((await request(sync + '&file=chapter.tex&line=1')).status, 409);
  assert.deepEqual(Buffer.from(await (await fetch(origin + '/api' + route + '/pdf')).arrayBuffer()), output);
});

test('history compares and restores a compiled snapshot, with recovery and stale-save protection', async t => {
  const runner = async (_command, args, options) => {
    assert.equal(await fs.readFile(path.join(options.cwd, 'main.tex'), 'utf8'), 'Working source');
    await fs.writeFile(path.join(args[args.indexOf('--outdir') + 1], 'main.pdf'), '%PDF-1.7');
    return { code: 0, log: 'Built' };
  };
  const { request, project } = await fixture(t, {
    engines: [{ id: 'tectonic', available: true, command: 'mock' }], runner
  });
  const route = '/projects/' + project.id;
  await request(route + '/file', 'PUT', { name: 'main.tex', content: 'Working source' });
  await request(route + '/file', 'PUT', { name: 'figure.png', content: 'AAEC', encoding: 'base64' });
  const build = await request(route + '/compile', 'POST', {});
  assert.equal(build.data.ok, true);
  const saved = route + '/history/' + build.data.jobId;
  await request(route + '/file', 'PUT', { name: 'main.tex', content: 'Newer draft' });
  await request(route + '/file', 'PUT', { name: 'chapter.tex', content: 'New chapter' });
  await request(route + '/file?name=figure.png', 'DELETE');
  const changes = await request(saved + '/compare');
  assert.deepEqual(Object.fromEntries(changes.data.map(change => [change.name, change.status])),
    { 'chapter.tex': 'Added', 'main.tex': 'Modified', 'figure.png': 'Removed' });
  assert.deepEqual((await request(saved + '/file?name=main.tex')).data,
    { saved: 'Working source', current: 'Newer draft' });
  const restored = await request(saved + '/restore', 'POST', {});
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.data.files.map(file => file.name), ['figure.png', 'main.tex']);
  assert.equal((await request(route + '/file?name=main.tex')).data.content, 'Working source');
  assert.equal((await request(route + '/file', 'PUT', { name: 'main.tex', content: 'Stale browser draft' })).status, 409);
  const recovery = (await request(route + '/history')).data.find(entry => entry.kind === 'before-restore');
  assert.equal((await request(route + '/history/' + recovery.id + '/file?name=main.tex')).data.saved, 'Newer draft');
  const next = await request(route + '/history/' + recovery.id + '/restore', 'POST', { sourceRevision: restored.data.sourceRevision });
  assert.equal(next.status, 200);
  assert.equal((await request(route + '/file?name=main.tex')).data.content, 'Newer draft');
});

test('cache-only without a bundle fails before compiling, and an explicit retry lasts one build', async t => {
  const calls = [];
  const runner = async (_command, args) => {
    calls.push(args);
    return args[0] === '-X' ? { code: 1, log: 'No cache' } : { code: 1, log: 'Compilation failed' };
  };
  const { request, project } = await fixture(t, {
    engines: [{ id: 'tectonic', available: true, command: 'mock' }], runner
  });
  const route = '/projects/' + project.id;
  await request(route, 'PATCH', { cachedOnly: true });
  const offline = await request(route + '/compile', 'POST', {});
  assert.equal(offline.data.missingResource, 'Tectonic bundle or format files');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '-X');
  const online = await request(route + '/compile', 'POST', { allowDownloads: true });
  assert.equal(online.data.cachedOnly, false);
  assert.ok(calls[1].includes('--synctex'));
  assert.equal((await request(route)).data.cachedOnly, true);
});


test('a nested main document can include files from the project root', { skip: process.env.TEXDESK_TEST_COMPILER !== '1', timeout: 240000 }, async t => {
  const engines = await detectEngines();
  const { request, project } = await fixture(t, { engines }), route = '/projects/' + project.id;
  await request(route + '/file', 'PUT', { name: 'chapters/paper.tex', content: String.raw`\documentclass{article}\begin{document}\input{chapter}\end{document}` });
  await request(route + '/file', 'PUT', { name: 'chapter.tex', content: 'Root-relative input works.' });
  const tectonic = engines.some(engine => engine.id === 'tectonic' && engine.available);
  await request(route, 'PATCH', { mainFile: 'chapters/paper.tex', cachedOnly: tectonic });
  const result = await request(route + '/compile', 'POST', {}); assert.equal(result.data.ok, true, result.data.log);
  assert.equal(result.data.cachedOnly, tectonic);
  const built = (await request(route)).data;
  assert.equal((await request(route + '/sync?build=' + built.pdf.jobId + '&file=chapters%2Fpaper.tex&line=1')).status, 200);
});

test('the portable compiler can resolve installed Windows fonts', { skip: process.env.TEXDESK_TEST_COMPILER !== '1' || process.platform !== 'win32', timeout: 240000 }, async t => {
  const engines = await detectEngines();
  const { request, project } = await fixture(t, { engines }), route = '/projects/' + project.id;
  await request(route + '/file', 'PUT', { name: 'main.tex', content: String.raw`\documentclass{article}\usepackage{fontspec}\setmainfont{Arial}\begin{document}A system font, compiled locally.\end{document}` });
  const result = await request(route + '/compile', 'POST', {}); assert.equal(result.data.ok, true, result.data.log);
});
