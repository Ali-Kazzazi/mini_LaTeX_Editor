import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') {
  console.error('Automatic compiler setup supports Windows. Install Tectonic, TeX Live, or MiKTeX with your system package manager, then restart mini_LaTeX_Editor.');
  process.exit(1);
}
const version = '0.17.0';
const asset = `tectonic-${version}-x86_64-pc-windows-msvc.zip`;
const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${version}/${asset}`;
const expectedHash = 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f';
console.log(`Downloading portable Tectonic ${version} from the official GitHub release…`);
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(archive).digest('hex');
  if (hash !== expectedHash) throw new Error('The compiler archive did not match its expected SHA-256. Nothing was installed.');
  const files = unzipSync(archive, { filter: file => /(^|\/)tectonic\.exe$/.test(file.name) });
  const binary = Object.values(files)[0]; if (!binary) throw new Error('The release did not contain tectonic.exe.');
  await fs.mkdir(path.join(root, '.tools'), { recursive: true });
  const target = path.join(root, '.tools', 'tectonic.exe'); await fs.writeFile(target, binary);
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const fonts = path.join(process.env.WINDIR || 'C:/Windows', 'Fonts').replaceAll('\\', '/');
  const cache = path.join(root, '.tools', 'font-cache').replaceAll('\\', '/');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(root, '.tools', 'fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir>${xml(fonts)}</dir><cachedir>${xml(cache)}</cachedir></fontconfig>`);
  const result = spawnSync(target, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.error?.message || result.stderr || 'The compiler could not start.');
  console.log(result.stdout.trim());
  console.log('Compiler installed in .tools/. Restart the app, or click Refresh compilers in Project settings.');
  console.log('The first compilation downloads the LaTeX packages your document uses and caches them locally.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

