import './style.css';
import { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection, rectangularSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, StreamLanguage, bracketMatching, indentOnInput } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { getDocument, GlobalWorkerOptions, TextLayer } from './pdf.js';
import { unzipSync } from 'fflate';
GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
const $ = id => document.getElementById(id);
const icons = {
 'chevron-down':'m6 9 6 6 6-6', 'chevron-left':'m15 6-6 6 6 6', 'chevron-right':'m9 6 6 6-6 6',
 'download':'M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4', 'upload':'M12 16V4m-5 5 5-5 5 5M5 16v4h14v-4',
 'file-text':'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8m-8 4h6',
 'file-plus':'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 12v6m-3-3h6',
 'file-check':'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 15l3 3 5-5',
 'folder':'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
 'settings':'m9 3-1 3-3 1-2 3 2 3v3l3 2 3-1 3 1 3-2v-3l2-3-2-3-3-1-1-3z M15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
 'hard-drive':'M5 4h14l3 11H2z M2 15v5h20v-5 M6 18h.01M10 18h.01', 'arrow-up-right':'M7 17 17 7M7 7h10v10',
 'panel-left':'M3 3h18v18H3z M9 3v18', 'list-tree':'M4 3v14h5M4 7h5 M13 5h7M13 15h7',
 'search':'M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0', 'wrap':'M3 5h17M3 10h14a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M3 16h4',
 'play':'m8 4 12 8-12 8z', 'plus':'M12 5v14M5 12h14', 'minus':'M5 12h14',
 'terminal':'m4 6 6 6-6 6M13 18h7', 'x':'m6 6 12 12M6 18 18 6', 'check':'m5 12 4 4L19 6',
 'code':'m8 6-6 6 6 6m8-12 6 6-6 6m-2-14-4 16',
 'refresh':'M20 7V3l-3 3a8 8 0 1 0 2 12M20 3h-5', 'image':'M3 3h18v18H3z M3 17l6-6 4 4 3-3 5 5 M15 7h.01',
 'trash':'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7', 'zip':'M14 2H6v20h14V8z M14 2v6h6M10 3v2m0 2v2m0 2v2m-2 3h4v4H8z'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons['file-text']}"/></svg>`;
function renderIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon)); }
renderIcons();
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let project, currentFile, projects = [], engines = [], openFiles = [], states = new Map(), pending = new Map();
let view, saveTimer, saveWork, autoTimer, compiling = false, log = '', pdf, pdfLoad, pageObserver, zoom = 'fit', renderGeneration = 0, fileRequest = 0, toastTimer;
let previewBuild, forwardSync, forwardSyncTimer, pickingSource = false;
let workspace = { positions: Object.create(null) }, workspaceTimer, workspaceRequest = 0;
let diagnostics = [], lastBuildFailed = false, previewOutdated = false;
let workspaceView = 'split', previousView = 'split';
const narrow = matchMedia('(max-width: 760px)');
const pageViewports = new WeakMap();
const wrap = new Compartment();
const setMarkers = StateEffect.define();
const errorMarkers = StateField.define({
  create: () => new RangeSetBuilder().finish(),
  update(markers, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMarkers)) return effect.value;
    return markers.map(transaction.changes);
  }
});
class ErrorMarker extends GutterMarker {
  constructor(message) { super(); this.message = message; }
  eq(other) { return this.message === other.message; }
  toDOM() {
    const marker = document.createElement('span');
    marker.className = 'source-error-marker';
    marker.title = this.message;
    marker.textContent = '!';
    return marker;
  }
}
let wrapping = true, editRevision = 0;
$('auto-compile').checked = localStorage.getItem('texdesk.auto') === 'true';
async function api(route, options = {}) {
  const response = await fetch('/api' + route, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `Request failed (${response.status}).`); }
  return response.json();
}
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, error ? 7500 : 3500); }
function guard(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(e => toast(e.message, true)); }
function base(id = project?.id) { return '/projects/' + id; }
function readWorkspace(id) {
  try { return JSON.parse(localStorage.getItem('texdesk.workspace.' + id)) || {}; }
  catch { return {}; }
}
function saveWorkspace() {
  clearTimeout(workspaceTimer);
  if (!project) return;
  if (view && currentFile) workspace.positions[currentFile] = view.state.selection.main.head;
  try {
    localStorage.setItem('texdesk.workspace.' + project.id, JSON.stringify({
      ...workspace, openFiles, currentFile, sourceRevision: project.sourceRevision
    }));
  } catch {}
}
function effectiveView() { return narrow.matches && workspaceView === 'split' ? 'source' : workspaceView; }
function setWorkspaceView(mode) {
  capturePDFPosition();
  if (workspaceView !== 'problems') previousView = workspaceView;
  workspaceView = mode;
  const active = effectiveView();
  $('app').dataset.workspaceView = active;
  if (active !== 'pdf' && active !== 'split') setSourcePicker(false);
  $('log-panel').hidden = active !== 'problems';
  for (const button of document.querySelectorAll('.view-switch button')) {
    button.setAttribute('aria-pressed', button.dataset.workspaceView === active);
  }
  if (active === 'source' || active === 'split') view?.requestMeasure();
  if (active === 'pdf' || active === 'split') restorePDFPosition();
}
function showSource() {
  if (!['source', 'split'].includes(effectiveView())) {
    setWorkspaceView(!narrow.matches && previousView === 'split' ? 'split' : 'source');
  }
}
function showPDF() {
  if (!['pdf', 'split'].includes(effectiveView())) setWorkspaceView('pdf');
}
function refreshErrorMarkers() {
  if (!view) return;
  const byLine = new Map();
  for (const issue of diagnostics) {
    if (issue.file !== currentFile || issue.line < 1 || issue.line > view.state.doc.lines) continue;
    const pos = view.state.doc.line(issue.line).from;
    byLine.set(pos, [...(byLine.get(pos) || []), issue.message]);
  }
  const markers = new RangeSetBuilder();
  for (const [pos, messages] of [...byLine].sort(([a], [b]) => a - b)) {
    markers.add(pos, pos, new ErrorMarker(messages.join('\n')));
  }
  view.dispatch({ effects: setMarkers.of(markers.finish()) });
}
function storageKey(name) {
  const revision = project.sourceRevision ? project.sourceRevision + '/' : '';
  return 'texdesk.draft.' + project.id + '.' + revision + name;
}
function setSaveStatus(message, busy = false) {
  $('save-status').innerHTML = `<span class="status-dot" style="background:${busy ? '#c0a268' : '#489171'}"></span>${escapeHTML(message)}`;
  $('saving-label').textContent = message;
}
async function flushSaves() {
  clearTimeout(saveTimer);
  if (saveWork) await saveWork;
  if (!pending.size) return;
  const id = project.id;
  saveWork = (async () => {
    setSaveStatus('Saving…', true);
    while (pending.size) {
      const [name, content] = pending.entries().next().value;
      await api(base(id) + '/file', { method: 'PUT', body: { name, content, sourceRevision: project.sourceRevision } });
      if (pending.get(name) === content) { pending.delete(name); localStorage.removeItem(storageKey(name)); }
    }
    setSaveStatus('All changes saved');
  })();
  try { await saveWork; } catch (e) { setSaveStatus('Save failed · retry with Ctrl+S', true); throw e; } finally { saveWork = null; }
}
function changed(update) {
  if (update.docChanged && currentFile) {
    editRevision++;
    const content = update.state.doc.toString(); pending.set(currentFile, content);
    try { localStorage.setItem(storageKey(currentFile), content); } catch {}
    setSaveStatus('Unsaved changes', true);
    clearTimeout(saveTimer); saveTimer = setTimeout(() => flushSaves().catch(e => toast(e.message, true)), 650);
    clearTimeout(autoTimer); if ($('auto-compile').checked) autoTimer = setTimeout(() => compile().catch(e => toast(e.message, true)), 2000);
    renderOutline();
    if (project?.pdf) {
      previewOutdated = true;
      updateFreshness();
      if (!compiling) $('build-status').textContent = 'Changes since last compile';
    }
  }
  if (update.docChanged || update.selectionSet) {
    updateCursor();
    clearTimeout(workspaceTimer);
    workspaceTimer = setTimeout(saveWorkspace, 250);
  }
}
const completions = ['documentclass','usepackage','begin','end','section','subsection','subsubsection','chapter','label','ref','eqref','cite','textbf','textit','emph','includegraphics','input','include','title','author','date','maketitle','tableofcontents','frac','sqrt','sum','int','alpha','beta','gamma','theta','pi','infty','varepsilon','mathbf','mathbb','left','right','item','caption','centering','bibliography','bibliographystyle','newcommand'];
function latexCompletion(context) { const word = context.matchBefore(/\\[a-zA-Z]*/); if (!word) return null; return { from: word.from, options: completions.map(label => ({ label: '\\' + label, type: 'keyword', apply: '\\' + label })) }; }
function makeState(content) {
  return EditorState.create({ doc: content, extensions: [lineNumbers(), errorMarkers,
    gutter({ class: 'cm-error-gutter', markers: v => v.state.field(errorMarkers) }),
    highlightActiveLineGutter(), history(), drawSelection(), rectangularSelection(), indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches(), StreamLanguage.define(stex), syntaxHighlighting(defaultHighlightStyle), autocompletion({ override: [latexCompletion] }), wrap.of(wrapping ? EditorView.lineWrapping : []), EditorView.updateListener.of(changed), keymap.of([{ key: 'Mod-s', run: () => { guard(flushSaves)(); return true; } }, { key: 'Mod-Enter', run: () => { guard(compile)(); return true; } }, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]), EditorView.theme({ '&': { color: '#536445' }, '.cm-content': { caretColor: '#24664f' } }), EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source code', spellcheck: 'false' })] });
}
function updateCursor() {
  if (!view) return;
  const pos = view.state.selection.main.head, line = view.state.doc.lineAt(pos);
  $('cursor-status').textContent = `Ln ${line.number}, Col ${pos - line.from + 1}`;
  const plain = view.state.doc.toString().replace(/%[^\n]*/g, '').replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, '').replace(/[{}\\$]/g, ' ');
  $('word-count').textContent = (plain.trim().match(/\S+/g)?.length || 0) + ' words';
}
function renderFiles() {
  $('file-tree').replaceChildren(); let previousFolder = '';
  for (const file of project.files) {
    const parts = file.name.split('/'), folder = parts.slice(0, -1).join('/');
    if (folder && folder !== previousFolder) { const el = document.createElement('div'); el.className = 'file-folder'; el.innerHTML = icon('folder') + escapeHTML(folder); $('file-tree').append(el); }
    previousFolder = folder;
    const el = document.createElement('button'); el.className = 'file-row' + (file.name === currentFile ? ' selected' : ''); el.title = file.name; el.style.paddingLeft = folder ? '22px' : '';
    el.innerHTML = icon(file.editable ? 'file-text' : 'image') + `<span class="file-name">${escapeHTML(parts.at(-1))}</span>` + (file.name === project.mainFile ? '<span class="main-dot" title="Main document">Main</span>' : '');
    el.onclick = guard(() => openFile(file.name)); $('file-tree').append(el);
  }
  if (!project.files.length) $('file-tree').innerHTML = '<p class="outline-empty">Add a .tex file to get started.</p>';
}
function renderTabs() {
  $('file-tabs').replaceChildren();
  for (const name of openFiles) {
    const el = document.createElement('div'); el.className = 'file-tab' + (name === currentFile ? ' selected' : '');
    const select = document.createElement('button'); select.innerHTML = icon('file-text') + escapeHTML(name.split('/').at(-1)); select.title = name; select.onclick = guard(() => openFile(name));
    if (name === currentFile) select.setAttribute('aria-current', 'true');
    const close = document.createElement('button'); close.className = 'tab-close'; close.innerHTML = '×'; close.title = 'Close ' + name; close.setAttribute('aria-label', 'Close ' + name);
    close.onclick = guard(async () => {
      await flushSaves();
      saveWorkspace();
      openFiles = openFiles.filter(n => n !== name);
      if (currentFile === name) {
        currentFile = null;
        view?.destroy(); view = null; $('editor').replaceChildren(); $('asset-view').hidden = true;
        states.delete(name);
        if (openFiles.length) await openFile(openFiles.at(-1));
        else { renderOutline(); renderFiles(); }
      }
      renderTabs(); saveWorkspace();
    });
    el.append(select, close); $('file-tabs').append(el);
  }
}
async function openFile(name, { activate = true } = {}) {
  if (name === currentFile) {
    if (activate) { showSource(); if (narrow.matches) showSidebar(false); view?.focus(); }
    return;
  }
  const ticket = ++fileRequest, file = project.files.find(f => f.name === name); if (!file) return;
  if (currentFile && view) {
    states.set(currentFile, view.state);
    workspace.positions[currentFile] = view.state.selection.main.head;
  }
  let nextState;
  if (file.editable) {
    if (states.has(name)) nextState = states.get(name);
    else {
      const { content } = await api(base() + '/file?name=' + encodeURIComponent(name));
      if (ticket !== fileRequest) return;
      const recovered = localStorage.getItem(storageKey(name)); nextState = makeState(recovered ?? content);
      const cursor = Math.min(nextState.doc.length, Math.max(0, workspace.positions[name] || 0));
      nextState = nextState.update({ selection: { anchor: cursor } }).state;
      if (recovered !== null && recovered !== content) { pending.set(name, recovered); setSaveStatus('Recovered unsaved changes', true); saveTimer = setTimeout(() => guard(flushSaves)(), 650); }
    }
  }
  if (ticket !== fileRequest) return;
  currentFile = name; if (!openFiles.includes(name)) openFiles.push(name);
  $('asset-view').hidden = file.editable; $('editor').hidden = !file.editable;
  if (activate) { showSource(); if (narrow.matches) showSidebar(false); }
  if (file.editable) {
    if (view) view.setState(nextState); else view = new EditorView({ state: nextState, parent: $('editor') });
    view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head) });
    if (activate) view.focus();
    updateCursor(); refreshErrorMarkers();
  }
  else { view?.destroy(); view = null; $('editor').replaceChildren(); $('asset-view').innerHTML = icon('image') + `<h2>${escapeHTML(name)}</h2><p>${(file.size / 1024).toFixed(1)} KB · Project asset</p><p>This file is included when your document compiles.<br>Export the source to download your project files.</p>`; }
  renderFiles(); renderTabs(); renderOutline(); saveWorkspace();
}
function renderOutline() {
  $('outline').replaceChildren();
  if (!view || !currentFile?.endsWith('.tex')) { $('outline').innerHTML = '<p class="outline-empty">Sections in your .tex file appear here.</p>'; return; }
  const text = view.state.doc.toString(), pattern = /^\s*\\(chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{([^}]*)\}/gm; let match, count = 0;
  while ((match = pattern.exec(text))) {
    const el = document.createElement('button'), pos = match.index; el.className = 'outline-link' + (!count ? ' active' : ''); el.textContent = match[2]; el.style.paddingLeft = match[1] === 'subsection' ? '32px' : match[1] === 'subsubsection' ? '42px' : '22px';
    el.onclick = () => { view.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); view.focus(); $('outline').querySelectorAll('.active').forEach(n => n.classList.remove('active')); el.classList.add('active'); };
    $('outline').append(el); count++;
  }
  if (!count) $('outline').innerHTML = '<p class="outline-empty">Add a section to give your document a little structure.</p>';
}
async function refreshProject() { project = await api(base()); renderFiles(); }
async function loadProject(id) {
  if (compiling) throw new Error('Wait for compilation to finish before switching projects.');
  const request = ++workspaceRequest;
  await flushSaves();
  const [nextProject, nextLog] = await Promise.all([api(base(id)), api(base(id) + '/log')]);
  if (request !== workspaceRequest) return;
  saveWorkspace(); clearTimeout(autoTimer); ++fileRequest;
  view?.destroy(); view = null; $('editor').replaceChildren(); states.clear(); pending.clear(); currentFile = null; openFiles = [];
  $('asset-view').hidden = true;
  project = nextProject;
  const saved = readWorkspace(id);
  const names = new Set(project.files.map(file => file.name));
  workspace = { positions: Object.create(null), split: Number.isFinite(saved.split) ? saved.split : .5 };
  if (saved.sourceRevision === project.sourceRevision) {
    for (const [name, pos] of Object.entries(saved.positions || {})) {
      if (names.has(name) && Number.isSafeInteger(pos)) workspace.positions[name] = pos;
    }
  }
  openFiles = Array.isArray(saved.openFiles) ? [...new Set(saved.openFiles.filter(name => names.has(name)))] : [];
  localStorage.setItem('texdesk.project', project.id);
  applySplit();
  $('project-name').textContent = project.name; document.title = project.name + ' — mini_LaTeX_Editor'; renderFiles(); renderTabs(); renderOutline();
  log = nextLog.log;
  lastBuildFailed = project.lastBuild?.ok === false && !project.restoredAt;
  previewOutdated = Boolean(project.restoredAt || (project.pdf && project.updatedAt > project.pdf.compiledAt));
  renderCompileLog(project.lastBuild);
  showOutput('errors');
  setBanner('');
  $('build-status').textContent = project.restoredAt ? 'Checkpoint restored · recompile to update PDF' :
    project.lastBuild ? (project.lastBuild.ok ? 'Last build succeeded' : 'Last build failed') : 'Ready to compile';
  if (project.lastBuild?.cachedOnly && !project.lastBuild.ok && !project.restoredAt) showCacheFailure(project.lastBuild);
  updateFreshness();
  previewBuild = undefined;
  clearForwardSync();
  setSourcePicker(false);
  $('download-pdf').disabled = !project.pdf;
  const previousLoad = pdfLoad;
  pdfLoad = null; pdf = null; renderGeneration++; pageObserver?.disconnect();
  $('pdf-pages').replaceChildren(); $('preview-empty').hidden = !!project.pdf; $('page-total').textContent = '/ 0';
  $('page-number').value = 1; pdfPosition = { page: 1, fraction: 0 }; zoom = 'fit';
  resetPDFSearch(true);
  if (previousLoad) await previousLoad.destroy();
  if (request !== workspaceRequest) return;
  const selected = openFiles.includes(saved.currentFile) ? saved.currentFile : openFiles.at(-1);
  const first = selected ?? (Array.isArray(saved.openFiles) && !saved.openFiles.length
    ? null : (names.has(project.mainFile) ? project.mainFile : project.files[0]?.name));
  if (first) await openFile(first, { activate: false });
  if (request !== workspaceRequest) return;
  if (project.pdf) await loadPDF();
  if (!pending.size) setSaveStatus('All changes saved');
}
function setBanner(message, type = '') { $('build-banner').textContent = message; $('build-banner').className = 'build-banner ' + type; $('build-banner').hidden = !message; }

