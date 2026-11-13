import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { compilerDiagnostics, findSyncLocation, missingCachedResource, readSyncTeX, sourceResolver, stageCachedBundle } from './compiler-output.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINES = ['tectonic', 'pdflatex', 'xelatex', 'lualatex'];
const TEXT_EXTENSIONS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.txt', '.md', '.csv', '.tikz', '.pgf', '.svg', '.json']);
const MAX_FILE = 15 * 1024 * 1024;
const MAX_PROJECT = 100 * 1024 * 1024;
const HISTORY_LIMIT = 10;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

export function validateFile(name) {
  if (typeof name !== 'string' || !name || name.length > 240 || name.includes('\\') || name.includes('\0')) throw fail(400, 'Use a relative file path with forward slashes.');
  const parts = name.split('/');
  if (parts.some(p => !p || p.startsWith('.') || /[<>:"|?*\x00-\x1f]/.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw fail(400, 'This file name is not supported. Avoid hidden files, reserved names, and parent paths.');
  return name;
}
export async function safeFile(root, name) {
  validateFile(name);
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw fail(400, 'Symbolic links are not supported.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
export async function listFiles(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await listFiles(root, name + '/'));
    else if (entry.isFile()) { const stat = await fs.stat(path.join(root, name)); result.push({ name, size: stat.size, editable: TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) }); }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
async function atomicJSON(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, file);
}

async function copySources(source, destination, files) {
  await fs.mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = path.join(destination, validateFile(file.name));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(await safeFile(source, file.name), target);
  }
}

async function historyEntries(directory) {
  const root = path.join(directory, '.history');
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const checkpoints = await Promise.all(entries.filter(entry => entry.isDirectory() && UUID.test(entry.name))
    .map(entry => fs.readFile(path.join(root, entry.name, '.checkpoint.json'), 'utf8').then(JSON.parse)));
  return checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function checkpoint(root, source, files, metadata) {
  const staged = path.join(path.dirname(root), '.pending-' + metadata.id);
  try {
    await copySources(source, staged, files);
    await atomicJSON(path.join(staged, '.checkpoint.json'), metadata);
    await fs.rename(staged, root);
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}

async function pruneHistory(directory) {
  for (const entry of (await historyEntries(directory)).slice(HISTORY_LIMIT)) {
    if (UUID.test(entry.id)) await fs.rm(path.join(directory, '.history', entry.id), { recursive: true, force: true });
  }
}

async function fileDigest(root, name) {
  return createHash('sha256').update(await fs.readFile(await safeFile(root, name))).digest('hex');
}
export function runProcess(command, args, options = {}) {
  return new Promise(resolve => {
    let log = '', settled = false, timedOut = false;
    const fontConfig = path.join(ROOT, '.tools', 'fonts.conf');
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, shell: false, env: { ...process.env, ...(process.platform === 'win32' && existsSync(fontConfig) && !process.env.FONTCONFIG_FILE ? { FONTCONFIG_FILE: fontConfig } : {}), ...(options.texOutputDir ? { TEXMFOUTPUT: options.texOutputDir } : {}), openin_any: 'p', openout_any: 'p', MIKTEX_ENABLE_INSTALLER: '0' } });
    const append = chunk => { if (log.length < 2_000_000) log += chunk.toString(); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeout || 180000);
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...result, log, timedOut }); } };
    child.on('error', error => { append(error.message); finish({ code: -1 }); });
    child.on('close', code => finish({ code }));
  });
}
export async function detectEngines() {
  return Promise.all(ENGINES.map(async id => {
    const local = path.join(ROOT, '.tools', process.platform === 'win32' ? 'tectonic.exe' : 'tectonic');
    const command = process.env['TEXDESK_' + id.toUpperCase()] || (id === 'tectonic' && existsSync(local) ? local : id);
    const result = await runProcess(command, ['--version'], { timeout: 5000 });
    return { id, command, available: result.code === 0, version: result.code === 0 ? result.log.split(/\r?\n/)[0] : null };
  }));
}
const SAMPLE = String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{xcolor}
\usepackage{hyperref}
\definecolor{forest}{HTML}{24735C}
\hypersetup{colorlinks=true,linkcolor=forest,urlcolor=forest}

