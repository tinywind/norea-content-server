export {};

type View = 'Overview' | 'Plugins' | 'Storage' | 'Content' | 'Jobs' | 'Devices' | 'Settings';
type Child = Node | string | number | null | undefined;
interface Device { id: string; deviceName: string; createdAt: number | string; lastSeenAt: number | string | null; blocked: boolean }
interface Plugin { id: string; name: string; url: string; enabled: boolean; updatedAt: number | string; sources: { id: string; name: string; version: string; installMode?: string }[] }
interface StorageSettings { path: string; mode: 'manual' | 'periodic' | 'changes'; intervalMinutes: number; enabled: boolean; lastScanAt?: number | string | null }
interface Job { id: string; rootId: string; rootName: string; status: string; startedAt: number | string; finishedAt?: number | string; error?: string; summary?: { registered: number; unchanged: number; skipped: number; failed: number; removed: number; scanned: number; cancelled: boolean } }
interface JobItem { path: string; sourceId?: string; status: string; reason?: string; chapterId?: string; workId?: string; revision?: string }
interface Entry { id: string; revision: string; fileBytes: number; deleted: boolean; sequence: number; manifest: { layout: 'chapter-files'; identity: { pluginId: string; novelPath: string; chapterPath: string }; novel: { name: string; author?: string | null; summary?: string | null }; chapter: { name: string; position: number; contentType: string }; files: { path: string; size: number; modifiedAt: number }[] } }
interface NovelMetadata {
  schemaVersion: 1;
  identity: { pluginId: string; novelPath: string };
  novel: { name: string; author: string | null; artist: string | null; summary: string | null; status: string | null; rating: number | null; genres: string | null; isLocal: boolean };
  cover: { fileName: string; contentType: string | null } | null;
  chapters: Record<string, string>;
}
interface WorkChapter { chapterNumber: string | null; name: string; position: number; entry: Pick<Entry, 'id' | 'fileBytes'> | null }
interface Work { id: string; sequence: number; metadata: Omit<NovelMetadata, 'chapters'> & { chapters?: NovelMetadata['chapters'] }; hasCover: boolean; chapterCount?: number; downloadedChapters?: number }
interface WorkView { search: string; offset: number; layout: 'grid' | 'list' }
interface Settings { anonymousRead: boolean; limits: { zipBytes: number; expandedBytes: number; files: number }; dataDir: string }
interface Overview { works: number; chapters: number; storedChapters: number; storedBytes: number; deletedChapters: number; plugins: number; contentsPath: string; runningJobs: number }

const app = document.querySelector<HTMLDivElement>('#app')!;
const sessionKey = 'norea-console-session';
let token = sessionStorage.getItem(sessionKey) ?? '';
let view: View = 'Overview';
let generation = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let page: HTMLElement;
let flash: HTMLElement;
let heading: HTMLElement;
let subtitle: HTMLElement;
let nav: HTMLElement;
const coverUrls = new Set<string>();
const coverRequests = new Set<AbortController>();
const apiRoot = '/api/v1';
const descriptions: Record<View, string> = {
  Overview: 'Content, storage, and ingestion at a glance.',
  Plugins: 'Register repositories and inspect the source identities they provide.',
  Storage: 'Inspect the content directory and scan for new or changed files.',
  Content: 'Browse works and metadata, inspect chapters, and delete server copies.',
  Jobs: 'Follow scans and inspect the outcome of every discovered file.',
  Devices: 'Inspect registered devices and block or restore their access.',
  Settings: 'Control anonymous reading and inspect server configuration.',
};
const iconPaths: Record<View, string> = {
  Overview: 'M3 3h6v6H3zM13 3h6v6h-6zM3 13h6v6H3zM13 13h6v6h-6z',
  Plugins: 'M8 3v4M14 3v4M5 7h12v4a6 6 0 0 1-12 0zM11 17v4',
  Storage: 'M2 6h7l2 2h9v11H2zM2 6V4h7l2 2',
  Content: 'M4 3h6a2 2 0 0 1 2 2v15a3 3 0 0 0-3-2H4zM12 5a2 2 0 0 1 2-2h6v15h-5a3 3 0 0 0-3 2',
  Jobs: 'M4 5h10M4 11h8M4 17h6M15 13l5 3-5 3z',
  Devices: 'M6 2h10v18H6zM9 17h4',
  Settings: 'M3 6h16M3 16h16M7 3v6M15 13v6',
};