async function jumpToSource(file, number) {
  if (!project.files.some(entry => entry.name === file && entry.editable)) throw new Error('That source file is no longer available.');
  await openFile(file);
  if (currentFile !== file || !view) return;
  const line = view.state.doc.line(Math.min(number, view.state.doc.lines));
  view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  view.focus();
}

function updateFreshness() {
  const badge = $('preview-freshness');
  badge.textContent = lastBuildFailed ? 'Last successful build' : 'Source changed';
  badge.hidden = !project?.pdf || !(lastBuildFailed || previewOutdated);
}
function showOutput(mode) {
  const raw = mode === 'raw';
  $('show-errors').setAttribute('aria-pressed', !raw);
  $('show-log').setAttribute('aria-pressed', raw);
  $('compile-errors').hidden = raw;
  $('log-content').hidden = !raw;
  $('copy-log').hidden = !raw;
}
function renderCompileLog(build) {
  diagnostics = build?.diagnostics ?? [];
  $('log-content').textContent = log || 'No compilation yet. Your compiler output will appear here.';
  $('log-engine').textContent = build?.engine || '';
  const list = $('compile-errors');
  list.replaceChildren();
  $('problem-count').textContent = diagnostics.length || '';
  $('problem-count').hidden = !diagnostics.length;
  const first = diagnostics[0];
  const summary = $('build-problem');
  summary.hidden = !lastBuildFailed;
  summary.textContent = first ? `${first.file}:${first.line} · ${first.message}` : 'Build failed · Open problems';
  summary.title = summary.textContent;
  summary.onclick = guard(() => {
    if (first) return jumpToSource(first.file, first.line);
    showOutput('errors'); setWorkspaceView('problems');
  });
  for (const issue of diagnostics) {
    const button = document.createElement('button');
    button.className = 'compile-error';
    const location = document.createElement('strong');
    location.textContent = issue.file + ':' + issue.line;
    button.append(location, document.createTextNode(' ' + issue.message));
    button.onclick = guard(() => jumpToSource(issue.file, issue.line));
    list.append(button);
  }
  if (!diagnostics.length) {
    const message = document.createElement('p');
    message.className = 'problems-empty';
    message.textContent = lastBuildFailed ? 'No source line was reported. Open Raw log for the compiler output.'
      : build ? 'No source errors in the last build.' : 'Compile the document to check for problems.';
    list.append(message);
  }
  refreshErrorMarkers();
}

function showCacheFailure(result) {
  const message = result.missingResource
    ? 'Missing from the cache or project: ' + result.missingResource + '.'
    : 'Compilation failed using cached packages only. Check the log for details.';
  setBanner(message, 'error');
  if (!result.missingResource) return;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry with downloads';
  retry.onclick = guard(() => compile(true));
  $('build-banner').append(document.createTextNode(' '), retry);
}

