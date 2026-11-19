import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildApp } from '../src/app.ts';
import { deviceHeaders } from './access.ts';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
let compiledAdminDir = '';
let compiledAdminJsUrl = '';

before(async () => {
  compiledAdminDir = await mkdtemp(join(tmpdir(), 'norea-admin-web-'));
  const tscBin = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  await execFileAsync(tscBin, ['-p', 'tsconfig.web.json', '--outDir', compiledAdminDir], { cwd: projectRoot });
  compiledAdminJsUrl = pathToFileURL(join(compiledAdminDir, 'admin.js')).href;
});

after(async () => {
  if (compiledAdminDir) {
    await rm(compiledAdminDir, { recursive: true, force: true });
  }
});

function createDomHarness(baseUrl: string) {
  const originalGlobals = {
    Node: globalThis.Node,
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    history: globalThis.history,
    sessionStorage: globalThis.sessionStorage,
    confirm: globalThis.confirm,
    fetch: globalThis.fetch,
  };

  class FakeNode {
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];

    get isConnected(): boolean {
      let cursor: FakeNode | null = this;
      while (cursor) {
        if (cursor === rootDoc || cursor === docBody) return true;
        cursor = cursor.parentNode;
      }
      return false;
    }

    get textContent(): string {
      return this.childNodes.map(child => child.textContent).join('');
    }

    set textContent(value: string) {
      this.replaceChildren(...(value ? [new FakeTextNode(String(value))] : []));
    }

    append(...items: (FakeNode | string | number)[]) {
      for (const item of items) {
        if (item === null || item === undefined) continue;
        const node = item instanceof FakeNode ? item : new FakeTextNode(String(item));
        if (node.parentNode) {
          const index = node.parentNode.childNodes.indexOf(node);
          if (index >= 0) node.parentNode.childNodes.splice(index, 1);
        }
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }

    replaceChildren(...items: (FakeNode | string | number)[]) {
      for (const child of this.childNodes) child.parentNode = null;
      this.childNodes = [];
      this.append(...items);
    }

    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
      this.parentNode = null;
    }
  }

  class FakeTextNode extends FakeNode {
    value: string;
    constructor(value: string) {
      super();
      this.value = value;
    }
    override get textContent(): string {
      return this.value;
    }
    override set textContent(value: string) {
      this.value = value;
    }
  }

  class FakeElement extends FakeNode {
    tagName: string;
    className = '';
    attributes = new Map<string, string>();
    dataset: Record<string, string> = {};
    listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
    value = '';
    checked = false;
    type = '';
    name = '';
    required = false;
    min = '';
    max = '';
    step = '';
    disabled = false;
    href = '';
    scope = '';
    autocomplete = '';
    placeholder = '';
    id = '';

    constructor(tagName: string) {
      super();
      this.tagName = tagName.toLowerCase();
    }

    get children(): FakeElement[] {
      return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
    }

    setAttribute(name: string, value: string) {
      const val = String(value);
      this.attributes.set(name, val);
      if (name === 'id') this.id = val;
      if (name === 'class') this.className = val;
    }

    getAttribute(name: string): string | null {
      if (name === 'id' && this.id) return this.id;
      if (name === 'class') return this.className;
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name: string) {
      this.attributes.delete(name);
    }

    focus() {}
    close() { this.remove(); }
    showModal() {}

    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    dispatchEvent(event: Record<string, unknown>) {
      const list = this.listeners.get(String(event.type)) ?? [];
      for (const listener of list) listener(event);
    }

    click() {
      this.dispatchEvent({
        type: 'click',
        button: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        preventDefault() {},
      });
    }

    submitForm() {
      this.dispatchEvent({
        type: 'submit',
        preventDefault() {},
      });
    }

    matches(selector: string): boolean {
      const parts = selector.trim().split(/(?=[.#])/);
      for (const part of parts) {
        if (!part) continue;
        if (part.startsWith('#')) {
          if (this.id !== part.slice(1)) return false;
        } else if (part.startsWith('.')) {
          const classes = this.className.split(/\s+/).filter(Boolean);
          if (!classes.includes(part.slice(1))) return false;
        } else if (this.tagName !== part.toLowerCase()) {
          return false;
        }
      }
      return true;
    }

    querySelectorAll(selector: string): FakeElement[] {
      const out: FakeElement[] = [];
      const walk = (node: FakeElement) => {
        for (const child of node.children) {
          if (child.matches(selector)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }

    querySelector(selector: string): FakeElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  const rootDoc = new FakeElement('html');
  const docBody = new FakeElement('body');
  const appEl = new FakeElement('div');
  appEl.id = 'app';
  docBody.append(appEl);
  rootDoc.append(docBody);

  const storage = new Map<string, string>();
  const windowListeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const loc = { href: `${baseUrl}/admin/`, pathname: '/admin/', search: '' };
  let confirmImpl = (_msg: string) => true;

  const fakeDocument = {
    body: docBody,
    hidden: false,
    title: '',
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    querySelector: (selector: string) => rootDoc.querySelector(selector),
    querySelectorAll: (selector: string) => rootDoc.querySelectorAll(selector),
  };

  globalThis.Node = FakeNode as unknown as typeof Node;
  globalThis.document = fakeDocument as unknown as Document;
  globalThis.window = {
    addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
  } as unknown as Window & typeof globalThis;
  globalThis.location = loc as unknown as Location;
  globalThis.history = {
    pushState: (_s: unknown, _t: string, url: string) => {
      const parsed = new URL(url, baseUrl);
      loc.href = parsed.href;
      loc.pathname = parsed.pathname;
      loc.search = parsed.search;
    },
    replaceState: (_s: unknown, _t: string, url: string) => {
      const parsed = new URL(url, baseUrl);
      loc.href = parsed.href;
      loc.pathname = parsed.pathname;
      loc.search = parsed.search;
    },
  } as unknown as History;
  globalThis.sessionStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  } as unknown as Storage;
  globalThis.confirm = ((msg?: string) => confirmImpl(String(msg ?? ''))) as typeof confirm;
  const origFetch = originalGlobals.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const target = raw.startsWith('/') ? `${baseUrl}${raw}` : raw;
    return origFetch(target, init);
  }) as typeof fetch;

  return {
    rootDoc,
    appEl,
    storage,
    setConfirm(fn: (msg: string) => boolean) {
      confirmImpl = fn;
    },
    async waitFor<T>(fn: () => T | null | false | undefined, label: string): Promise<T> {
      for (let i = 0; i < 300; i++) {
        const result = fn();
        if (result) return result;
        await delay(10);
      }
      throw new Error(`Timed out waiting for: ${label}`);
    },
    restore() {
      globalThis.Node = originalGlobals.Node;
      globalThis.document = originalGlobals.document;
      globalThis.window = originalGlobals.window;
      globalThis.location = originalGlobals.location;
      globalThis.history = originalGlobals.history;
      globalThis.sessionStorage = originalGlobals.sessionStorage;
      globalThis.confirm = originalGlobals.confirm;
      globalThis.fetch = originalGlobals.fetch;
    },
  };
}

test('interactive /admin/ UI executes login, user-state stats/compact/retention/reset, and device backup deletion with XSS escaping', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'norea-admin-dom-'));
  const app = await buildApp({
    dataDir,
    userStateMaintenance: { compactionIntervalMs: 0 },
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const dom = createDomHarness(baseUrl);
  try {
    const password = (await readFile(join(dataDir, 'admin-password.hash'), 'utf8')).trim();
    const device = await deviceHeaders(app, 'DOM-Test-Tablet');

    // Seed user-state records & superseded change + two device backups (special chars + XSS payload).
    const ws = await (await fetch(`${baseUrl}/api/v1/user-state`, { headers: device })).json();
    const scope = { workspaceId: ws.workspaceId, epoch: ws.epoch };
    const work = { pluginId: 'src', sourceNovelId: 'w1', novelPath: '/w1', name: 'Work 1' };
    await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...device, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope,
        operations: [
          { operationId: 'dom-op-1', entity: { kind: 'library', work }, baseRevision: 0, value: { inLibrary: true, addedAt: 100 } },
          { operationId: 'dom-op-2', entity: { kind: 'bookmark', work, chapter: { chapterPath: '/c1' } }, baseRevision: 0, value: { bookmarked: false } },
        ],
      }),
    });
    await fetch(`${baseUrl}/api/v1/user-state/merge`, {
      method: 'POST',
      headers: { ...device, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope,
        operations: [
          { operationId: 'dom-op-3', entity: { kind: 'library', work }, baseRevision: 1, value: { inLibrary: true, addedAt: 200 } },
        ],
      }),
    });

    const uploadBackup = async (name: string, payloadText: string) => {
      const buf = Buffer.from(payloadText);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const res = await fetch(`${baseUrl}/api/v1/device-backups/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { ...device, 'content-type': 'application/octet-stream', 'x-backup-sha256': sha256 },
        body: buf,
      });
      assert.equal(res.status, 200);
    };
    const xssName = '<img src=x onerror=alert(1)>';
    await uploadBackup('내 기기 / S25', 'PK backup korean');
    await uploadBackup(xssName, 'PK backup xss');

    // Boot compiled admin.js inside the Node DOM harness.
    await import(`${compiledAdminJsUrl}?run=${Date.now()}`);

    // 1. Login flow
    const loginForm = await dom.waitFor(() => dom.appEl.querySelector('form'), 'login form');
    const pwInput = loginForm.querySelectorAll('input').find(i => i.name === 'password')!;
    pwInput.value = password;
    loginForm.submitForm();

    await dom.waitFor(() => dom.appEl.querySelector('h1')?.textContent === 'Overview', 'Overview heading');
    assert.ok(dom.storage.get('norea-console-session'), 'session token stored in sessionStorage');

    // 2. Navigate to User state & inspect rendered per-table stats & entity kinds
    const userStateLink = dom.appEl.querySelectorAll('a').find(a => a.dataset.view === 'User state')!;
    userStateLink.click();
    await dom.waitFor(() => {
      const h1 = dom.appEl.querySelector('h1')?.textContent;
      const loading = dom.appEl.querySelector('.loading');
      return h1 === 'User state' && !loading;
    }, 'User state view loaded');

    const fullText = dom.appEl.textContent;
    for (const tableName of [
      'user_state_meta',
      'user_state_records',
      'user_state_changes',
      'user_state_operations',
      'user_state_category_aliases',
    ]) {
      assert.ok(fullText.includes(tableName), `expected table ${tableName} in User state view`);
    }
    assert.ok(fullText.includes('Active records'), 'Active records stat rendered');
    assert.ok(fullText.includes('library'), 'library kind row rendered');
    assert.ok(fullText.includes('bookmark'), 'bookmark kind row rendered');

    // 3. Compact & vacuum button
    const compactBtn = dom.appEl.querySelectorAll('button').find(b => b.textContent === 'Compact & vacuum')!;
    compactBtn.click();
    await dom.waitFor(
      () => dom.appEl.querySelector('.flash')?.textContent.includes('Compaction complete:'),
      'Compaction flash notice',
    );

    // 4. Retention form: invalid error + valid save & persistence
    const retentionPanel = dom.appEl.querySelectorAll('section').find(s => s.textContent.includes('Retention policies'))!;
    const retentionForm = retentionPanel.querySelector('form')!;
    const inputs = retentionForm.querySelectorAll('input');
    const byName = (name: string) => inputs.find(i => i.name === name)!;

    byName('p2aDays').value = '0';
    retentionForm.submitForm();
    const errNotice = await dom.waitFor(() => retentionForm.querySelector('.notice.error'), 'retention error notice');
    assert.ok(errNotice.textContent.length > 0);

    byName('p2aEnabled').checked = true;
    byName('p2aDays').value = '45';
    byName('p2bEnabled').checked = true;
    byName('p2bDays').value = '60';
    byName('p2cEnabled').checked = true;
    byName('p2cMonths').value = '6';
    byName('gcDays').value = '14';
    retentionForm.submitForm();
    await dom.waitFor(
      () => dom.appEl.querySelector('.flash')?.textContent.includes('Retention policies saved.'),
      'Retention policies saved flash',
    );

    // Re-check persisted values in refreshed form
    const refreshedInputs = await dom.waitFor(() => {
      const panel = dom.appEl.querySelectorAll('section').find(s => s.textContent.includes('Retention policies'));
      const list = panel?.querySelectorAll('input');
      return list && list.find(i => i.name === 'p2aDays')?.value === '45' ? list : null;
    }, 'refreshed retention values');
    assert.equal(refreshedInputs.find(i => i.name === 'p2aEnabled')!.checked, true);
    assert.equal(refreshedInputs.find(i => i.name === 'p2bEnabled')!.checked, true);
    assert.equal(refreshedInputs.find(i => i.name === 'p2bDays')!.value, '60');
    assert.equal(refreshedInputs.find(i => i.name === 'p2cEnabled')!.checked, true);
    assert.equal(refreshedInputs.find(i => i.name === 'p2cMonths')!.value, '6');
    assert.equal(refreshedInputs.find(i => i.name === 'gcDays')!.value, '14');

    // 5. Reset workspace epoch: confirm cancel = no-op; confirm accept = rotate epoch & headRevision = 0
    const epochBefore = (await (await fetch(`${baseUrl}/api/v1/user-state`, { headers: device })).json()).epoch;
    const confirmPrompts: string[] = [];
    dom.setConfirm(msg => {
      confirmPrompts.push(msg);
      return false;
    });
    const resetBtnCancel = dom.appEl.querySelectorAll('button').find(b => b.textContent === 'Reset workspace epoch')!;
    resetBtnCancel.click();
    await delay(40);
    assert.equal(confirmPrompts.length, 1);
    const epochAfterCancel = (await (await fetch(`${baseUrl}/api/v1/user-state`, { headers: device })).json()).epoch;
    assert.equal(epochAfterCancel, epochBefore);

    dom.setConfirm(msg => {
      confirmPrompts.push(msg);
      return true;
    });
    const resetBtnAccept = dom.appEl.querySelectorAll('button').find(b => b.textContent === 'Reset workspace epoch')!;
    resetBtnAccept.click();
    await dom.waitFor(
      () => dom.appEl.querySelector('.flash')?.textContent.includes('Workspace epoch rotated'),
      'Workspace epoch rotated flash',
    );
    const wsAfterReset = await (await fetch(`${baseUrl}/api/v1/user-state`, { headers: device })).json();
    assert.notEqual(wsAfterReset.epoch, epochBefore);
    assert.equal(wsAfterReset.headRevision, 0);

    // 6. Devices view: backup listing, XSS escaping, confirm cancel/accept deletion
    const devicesLink = dom.appEl.querySelectorAll('a').find(a => a.dataset.view === 'Devices')!;
    devicesLink.click();
    await dom.waitFor(() => {
      const h1 = dom.appEl.querySelector('h1')?.textContent;
      const loading = dom.appEl.querySelector('.loading');
      return h1 === 'Devices' && !loading;
    }, 'Devices view loaded');

    assert.equal(dom.rootDoc.querySelectorAll('img').length, 0, 'XSS payload must render as text, never <img> element');
    assert.ok(dom.appEl.textContent.includes(xssName));
    assert.ok(dom.appEl.textContent.includes('내 기기 / S25'));

    const findBackupDeleteBtn = (deviceName: string) => {
      const row = dom.appEl.querySelectorAll('tr').find(tr => tr.textContent.includes(deviceName));
      return row?.querySelector('button') ?? null;
    };

    dom.setConfirm(() => false);
    findBackupDeleteBtn('내 기기 / S25')!.click();
    await delay(40);
    assert.ok(findBackupDeleteBtn('내 기기 / S25'), 'cancelled delete must keep backup row');

    dom.setConfirm(() => true);
    findBackupDeleteBtn('내 기기 / S25')!.click();
    await dom.waitFor(
      () => dom.appEl.querySelector('.flash')?.textContent.includes('Deleted backup for “내 기기 / S25”.'),
      'Deleted Korean backup flash',
    );
    assert.equal(findBackupDeleteBtn('내 기기 / S25'), null);

    findBackupDeleteBtn(xssName)!.click();
    await dom.waitFor(
      () => dom.appEl.textContent.includes('No device backups stored on the server.'),
      'Empty backups notice after deleting all backups',
    );
  } finally {
    dom.restore();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