function setToken(value: string) {
  token = value;
  if (value) sessionStorage.setItem(sessionKey, value); else sessionStorage.removeItem(sessionKey);
}
function routeView(): View {
  const name = location.pathname.replace(/\/$/, '').split('/').at(-1);
  return (Object.keys(descriptions) as View[]).find(item => item.toLowerCase() === name) ?? 'Overview';
}
function queryOffset(key = 'offset') {
  const value = Number(new URLSearchParams(location.search).get(key));
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function updateQuery(values: Record<string, string | number | null>, push = false) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === '' || value === 0) url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  if (url.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const child of children) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child));
  return node;
}
function icon(name: View) {
  const wrapper = el('span', 'nav-icon');
  wrapper.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 22 22');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', iconPaths[name]);
  svg.append(path); wrapper.append(svg); return wrapper;
}
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** index).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}
function date(value?: number | string | null) { return value ? new Date(value).toLocaleString() : 'Never'; }
function badge(value: string) { return el('span', `badge ${value.replace(/[^a-z-]/g, '')}`, value); }
function message(error: unknown) { return error instanceof Error ? error.message : 'The request could not be completed.'; }
function showError(target: HTMLElement, error: unknown) { target.replaceChildren(el('div', 'notice error', message(error))); }
function notify(text: string) { flash.replaceChildren(el('div', 'notice', text)); }
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const requestToken = token;
  const response = await fetch(`${apiRoot}${path}`, {
    method, headers: { ...(requestToken ? { Authorization: `Bearer ${requestToken}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store',
  });
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (requestToken !== token) throw new Error('The session changed while this request was in progress.');
  if (!response.ok) {
    if (response.status === 401 && token) { setToken(''); login('Your session expired. Sign in again.'); }
    throw new Error(data?.message || data?.error || `Request failed (${response.status}).`);
  }
  return data as T;
}
function action(label: string, callback: () => void | Promise<void>, className = '', errors?: HTMLElement) {
  const button = el('button', `button ${className}`, label); button.type = 'button';
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    const errorTarget = errors ?? flash;
    button.disabled = true;
    try { await callback(); } catch (error) { if (errorTarget.isConnected) showError(errorTarget, error); } finally { button.disabled = false; }
  });
  return button;
}
function input(name: string, type = 'text', value = '', required = true) {
  const field = el('input'); field.name = name; field.type = type; field.value = value; field.required = required; return field;
}
function select(name: string, options: string[], value?: string) {
  const field = el('select'); field.name = name;
  for (const option of options) { const item = el('option', '', option); item.value = option; field.append(item); }
  if (value) field.value = value; return field;
}
function field(label: string, control: HTMLElement, hint?: string, full = false) {
  return el('label', `field${full ? ' full' : ''}`, el('span', '', label), control, hint ? el('span', 'hint', hint) : null);
}
function submit(form: HTMLFormElement, label: string, callback: () => Promise<void>, errors: HTMLElement) {
  const button = el('button', 'button primary', label); button.type = 'submit';
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (button.disabled) return; button.disabled = true; errors.replaceChildren();
    try { await callback(); } catch (error) { showError(errors, error); } finally { button.disabled = false; }
  });
  return button;
}
function panel(title: string, hint?: string) {
  const body = el('div', 'panel-body');
  const node = el('section', 'panel', el('div', 'panel-head', el('div', '', el('h2', '', title), hint ? el('p', 'hint', hint) : null)), body);
  return { node, body };
}
function table(headers: string[], rows: Child[][], emptyText: string) {
  if (!rows.length) return el('div', 'empty', emptyText);
  const node = el('table');
  node.append(el('thead', '', el('tr', '', ...headers.map(header => { const cell = el('th', '', header); cell.scope = 'col'; return cell; }))));
  node.append(el('tbody', '', ...rows.map(row => el('tr', '', ...row.map(cell => el('td', '', cell))))));
  return el('div', 'table-wrap', node);
}
function details(values: [string, Child][]) {
  return el('dl', 'detail-list', ...values.flatMap(([name, value]) => [el('dt', '', name), el('dd', '', value)]));
}
function dialog(title: string) {
  const node = el('dialog', 'dialog'); const body = el('div', 'dialog-body');
  node.setAttribute('aria-label', title);
  const close = action('Close', () => node.close(), 'small');
  node.append(el('div', 'dialog-head', el('h2', '', title), close), body);
  node.addEventListener('close', () => node.remove()); document.body.append(node); node.showModal();
  return { node, body };
}
function pagination(total: number, offset: number, limit: number, change: (offset: number) => Promise<void>) {
  const previous = action('Previous', () => change(Math.max(0, offset - limit)), 'small'); previous.disabled = offset === 0;
  const next = action('Next', () => change(offset + limit), 'small'); next.disabled = offset + limit >= total;
  return el('div', 'pagination', el('span', '', total ? `${offset + 1}–${Math.min(offset + limit, total)} of ${total.toLocaleString()}` : '0 results'), el('div', 'actions', previous, next));
}
function stopPolling() { if (pollTimer) clearTimeout(pollTimer); pollTimer = undefined; }
function clearCovers() {
  for (const controller of coverRequests) controller.abort();
  coverRequests.clear();
  for (const url of coverUrls) URL.revokeObjectURL(url);
  coverUrls.clear();
}

function login(error?: string) {
  stopPolling(); clearCovers(); generation++; document.querySelectorAll('dialog').forEach(node => node.remove());
  document.title = 'Sign in · Norea';
  const password = input('password', 'password'); password.autocomplete = 'current-password';
  const errors = el('div'); errors.setAttribute('role', 'alert');
  if (error) showError(errors, new Error(error));
  const form = el('form');
  const button = submit(form, 'Sign in', async () => {
    const session = await api<{ token: string }>('/console-sessions', 'POST', { password: password.value });
    password.value = ''; setToken(session.token);
    shell(); await navigate(routeView(), false);
  }, errors);
  form.append(field('Installation secret', password, 'Use the value stored in admin-password.hash in the server data directory.'), button);
  app.replaceChildren(el('div', 'login',
    el('aside', 'login-aside', el('div', 'brand', el('span', 'brand-mark', '◈'), 'norea'),
      el('div', '', el('div', 'eyebrow', 'Content server'), el('h1', '', 'Content server administration'), el('p', '', 'Browse stored content, inspect scans, and manage device access.')),
      el('div', 'login-footer', 'Administration console')),
    el('main', 'login-main', el('div', 'login-card', el('div', 'eyebrow', 'Administration'), el('h2', '', 'Welcome back'), el('p', 'hint', 'Sign in with this server’s installation secret.'), form, errors,
      el('p', 'hint', 'Your session stays signed in in this tab until it expires or you sign out.')))));
  password.focus();
}
function shell() {
  nav = el('nav', 'nav'); nav.setAttribute('aria-label', 'Administration');
  for (const name of Object.keys(descriptions) as View[]) {
    const link = el('a', '', icon(name), name); link.href = `/admin/${name.toLowerCase()}`; link.dataset.view = name;
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); void navigate(name);
    });
    nav.append(link);
  }
  heading = el('h1'); subtitle = el('p'); page = el('div', 'page'); flash = el('div', 'flash'); flash.setAttribute('role', 'status');
  const main = el('main', 'main', el('div', 'topline', el('span', '', 'NOREA', ' / ', el('strong', '', 'CONTENT SERVER')), el('span', 'environment', el('span', 'dot'), 'ADMINISTRATION')),
    flash, el('header', 'page-heading', el('div', '', el('div', 'eyebrow', 'Library administration'), heading, subtitle)), page);
  app.replaceChildren(el('div', 'shell', el('aside', 'sidebar', el('div', 'brand', el('span', 'brand-mark', '◈'), 'norea'), el('div', 'brand-caption', 'Content server'), nav,
    el('div', 'sidebar-footer', el('strong', '', 'Console session'), action('Sign out', async () => { await api('/console-sessions/current', 'DELETE'); setToken(''); login(); }))), main));
}
async function navigate(next: View, push = true) {
  const path = `/admin/${next.toLowerCase()}`;
  if (push && location.pathname + location.search !== path) history.pushState(null, '', path);
  else if (location.pathname.replace(/\/$/, '') !== path) history.replaceState(null, '', path + location.search);
  stopPolling(); clearCovers(); const current = ++generation; view = next;
  document.querySelectorAll('dialog').forEach(node => node.remove());
  heading.textContent = next; subtitle.textContent = descriptions[next]; flash.replaceChildren();
  for (const button of nav.querySelectorAll('a')) {
    if (button.dataset.view === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  page.replaceChildren(el('div', 'loading', 'Loading…')); document.title = `${next} · Norea`;
  try {
    const render = { Overview: overview, Plugins: plugins, Storage: storage, Content: contentRoute, Jobs: jobs, Devices: devices, Settings: settings }[next];
    await render(current);
  } catch (error) { if (current === generation) page.replaceChildren(el('div', 'notice error', message(error)), action('Try again', () => navigate(next, false))); }
}

async function overview(current: number) {
  const data = await api<Overview>('/admin/overview'); if (current !== generation) return;
  const stats = el('div', 'stats');
  for (const [label, value, detail] of [
    ['Works', data.works.toLocaleString(), 'Distinct novels in the catalog'], ['Chapters', data.chapters.toLocaleString(), 'Available to connected readers'],
    ['Content storage', bytes(data.storedBytes), `${data.storedChapters.toLocaleString()} stored chapters`], ['Running scans', data.runningJobs.toLocaleString(), 'Content directory'],
  ]) stats.append(el('div', 'stat', el('div', 'stat-label', label), el('div', 'stat-value', value), el('div', 'stat-detail', detail)));
  const inventory = panel('Server inventory');
  for (const [label, value] of [['Registered repositories', data.plugins], ['Chapters in trash', data.deletedChapters]]) inventory.body.append(el('div', 'health-line', el('span', '', label), el('strong', '', value)));
  inventory.body.append(el('div', 'form-actions', action('Browse content', () => navigate('Content'), 'primary'), action('View jobs', () => navigate('Jobs'))));
  const storage = panel('Content directory', 'Uploads and scans use this directory.');
  storage.body.append(el('p', 'mono', data.contentsPath), action('Scan settings', () => navigate('Storage')));
  page.replaceChildren(stats, el('div', 'two-col', inventory.node, storage.node));
}

async function plugins(current: number) {
  const data = await api<{ items: Plugin[] }>('/admin/plugins'); if (current !== generation) return;
  const list = panel('Plugin repositories', `${data.items.length} registered`); list.body.className = '';
  list.body.append(table(['Repository', 'Sources', 'Status', 'Actions'], data.items.map(plugin => {
    const sources = el('details', 'sources', el('summary', '', `${plugin.sources.length} sources`), el('ul', '', ...plugin.sources.map(source => el('li', '', `${source.name} · ${source.id} · ${source.version}${source.installMode ? ` · ${source.installMode}` : ''}`))));
    return [el('div', '', el('div', 'cell-title', plugin.name), el('div', 'hint mono', plugin.url), el('div', 'hint', `Updated ${date(plugin.updatedAt)}`)), sources, badge(plugin.enabled ? 'enabled' : 'disabled'),
      el('div', 'actions', action(plugin.enabled ? 'Disable' : 'Enable', async () => { await api(`/admin/plugins/${encodeURIComponent(plugin.id)}`, 'PATCH', { enabled: !plugin.enabled }); await navigate('Plugins'); }, 'small'),
        action('Remove', async () => { if (!confirm(`Remove repository “${plugin.name}”? Existing server content and source files will remain.`)) return; await api(`/admin/plugins/${encodeURIComponent(plugin.id)}`, 'DELETE'); await navigate('Plugins'); }, 'small danger'))];
  }), 'No repositories yet. Register a repository below.'));
  const add = panel('Register a repository', 'Provide a repository JSON URL or an absolute path on the server. Repository registrations do not restrict folder scans.');
  const form = el('form'); const url = input('url'); url.placeholder = 'https://…/repository.json or C:\\…\\repository.json';
  const name = input('name', 'text', '', false); name.placeholder = 'Use the repository name'; const errors = el('div');
  form.append(el('div', 'form-grid', field('Repository URL or local path', url, undefined, true), field('Display name (optional)', name)));
  form.append(el('div', 'form-actions', submit(form, 'Register repository', async () => { await api('/admin/plugins', 'POST', { url: url.value.trim(), ...(name.value.trim() ? { name: name.value.trim() } : {}) }); await navigate('Plugins'); notify('Repository registered.'); }, errors)), errors);
  add.body.append(form); page.replaceChildren(list.node, add.node);
}

async function storage(current: number) {
  const data = await api<StorageSettings>('/admin/storage'); if (current !== generation) return;
  const directory = panel('Content directory', 'Configured when the server starts. Uploads and scans use the same directory.');
  const scan = async (full: boolean) => {
    const job = await api<Job>('/admin/storage/scan', 'POST', { full });
    await navigate('Jobs'); updateQuery({ job: job.id }, true); await navigate('Jobs', false);
  };
  directory.body.append(details([['Path', el('span', 'mono', data.path)], ['Last scan', date(data.lastScanAt)]]),
    el('div', 'form-actions', action('Scan now', () => scan(false), 'primary'), action('Full inspection', () => scan(true))));
  const schedule = panel('Scan schedule'); const form = el('form'); const errors = el('div');
  const enabled = input('enabled', 'checkbox', '', false); enabled.checked = data.enabled;
  const mode = select('mode', ['manual', 'periodic', 'changes'], data.mode);
  const interval = input('intervalMinutes', 'number', String(data.intervalMinutes)); interval.min = '1'; interval.max = '1440'; interval.step = '1';
  const updateMode = () => { interval.disabled = mode.value === 'manual'; }; mode.addEventListener('change', updateMode); updateMode();
  form.append(el('label', 'check-field', enabled, 'Enable scheduled scans'),
    el('div', 'form-grid', field('Scan mode', mode, 'Changes mode watches files and also checks on the configured interval.'), field('Interval (minutes)', interval)),
    el('div', 'form-actions', submit(form, 'Save schedule', async () => {
      await api('/admin/storage', 'PATCH', { mode: mode.value, intervalMinutes: Number(interval.value), enabled: enabled.checked }); notify('Scan schedule saved.');
    }, errors)), errors);
  schedule.body.append(form);
  page.replaceChildren(directory.node, schedule.node, el('div', 'notice', 'Scan now finds added or removed folders and refreshes work metadata and covers. Known complete chapters and unsupported folders reuse their previous results. Changes mode inspects files reported by the filesystem watcher. Use Full inspection after editing existing chapter files or repairing unsupported folders when no change event was received. Each work needs valid novel.json. Scans never alter original files or contact source sites.'));
}

async function loadCover(work: Work, target: HTMLElement, current: number) {
  const controller = new AbortController(); coverRequests.add(controller);
  const requestToken = token;
  try {
    const response = await fetch(`${apiRoot}/admin/works/${encodeURIComponent(work.id)}/cover`, {
      headers: { Authorization: `Bearer ${requestToken}` }, cache: 'no-store', signal: controller.signal,
    });
    if (requestToken !== token || current !== generation || !target.isConnected) return;
    if (response.status === 401) { setToken(''); login('Your session expired. Sign in again.'); return; }
    if (!response.ok) throw new Error('Cover unavailable');
    const blob = await response.blob();
    if (controller.signal.aborted || current !== generation || !target.isConnected) return;
    const url = URL.createObjectURL(blob); coverUrls.add(url);
    const image = el('img'); image.alt = ''; image.src = url;
    image.addEventListener('error', () => {
      URL.revokeObjectURL(url); coverUrls.delete(url);
      target.replaceChildren(el('span', 'cover-placeholder', 'Cover unavailable'));
    }, { once: true });
    target.replaceChildren(image);
  } catch {
    if (!controller.signal.aborted && current === generation && target.isConnected) target.replaceChildren(el('span', 'cover-placeholder', 'Cover unavailable'));
  } finally { coverRequests.delete(controller); }
}
async function inspectWork(work: Work) {
  if (work.metadata.chapters === undefined) work = await api<Work>(`/works/${encodeURIComponent(work.id)}`);
  const { metadata } = work; const { novel, identity, cover } = metadata;
  const modal = dialog(`Metadata · ${novel.name}`); modal.node.classList.add('metadata-dialog');
  const values: [string, Child][] = [
    ['Title', novel.name], ['Author', novel.author ?? '—'], ['Artist', novel.artist ?? '—'],
    ['Status', novel.status ?? '—'], ['Rating', novel.rating ?? '—'], ['Genres', novel.genres ?? '—'], ['Summary', el('span', 'preserve-lines', novel.summary ?? '—')],
    ['Local work', novel.isLocal ? 'Yes' : 'No'],
    ['Plugin ID', el('span', 'mono', identity.pluginId)], ['Novel path', el('span', 'mono', identity.novelPath)],
    ['Cover file', cover?.fileName ?? '—'], ['Cover content type', cover?.contentType ?? '—'],
    ['Stored cover', work.hasCover ? 'Available' : 'Not available'],
    ['Catalog chapters', Object.keys(metadata.chapters ?? {}).length],
    ['Schema version', metadata.schemaVersion], ['Work ID', el('span', 'mono', work.id)], ['Sequence', work.sequence],
  ];
  if (work.downloadedChapters !== undefined) values.push(['Downloaded chapters', work.downloadedChapters]);
  const json = el('details', 'metadata-json', el('summary', '', 'Full JSON'), el('pre', 'mono', JSON.stringify(metadata, null, 2)));
  modal.body.append(details(values), json);
}
async function deleteWork(work: Work): Promise<boolean> {
  if (!confirm(`Delete “${work.metadata.novel.name}” and its entire server folder, including all chapters, metadata and cover images? This cannot be undone. Copies on other devices remain.`)) return false;
  await api(`/admin/works/${encodeURIComponent(work.id)}`, 'DELETE');
  return true;
}
async function contentRoute(current: number) {
  const query = new URLSearchParams(location.search);
  if (query.has('work') || query.has('chapters')) {
    const work = query.has('work') ? await api<Work>(`/works/${encodeURIComponent(query.get('work')!)}`) : undefined;
    if (current !== generation) return;
    await chapters(current, work, async () => {
      updateQuery({ work: null, chapters: null, chapterSearch: null, chapterOffset: null, deleted: null }, true);
      await navigate('Content', false);
    });
  } else await content(current, { search: query.get('search') ?? '', offset: queryOffset(), layout: query.get('layout') === 'list' ? 'list' : 'grid' });
}
async function content(current: number, state: WorkView) {
  clearCovers();
  const section = panel('Works', 'Saved chapter catalogs and available server copies.'); section.body.className = '';
  const search = input('search', 'search', state.search, false); search.className = 'search-input'; search.placeholder = 'Search works'; search.setAttribute('aria-label', 'Search works');
  const errors = el('div'); errors.setAttribute('role', 'alert');
  const results = el('div'); let requestId = 0; let data: { items: Work[]; total: number } | undefined;
  const openChapters = async (work?: Work) => {
    updateQuery({ work: work?.id ?? null, chapters: work ? null : 'all' }, true);
    await navigate('Content', false);
  };
  const grid = action('Grid', () => changeLayout('grid'), 'small');
  const list = action('List', () => changeLayout('list'), 'small');
  const toggle = el('div', 'actions layout-toggle', grid, list); toggle.setAttribute('role', 'group'); toggle.setAttribute('aria-label', 'Work layout');
  function changeLayout(layout: WorkView['layout']) { state.layout = layout; updateQuery({ layout }); render(); }
  function render() {
    if (!data || current !== generation) return;
    clearCovers();
    grid.setAttribute('aria-pressed', String(state.layout === 'grid')); list.setAttribute('aria-pressed', String(state.layout === 'list'));
    const covers: { work: Work; node: HTMLElement }[] = [];
    const works = el('div', `works works-${state.layout}`);
    for (const work of data.items) {
      const cover = el('div', 'work-cover', el('span', 'cover-placeholder', work.hasCover ? 'Loading cover…' : 'No cover'));
      const title = action(work.metadata.novel.name, () => openChapters(work), 'work-title');
      const controls = el('div', 'actions', action('Chapters', () => openChapters(work), 'small'), action('Metadata', () => inspectWork(work), 'small'),
        action('Delete', async () => { if (await deleteWork(work)) await load(state.offset); }, 'small danger', errors));
      const info = el('div', 'work-info', el('h3', '', title), el('p', 'hint work-author', work.metadata.novel.author || 'Unknown author'),
        el('p', 'hint mono', work.metadata.identity.pluginId), el('p', 'work-count', `${(work.downloadedChapters ?? 0).toLocaleString()} chapters backed up · ${(work.chapterCount ?? 0).toLocaleString()} catalog chapters`), controls);
      works.append(el('article', 'work', cover, info));
      if (work.hasCover) covers.push({ work, node: cover });
    }
    results.replaceChildren(data.items.length ? works : el('div', 'empty', state.search ? 'No matching works.' : 'No work metadata yet. Scan a folder containing novel.json to add works.'), pagination(data.total, state.offset, 50, load));
    for (const cover of covers) void loadCover(cover.work, cover.node, current);
  }
  async function load(offset = 0) {
    const request = ++requestId; errors.replaceChildren(); results.setAttribute('aria-busy', 'true');
    const query = search.value.trim();
    try {
      const next = await api<{ items: Work[]; total: number }>(`/admin/works?search=${encodeURIComponent(query)}&offset=${offset}&limit=50`);
      if (current !== generation || request !== requestId) return;
      state.search = query; state.offset = offset; updateQuery({ search: query, offset }); data = next; render();
    } catch (error) {
      if (current !== generation || request !== requestId) return;
      clearCovers(); data = undefined;
      showError(errors, error); results.replaceChildren(el('div', 'empty', action('Try again', () => load(offset))));
    } finally { if (request === requestId) results.removeAttribute('aria-busy'); }
  }
  const form = el('form', 'toolbar', search); form.append(submit(form, 'Search', () => load(), errors), toggle, action('All chapters', () => openChapters(), 'small'));
  results.append(el('div', 'loading', 'Loading works…')); section.body.append(form, errors, results);
  if (current !== generation) return; page.replaceChildren(section.node); await load(state.offset);
}
async function chapters(current: number, work: Work | undefined, back: () => Promise<void>) {
  clearCovers();
  const section = panel(work ? work.metadata.novel.name : 'All chapters', work ? 'Saved chapter catalog with server file availability. Deleting a server copy keeps its catalog title.' : 'All chapters associated with registered work metadata.'); section.body.className = '';
  const query = new URLSearchParams(location.search);
  const search = input('search', 'search', query.get('chapterSearch') ?? '', false); search.className = 'search-input'; search.placeholder = 'Search novel or chapter'; search.setAttribute('aria-label', 'Search content');
  const deleted = select('deleted', ['Active content', 'Trash']); deleted.setAttribute('aria-label', 'Content state'); deleted.className = 'button';
  if (query.get('deleted') === 'true') deleted.value = 'Trash';
  const results = el('div'); let requestId = 0;
  const load = async (offset = 0) => {
    const request = ++requestId; errors.replaceChildren(); results.setAttribute('aria-busy', 'true');
    try {
      if (work && deleted.value !== 'Trash') {
        const data = await api<{ items: WorkChapter[]; total: number }>(`/admin/works/${encodeURIComponent(work.id)}/chapters?search=${encodeURIComponent(search.value.trim())}&offset=${offset}&limit=50`);
        if (current !== generation || request !== requestId) return;
        updateQuery({ chapterSearch: search.value.trim(), chapterOffset: offset, deleted: null });
        results.replaceChildren(table(['Chapter', 'Server files', 'Actions'], data.items.map(chapter => [
          el('div', '', el('div', 'cell-title', chapter.name), el('div', 'hint', `Chapter ${chapter.chapterNumber ?? chapter.position}`)),
          chapter.entry ? el('div', '', 'Available', el('div', 'hint', bytes(chapter.entry.fileBytes))) : el('span', 'hint', 'Not backed up'),
          chapter.entry ? el('div', 'actions', action('Inspect', () => inspectEntry(chapter.entry!.id, () => load(offset)), 'small'), action('Delete', async () => {
            if (!confirm(`Delete “${chapter.name}” from the server? Its catalog title and local device copies remain.`)) return;
            await api(`/chapters/${encodeURIComponent(chapter.entry!.id)}`, 'DELETE'); await load(offset);
          }, 'small danger', errors)) : null,
        ]), 'No matching chapters.'), pagination(data.total, offset, 50, load));
        return;
      }
      const data = await api<{ items: Entry[]; total: number }>(`/admin/chapters?search=${encodeURIComponent(search.value.trim())}&deleted=${deleted.value === 'Trash'}&offset=${offset}&limit=50${work ? `&workId=${encodeURIComponent(work.id)}` : ''}`);
      if (current !== generation || request !== requestId) return;
      updateQuery({ chapterSearch: search.value.trim(), chapterOffset: offset, deleted: deleted.value === 'Trash' ? 'true' : null });
      results.replaceChildren(table(['Chapter', 'Source', 'Stored content', 'Actions'], data.items.map(entry => [
        el('div', '', el('div', 'cell-title', entry.manifest.chapter.name), el('div', 'hint', `Position ${entry.manifest.chapter.position} · ${entry.manifest.novel.name}`)),
        el('div', 'mono', entry.manifest.identity.pluginId), el('div', '', bytes(entry.fileBytes), el('div', 'hint mono', entry.revision.slice(0, 12))),
        el('div', 'actions', action('Inspect', () => inspectEntry(entry.id, () => load(offset)), 'small'), entry.deleted ? null : action('Delete', async () => {
          if (!confirm(`Delete “${entry.manifest.chapter.name}” from the server? Local device copies remain. You can upload a replacement after deletion.`)) return;
          await api(`/chapters/${encodeURIComponent(entry.id)}`, 'DELETE'); await load(offset);
        }, 'small danger', errors)),
      ]), deleted.value === 'Trash' ? 'Trash is empty.' : 'No matching chapters. Scan the content directory to add content.'), pagination(data.total, offset, 50, load));
    } catch (error) {
      if (current !== generation || request !== requestId) return;
      showError(errors, error); results.replaceChildren(el('div', 'empty', action('Try again', () => load(offset))));
    } finally { if (request === requestId) results.removeAttribute('aria-busy'); }
  };
  const form = el('form', 'toolbar', search, deleted); const errors = el('div'); errors.setAttribute('role', 'alert');
  if (work) section.node.querySelector('h2')?.append(' ', action('Delete work', async () => {
    if (await deleteWork(work)) await back();
  }, 'small danger', errors));
  form.append(submit(form, 'Search', () => load(), errors)); deleted.addEventListener('change', () => { void load().catch(error => showError(errors, error)); });
  results.append(el('div', 'loading', 'Loading chapters…'));
  section.body.append(form, errors, results); if (current !== generation) return;
  page.replaceChildren(el('div', 'actions', action('Back to works', back), work ? action('Metadata', () => inspectWork(work)) : null), section.node); await load(queryOffset('chapterOffset'));
}
async function inspectEntry(id: string, changed: () => Promise<void>) {
  const modal = dialog('Chapter details'); modal.body.append(el('div', 'loading', 'Loading chapter…'));
  try {
    const { entry } = await api<{ entry: Entry }>(`/admin/chapters/${encodeURIComponent(id)}`); if (!modal.node.isConnected) return;
    const errors = el('div'); const endpoint = `/chapters/${encodeURIComponent(id)}`;
    const done = async () => { modal.node.close(); await changed(); };
    const actions = el('div', 'actions');
    if (entry.deleted) {
      actions.append(action('Restore chapter', async () => { await api(`${endpoint}/restore`, 'POST'); await done(); }, 'primary', errors),
        action('Permanently purge', async () => { if (!confirm(`Permanently purge “${entry.manifest.chapter.name}” from server trash? This cannot be undone.`)) return; await api(`${endpoint}/purge`, 'POST'); await done(); }, 'danger', errors));
    } else actions.append(action('Delete from server', async () => { if (!confirm(`Delete “${entry.manifest.chapter.name}” from the server? Local device copies remain. You can upload a replacement after deletion.`)) return; await api(endpoint, 'DELETE'); await done(); }, 'danger', errors));
    const metadata: [string, Child][] = [['Status', badge(entry.deleted ? 'deleted' : 'active')], ['Position', entry.manifest.chapter.position], ['Content type', entry.manifest.chapter.contentType]];
    if (entry.manifest.novel.author) metadata.push(['Author', entry.manifest.novel.author]);
    if (entry.manifest.novel.summary) metadata.push(['Summary', entry.manifest.novel.summary]);
    metadata.push(['Chapter ID', el('span', 'mono', entry.id)], ['Plugin ID', entry.manifest.identity.pluginId], ['Novel path', el('span', 'mono', entry.manifest.identity.novelPath)], ['Chapter path', el('span', 'mono', entry.manifest.identity.chapterPath)], ['Current file token', el('span', 'mono', entry.revision)], ['Storage format', 'Original chapter files'], ['Stored size', bytes(entry.fileBytes)]);
    modal.body.replaceChildren(el('div', '', el('h3', '', entry.manifest.chapter.name), el('p', 'hint', entry.manifest.novel.name)),
      details(metadata),
      table(['Original file', 'Size'], entry.manifest.files.map(file => [el('span', 'mono', file.path), bytes(file.size)]), 'No stored files.'),
      el('div', 'notice', 'Only one complete copy is kept. Delete it before uploading a replacement. These actions affect this server only.'), actions, errors);
  } catch (error) { showError(modal.body, error); }
}

async function jobs(current: number) {
  const list = panel('Scan history', 'Refreshes every 2 seconds while this view is open.'); list.body.className = '';
  const detail = panel('Scan results', 'Select a job to inspect file outcomes and skip reasons.');
  const detailMeta = el('div', 'job-meta'); const detailResults = el('div'); const errors = el('div');
  detail.body.append(detailMeta, detailResults); let selected = new URLSearchParams(location.search).get('job') ?? undefined; let offset = queryOffset(); let listFingerprint = ''; let resultFingerprint = ''; let pollBusy = false; let resultRequest = 0;
  async function results() {
    if (!selected) return; const id = selected; const position = offset; const request = ++resultRequest;
    const data = await api<{ job: Job; items: JobItem[]; total: number }>(`/admin/jobs/${encodeURIComponent(id)}?offset=${position}&limit=100`);
    if (current !== generation || id !== selected || position !== offset || request !== resultRequest) return;
    const fingerprint = JSON.stringify(data); if (fingerprint === resultFingerprint) return; resultFingerprint = fingerprint;
    const summary = data.job.summary;
    detailMeta.replaceChildren(el('div', 'cell-title', `${data.job.rootName} · ${data.job.status}`), el('div', 'mono', data.job.id),
      el('div', '', `Started ${date(data.job.startedAt)}${data.job.finishedAt ? ` · Finished ${date(data.job.finishedAt)}` : ''}`),
      summary ? el('div', '', `${summary.scanned} scanned · ${summary.registered} registered · ${summary.unchanged} unchanged · ${summary.skipped} skipped · ${summary.failed} failed · ${summary.removed ?? 0} removed`) : '',
      el('div', 'hint', 'Unchanged items and cached skips are counted above. Details list only new results and errors.'),
      data.job.error ? el('div', 'notice error', data.job.error) : '');
    detailResults.replaceChildren(table(['File', 'Outcome', 'Reason / identity'], data.items.map(item => [el('div', 'mono result-path', item.path), badge(item.status),
      el('div', '', item.reason || '—', item.sourceId ? el('div', 'hint mono', `Source: ${item.sourceId}`) : null, item.workId ? el('div', 'hint mono', `Work: ${item.workId}`) : null, item.chapterId ? el('div', 'hint mono', `Chapter: ${item.chapterId}`) : null, item.revision ? el('div', 'hint mono', `Revision: ${item.revision}`) : null)]), 'No file results recorded yet.'),
      pagination(data.total, position, 100, async next => { offset = next; updateQuery({ offset }); resultFingerprint = ''; await results(); }));
  }
  async function refresh() {
    const data = await api<{ items: Job[] }>('/admin/jobs'); if (current !== generation) return;
    const fingerprint = JSON.stringify(data); if (fingerprint !== listFingerprint) {
      listFingerprint = fingerprint;
      list.body.replaceChildren(table(['Folder', 'Status', 'Started', 'Results', 'Actions'], data.items.map(job => [el('div', 'cell-title', job.rootName), badge(job.status), date(job.startedAt),
        job.summary ? `${job.summary.registered} registered / ${job.summary.unchanged} unchanged / ${job.summary.skipped} skipped / ${job.summary.failed} failed / ${job.summary.removed ?? 0} removed` : 'In progress',
        el('div', 'actions', action('Inspect', async () => { selected = job.id; offset = 0; updateQuery({ job: selected, offset }, true); resultFingerprint = ''; await results(); }, 'small'),
          job.status === 'running' ? action('Cancel', async () => { if (!confirm(`Cancel the scan for “${job.rootName}”? Content already registered will remain.`)) return; await api(`/admin/jobs/${encodeURIComponent(job.id)}/cancel`, 'POST'); await refresh(); }, 'small danger') : null),
      ]), 'No scans yet. Start a scan from Storage.'));
    }
    await results();
  }
  async function poll() {
    if (current !== generation || view !== 'Jobs' || !token) return;
    if (!document.hidden && !pollBusy) {
      pollBusy = true;
      try { await refresh(); errors.replaceChildren(); } catch (error) { if (current === generation) showError(errors, error); } finally { pollBusy = false; }
    }
    if (current === generation) pollTimer = setTimeout(() => { void poll(); }, 2000);
  }
  page.replaceChildren(errors, list.node, detail.node); await refresh();
  if (current === generation) pollTimer = setTimeout(() => { void poll(); }, 2000);
}

async function devices(current: number) {
  const data = await api<{ items: Device[] }>('/admin/devices'); if (current !== generation) return;
  const list = panel('Registered devices', `${data.items.length} devices`); list.body.className = '';
  list.body.append(table(['Device', 'Registered', 'Last seen', 'Status', 'Access'], data.items.map(device => [
    el('div', '', el('div', 'cell-title', device.deviceName), el('div', 'hint mono', device.id.slice(0, 8))),
    date(device.createdAt), date(device.lastSeenAt), badge(device.blocked ? 'blocked' : 'allowed'),
    action(device.blocked ? 'Unblock' : 'Block', async () => {
      const blocked = !device.blocked;
      if (!confirm(blocked
        ? `Block “${device.deviceName}”? Its device key will remain blocked even if it tries to register again.`
        : `Unblock “${device.deviceName}” and restore access with its existing device key?`)) return;
      await api(`/admin/devices/${encodeURIComponent(device.id)}`, 'PATCH', { blocked });
      if (current !== generation) return;
      await navigate('Devices');
    }, device.blocked ? 'small' : 'small danger'),
  ]), 'No devices have connected yet.'));
  page.replaceChildren(el('div', 'notice', 'New devices are allowed automatically. Blocking applies to the selected device key; a new key is treated as a new device. Anonymous reading, when enabled, remains available without a device key.'), list.node);
}

async function settings(current: number) {
  const data = await api<Settings>('/admin/settings'); if (current !== generation) return;
  const access = panel('Reading access'); const form = el('form'); const errors = el('div');
  const anonymous = input('anonymousRead', 'checkbox', '', false); anonymous.checked = data.anonymousRead;
  form.append(el('label', 'check-field', anonymous, 'Allow anonymous reading'), el('p', 'hint', 'When enabled, clients can read catalog entries and download chapter packages without a device key. Administration requires a console session opened with the installation secret.'));
  form.append(el('div', 'form-actions', submit(form, 'Save access settings', async () => {
    await api('/admin/settings', 'PATCH', { anonymousRead: anonymous.checked }); notify('Reading access settings saved.');
  }, errors)), errors); access.body.append(form);
  const config = panel('Server configuration', 'Package limits are configured on the server and are read-only here.');
  config.body.append(details([['Data directory', el('span', 'mono', data.dataDir)], ['Maximum media archive size', bytes(data.limits.zipBytes)], ['Chapter and expanded media limit', bytes(data.limits.expandedBytes)], ['Media files per chapter', data.limits.files.toLocaleString()]]));
  page.replaceChildren(access.node, config.node);
}

window.addEventListener('popstate', () => { if (token) void navigate(routeView(), false); });
if (token) { shell(); void navigate(routeView(), false); } else login();