async function compile(allowDownloads = false) {
  if (compiling || !project) return;
  clearTimeout(autoTimer); await flushSaves();
  if (compiling) return;
  compiling = true; $('compile').disabled = true; $('empty-compile').disabled = true;
  $('compile').innerHTML = `<span class="spinning">${icon('refresh')}</span><span>Compiling…</span>`;
  $('build-status').textContent = 'Compiling on your computer…';
  const engine = project.engine === 'auto' ? engines.find(item => item.available)?.id : project.engine;
  const useCache = engine === 'tectonic' && project.cachedOnly && allowDownloads !== true;
  setBanner(useCache ? 'Compiling with cached packages only…' : 'Compiling your document…');
  const id = project.id, buildRevision = editRevision;
  try {
    const result = await api(base(id) + '/compile', {
      method: 'POST',
      body: { allowDownloads: allowDownloads === true, sourceRevision: project.sourceRevision ?? null }
    });
    log = result.log;
    lastBuildFailed = !result.ok;
    previewOutdated = editRevision !== buildRevision || !result.ok;
    renderCompileLog(result);
    $('build-status').textContent = `${result.ok ? 'Compiled' : 'Build failed'} in ${(result.duration / 1000).toFixed(1)}s`;
    project = await api(base(id));
    updateFreshness();
    if (result.ok) {
      $('download-pdf').disabled = false; await loadPDF();
      if (editRevision !== buildRevision) setBanner('Compiled successfully. You have changes since this build.', 'success'); else setBanner('');
    } else {
      if (result.cachedOnly) showCacheFailure(result);
      else if (result.timedOut) setBanner('Compilation reached its time limit. Open Problems for details.', 'error');
      else setBanner('');
      showOutput('errors');
    }
  } catch (e) { setBanner(e.message, 'error'); $('build-status').textContent = 'Could not compile'; }
  finally { compiling = false; $('compile').disabled = false; $('empty-compile').disabled = false; $('compile').innerHTML = icon('play') + '<span>Recompile</span><kbd>Ctrl ↵</kbd>'; if ($('auto-compile').checked && editRevision !== buildRevision) autoTimer = setTimeout(() => guard(compile)(), 2000); }
}
async function loadPDF() {
  clearForwardSync();
  setSourcePicker(false);
  const generation = ++renderGeneration;
  const jobId = project.pdf.jobId;
  if (pdfLoad) await pdfLoad.destroy(); pdfLoad = null; pdf = null;
  pdfLoad = getDocument({ url: '/api' + base() + '/pdf?build=' + encodeURIComponent(jobId), cMapUrl: '/cmaps/', cMapPacked: true, standardFontDataUrl: '/standard_fonts/', wasmUrl: '/wasm/' });
  const loaded = await pdfLoad.promise;
  if (generation !== renderGeneration) return;
  pdf = loaded; previewBuild = jobId; $('preview-empty').hidden = true; $('page-total').textContent = '/ ' + pdf.numPages; $('page-number').max = pdf.numPages;
  resetPDFSearch();
  await renderPDF();
  if ($('pdf-query').value) queuePDFSearch();
}
async function renderPDF() {
  if (!pdf) return;
  const generation = ++renderGeneration, documentPDF = pdf;
  const first = await documentPDF.getPage(1); if (generation !== renderGeneration) return;
  capturePDFPosition();
  const scroll = $('pdf-scroll');
  const width = scroll.clientWidth || Math.max(320, $('app').clientWidth / 2);
  const fitScale = Math.max(.2, (width - 50) / first.getViewport({ scale: 1 }).width);
  const scale = pdfScale = zoom === 'fit' ? Math.min(1.6, fitScale) : zoom;
  pageObserver?.disconnect(); $('pdf-pages').replaceChildren();
  $('zoom-fit').textContent = zoom === 'fit' ? 'Fit width' : Math.round(scale * 100) + '%';
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  pageObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      const box = entry.target; pageObserver?.unobserve(box); const number = Number(box.dataset.page);
      documentPDF.getPage(number).then(async page => {
        if (generation !== renderGeneration) return;
        const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas');
        const textLayer = document.createElement('div');
        textLayer.className = 'textLayer';
        textLayer.style.setProperty('--total-scale-factor', viewport.scale);
        if (project.pdf?.hasSync) box.title = 'Use Go to source or Alt + double-click to jump to source';
        canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio); canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px'; canvas.setAttribute('aria-label', 'PDF page ' + number);
        box.style.width = viewport.width + 'px'; box.style.height = viewport.height + 'px';
        box.prepend(canvas, textLayer);
        const rendered = { page, viewport, textDivs: [] };
        pageViewports.set(box, rendered);
        if (forwardSync?.page === number) paintSyncMarker(box, page, viewport, forwardSync);
        const textReady = readPDFText(documentPDF, number).then(async content => {
          if (!box.isConnected) return;
          const layer = new TextLayer({ textContentSource: content, container: textLayer, viewport });
          await layer.render();
          rendered.textDivs = layer.textDivs;
          highlightPDFPage(box);
          if (pendingMatchReveal === activeMatch) revealPDFMatch(box);
        }).catch(() => {}); // A page remains visible if its text cannot be extracted.
        await Promise.all([page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] }).promise, textReady]);
      }).catch(e => { if (generation === renderGeneration) toast('PDF rendering: ' + e.message, true); });
    }
  }, { root: $('pdf-scroll'), rootMargin: '500px' });
  const initial = first.getViewport({ scale });
  for (let n = 1; n <= documentPDF.numPages; n++) {
    const box = document.createElement('div'); box.className = 'pdf-page'; box.dataset.page = n; box.dataset.scale = scale; box.style.width = initial.width + 'px'; box.style.height = initial.height + 'px'; box.innerHTML = `<span class="page-caption">${n}</span>`; $('pdf-pages').append(box); pageObserver.observe(box);
  }
  restorePDFPosition();
}
let pdfPosition = { page: 1, fraction: 0, left: 0 }, pdfScale = 1;
function capturePDFPosition() {
  const scroll = $('pdf-scroll');
  const boxes = $('pdf-pages').children;
  if (!scroll.clientHeight || !boxes.length) return;
  const top = scroll.getBoundingClientRect().top;
  let low = 0, high = boxes.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (boxes[mid].getBoundingClientRect().bottom <= top + 1) low = mid + 1;
    else high = mid;
  }
  const bounds = boxes[low].getBoundingClientRect();
  pdfPosition = {
    page: low + 1,
    fraction: Math.min(1, Math.max(0, (top - bounds.top) / bounds.height)),
    left: scroll.scrollLeft
  };
  if (document.activeElement !== $('page-number')) $('page-number').value = pdfPosition.page;
}
function restorePDFPosition() {
  const scroll = $('pdf-scroll');
  const boxes = $('pdf-pages').children;
  if (!scroll.clientHeight || !boxes.length) return;
  const page = Math.min(pdfPosition.page, boxes.length);
  const bounds = boxes[page - 1].getBoundingClientRect();
  const inset = page === 1 && pdfPosition.fraction === 0 ? 0 : 1;
  scroll.scrollTop = inset ? scroll.scrollTop + bounds.top - scroll.getBoundingClientRect().top + bounds.height * pdfPosition.fraction : 0;
  scroll.scrollLeft = pdfPosition.left || 0;
  $('page-number').value = page;
}
function goPage(number) {
  if (!pdf) return;
  const page = Math.max(1, Math.min(pdf.numPages, Math.trunc(Number(number)) || 1));
  pdfPosition = { ...pdfPosition, page, fraction: 0 };
  restorePDFPosition();
}

