import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useExt } from '../context/ExtContext';
import type {
  ComponentRef,
  ComponentType,
  OmniBundle,
  BundleEntry,
  ImportResult,
  PreflightResult,
  OrgInfo,
} from '../../types/bundle.js';
import { JsonHighlight } from '../components/JsonHighlight';

type StatusType = 'success' | 'error' | 'info' | '';
type PreviewMode = 'bundle' | 'preflight' | 'results' | 'component' | 'orgPicker' | null;

interface PreviewState {
  mode: PreviewMode;
  title: string;
  data: unknown;
  onConfirm?: () => void;
}

export default function DataPackTab() {
  const { originTabId } = useExt();

  // ── Component list ─────────────────────────────────────────────────────────
  const [compType, setCompType] = useState<ComponentType>('OmniScript');
  const [components, setComponents] = useState<ComponentRef[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [includeDeps, setIncludeDeps] = useState(true);
  const [activeOnly, setActiveOnly] = useState(false);
  const [loadingList, setLoadingList] = useState(false);

  // ── Org picker ─────────────────────────────────────────────────────────────
  const [orgList, setOrgList] = useState<OrgInfo[]>([]);
  const [sourceOrg, setSourceOrg] = useState<string>('');      // export / list source
  const [importTargetOrg, setImportTargetOrg] = useState<string>('');  // import target
  const [sourceApiVersion, setSourceApiVersion] = useState<string>('');  // detected API version

  // ── Status + preview ───────────────────────────────────────────────────────
  const [status, setStatus] = useState<{ text: string; type: StatusType }>({ text: 'Ready', type: '' });
  const [preview, setPreview] = useState<PreviewState>({ mode: null, title: 'Preview', data: null });

  // ── Operations ─────────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preflight, setPreflight] = useState(false);
  const [pendingImportBundle, setPendingImportBundle] = useState<OmniBundle | null>(null);

  // True whenever any background call is in flight — drives the progress bar + ↻ spin
  const isBusy = loadingList || exporting || importing || preflight;

  const importRef = useRef<HTMLInputElement>(null);

  // ── Fetch org list; sync sourceOrg when originTabId changes ──────────────
  // This runs on mount AND whenever the header org picker changes originTabId.
  // sourceOrg is always updated (not guarded by prev || …) so that switching
  // orgs in the header immediately moves the DataPack tab to that org too.
  useEffect(() => {
    void (async () => {
      type OrgListResponse = { success: true; data: OrgInfo[] } | { success: false; error: string };
      try {
        const resp = await chrome.runtime.sendMessage<unknown, OrgListResponse>({ type: 'LIST_SF_ORGS' });
        if (resp.success && resp.data.length > 0) {
          setOrgList(resp.data);
          // Always track the active org — not guarded by prev so header switches take effect
          const matchingOrg = originTabId != null
            ? resp.data.find(o => o.tabId === originTabId)
            : undefined;
          const defaultOrg = matchingOrg?.orgDomain ?? resp.data[0].orgDomain;
          setSourceOrg(defaultOrg);
          setImportTargetOrg(prev => prev || defaultOrg);
        }
      } catch (_) {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originTabId]);

  // ── Load component list ────────────────────────────────────────────────────
  // Declared BEFORE refreshOrgs so the const is initialised before it appears
  // in refreshOrgs's dependency array (avoids TDZ crash in bundled output).
  const loadComponents = useCallback(async () => {
    if (!sourceOrg && !originTabId) return;
    setLoadingList(true);
    setSelectedKeys(new Set());
    type ListResponse = { success: true; data: ComponentRef[]; apiVersion?: string } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, ListResponse>({
        type: 'LIST_COMPONENTS',
        tabId: originTabId ?? 0,
        orgDomain: sourceOrg || undefined,
        componentType: compType,
        activeOnly,
      });
      if (!resp.success) { setStatus({ text: resp.error, type: 'error' }); return; }
      setComponents(resp.data);
      if (resp.apiVersion) setSourceApiVersion(resp.apiVersion);
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setLoadingList(false);
    }
  }, [originTabId, sourceOrg, compType, activeOnly]);

  useEffect(() => { void loadComponents(); }, [loadComponents]);

  // ── Refresh org list + reload component list ───────────────────────────────
  const refreshOrgs = useCallback(async () => {
    type OrgListResponse = { success: true; data: OrgInfo[] } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, OrgListResponse>({ type: 'LIST_SF_ORGS' });
      if (resp.success) {
        setOrgList(resp.data);
        if (resp.data.length > 0 && !sourceOrg) {
          const defaultOrg = resp.data[0].orgDomain;
          setSourceOrg(defaultOrg);
          setImportTargetOrg(defaultOrg);
        }
      }
    } catch (_) {}
    // Always reload the component list for the current org after refreshing
    await loadComponents();
  }, [sourceOrg, loadComponents]);

  // ── Clear stale view state whenever the source org changes ────────────────
  // loadComponents already reloads the component list + clears selectedKeys.
  // This effect clears the preview panel, status bar, and any pending import
  // so the right panel never shows data that belongs to a different org.
  useEffect(() => {
    setPreview({ mode: null, title: 'Preview', data: null });
    setStatus({ text: 'Ready', type: '' });
    setPendingImportBundle(null);
    setSourceApiVersion('');
  }, [sourceOrg]);

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allKeys = components.map(c => c.matchingKey);
  const allSelected = allKeys.length > 0 && allKeys.every(k => selectedKeys.has(k));
  const someSelected = allKeys.some(k => selectedKeys.has(k));

  const toggleKey = (key: string) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) { setSelectedKeys(new Set()); }
    else { setSelectedKeys(new Set(allKeys)); }
  };

  // ── Export ─────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    if (selectedKeys.size === 0 || (!sourceOrg && !originTabId)) return;
    setExporting(true);
    setStatus({ text: 'Exporting…', type: 'info' });
    type ExportResponse = { success: true; data: OmniBundle } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, ExportResponse>({
        type: 'EXPORT_DATAPACK',
        tabId: originTabId ?? 0,
        orgDomain: sourceOrg || undefined,
        componentType: compType,
        matchingKeys: Array.from(selectedKeys),
        includeDeps,
        activeOnly,
      });
      if (!resp.success) { setStatus({ text: resp.error, type: 'error' }); return; }
      const bundle = resp.data;
      const json = JSON.stringify(bundle, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = url; a.download = `omnistudio-bundle-${date}.json`; a.click();
      URL.revokeObjectURL(url);
      setPreview({ mode: 'bundle', title: 'Exported Bundle', data: bundle });
      setStatus({ text: `Exported ${bundle.entries.length} component${bundle.entries.length !== 1 ? 's' : ''} from ${sourceOrg || 'org'}`, type: 'success' });
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setExporting(false);
    }
  };

  // ── Import — file selected ─────────────────────────────────────────────────
  const handleImportFile = async (file: File) => {
    setStatus({ text: 'Reading file…', type: 'info' });
    let rawBundle: unknown;
    try { rawBundle = JSON.parse(await file.text()); }
    catch { setStatus({ text: 'Invalid JSON file', type: 'error' }); return; }

    const bundleObj = rawBundle as Record<string, unknown>;
    let bundle: OmniBundle;

    if (bundleObj['formatVersion'] === '2.0') {
      bundle = rawBundle as OmniBundle;
    } else if (Array.isArray(bundleObj['dataPacks'])) {
      const legacyEntries = bundleObj['dataPacks'] as Array<Record<string, unknown>>;
      bundle = {
        formatVersion: '2.0',
        exportDate: (bundleObj['exportDate'] as string) ?? new Date().toISOString(),
        exportOrg: (bundleObj['exportOrg'] as string) ?? '',
        entries: legacyEntries.map(convertLegacyEntry),
      };
    } else {
      setStatus({ text: 'Unrecognized bundle format', type: 'error' });
      return;
    }

    // Show the target-org picker before running preflight
    setPendingImportBundle(bundle);
    setPreview({ mode: 'orgPicker', title: 'Select Target Org', data: orgList });
    setStatus({
      text: `${bundle.entries.length} component${bundle.entries.length !== 1 ? 's' : ''} ready — pick target org`,
      type: 'info',
    });
  };

  // ── Preflight ──────────────────────────────────────────────────────────────
  const runPreflightThenImport = async (bundle: OmniBundle, targetOrg: string) => {
    setPreflight(true);
    setStatus({ text: 'Running pre-flight check…', type: 'info' });
    type PreflightResponse = { success: true; data: PreflightResult[] } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, PreflightResponse>({
        type: 'PREFLIGHT',
        tabId: originTabId ?? 0,
        orgDomain: targetOrg || undefined,
        bundle,
      });
      if (!resp.success) { setStatus({ text: resp.error, type: 'error' }); return; }
      setStatus({ text: 'Review the import plan and confirm.', type: 'info' });
      setPreview({
        mode: 'preflight',
        title: `Import Preview → ${targetOrg}`,
        data: resp.data,
        onConfirm: () => {
          setStatus({ text: 'Importing…', type: 'info' });
          void runImportBundle(bundle, targetOrg);
        },
      });
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setPreflight(false);
    }
  };

  // ── Import ─────────────────────────────────────────────────────────────────
  const runImportBundle = async (bundle: OmniBundle, targetOrg: string) => {
    setImporting(true);
    type ImportResponse = { success: true; data: ImportResult[] } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, ImportResponse>({
        type: 'IMPORT_DATAPACK',
        tabId: originTabId ?? 0,
        orgDomain: targetOrg || undefined,
        bundle,
      });
      if (!resp.success) { setStatus({ text: resp.error, type: 'error' }); return; }
      const results = resp.data;
      const errors = results.filter(r => r.action === 'error').length;
      const created = results.filter(r => r.action === 'created').length;
      const withNotes = results.filter(r => r.action === 'created' && r.note).length;
      let statusText: string;
      if (errors > 0) {
        statusText = `${created} created, ${errors} error${errors !== 1 ? 's' : ''} → ${targetOrg}`;
      } else if (withNotes > 0) {
        statusText = `Created ${created} in ${targetOrg} — see results for activation notes`;
      } else {
        statusText = `Created ${created} component${created !== 1 ? 's' : ''} in ${targetOrg}`;
      }
      setStatus({ text: statusText, type: errors > 0 ? 'error' : 'success' });
      setPreview({ mode: 'results', title: 'Import Results', data: results });
      await loadComponents();
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), type: 'error' });
    } finally {
      setImporting(false);
      setPendingImportBundle(null);
    }
  };

  // ── Preview renderer ───────────────────────────────────────────────────────
  const renderPreview = () => {
    if (!preview.mode) {
      return (
        <div className="preview-placeholder">
          <div className="preview-placeholder__icon">⇄</div>
          <p>Select components on the left, then export or import.</p>
          <p className="preview-placeholder__sub">The bundle JSON will appear here after export.</p>
        </div>
      );
    }

    // ── Target org picker ────────────────────────────────────────────────────
    if (preview.mode === 'orgPicker') {
      const orgs = orgList;
      return (
        <div className="preflight-panel">
          <h3 style={{ marginBottom: '12px' }}>Select Target Org</h3>
          {pendingImportBundle && (
            <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '16px' }}>
              {pendingImportBundle.entries.length} component{pendingImportBundle.entries.length !== 1 ? 's' : ''} to import
              {pendingImportBundle.exportOrg ? ` (exported from ${pendingImportBundle.exportOrg})` : ''}
            </p>
          )}
          {orgs.length === 0 ? (
            <div style={{
              padding: '12px 14px', background: '#fff5f5', border: '1px solid #fecaca',
              borderRadius: '6px', color: '#dc2626', fontSize: '13px', marginBottom: '16px',
              lineHeight: 1.5,
            }}>
              No Salesforce orgs with active sessions found.<br />
              Open a Salesforce org in another browser tab, then try again.
            </div>
          ) : (
            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'block', fontSize: '11px', fontWeight: 600, color: '#4b5563',
                textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '6px',
              }}>
                Target org
              </label>
              <select
                className="org-select"
                style={{ width: '100%' }}
                value={importTargetOrg}
                onChange={e => setImportTargetOrg(e.target.value)}
              >
                {orgs.map(o => (
                  <option key={o.orgDomain} value={o.orgDomain}>{o.orgDomain}</option>
                ))}
              </select>
              {importTargetOrg && (
                <p style={{ fontSize: '11px', color: '#6b7280', marginTop: '6px' }}>
                  All components will be created as inactive new versions in this org.
                </p>
              )}
            </div>
          )}
          <div className="preflight-actions">
            <button
              className="btn btn--primary"
              disabled={!importTargetOrg || !pendingImportBundle || orgs.length === 0}
              onClick={() => {
                if (pendingImportBundle && importTargetOrg) {
                  void runPreflightThenImport(pendingImportBundle, importTargetOrg);
                }
              }}
            >
              Continue →
            </button>
            <button className="btn" onClick={() => {
              setPreview({ mode: null, title: 'Preview', data: null });
              setStatus({ text: 'Import cancelled', type: '' });
              setPendingImportBundle(null);
            }}>Cancel</button>
          </div>
        </div>
      );
    }

    // ── Exported bundle tree + JSON ──────────────────────────────────────────
    if (preview.mode === 'bundle') {
      const bundle = preview.data as OmniBundle;
      const json = JSON.stringify(bundle, null, 2);
      return (
        <div>
          {bundle.entries && (
            <div className="dep-tree">
              <div className="dep-tree__heading">Exported {bundle.entries.length} component{bundle.entries.length !== 1 ? 's' : ''}:</div>
              {bundle.entries.map(e => (
                <div key={e.matchingKey}>
                  <div className="dep-tree__row">  └─ {e.matchingKey}</div>
                  {(e.dependencies ?? []).map(d => <div key={d} className="dep-tree__dep">       dep: {d}</div>)}
                  {(e.externalRefs ?? []).map(r => (
                    <div key={`${r.kind}:${r.name}`} className="dep-tree__dep" style={{ color: '#d97706' }}>
                      ⚠ ext: {r.kind}/{r.name}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          <JsonHighlight json={json} />
        </div>
      );
    }

    // ── Preflight confirmation ───────────────────────────────────────────────
    if (preview.mode === 'preflight') {
      const results = preview.data as PreflightResult[];
      const totalWarnings = results.reduce((s, r) => s + (r.warnings?.length ?? 0), 0);
      return (
        <div className="preflight-panel">
          <h3 style={{ marginBottom: '12px' }}>Import Preview</h3>
          <div className="preflight-summary">
            <div className="preflight-stat">
              <div className="preflight-stat__num" style={{ color: '#059669' }}>{results.length}</div>
              <div className="preflight-stat__label">to create</div>
            </div>
            {totalWarnings > 0 && (
              <div className="preflight-stat">
                <div className="preflight-stat__num" style={{ color: '#d97706' }}>{totalWarnings}</div>
                <div className="preflight-stat__label">warning{totalWarnings !== 1 ? 's' : ''}</div>
              </div>
            )}
          </div>
          {totalWarnings > 0 && (
            <div style={{
              padding: '8px 12px', marginBottom: '10px',
              background: '#fffbeb', border: '1px solid #fde68a',
              borderRadius: '6px', fontSize: '12px', color: '#92400e', lineHeight: 1.5,
            }}>
              ⚠ Some components reference Apex classes or LWC components that are missing in the target org.
              The import will still proceed — affected elements will fail at runtime until those artefacts exist.
            </div>
          )}
          {results.map(r => (
            <div key={r.displayName} className="preflight-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <span className="badge badge-create">CREATE v{r.targetVersion}</span>
                <span className="preflight-key">{r.displayName}</span>
                {r.activeVersion != null && (
                  <span style={{ fontSize: '11px', color: '#d97706', marginLeft: 6 }}>
                    active: v{r.activeVersion}
                  </span>
                )}
                {r.existingVersions.filter(v => v !== r.activeVersion).length > 0 && (
                  <span style={{ fontSize: '11px', color: '#6b7280', marginLeft: 4 }}>
                    inactive: {r.existingVersions.filter(v => v !== r.activeVersion).map(v => `v${v}`).join(', ')}
                  </span>
                )}
              </div>
              {r.warnings && r.warnings.map((w, wi) => (
                <div key={wi} style={{ fontSize: '11px', color: '#b45309', paddingLeft: '4px', marginTop: '3px' }}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          ))}
          <div className="preflight-actions">
            <button className="btn btn--primary" onClick={preview.onConfirm}>Confirm Import</button>
            <button className="btn" onClick={() => {
              setPreview({ mode: null, title: 'Preview', data: null });
              setStatus({ text: 'Import cancelled', type: '' });
            }}>Cancel</button>
          </div>
        </div>
      );
    }

    // ── Import results ───────────────────────────────────────────────────────
    if (preview.mode === 'results') {
      const results = preview.data as ImportResult[];
      return (
        <div className="results-view">
          <h3>Import Results</h3>
          {results.map((r, i) => (
            <div key={i} className="result-row">
              <span className={`result-badge result-badge--${r.action}`}>{r.action}</span>
              <span>{r.matchingKey ?? '(unknown)'}</span>
              {r.error && <span style={{ color: '#dc2626', fontSize: '12px' }}>{r.error}</span>}
              {r.note && <span style={{ color: '#d97706', fontSize: '12px' }}>⚠ {r.note}</span>}
            </div>
          ))}
        </div>
      );
    }

    // ── Component JSON preview ───────────────────────────────────────────────
    if (preview.mode === 'component') {
      return <JsonHighlight json={JSON.stringify(preview.data, null, 2)} />;
    }

    return null;
  };

  const canCopyPreview = preview.mode === 'bundle' || preview.mode === 'component';
  const copyPreviewJson = () => {
    const json = JSON.stringify(preview.data, null, 2);
    void navigator.clipboard.writeText(json);
  };

  const COMP_TYPES: { type: ComponentType; label: string }[] = [
    { type: 'OmniScript', label: 'OmniScript' },
    { type: 'IntegrationProcedure', label: 'IP' },
    { type: 'OmniUiCard', label: 'FlexCard' },
    { type: 'DataRaptor', label: 'DataRaptor' },
  ];

  const statusColor = status.type === 'error' ? '#dc2626' : status.type === 'success' ? '#059669' : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>

      {/* ── Thin progress bar — always takes space; fill only when busy ──── */}
      <div className="dp-progress-bar">
        {isBusy && <div className="dp-progress-bar__fill" />}
      </div>

      {/* ── Full-panel overlay — blocks all interaction while busy ────────── */}
      {isBusy && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 100,
          cursor: 'wait',
          background: 'rgba(255,255,255,0.35)',
        }} />
      )}

      <div className="main-panel" style={{ flex: 1, minHeight: 0 }}>
        <aside className="sidebar">

          {/* ── Source org selector ─────────────────────────────────────── */}
          <div className="org-selector-row">
            <span className="org-selector-label">Source</span>
            <select
              className="org-select org-select--inline"
              value={sourceOrg}
              onChange={e => setSourceOrg(e.target.value)}
              disabled={orgList.length === 0}
              title={sourceOrg || 'No orgs detected'}
            >
              {orgList.length === 0 ? (
                <option value="">No orgs found</option>
              ) : (
                orgList.map(o => (
                  <option key={o.orgDomain} value={o.orgDomain}>{o.orgDomain}</option>
                ))
              )}
            </select>
            {sourceApiVersion ? (
              <span style={{
                fontSize: '10px', fontWeight: 600, color: '#6b7280',
                background: '#f3f4f6', border: '1px solid #e5e7eb',
                borderRadius: '4px', padding: '1px 5px', whiteSpace: 'nowrap',
              }} title={`API version in use for ${sourceOrg}`}>
                {sourceApiVersion}
              </span>
            ) : null}
            <button
              className={`org-refresh-btn${isBusy ? ' is-spinning' : ''}`}
              onClick={() => { void refreshOrgs(); }}
              disabled={isBusy}
              title={isBusy ? 'Loading…' : 'Refresh org list'}
            >↻</button>
          </div>

          {/* ── Type tabs ───────────────────────────────────────────────── */}
          <div className="tab-bar">
            {COMP_TYPES.map(ct => (
              <button
                key={ct.type}
                className={`tab${compType === ct.type ? ' tab--active' : ''}`}
                onClick={() => setCompType(ct.type)}
              >
                {ct.label}
              </button>
            ))}
          </div>

          {/* ── Options ─────────────────────────────────────────────────── */}
          <div className="options-section">
            <label className="option-row">
              <input type="checkbox" checked={includeDeps} onChange={e => setIncludeDeps(e.target.checked)} />
              <span>Include dependencies</span>
            </label>
            <label className="option-row">
              <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} />
              <span>Active only</span>
            </label>
            <p className="options-note">
              Only record-based components (created via the designer) are listed.
              File-based / source-deployed components are not included.
            </p>
          </div>

          {/* ── Component list header ────────────────────────────────────── */}
          <div className="list-header">
            <label className="option-row">
              <input
                type="checkbox"
                checked={allSelected}
                ref={el => { if (el) el.indeterminate = someSelected && !allSelected; }}
                onChange={toggleAll}
              />
              <span className="list-header__label">Component</span>
            </label>
            <span className="list-header__version">Ver</span>
          </div>

          {/* ── Component list ───────────────────────────────────────────── */}
          <div className="component-list">
            {loadingList ? (
              <div className="loading-state"><div className="dp-spinner" /></div>
            ) : components.length === 0 ? (
              <div className="empty-state">No components found.</div>
            ) : (
              components.map(ref => (
                <div
                  key={ref.matchingKey}
                  className={`component-row${selectedKeys.has(ref.matchingKey) ? ' is-selected' : ''}`}
                  onClick={e => {
                    if ((e.target as HTMLElement).tagName === 'INPUT') return;
                    toggleKey(ref.matchingKey);
                    setPreview({
                      mode: 'component', title: ref.name,
                      data: { type: ref.type, matchingKey: ref.matchingKey, version: ref.version, isActive: ref.isActive, id: ref.id },
                    });
                  }}
                >
                  <div className="component-row__left">
                    <input
                      type="checkbox"
                      checked={selectedKeys.has(ref.matchingKey)}
                      onChange={() => toggleKey(ref.matchingKey)}
                      onClick={e => e.stopPropagation()}
                    />
                    <span className="component-row__name" title={ref.matchingKey}>{ref.name}</span>
                  </div>
                  <span className="component-row__version">v{ref.version ?? '?'}</span>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ── Preview panel ─────────────────────────────────────────────── */}
        <section className="preview-panel">
          <div className="preview-toolbar">
            <span className="preview-title">{preview.title || 'Select a component to preview'}</span>
            {canCopyPreview && (
              <button className="copy-btn" onClick={copyPreviewJson}>⧉ Copy</button>
            )}
          </div>
          <div className="preview-content" style={{ flex: 1, overflow: 'auto' }}>
            {renderPreview()}
          </div>
        </section>
      </div>

      {/* ── Action bar ──────────────────────────────────────────────────── */}
      <footer className="action-bar">
        <div className="action-bar__left">
          <button
            className="btn btn--primary"
            disabled={selectedKeys.size === 0 || exporting}
            onClick={handleExport}
          >
            {exporting ? '↓ Exporting…' : '↓ Export selected'}
          </button>
          <label
            className="btn btn--secondary"
            style={importing ? { opacity: 0.5, cursor: 'default', pointerEvents: 'none' } : undefined}
            title={importing ? 'Import in progress…' : 'Import a JSON bundle file'}
          >
            {importing ? '↑ Importing…' : '↑ Import…'}
            <input
              ref={importRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              disabled={importing}
              onChange={e => {
                const file = e.target.files?.[0];
                if (file && !importing) { void handleImportFile(file); e.target.value = ''; }
              }}
            />
          </label>
        </div>
        <div className="action-bar__status">
          <span style={{ color: statusColor }}>{status.text}</span>
        </div>
      </footer>
    </div>
  );
}

// ── Legacy v1.0 DataPack converter ────────────────────────────────────────────
function convertLegacyEntry(e: Record<string, unknown>): BundleEntry {
  const type = (e['VlocityDataPackType'] as ComponentType) ?? 'OmniScript';
  const matchingKey = (e['VlocityMatchingRecordSourceKey'] as string) ?? '';
  const data = (e['VlocityDataPackData'] as Record<string, Array<Record<string, unknown>>>) ?? {};
  const lookupList = e['VlocityLookupRecordList'] as Array<Record<string, unknown>> | undefined;
  const entry: BundleEntry = {
    type, matchingKey,
    exportedAt: new Date().toISOString(),
    dependencies: (lookupList ?? []).map(l => (l['VlocityMatchingRecordSourceKey'] as string) ?? ''),
  };
  if (type === 'OmniScript' || type === 'IntegrationProcedure') {
    const processArr = data['OmniProcess'];
    if (processArr?.length > 0) {
      const { OmniProcessElement: elemWrap, ...procFields } = processArr[0];
      entry.process = procFields as unknown as import('../../types/bundle.js').OmniScriptRecord;
      entry.elements = ((elemWrap as { records?: unknown[] } | undefined)?.records ?? []) as import('../../types/bundle.js').OmniElementRecord[];
    }
  } else if (type === 'OmniUiCard') {
    const cardArr = data['OmniUiCard'];
    if (cardArr?.length > 0) entry.card = cardArr[0] as unknown as import('../../types/bundle.js').OmniUiCardRecord;
  } else if (type === 'DataRaptor') {
    const trArr = data['OmniDataTransform'];
    if (trArr?.length > 0) {
      const { OmniDataTransformItem: itemWrap, ...trFields } = trArr[0];
      entry.transform = trFields as unknown as import('../../types/bundle.js').OmniDataTransformRecord;
      entry.transformItems = ((itemWrap as { records?: unknown[] } | undefined)?.records ?? []) as import('../../types/bundle.js').OmniDataTransformItemRecord[];
    }
  }
  return entry;
}
