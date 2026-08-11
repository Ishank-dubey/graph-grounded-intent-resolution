import type { ComponentRef, ComponentType, DataPackBundle, ImportResult } from './types/datapack.js';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let currentTab: chrome.tabs.Tab | null = null;
let currentComponentType: ComponentType = 'OmniScript';
let currentComponents: ComponentRef[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} not found`);
  return el;
}

function setStatus(text: string, type: 'success' | 'error' | 'info' | '' = '') {
  const bar = $('status-bar');
  bar.textContent = text;
  if (type) {
    bar.setAttribute('data-type', type);
  } else {
    bar.removeAttribute('data-type');
  }
}

function getCheckedKeys(): string[] {
  const checkboxes = document.querySelectorAll<HTMLInputElement>(
    '#component-list input[type="checkbox"]:checked',
  );
  return Array.from(checkboxes).map((cb) => cb.dataset['key'] ?? '').filter(Boolean);
}

function updateExportButton() {
  const btn = $('export-btn') as HTMLButtonElement;
  btn.disabled = getCheckedKeys().length === 0;
}

function updateSelectAll() {
  const all = document.querySelectorAll<HTMLInputElement>(
    '#component-list input[type="checkbox"]',
  );
  const checked = document.querySelectorAll<HTMLInputElement>(
    '#component-list input[type="checkbox"]:checked',
  );
  const selectAll = document.getElementById('select-all') as HTMLInputElement | null;
  if (!selectAll) return;

  if (all.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  } else if (checked.length === all.length) {
    selectAll.checked = true;
    selectAll.indeterminate = false;
  } else if (checked.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  } else {
    selectAll.checked = false;
    selectAll.indeterminate = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component list rendering
// ─────────────────────────────────────────────────────────────────────────────

async function loadComponents() {
  if (!currentTab?.id) return;

  const list = $('component-list');
  list.innerHTML = '<div class="list-placeholder">Loading…</div>';
  updateExportButton();

  const activeOnly = ($('active-only') as HTMLInputElement).checked;

  type ListResponse =
    | { success: true; data: ComponentRef[] }
    | { success: false; error: string };

  const resp = await chrome.runtime.sendMessage<unknown, ListResponse>({
    type: 'LIST_COMPONENTS',
    tabId: currentTab.id,
    componentType: currentComponentType,
    activeOnly,
  });

  if (!resp.success) {
    list.innerHTML = `<div class="list-placeholder" style="color:var(--error)">${resp.error}</div>`;
    return;
  }

  currentComponents = resp.data;
  const count = $('list-count');
  count.textContent = `${currentComponents.length} component${currentComponents.length !== 1 ? 's' : ''}`;

  if (currentComponents.length === 0) {
    list.innerHTML = '<div class="list-placeholder">No components found.</div>';
    updateSelectAll();
    updateExportButton();
    return;
  }

  list.innerHTML = '';
  for (const ref of currentComponents) {
    const label = document.createElement('label');
    label.className = 'component-row';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset['key'] = ref.matchingKey;
    cb.addEventListener('change', () => {
      updateSelectAll();
      updateExportButton();
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'component-name';
    nameSpan.textContent = ref.name;
    nameSpan.title = ref.matchingKey;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `v${ref.version ?? '?'}`;

    label.appendChild(cb);
    label.appendChild(nameSpan);
    label.appendChild(badge);
    list.appendChild(label);
  }

  updateSelectAll();
  updateExportButton();
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

async function handleExport() {
  if (!currentTab?.id) return;

  const keys = getCheckedKeys();
  if (keys.length === 0) return;

  const includeDeps = ($('include-deps') as HTMLInputElement).checked;
  const activeOnly = ($('active-only') as HTMLInputElement).checked;

  setStatus('Exporting…', 'info');
  ($('export-btn') as HTMLButtonElement).disabled = true;

  type ExportResponse =
    | { success: true; data: DataPackBundle }
    | { success: false; error: string };

  try {
    const resp = await chrome.runtime.sendMessage<unknown, ExportResponse>({
      type: 'EXPORT_DATAPACK',
      tabId: currentTab.id,
      componentType: currentComponentType,
      matchingKeys: keys,
      includeDeps,
      activeOnly,
    });

    if (!resp.success) {
      setStatus(resp.error, 'error');
      return;
    }

    const bundle = resp.data;
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const date = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omnistudio-datapack-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);

    setStatus(`Exported ${bundle.dataPacks.length} component${bundle.dataPacks.length !== 1 ? 's' : ''}`, 'success');
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    updateExportButton();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import
// ─────────────────────────────────────────────────────────────────────────────

async function handleImport(file: File) {
  if (!currentTab?.id) return;

  setStatus('Reading file…', 'info');

  let bundle: DataPackBundle;
  try {
    const text = await file.text();
    bundle = JSON.parse(text) as DataPackBundle;
  } catch {
    setStatus('Invalid JSON file', 'error');
    return;
  }

  if (!Array.isArray(bundle.dataPacks)) {
    setStatus('File is not a valid DataPack bundle (missing dataPacks)', 'error');
    return;
  }

  setStatus('Importing…', 'info');

  type ImportResponse =
    | { success: true; data: ImportResult[] }
    | { success: false; error: string };

  try {
    const resp = await chrome.runtime.sendMessage<unknown, ImportResponse>({
      type: 'IMPORT_DATAPACK',
      tabId: currentTab.id,
      bundle,
    });

    if (!resp.success) {
      setStatus(resp.error, 'error');
      return;
    }

    const results = resp.data;
    const created = results.filter((r) => r.action === 'created').length;
    const errors = results.filter((r) => r.action === 'error').length;

    setStatus(
      `Imported: ${created} created, ${errors} error${errors !== 1 ? 's' : ''}`,
      errors > 0 ? 'error' : 'success',
    );

    await loadComponents();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;

  const badge = document.getElementById('org-badge')!;
  const authError = $('auth-error');
  const mainPanel = $('main-panel');

  if (!currentTab?.id) {
    badge.textContent = 'No tab';
    badge.className = 'org-badge error';
    authError.hidden = false;
    return;
  }

  type AuthResponse =
    | { success: true; data: { orgUrl: string; orgDomain: string } }
    | { success: false; error: string };

  const authResp = await chrome.runtime.sendMessage<unknown, AuthResponse>({
    type: 'GET_AUTH',
    tabId: currentTab.id,
  });

  if (!authResp.success) {
    badge.textContent = 'Not connected';
    badge.className = 'org-badge error';
    authError.hidden = false;
    mainPanel.hidden = true;
    return;
  }

  badge.textContent = authResp.data.orgDomain;
  badge.className = 'org-badge connected';
  authError.hidden = true;
  mainPanel.hidden = false;

  // Wire tab buttons
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('[data-type]');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentComponentType = btn.dataset['type'] as ComponentType;
      void loadComponents();
    });
  });

  // Active-only checkbox
  ($('active-only') as HTMLInputElement).addEventListener('change', () => {
    void loadComponents();
  });

  // Select-all checkbox
  const selectAll = document.getElementById('select-all') as HTMLInputElement | null;
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      const checkboxes = document.querySelectorAll<HTMLInputElement>(
        '#component-list input[type="checkbox"]',
      );
      checkboxes.forEach((cb) => {
        cb.checked = selectAll.checked;
      });
      updateExportButton();
    });
  }

  // Export button
  $('export-btn').addEventListener('click', () => {
    void handleExport();
  });

  // Import file input
  const importInput = document.getElementById('import-input') as HTMLInputElement;
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file) {
      void handleImport(file);
      importInput.value = ''; // reset so same file can be re-imported
    }
  });

  // Initial load
  await loadComponents();
});