let textCache = new Map(), pdfMatches = [], activeMatch = -1, pendingMatchReveal = -1, pdfSearchTicket = 0, pdfSearchTimer;
function readPDFText(documentPDF, number) {
  if (documentPDF !== pdf) return documentPDF.getPage(number).then(page => page.getTextContent());
  if (!textCache.has(number)) textCache.set(number, documentPDF.getPage(number).then(page => page.getTextContent()));
  return textCache.get(number);
}
function resetPDFSearch(clearQuery = false) {
  textCache = new Map();
  ++pdfSearchTicket;
  clearTimeout(pdfSearchTimer);
  pdfMatches = []; activeMatch = pendingMatchReveal = -1;
  $('pdf-query').disabled = !pdf;
  if (clearQuery) $('pdf-query').value = '';
  updatePDFSearchStatus('');
}
function updatePDFSearchStatus(message) {
  $('pdf-find-status').textContent = message;
  $('pdf-match-prev').disabled = $('pdf-match-next').disabled = !pdfMatches.length;
}
function highlightPDFPage(box) {
  const spans = pageViewports.get(box)?.textDivs;
  if (!spans?.length) return;
  box.querySelectorAll('.pdf-match, .pdf-match-current').forEach(span => span.classList.remove('pdf-match', 'pdf-match-current'));
  pdfMatches.forEach(({ page, first, last }, index) => {
    if (page !== Number(box.dataset.page)) return;
    for (let n = first; n <= last; n++) {
      spans[n]?.classList.add('pdf-match');
      if (activeMatch === index) spans[n]?.classList.add('pdf-match-current');
    }
  });
}
function selectPDFMatch(index) {
  if (!pdfMatches.length) return;
  activeMatch = (index + pdfMatches.length) % pdfMatches.length;
  pendingMatchReveal = activeMatch;
  const match = pdfMatches[activeMatch];
  goPage(match.page);
  for (const box of $('pdf-pages').children) highlightPDFPage(box);
  revealPDFMatch($('pdf-pages').children[match.page - 1]);
  updatePDFSearchStatus(`${activeMatch + 1} of ${pdfMatches.length}`);
}
function revealPDFMatch(box) {
  const match = pdfMatches[activeMatch];
  if (!box || match?.page !== Number(box.dataset.page)) return;
  const matchText = box.querySelector('.pdf-match-current');
  if (matchText) {
    pendingMatchReveal = -1;
    matchText.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
function queuePDFSearch() {
  clearTimeout(pdfSearchTimer);
  const ticket = ++pdfSearchTicket;
  const pdfDoc = pdf;
  const query = $('pdf-query').value.trim().toLowerCase().replace(/\s+/g, ' ');
  pdfMatches = []; activeMatch = pendingMatchReveal = -1;
  for (const box of $('pdf-pages').children) highlightPDFPage(box);
  updatePDFSearchStatus(query && pdfDoc ? 'Searching…' : '');
  if (!query || !pdfDoc) return;
  pdfSearchTimer = setTimeout(async () => {
    try {
      const found = [];
      for (let page = 1; page <= pdfDoc.numPages; page++) {
        const content = await readPDFText(pdfDoc, page);
        if (ticket !== pdfSearchTicket) return;
        let text = '';
        const ranges = [];
        content.items.forEach((item, run) => {
          const start = text.length;
          text += item.str.toLowerCase().replace(/\s+/g, ' ');
          ranges.push({ start, end: text.length, run });
          if (item.hasEOL && !text.endsWith(' ')) text += ' ';
        });
        let first = 0, last = 0;
        for (let index = text.indexOf(query); index !== -1; index = text.indexOf(query, index + query.length)) {
          while (first < ranges.length - 1 && ranges[first].end <= index) first++;
          last = Math.max(first, last);
          while (last < ranges.length - 1 && ranges[last + 1].start < index + query.length) last++;
          found.push({ page, first: ranges[first].run, last: ranges[last].run });
        }
      }
      if (ticket !== pdfSearchTicket) return;
      pdfMatches = found;
      for (const box of $('pdf-pages').children) highlightPDFPage(box);
      updatePDFSearchStatus(found.length ? `${found.length} found` : 'No matches');
    } catch {
      if (ticket === pdfSearchTicket) updatePDFSearchStatus('Search unavailable');
    }
  }, 180);
}

async function syncLocation(query) {
  if (!pdf || !project.pdf?.hasSync || !previewBuild) throw new Error('Recompile to enable source and PDF navigation.');
  const id = project.id;
  const build = previewBuild;
  const revision = editRevision;
  await flushSaves();
  const location = await api(base(id) + '/sync?' + new URLSearchParams({ ...query, build }));
  if (project.id !== id || previewBuild !== build || editRevision !== revision) {
    throw new Error('The source or PDF changed. Try the jump again.');
  }
  return location;
}

async function jumpToPDF() {
  if (!view || !currentFile) throw new Error('Open a source file first.');
  const file = currentFile;
  const line = view.state.doc.lineAt(view.state.selection.main.head).number;
  const documentPDF = pdf;
  const location = await syncLocation({ file, line });
  const page = await documentPDF.getPage(location.page);
  if (documentPDF !== pdf || currentFile !== file) return;
  showPDF();
  setSourcePicker(false);
  clearForwardSync();
  forwardSync = location;
  goPage(location.page);
  const box = $('pdf-pages').children[location.page - 1];
  if (box) {
    const viewport = pageViewports.get(box)?.viewport ?? page.getViewport({ scale: Number(box.dataset.scale) });
    const marker = paintSyncMarker(box, page, viewport, location);
    marker.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    capturePDFPosition();
  }
  forwardSyncTimer = setTimeout(clearForwardSync, 3500);
}

function clearForwardSync() {
  clearTimeout(forwardSyncTimer);
  forwardSync = null;
  $('pdf-pages').querySelector('.sync-marker')?.remove();
}

function paintSyncMarker(box, page, viewport, location) {
  const [left, , , top] = page.view;
  const [x1, y1] = viewport.convertToViewportPoint(left + location.x, top - location.y);
  const [x2, y2] = viewport.convertToViewportPoint(left + location.right, top - location.bottom);
  const existing = box.querySelector('.sync-marker');
  const marker = existing ?? document.createElement('span');
  marker.className = 'sync-marker';
  marker.setAttribute('aria-hidden', 'true');
  marker.style.left = Math.min(x1, x2) + 'px';
  marker.style.top = Math.min(y1, y2) + 'px';
  marker.style.width = Math.max(16, Math.abs(x2 - x1)) + 'px';
  marker.style.height = Math.max(12, Math.abs(y2 - y1)) + 'px';
  if (!existing) box.append(marker);
  return marker;
}

function setSourcePicker(active) {
  pickingSource = active;
  $('sync-source').setAttribute('aria-pressed', active);
  $('sync-source-hint').hidden = !active;
  $('pdf-scroll').classList.toggle('sync-picking', active);
}

async function jumpFromPDF(event) {
  const shortcut = event.type === 'dblclick' && event.altKey;
  const pick = event.type === 'click' && pickingSource;
  if (!shortcut && !pick) return;
  const box = event.target.closest('.pdf-page');
  if (!box || !pdf) return;
  event.preventDefault();
  setSourcePicker(false);
  const documentPDF = pdf;
  const number = Number(box.dataset.page);
  const bounds = box.getBoundingClientRect();
  const rendered = pageViewports.get(box);
  const page = rendered?.page ?? await documentPDF.getPage(number);
  if (documentPDF !== pdf) return;
  const viewport = rendered?.viewport ?? page.getViewport({ scale: Number(box.dataset.scale) });
  const [x, y] = viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
  const [left, , , top] = page.view;
  const location = await syncLocation({ page: number, x: x - left, y: top - y });
  await jumpToSource(location.file, location.line);
}
$('pdf-scroll').addEventListener('scroll', capturePDFPosition, { passive: true });
$('page-number').addEventListener('blur', () => { $('page-number').value = pdfPosition.page; });
function modal(title, body) { $('modal-content').innerHTML = `<div class="modal-header"><h2>${title}</h2><button class="icon-button" id="modal-close" aria-label="Close dialog">${icon('x')}</button></div><div class="modal-body">${body}</div>`; $('modal-close').onclick = () => $('modal').close(); if (!$('modal').open) $('modal').showModal(); }
$('modal').addEventListener('click', e => { if (e.target === $('modal')) { const r = $('modal').getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $('modal').close(); } });
function showQuickFile() {
  if (!project || $('modal').open) return;
  modal('Open file', '<label class="field">File name<input id="quick-query" type="search" autocomplete="off" /></label><div id="quick-results" class="quick-results" aria-label="Matching files"></div>');
  const input = $('quick-query'), list = $('quick-results');
  let selected = 0, buttons = [];
  const choose = guard(async name => { $('modal').close(); await openFile(name); });
  function select(index) {
    buttons[selected]?.classList.remove('active');
    selected = index;
    buttons[selected]?.classList.add('active');
    buttons[selected]?.scrollIntoView({ block: 'nearest' });
  }
  function render() {
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    buttons = project.files.filter(file => file.name.toLowerCase().includes(query)).map(file => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = file.name;
      button.onclick = () => choose(file.name);
      list.append(button);
      return button;
    });
    if (!buttons.length) list.textContent = 'No matching files.';
    select(0);
  }
  input.oninput = render;
  input.onkeydown = event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (buttons.length) select((selected + buttons.length + (event.key === 'ArrowDown' ? 1 : -1)) % buttons.length);
    } else if (event.key === 'Enter' && buttons[selected]) {
      event.preventDefault();
      buttons[selected].click();
    }
  };
  render(); input.focus();
}
function askName({ title, label, value = '', hint = '', action, submit = 'Create' }) {
  modal(title, `<form id="name-form"><label class="field">${label}<input id="name-input" value="${escapeHTML(value)}" required maxlength="240" autocomplete="off" />${hint ? `<small>${hint}</small>` : ''}</label><p id="form-error" class="modal-error"></p><div class="modal-footer"><button type="button" id="cancel-name" class="button secondary">Cancel</button><button class="button primary" id="submit-name">${submit}</button></div></form>`);
  $('cancel-name').onclick = () => $('modal').close(); $('name-input').select();
  $('name-form').onsubmit = async e => { e.preventDefault(); $('submit-name').disabled = true; try { await action($('name-input').value.trim()); $('modal').close(); } catch (error) { $('form-error').textContent = error.message; } finally { if ($('submit-name')) $('submit-name').disabled = false; } };
}
function confirmAction(title, message, action, label = 'Delete') {
  modal(title, `<p class="modal-description">${escapeHTML(message)}</p><p id="confirm-error" class="modal-error"></p><div class="modal-footer"><button id="cancel-action" class="button secondary">Cancel</button><button id="confirm-action" class="button danger">${label}</button></div>`);
  $('cancel-action').onclick = () => $('modal').close(); $('confirm-action').onclick = async () => { $('confirm-action').disabled = true; try { await action(); $('modal').close(); } catch (e) { $('confirm-error').textContent = e.message; $('confirm-action').disabled = false; } };
}
async function showProjects() {
  if (compiling) throw new Error('Wait for compilation to finish before switching projects.');
  projects = await api('/projects');
  modal('Your workspace', '<p class="modal-description">A home for every paper, problem set, and passing idea.</p><div id="project-list" class="project-list"></div><div class="project-choices"><button id="create-project" class="button primary">' + icon('plus') + 'New project</button><button id="import-folder" class="button secondary">' + icon('folder') + 'Import folder</button><button id="import-zip" class="button secondary">' + icon('zip') + 'Import ZIP</button></div>');
  for (const p of projects) {
    const card = document.createElement('div'); card.className = 'project-card' + (p.id === project?.id ? ' current' : '');
    card.innerHTML = `<span data-icon="file-text">${icon('file-text')}</span><button class="project-card-info"><h3>${escapeHTML(p.name)}</h3><p>${p.id === project?.id ? 'Current project · ' : ''}Edited ${new Date(p.updatedAt).toLocaleDateString()}</p></button><button class="icon-button small project-delete" aria-label="Delete ${escapeHTML(p.name)}">${icon('trash')}</button>`;
    card.querySelector('.project-card-info').onclick = guard(async () => { await loadProject(p.id); $('modal').close(); });
    card.querySelector('.project-delete').onclick = () => confirmAction('Delete project?', `This permanently removes “${p.name}” and its files from this workspace. Export a source ZIP first if you need a copy.`, async () => { if (p.id === project?.id) await flushSaves(); await api(base(p.id), { method: 'DELETE' }); if (p.id === project?.id) { pending.clear(); const remaining = await api('/projects'); const next = remaining[0] || await api('/projects', { method: 'POST', body: { name: 'My first document' } }); await loadProject(next.id); } toast('Project deleted'); });
    $('project-list').append(card);
  }
  $('create-project').onclick = () => askName({ title: 'A new beginning', label: 'Project name', value: 'Untitled project', action: async name => { const p = await api('/projects', { method: 'POST', body: { name } }); await loadProject(p.id); } });
  $('import-folder').onclick = () => $('folder-input').click(); $('import-zip').onclick = () => $('zip-input').click();
}
async function refreshEngines(refresh = false) {
  engines = await api('/engines' + (refresh ? '?refresh=1' : ''));
  const available = engines.filter(e => e.available);
  $('engine-status').textContent = available.length ? (project?.engine && project.engine !== 'auto' ? project.engine : available[0].id) + ' connected' : 'Compiler setup needed'; return engines;
}
async function showSettings() {
  await refreshEngines();
  modal('Project settings', `<form id="settings-form"><label class="field">Project name<input id="setting-name" required maxlength="100" value="${escapeHTML(project.name)}" /></label><label class="field">Main document<select id="setting-main">${project.files.filter(f => f.name.endsWith('.tex')).map(f => `<option value="${escapeHTML(f.name)}" ${f.name === project.mainFile ? 'selected' : ''}>${escapeHTML(f.name)}</option>`).join('')}</select><small>Choose the file containing \\documentclass and \\begin{document}.</small></label><label class="field">LaTeX compiler<select id="setting-engine"><option value="auto">Auto · first available compiler</option>${engines.map(e => `<option value="${e.id}" ${e.id === project.engine ? 'selected' : ''}>${e.id}${e.available ? '' : ' · not installed'}</option>`).join('')}</select></label><div id="compiler-list">${engines.map(e => `<div class="compiler-row"><span class="status-dot ${e.available ? '' : 'missing'}"></span><span>${e.id}</span><code title="${escapeHTML(e.version || '')}">${escapeHTML(e.version || 'Not found')}</code></div>`).join('')}</div><button type="button" id="refresh-engines" class="text-button">${icon('refresh')}Refresh compilers</button><div class="modal-divider"></div><div class="setup-note">Need a compiler? Install TeX Live or put Tectonic on your PATH. On Windows, you can also use MiKTeX or install portable Tectonic on x64:<code>npm run setup:compiler</code>Tectonic downloads missing packages on the first build that needs them.</div><p id="settings-error" class="modal-error"></p><div class="modal-footer"><button type="button" id="cancel-settings" class="button secondary">Cancel</button><button id="save-settings" class="button primary">Save settings</button></div></form>`);
  $('compiler-list').insertAdjacentHTML('beforebegin',
    '<label class="cache-setting"><input type="checkbox" id="setting-cached" /> Use cached packages only (Tectonic)</label>');
  const cache = $('setting-cached');
  cache.checked = project.cachedOnly === true;
  const updateCacheAvailability = () => {
    const selected = $('setting-engine').value;
    cache.disabled = (selected === 'auto' ? engines.find(engine => engine.available)?.id : selected) !== 'tectonic';
  };
  $('setting-engine').onchange = updateCacheAvailability;
  updateCacheAvailability();
  $('cancel-settings').onclick = () => $('modal').close();
  $('refresh-engines').onclick = guard(async () => { await refreshEngines(true); await showSettings(); toast('Compiler list refreshed'); });
  $('settings-form').onsubmit = async event => {
    event.preventDefault();
    try {
      await flushSaves();
      const body = { name: $('setting-name').value, engine: $('setting-engine').value, cachedOnly: cache.checked };
      if ($('setting-main').value) body.mainFile = $('setting-main').value;
      project = await api(base(), { method: 'PATCH', body });
      $('project-name').textContent = project.name;
      document.title = project.name + ' — mini_LaTeX_Editor';
      await refreshEngines();
      renderFiles();
      $('modal').close();
      toast('Project settings saved');
    } catch (error) { $('settings-error').textContent = error.message; }
  };
}

