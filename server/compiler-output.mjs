import path from 'node:path';
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export async function stageCachedBundle(command, runner, destination) {
  // Tectonic 0.17 can refresh remote bundle metadata even with --only-cached.
  // A local directory bundle avoids that code path entirely.
  let cache;
  if (process.env.TECTONIC_CACHE_DIR) {
    cache = path.resolve(process.env.TECTONIC_CACHE_DIR, 'bundles');
  } else {
    const result = await runner(command, ['-X', 'show', 'user-cache-dir'], { timeout: 5000 });
    cache = result.log.trim().split(/\r?\n/).findLast(line => path.isAbsolute(line.trim()))?.trim();
    if (result.code !== 0 || !cache) return null;
  }
  const hashes = path.join(cache, 'hashes');
  const entries = await fs.readdir(hashes, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.endsWith('.lock')) continue;
    const file = path.join(hashes, entry.name);
    const digest = (await fs.readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(digest)) continue;
    candidates.push({ digest, modified: (await fs.stat(file)).mtimeMs });
  }
  candidates.sort((a, b) => b.modified - a.modified);
  for (const { digest } of candidates) {
    const bundle = path.join(cache, 'data', digest);
    const stat = await fs.lstat(bundle).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isDirectory()) continue;
    await fs.cp(bundle, destination, {
      recursive: true,
      filter: async source => !(await fs.lstat(source)).isSymbolicLink()
    });
    await fs.writeFile(path.join(destination, 'SHA256SUM'), digest + '\n');
    return pathToFileURL(destination).href;
  }
  return null;
}

export function sourceResolver(buildDir, files, entryFile, mainFile) {
  const names = new Map(files.filter(file => file.editable).map(file => [
    process.platform === 'win32' ? file.name.toLowerCase() : file.name, file.name
  ]));
  return value => {
    const clean = value.trim().replace(/^"|"$/g, '').replaceAll('\\', '/');
    if (!clean) return null;
    const relative = path.relative(buildDir, path.resolve(buildDir, clean)).split(path.sep).join('/');
    if (relative === entryFile && entryFile !== mainFile) return mainFile;
    const key = process.platform === 'win32' ? relative.toLowerCase() : relative;
    // Tectonic can report the literal argument to \input without the suffix.
    return names.get(key) ?? names.get(key + '.tex') ?? null;
  };
}

export function compilerDiagnostics(log, resolveSource) {
  const issues = [];
  const seen = new Set();
  for (const row of log.split(/\r?\n/)) {
    // Tectonic prefixes its errors with "error:". TeX's file-line-error
    // format can also contain an absolute path with a Windows drive letter.
    const match = /^(?:error:\s*)?(.+?):(\d+):\s*(?:!\s*)?(.+)$/.exec(row.trim());
    if (!match) continue;
    const [, source, number, message] = match;
    const file = resolveSource(source);
    const line = Number(number);
    if (!file || !Number.isSafeInteger(line) || line < 1) continue;
    const key = JSON.stringify([file, line, message]);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ file, line, message: message.slice(0, 500) });
    if (issues.length === 50) break;
  }
  return issues;
}

export function missingCachedResource(log) {
  const file = /(?:file\s+)?[`'"“]([^\r\n`'"”]+)[`'"”]\s+(?:not found|(?:is )?not (?:in the )?cache)/i.exec(log);
  if (file) return file[1].slice(0, 240);
  if (/bundle (?:isn't|is not) cached|could not (?:load|find|open).*?(?:bundle|format)|not available in (?:the )?cache/i.test(log)) {
    return 'Tectonic bundle or format files';
  }
  return null;
}

export async function readSyncTeX(outputDir, stem, resolveSource) {
  const plain = path.join(outputDir, stem + '.synctex');
  let data;
  try {
    data = gunzipSync(await fs.readFile(plain + '.gz'), { maxOutputLength: 32 * 1024 * 1024 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { data = await fs.readFile(plain); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  if (data.length > 32 * 1024 * 1024) return [];
  const text = data.toString('utf8');
  const preamble = text.split(/^Content:\s*$/m, 1)[0];
  const parameter = (name, fallback) => Number(new RegExp('^' + name + ':(-?\\d+)\\s*$', 'm').exec(preamble)?.[1] ?? fallback);
  const baseUnit = parameter('Unit', 1) / 65781.76;
  const scale = baseUnit * parameter('Magnification', 1000) / 1000;
  const offsetX = parameter('X Offset', 0) * baseUnit;
  const offsetY = parameter('Y Offset', 0) * baseUnit;
  const files = new Map();
  const rows = new Map();
  let page = 0;
  for (const row of text.split(/\r?\n/)) {
    const input = /^Input:(\d+):(.*)$/.exec(row);
    if (input) {
      files.set(input[1], resolveSource(input[2]));
      continue;
    }
    const sheet = /^\{(\d+)$/.exec(row);
    if (sheet) { page = Number(sheet[1]); continue; }
    if (row.startsWith('}')) { page = 0; continue; }
    if (!page) continue;
    // Glue and kern records often retain a more precise source line than the
    // enclosing horizontal box, which may refer to the paragraph terminator.
    const item = /^([(hkgx$])(\d+),(\d+)(?:,\d+)?:([-\d]+),([-\d]+)(?::([-\d]+)(?:,([-\d]+),([-\d]+))?)?/.exec(row);
    if (!item) continue;
    const [, kind, tag, lineText, h, v, w, height, depth] = item;
    const file = files.get(tag);
    const line = Number(lineText);
    if (!file || !line) continue;
    const x = Number(h) * scale + offsetX;
    const baseline = Number(v) * scale + offsetY;
    const left = kind === 'k' ? Math.min(x, x - Number(w || 0) * scale) : x;
    const right = kind === 'h' || kind === '(' ? x + Math.max(0, Number(w || 0) * scale) : x;
    const priority = kind === '(' ? 0 : kind === 'k' ? 1 : 2;
    const key = JSON.stringify([file, line, page, Math.round(baseline * 2)]);
    const existing = rows.get(key);
    if (existing && existing.priority > priority) continue;
    if (existing?.priority === priority) {
      existing.x = Math.min(existing.x, left);
      existing.right = Math.max(existing.right, right);
      continue;
    }
    rows.set(key, {
      file, line, page, x: left, right, priority,
      y: baseline - Math.max(7, Number(height || 0) * scale),
      bottom: baseline + Math.max(3, Number(depth || 0) * scale)
    });
    if (rows.size >= 100000) break;
  }
  return [...rows.values()];
}

export function findSyncLocation(rows, query) {
  let best;
  let bestScore = Infinity;
  for (const row of rows) {
    let score;
    if (query.file) {
      if (row.file !== query.file) continue;
      score = Math.abs(row.line - query.line) * 10 - row.priority;
    } else {
      if (row.page !== query.page) continue;
      const dx = Math.max(row.x - query.x, query.x - row.right, 0);
      const dy = Math.max(row.y - query.y, query.y - row.bottom, 0);
      score = Math.hypot(dx * 0.25, dy * 2) + (2 - row.priority) * 4;
    }
    if (score < bestScore) { bestScore = score; best = row; }
  }
  return best;
}