\title{A little space for big ideas}
\author{Your name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Every great paper starts with a single line. This is your local
workspace for writing, thinking, and bringing ideas to life.
\end{abstract}

\section{Make yourself at home}
Welcome to your new document. Edit the source on the left, then
click \textbf{Recompile} to see your changes on the right.
Your files and compilation stay on your computer.

\section{A beautiful equation}
Some ideas are best expressed in mathematics:
\begin{equation}
  e^{i\pi} + 1 = 0
\end{equation}
Or, a little more room to explore:
\begin{align}
  \nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
  \nabla \cdot \mathbf{B} &= 0
\end{align}

\section{What's next?}
\begin{itemize}
  \item Add a file or import an existing project folder.
  \item Choose your main document and preferred compiler.
  \item Download the PDF when you're ready to share.
\end{itemize}

\bigskip
\noindent\textcolor{forest}{\textit{Less setup. More writing.}}
\end{document}
`;

export async function createApp({ dataDir = process.env.TEXDESK_DATA_DIR || path.join(ROOT, '.data'), engines: suppliedEngines, runner = runProcess } = {}) {
  const projectsDir = path.resolve(dataDir, 'projects');
  await fs.mkdir(projectsDir, { recursive: true });
  const app = express();
  const active = new Set();
  const writes = new Map();
  async function projectWrite(id, action) {
    const previous = writes.get(id);
    let release;
    const next = new Promise(resolve => { release = resolve; });
    writes.set(id, next);
    try { await previous; return await action(); }
    finally {
      release();
      if (writes.get(id) === next) writes.delete(id);
    }
  }
  const writeRoute = handler => (req, res) => projectWrite(req.params.id, () => handler(req, res));
  let engines = suppliedEngines || await detectEngines();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return res.status(403).json({ error: 'Only localhost connections are accepted.' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '24mb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const getProject = async id => {
    if (!UUID.test(id)) throw fail(404, 'Project not found.');
    const directory = path.join(projectsDir, id);
    try {
      const meta = JSON.parse(await fs.readFile(path.join(directory, '.project.json'), 'utf8'));
      const sources = UUID.test(meta.sourceRevision) ? path.join(directory, '.sources', meta.sourceRevision) : directory;
      return { directory, meta, sources };
    }
    catch (e) { if (e.code === 'ENOENT') throw fail(404, 'Project not found.'); throw e; }
  };
  const saveMeta = (directory, meta) => atomicJSON(path.join(directory, '.project.json'), meta);
  const idle = id => { if (active.has(id)) throw fail(409, 'Wait for this project to finish compiling.'); };
  const description = async ({ directory, meta, sources = directory }) => ({ ...meta, files: await listFiles(sources) });
  const getCheckpoint = async (directory, id) => {
    if (!UUID.test(id)) throw fail(404, 'Checkpoint not found.');
    const root = path.join(directory, '.history', id);
    const info = JSON.parse(await fs.readFile(path.join(root, '.checkpoint.json'), 'utf8'));
    return { root, info };
  };
  app.get('/api/health', (_req, res) => res.json({ ok: true, local: true }));
  app.get('/api/engines', async (req, res) => { if (req.query.refresh) engines = suppliedEngines || await detectEngines(); res.json(engines.map(({ command, ...publicEngine }) => publicEngine)); });
  app.get('/api/projects', async (_req, res) => {
    const items = [];
    for (const entry of await fs.readdir(projectsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) { try { const { meta } = await getProject(entry.name); items.push(meta); } catch {} }
    }
    res.json(items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  });
  app.post('/api/projects', async (req, res) => {
    const name = String(req.body.name || 'Untitled project').trim().slice(0, 100) || 'Untitled project';
    const id = randomUUID(), directory = path.join(projectsDir, id);
    await fs.mkdir(directory);
    const meta = { id, name, mainFile: 'main.tex', engine: 'auto', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (!req.body.empty) await fs.writeFile(path.join(directory, 'main.tex'), SAMPLE);
    await saveMeta(directory, meta);
    res.status(201).json(await description({ directory, meta }));
  });
  app.get('/api/projects/:id', writeRoute(async (req, res) => res.json(await description(await getProject(req.params.id)))));
  app.patch('/api/projects/:id', writeRoute(async (req, res) => {
    idle(req.params.id);
    const { directory, meta, sources } = await getProject(req.params.id);
    if (req.body.name !== undefined) { const name = String(req.body.name).trim(); if (!name) throw fail(400, 'Enter a project name.'); meta.name = name.slice(0, 100); }
    if (req.body.mainFile !== undefined) { validateFile(req.body.mainFile); if (!req.body.mainFile.endsWith('.tex')) throw fail(400, 'The main document must be a .tex file.'); meta.mainFile = req.body.mainFile; }
    if (req.body.engine !== undefined) { if (!['auto', ...ENGINES].includes(req.body.engine)) throw fail(400, 'Unknown compiler.'); meta.engine = req.body.engine; }
    if (req.body.cachedOnly !== undefined) {
      if (typeof req.body.cachedOnly !== 'boolean') throw fail(400, 'Choose whether to use cached packages only.');
      meta.cachedOnly = req.body.cachedOnly;
    }
    meta.updatedAt = new Date().toISOString(); await saveMeta(directory, meta); res.json(await description({ directory, meta, sources }));
  }));
  app.delete('/api/projects/:id', writeRoute(async (req, res) => { idle(req.params.id); const { directory } = await getProject(req.params.id); await fs.rm(directory, { recursive: true }); res.json({ ok: true }); }));
  app.get('/api/projects/:id/file', writeRoute(async (req, res) => {
    const { sources } = await getProject(req.params.id), target = await safeFile(sources, req.query.name);
    if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) throw fail(400, 'This is a binary asset. Download the source archive to access it.');
    const stat = await fs.stat(target); if (stat.size > MAX_FILE) throw fail(413, 'File is too large to edit.');
    res.json({ content: await fs.readFile(target, 'utf8') });
  }));
  app.put('/api/projects/:id/file', writeRoute(async (req, res) => {
    const { sources, meta } = await getProject(req.params.id), name = validateFile(req.body.name), target = await safeFile(sources, name);
    if ((req.body.sourceRevision ?? null) !== (meta.sourceRevision ?? null)) throw fail(409, 'This project was restored in another tab. Reload before saving.');
    if (req.body.createOnly && existsSync(target)) throw fail(409, 'A file with that name already exists.');
    const content = req.body.encoding === 'base64' ? Buffer.from(req.body.content || '', 'base64') : Buffer.from(req.body.content || '', 'utf8');
    if (content.length > MAX_FILE) throw fail(413, 'Files must be smaller than 15 MB.');
    const files = await listFiles(sources), old = files.find(f => f.name === name)?.size || 0;
    if (files.reduce((n, f) => n + f.size, 0) - old + content.length > MAX_PROJECT) throw fail(413, 'Projects must be smaller than 100 MB.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = path.join(path.dirname(target), '.' + randomUUID() + '.tmp');
    await fs.writeFile(temp, content); await fs.rename(temp, target);
    res.json({ ok: true });
  }));
  app.post('/api/projects/:id/rename-file', writeRoute(async (req, res) => {
    idle(req.params.id); const { directory, meta, sources } = await getProject(req.params.id);
    const from = await safeFile(sources, req.body.from), to = await safeFile(sources, req.body.to);
    if (existsSync(to)) throw fail(409, 'That file already exists.');
    if (!(await fs.stat(from)).isFile()) throw fail(400, 'Choose a file.');
    await fs.mkdir(path.dirname(to), { recursive: true }); await fs.rename(from, to);
    if (meta.mainFile === req.body.from) { meta.mainFile = req.body.to; await saveMeta(directory, meta); }
    res.json(await description({ directory, meta, sources }));
  }));
  app.delete('/api/projects/:id/file', writeRoute(async (req, res) => {
    idle(req.params.id); const { sources } = await getProject(req.params.id); await fs.unlink(await safeFile(sources, req.query.name)); res.json({ ok: true });
  }));
  app.get('/api/projects/:id/source', writeRoute(async (req, res) => {
    const { sources, meta } = await getProject(req.params.id), files = Object.create(null);
    for (const file of await listFiles(sources)) files[file.name] = new Uint8Array(await fs.readFile(await safeFile(sources, file.name)));
    res.attachment((meta.name.replace(/[^a-z0-9_-]/gi, '_') || 'project') + '.zip').type('zip').send(Buffer.from(zipSync(files)));
  }));
  app.get('/api/projects/:id/history', writeRoute(async (req, res) => {
    const { directory } = await getProject(req.params.id);
    res.json(await historyEntries(directory));
  }));
  app.get('/api/projects/:id/history/:checkpoint/compare', writeRoute(async (req, res) => {
    const { directory, sources } = await getProject(req.params.id);
    const { root } = await getCheckpoint(directory, req.params.checkpoint);
    const saved = new Map((await listFiles(root)).map(file => [file.name, file]));
    const current = new Map((await listFiles(sources)).map(file => [file.name, file]));
    const changes = [];
    for (const name of new Set([...current.keys(), ...saved.keys()])) {
      const before = saved.get(name);
      const after = current.get(name);
      if (before && after && before.size === after.size &&
          await fileDigest(root, name) === await fileDigest(sources, name)) continue;
      changes.push({ name, editable: (before ?? after).editable, status: !before ? 'Added' : !after ? 'Removed' : 'Modified' });
    }
    res.json(changes);
  }));
  app.get('/api/projects/:id/history/:checkpoint/file', writeRoute(async (req, res) => {
    const { directory, sources } = await getProject(req.params.id);
    const { root } = await getCheckpoint(directory, req.params.checkpoint);
    const name = validateFile(req.query.name);
    if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) throw fail(400, 'Only text files can be compared.');
    const read = async source => {
      const target = await safeFile(source, name);
      try {
        const stat = await fs.stat(target);
        if (!stat.isFile()) return null;
        if (stat.size > MAX_FILE) throw fail(413, 'File is too large to compare.');
        return await fs.readFile(target, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      }
    };
    const [saved, current] = await Promise.all([read(root), read(sources)]);
    res.json({ saved, current });
  }));
  app.post('/api/projects/:id/history/:checkpoint/restore', writeRoute(async (req, res) => {
    const id = req.params.id;
    idle(id);
    const { directory, meta, sources } = await getProject(id);
    if ((req.body.sourceRevision ?? null) !== (meta.sourceRevision ?? null)) throw fail(409, 'This project was restored in another tab. Reload first.');
    const { root, info } = await getCheckpoint(directory, req.params.checkpoint);
    const recoveryId = randomUUID();
    const restoredAt = new Date().toISOString();
    const revision = randomUUID();
    const destination = path.join(directory, '.sources', revision);
    const previousRevision = meta.sourceRevision;
    await checkpoint(path.join(directory, '.history', recoveryId), sources, await listFiles(sources), {
      id: recoveryId, createdAt: restoredAt, kind: 'before-restore', mainFile: meta.mainFile
    });
    try {
      await copySources(root, destination, await listFiles(root));
      meta.sourceRevision = revision;
      meta.mainFile = validateFile(info.mainFile);
      meta.updatedAt = restoredAt;
      meta.restoredAt = restoredAt;
      await saveMeta(directory, meta);
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true }).catch(console.error);
      throw error;
    }
    if (UUID.test(previousRevision)) {
      await fs.rm(path.join(directory, '.sources', previousRevision), { recursive: true, force: true }).catch(console.error);
    }
    await pruneHistory(directory).catch(console.error);
    res.json(await description({ directory, meta, sources: destination }));
  }));
  app.post('/api/projects/:id/compile', async (req, res) => {
    const id = req.params.id; idle(id);
    if (active.size >= 2) throw fail(429, 'Two projects are compiling. Try again shortly.');
    const { directory, meta, sources } = await getProject(id);
    const engine = meta.engine === 'auto' ? engines.find(e => e.available) : engines.find(e => e.id === meta.engine && e.available);
    if (!engine) throw fail(503, process.platform === 'win32'
      ? 'No compiler is available. Install MiKTeX or TeX Live, or run npm run setup:compiler on Windows x64. Then refresh compilers in Settings.'
      : 'No compiler is available. Install TeX Live or put Tectonic on your PATH, then refresh compilers in Settings.');
    const { allowDownloads, sourceRevision } = req.body ?? {};
    if (sourceRevision !== undefined && sourceRevision !== (meta.sourceRevision ?? null)) {
      throw fail(409, 'This project was restored in another tab. Reload before compiling.');
    }
    if (allowDownloads !== undefined && typeof allowDownloads !== 'boolean') throw fail(400, 'Invalid package download setting.');
    const cachedOnly = engine.id === 'tectonic' && meta.cachedOnly === true && allowDownloads !== true;
    idle(id);
    if (active.size >= 2) throw fail(429, 'Two projects are compiling. Try again shortly.');
    active.add(id);
    const started = Date.now(), jobId = randomUUID(), buildDir = path.join(directory, '.build', jobId), outputDir = path.join(buildDir, '.output');
    let log = '', result;
    try {
      const files = await projectWrite(id, async () => {
        const current = await getProject(id);
        if (current.meta.sourceRevision !== meta.sourceRevision || current.meta.mainFile !== meta.mainFile ||
            current.meta.engine !== meta.engine || current.meta.cachedOnly !== meta.cachedOnly) {
          throw fail(409, 'Project settings changed. Reload before compiling.');
        }
        const mainFile = await safeFile(sources, meta.mainFile);
        if (!existsSync(mainFile)) throw fail(400, 'The main .tex file is missing. Select it in Settings.');
        const list = await listFiles(sources);
        await copySources(sources, buildDir, list);
        await fs.mkdir(outputDir, { recursive: true });
        return list;
      });
      let texPath = './' + meta.mainFile;
      const nestedTectonic = engine.id === 'tectonic' && meta.mainFile.includes('/');
      if (nestedTectonic) { await fs.copyFile(path.join(buildDir, meta.mainFile), path.join(buildDir, '.texdesk-entry.tex')); texPath = './.texdesk-entry.tex'; }
      const offlineBundle = path.join(outputDir, '.cached-bundle');
      const bundle = cachedOnly ? await stageCachedBundle(engine.command, runner, offlineBundle) : null;
      const args = engine.id === 'tectonic'
        ? ['--untrusted', '--synctex', '--keep-logs', '--keep-intermediates', ...(bundle ? ['--only-cached', '--bundle', bundle] : []), '--outdir', outputDir, texPath]
        : ['-no-shell-escape', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-output-directory=' + outputDir, texPath];
      // Older TeX Live releases consult TEXMFOUTPUT when checking absolute paths under openout_any=p.
      const compilerOptions = { cwd: buildDir, texOutputDir: engine.id === 'tectonic' ? undefined : outputDir };
      let pass;
      try {
        pass = cachedOnly && !bundle
          ? { code: 1, log: 'The Tectonic bundle is not cached. Run a build with downloads enabled.' }
          : await runner(engine.command, args, compilerOptions);
      } finally {
        if (cachedOnly) await fs.rm(offlineBundle, { recursive: true, force: true }).catch(console.error);
      }
      log += pass.log;
      if (pass.code === 0 && engine.id !== 'tectonic') { pass = await runner(engine.command, args, compilerOptions); log += '\n--- Second pass ---\n' + pass.log; }
      const pdfName = path.basename(meta.mainFile, '.tex') + '.pdf';
      const pdf = path.join(outputDir, pdfName);
      const generated = path.join(outputDir, '.texdesk-entry.pdf');
      if (nestedTectonic && pass.code === 0 && existsSync(generated)) await fs.rename(generated, pdf);
      const ok = pass.code === 0 && existsSync(pdf);
      const resolveSource = sourceResolver(buildDir, files, texPath.slice(2), meta.mainFile);
      const diagnostics = ok ? [] : compilerDiagnostics(log, resolveSource);
      result = {
        ok, engine: engine.id, duration: Date.now() - started, completedAt: new Date().toISOString(),
        timedOut: pass.timedOut || false, log: log || 'The compiler returned no output.', jobId,
        diagnostics, cachedOnly, missingResource: cachedOnly && !ok ? missingCachedResource(log) : null
      };
      await projectWrite(id, async () => {
        const latest = (await getProject(id)).meta;
        if (ok) {
          const syncRows = await readSyncTeX(outputDir, path.basename(texPath, '.tex'), resolveSource).catch(() => []);
          if (syncRows.length) await atomicJSON(path.join(buildDir, '.sync.json'), syncRows);
          latest.pdf = { jobId, pdfName, compiledAt: result.completedAt, hasSync: syncRows.length > 0 };
          delete latest.restoredAt;
          await checkpoint(path.join(directory, '.history', jobId), buildDir, files, {
            id: jobId, createdAt: result.completedAt, kind: 'compile', engine: engine.id, mainFile: meta.mainFile
          });
        }
        latest.lastBuild = { ...result, log: undefined };
        latest.updatedAt = result.completedAt;
        await fs.writeFile(path.join(directory, '.compile.log'), result.log);
        await saveMeta(directory, latest);
        const retained = new Set([jobId, latest.pdf?.jobId]);
        await pruneHistory(directory).catch(console.error);
        for (const entry of await fs.readdir(path.join(directory, '.build'))) {
          if (UUID.test(entry) && !retained.has(entry)) {
            await fs.rm(path.join(directory, '.build', entry), { recursive: true, force: true }).catch(console.error);
          }
        }
      });
      res.json(result);
    } finally { active.delete(id); }
  });
  app.get('/api/projects/:id/log', async (req, res) => {
    const { directory } = await getProject(req.params.id); let log = ''; try { log = await fs.readFile(path.join(directory, '.compile.log'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; } res.json({ log });
  });
  app.get('/api/projects/:id/sync', writeRoute(async (req, res) => {
    const { directory, meta, sources } = await getProject(req.params.id);
    if (!meta.pdf?.hasSync || !UUID.test(meta.pdf.jobId)) throw fail(404, 'Recompile to enable source and PDF navigation.');
    if (req.query.build !== meta.pdf.jobId) throw fail(409, 'The PDF changed. Reload the preview and try again.');
    const build = path.join(directory, '.build', meta.pdf.jobId);
    const rows = JSON.parse(await fs.readFile(path.join(build, '.sync.json'), 'utf8'));
    let query;
    if (req.query.file !== undefined) {
      query = { file: validateFile(req.query.file), line: Number(req.query.line) };
      if (!Number.isSafeInteger(query.line) || query.line < 1) throw fail(400, 'Invalid source line.');
    } else {
      query = { page: Number(req.query.page), x: Number(req.query.x), y: Number(req.query.y) };
      if (!Number.isSafeInteger(query.page) || query.page < 1 || !Number.isFinite(query.x) || !Number.isFinite(query.y)) throw fail(400, 'Invalid PDF position.');
    }
    const location = findSyncLocation(rows, query);
    if (!location) throw fail(404, 'No matching source or PDF position was found.');
    const unchanged = await Promise.all([fileDigest(build, location.file), fileDigest(sources, location.file)])
      .then(([compiled, current]) => compiled === current).catch(() => false);
    if (!unchanged) throw fail(409, 'This source file changed since the PDF was built. Recompile to sync it.');
    res.json(location);
  }));
  app.get('/api/projects/:id/pdf', async (req, res) => {
    const { directory, meta } = await getProject(req.params.id);
    if (!meta.pdf) throw fail(404, 'Compile your document to create a PDF.');
    if (req.query.build && req.query.build !== meta.pdf.jobId) throw fail(409, 'The PDF changed. Reload the preview.');
    res.set('Cache-Control', 'no-store');
    if (req.query.download) res.attachment(meta.pdf.pdfName);
    res.type('pdf').sendFile(path.join(directory, '.build', meta.pdf.jobId, '.output', meta.pdf.pdfName), { dotfiles: 'allow' });
  });
  app.use(express.static(path.join(ROOT, 'dist')));
  app.use((error, _req, res, _next) => {
    const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
    if (status === 500) console.error(error);
    res.status(status).json({ error: status === 500 ? 'The local server could not complete the request. Check the terminal for details.' : error.message });
  });
  return app;
}