async function showHistory() {
  if (compiling) throw new Error('Wait for compilation to finish before opening history.');
  await flushSaves();
  const route = base() + '/history';
  const checkpoints = await api(route);
  modal('Version history', '<div id="checkpoints" class="project-list"></div>');
  const list = $('checkpoints');
  if (!checkpoints.length) list.textContent = 'A checkpoint is saved after each successful compile.';
  for (const entry of checkpoints) {
    const card = document.createElement('div');
    card.className = 'checkpoint-row';
    const info = document.createElement('div');
    const date = document.createElement('strong');
    date.textContent = new Date(entry.createdAt).toLocaleString();
    const detail = document.createElement('small');
    detail.textContent = entry.kind === 'before-restore' ? 'Before restore' : 'Successful compile · ' + entry.engine;
    info.append(date, detail);
    const compare = document.createElement('button');
    compare.className = 'button secondary';
    compare.textContent = 'Compare';
    compare.onclick = guard(() => compareCheckpoint(route + '/' + entry.id));
    const restore = document.createElement('button');
    restore.className = 'button secondary';
    restore.textContent = 'Restore';
    restore.onclick = () => confirmAction('Restore checkpoint?',
      'Restore the project files and main document from this checkpoint? The current files will be saved as a recovery checkpoint.',
      async () => {
        if (compiling) throw new Error('Wait for compilation to finish before restoring.');
        const id = project.id;
        clearTimeout(autoTimer);
        await flushSaves();
        await api(route + '/' + entry.id + '/restore', { method: 'POST', body: { sourceRevision: project.sourceRevision } });
        await loadProject(id);
        toast('Checkpoint restored. Recompile to update the PDF.');
      }, 'Restore checkpoint');
    card.append(info, compare, restore);
    list.append(card);
  }
}

async function compareCheckpoint(route) {
  await flushSaves();
  const changes = await api(route + '/compare');
  modal('Compare checkpoint', '<button type="button" class="text-button" id="back-to-history">Back to history</button><div id="changed-files" class="checkpoint-changes"></div><div id="checkpoint-content"></div>');
  $('back-to-history').onclick = guard(showHistory);
  const files = $('changed-files');
  if (!changes.length) files.textContent = 'Project files match this checkpoint.';
  let request = 0;
  const content = $('checkpoint-content');
  async function compareFile(name) {
    const currentRequest = ++request;
    const file = await api(route + '/file?name=' + encodeURIComponent(name));
    if (currentRequest !== request || !content.isConnected) return;
    content.className = 'checkpoint-comparison';
    content.replaceChildren();
    for (const [label, text] of [['Checkpoint', file.saved], ['Current', file.current]]) {
      const pane = document.createElement('section');
      const heading = document.createElement('strong');
      heading.textContent = label + ' · ' + name;
      const source = document.createElement('pre');
      source.textContent = text ?? '(File absent)';
      pane.append(heading, source);
      content.append(pane);
    }
  }
  for (const change of changes) {
    const row = document.createElement(change.editable ? 'button' : 'div');
    row.className = 'checkpoint-change';
    row.textContent = change.status + ' · ' + change.name;
    if (change.editable) row.onclick = guard(() => compareFile(change.name));
    files.append(row);
  }
  const firstText = changes.find(change => change.editable);
  if (firstText) await compareFile(firstText.name);
}
async function uploadEntries(entries, intoNewProject, name) {
  if (compiling) throw new Error('Wait for compilation to finish before importing files.');
  await flushSaves();
  if (entries.length > 500) throw new Error('Import up to 500 files at a time.');
  const files = entries.filter(e => !e.name.split('/').some(part => part.startsWith('.')) && !/\.(aux|log|synctex\.gz|toc|out|fls|fdb_latexmk)$/i.test(e.name));
  if (!files.length) throw new Error('No source files found.');
  if (files.some(e => e.data.length > 15 * 1024 * 1024)) throw new Error('Each file must be smaller than 15 MB.');
  if (files.reduce((n, e) => n + e.data.length, 0) > 100 * 1024 * 1024) throw new Error('Projects must be smaller than 100 MB.');
  let target = project;
  if (intoNewProject) target = await api('/projects', { method: 'POST', body: { name, empty: true } });
  let uploaded = 0;
  try {
    for (const entry of files) {
      let binary = ''; for (let i = 0; i < entry.data.length; i += 8192) binary += String.fromCharCode(...entry.data.subarray(i, i + 8192));
      await api(base(target.id) + '/file', { method: 'PUT', body: { name: entry.name, content: btoa(binary), encoding: 'base64', createOnly: true, sourceRevision: target.sourceRevision } }); uploaded++;
    }
    if (intoNewProject) {
      const decoder = new TextDecoder(); const main = files.find(f => f.name === 'main.tex') || files.find(f => f.name.endsWith('.tex') && /\\documentclass/.test(decoder.decode(f.data))) || files.find(f => f.name.endsWith('.tex'));
      if (main) await api(base(target.id), { method: 'PATCH', body: { mainFile: main.name } });
      await loadProject(target.id);
    } else { await refreshProject(); for (const f of files) states.delete(f.name); if (!currentFile) await openFile(files[0].name); }
    $('modal').close(); toast(`Imported ${uploaded} file${uploaded === 1 ? '' : 's'}`);
  } catch (error) { if (intoNewProject) await loadProject(target.id); else await refreshProject(); throw new Error(`${uploaded} file(s) imported. ${error.message}`); }
}
$('file-input').onchange = guard(async e => { const entries = []; for (const file of e.target.files) entries.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }); e.target.value = ''; await uploadEntries(entries, false); });
$('folder-input').onchange = guard(async e => { const list = [...e.target.files], name = list[0]?.webkitRelativePath.split('/')[0] || 'Imported project', entries = []; for (const file of list) entries.push({ name: file.webkitRelativePath.split('/').slice(1).join('/'), data: new Uint8Array(await file.arrayBuffer()) }); e.target.value = ''; await uploadEntries(entries, true, name); });
$('zip-input').onchange = guard(async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (file.size > 100 * 1024 * 1024) throw new Error('ZIP files must be smaller than 100 MB.');
  let totalSize = 0, totalFiles = 0;
  const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: entry => { totalSize += entry.originalSize; totalFiles++; if (entry.originalSize > 15 * 1024 * 1024 || totalSize > 100 * 1024 * 1024 || totalFiles > 500) throw new Error('Archive exceeds project size or file count limits.'); return !entry.name.endsWith('/'); } });
  let entries = Object.entries(unzipped).map(([name, data]) => ({ name, data }));
  const prefix = entries[0]?.name.split('/')[0] + '/'; if (entries.length && entries.every(e => e.name.startsWith(prefix))) entries = entries.map(e => ({ ...e, name: e.name.slice(prefix.length) }));
  await uploadEntries(entries, true, file.name.replace(/\.zip$/i, ''));
});
$('new-file').onclick = () => askName({ title: 'Add a file', label: 'File name', value: 'section.tex', hint: 'Use a path like chapters/introduction.tex to add a subfolder.', action: async name => { await api(base() + '/file', { method: 'PUT', body: { name, content: '', createOnly: true, sourceRevision: project.sourceRevision } }); await refreshProject(); await openFile(name); } });
$('rename-file').onclick = () => { if (!currentFile) return; const from = currentFile; askName({ title: 'Rename file', label: 'File name', value: from, submit: 'Rename', action: async to => { await flushSaves(); if (view) states.set(from, view.state); project = await api(base() + '/rename-file', { method: 'POST', body: { from, to } }); const old = states.get(from); if (old) states.set(to, old); states.delete(from); openFiles = openFiles.map(n => n === from ? to : n); currentFile = null; await openFile(to); } }); };
$('delete-file').onclick = () => { if (!currentFile) return; const name = currentFile; confirmAction('Delete file?', `Permanently delete “${name}” from this project?`, async () => { await flushSaves(); await api(base() + '/file?name=' + encodeURIComponent(name), { method: 'DELETE' }); openFiles = openFiles.filter(n => n !== name); states.delete(name); currentFile = null; view?.destroy(); view = null; $('editor').replaceChildren(); $('asset-view').hidden = true; await refreshProject(); if (project.files.length) await openFile(project.files[0].name); else { renderTabs(); renderOutline(); } toast('File deleted'); }); };
$('upload-files').onclick = () => $('file-input').click();
$('compile').onclick = guard(compile); $('empty-compile').onclick = guard(compile);
$('history').onclick = guard(showHistory);
$('sync-pdf').onclick = guard(jumpToPDF);
$('sync-source').onclick = guard(() => {
  if (!pdf || !project.pdf?.hasSync) throw new Error('Recompile to enable source and PDF navigation.');
  setSourcePicker(!pickingSource);
});
$('pdf-pages').addEventListener('click', guard(jumpFromPDF));
$('pdf-pages').addEventListener('dblclick', guard(jumpFromPDF));
$('auto-compile').onchange = e => { localStorage.setItem('texdesk.auto', e.target.checked); if (e.target.checked && pending.size) guard(compile)(); };
$('settings').onclick = guard(showSettings); $('project-switch').onclick = guard(showProjects);
$('quick-file').onclick = showQuickFile;
$('project-menu').addEventListener('click', event => {
  if (event.target.closest('.project-menu-items button')) {
    $('project-menu').open = false;
    $('project-menu').querySelector('summary').focus();
  }
});
document.addEventListener('click', event => {
  if (!$('project-menu').contains(event.target)) $('project-menu').open = false;
});
$('project-menu').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    $('project-menu').open = false;
    $('project-menu').querySelector('summary').focus();
  }
});
$('export-source').onclick = guard(async () => { await flushSaves(); window.location.href = '/api' + base() + '/source'; });
$('download-pdf').onclick = () => { if (project.pdf) window.location.href = '/api' + base() + '/pdf?download=1'; };
function showSidebar(show) {
  $('app').classList.toggle('sidebar-hidden', narrow.matches ? show : !show);
  $('toggle-sidebar').setAttribute('aria-expanded', show);
}
$('toggle-sidebar').onclick = () => showSidebar($('toggle-sidebar').getAttribute('aria-expanded') !== 'true');
$('toggle-sidebar').setAttribute('aria-controls', 'sidebar');
narrow.addEventListener('change', () => {
  showSidebar(!narrow.matches);
  setWorkspaceView(workspaceView);
});
for (const button of document.querySelectorAll('.view-switch button')) {
  button.onclick = () => setWorkspaceView(button.dataset.workspaceView);
}
$('find').onclick = () => { if (view) { openSearchPanel(view); view.focus(); } };
$('editor-wrap').onclick = () => { wrapping = !wrapping; $('editor-wrap').classList.toggle('active', wrapping); if (view) view.dispatch({ effects: wrap.reconfigure(wrapping ? EditorView.lineWrapping : []) }); for (const [name, state] of states) states.set(name, state.update({ effects: wrap.reconfigure(wrapping ? EditorView.lineWrapping : []) }).state); };
$('show-errors').onclick = () => showOutput('errors');
$('show-log').onclick = () => showOutput('raw');
$('copy-log').onclick = guard(async () => { await navigator.clipboard.writeText(log); toast('Compilation log copied'); });
$('prev-page').onclick = () => goPage(pdfPosition.page - 1); $('next-page').onclick = () => goPage(pdfPosition.page + 1); $('page-number').onchange = e => goPage(e.target.value);
$('zoom-in').onclick = guard(async () => { zoom = Math.min(2, pdfScale + .15); await renderPDF(); });
$('zoom-out').onclick = guard(async () => { zoom = Math.max(.2, pdfScale - .15); await renderPDF(); });
$('zoom-fit').onclick = guard(async () => { zoom = 'fit'; await renderPDF(); });
$('pdf-query').oninput = queuePDFSearch;
$('pdf-find').onsubmit = event => { event.preventDefault(); selectPDFMatch(activeMatch + 1); };
$('pdf-match-prev').onclick = () => selectPDFMatch(activeMatch < 0 ? pdfMatches.length - 1 : activeMatch - 1);
$('help').onclick = () => modal('Keyboard shortcuts', `${[['Compile document','Ctrl / ⌘ + Enter'],['Save all open files','Ctrl / ⌘ + S'],['Open file by name','Ctrl / ⌘ + P'],['Find and replace in source','Ctrl / ⌘ + F'],['Jump from PDF to source','Alt + double-click'],['Undo / redo','Ctrl / ⌘ + Z / Y'],['Comment selection','Ctrl / ⌘ + /'],['Show suggestions','Ctrl + Space'],['Indent selection','Tab']].map(([a,b]) => `<div class="shortcut-row"><span>${a}</span><kbd>${b}</kbd></div>`).join('')}`);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && pickingSource) {
    setSourcePicker(false);
    $('sync-source').focus();
  }
  if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'p' && !event.shiftKey && !event.altKey && project && !$('modal').open) {
    event.preventDefault(); showQuickFile();
  } else if (key === 'enter') {
    event.preventDefault(); guard(compile)();
  } else if (key === 's') {
    event.preventDefault(); guard(flushSaves)();
  }
});
window.addEventListener('pagehide', saveWorkspace);
window.addEventListener('beforeunload', event => { saveWorkspace(); if (pending.size) { event.preventDefault(); event.returnValue = ''; } });
let resizeTimer, previewWidth;
new ResizeObserver(() => {
  const width = $('pdf-scroll').clientWidth;
  if (width === previewWidth) return;
  previewWidth = width;
  clearTimeout(resizeTimer);
  if (width && pdf && zoom === 'fit') resizeTimer = setTimeout(() => renderPDF().catch(() => {}), 150);
}).observe($('pdf-scroll'));

const splitter = $('resize-handle');
function applySplit() {
  const ratio = Math.max(.30, Math.min(.70, workspace.split || .5));
  $('editor-pane').style.setProperty('--split-width', `calc((100% - var(--visible-sidebar) - 8px) * ${ratio})`);
  splitter.setAttribute('aria-valuenow', Math.round(ratio * 100));
}
function updateSplit(width, total) {
  if (!total) return;
  const lower = Math.min(.5, Math.max(.30, 220 / total));
  const upper = Math.max(lower, Math.min(.70, 1 - 290 / total));
  workspace.split = Math.max(lower, Math.min(upper, width / total));
  applySplit();
}
splitter.onpointerdown = event => {
  if (event.button !== 0) return;
  event.preventDefault();
  splitter.focus();
  splitter.setPointerCapture(event.pointerId);
  const start = event.clientX;
  const width = $('editor-pane').getBoundingClientRect().width;
  const total = width + $('preview-pane').getBoundingClientRect().width;
  splitter.onpointermove = move => updateSplit(width + move.clientX - start, total);
  splitter.onlostpointercapture = () => { splitter.onpointermove = null; saveWorkspace(); };
};
splitter.onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const width = $('editor-pane').getBoundingClientRect().width;
  const total = width + $('preview-pane').getBoundingClientRect().width;
  const target = { ArrowLeft: width - 25, ArrowRight: width + 25, Home: 0, End: total }[event.key];
  updateSplit(target, total);
  saveWorkspace();
};
showSidebar(!narrow.matches);
setWorkspaceView('split');
async function init() {
  try {
    await refreshEngines(); projects = await api('/projects'); const stored = localStorage.getItem('texdesk.project');
    const selected = projects.find(p => p.id === stored) || projects[0] || await api('/projects', { method: 'POST', body: { name: 'My first document' } });
    await loadProject(selected.id); await refreshEngines();
    if (!engines.some(e => e.available)) setBanner('Add a local compiler to bring your document to life. Open Project settings to get started.');
  } catch (e) { setBanner(e.message, 'error'); toast(e.message, true); }
}
init();


