import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useExt } from '../context/ExtContext';
import { JsonTree } from '../components/JsonTree';
import { CallTraceCard } from '../components/CallTraceCard';
import { ComponentPicker } from '../components/ComponentPicker';
import { FlexCardEventCard } from '../components/FlexCardEventCard';
import type { ComponentInfo } from '../../types/debugger';

type CallTraceEntry = { callTrace: unknown; timestamp: number };
type FlexCardEventEntry = { event: { name?: string; detail?: unknown; source?: string }; timestamp: number };

export default function DebuggerTab() {
  const { originTabId } = useExt();
  const [subTab, setSubTab] = useState<'datajson' | 'events' | 'calltrace'>('datajson');

  // Component inventory — all top-level OS/FC found on the page
  const [inventory, setInventory] = useState<ComponentInfo[]>([]);
  // The component the user has selected (null = none yet)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Track previous inventory length so we can detect growth from 1 → 2+
  const prevInventoryLenRef = useRef(0);

  const [dataJson, setDataJson] = useState<{ source: string; data: unknown; timestamp: number } | null>(null);
  const [hookAlive, setHookAlive] = useState(false);
  const [hookChecking, setHookChecking] = useState(true);
  const [callTrace, setCallTrace] = useState<CallTraceEntry[]>([]);
  const [flexCardEvents, setFlexCardEvents] = useState<FlexCardEventEntry[]>([]);
  const [tabUrl, setTabUrl] = useState('');
  const [reloading, setReloading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-select / reset logic driven by inventory changes.
  //
  // Invariants:
  //   0 components  → clear selection
  //   1 component   → auto-select it (convenience: no picker needed)
  //   1 → 2+ grow  → RESET to null so the picker requires an explicit choice
  //                   (prevents a silently auto-selected "wrong" component
  //                    when a second OS/FC mounts slightly after the first)
  //   was already 2+ → keep selection unless that component disappeared
  useEffect(() => {
    const prev = prevInventoryLenRef.current;
    prevInventoryLenRef.current = inventory.length;

    if (inventory.length === 0) {
      setSelectedId(null);
    } else if (inventory.length === 1) {
      setSelectedId(inventory[0].id);
    } else if (prev <= 1) {
      // Grew from 0-1 → 2+: clear any auto-selection and show the picker
      setSelectedId(null);
    } else {
      // Was already 2+: preserve selection unless that component left the page
      setSelectedId(cur => (cur !== null && !inventory.find(c => c.id === cur) ? null : cur));
    }
  }, [inventory]);

  const poll = useCallback(async () => {
    if (!originTabId) return;

    // Poll inventory
    type InvResponse = { success: true; data: ComponentInfo[] } | { success: false; error: string };
    const invResp = await chrome.runtime.sendMessage<unknown, InvResponse>({ type: 'GET_INVENTORY', tabId: originTabId });
    if (invResp.success) setInventory(invResp.data);

    // Poll hook status
    type HookResp = { success: true; data: { alive: boolean } } | { success: false; error: string };
    const hookResp = await chrome.runtime.sendMessage<unknown, HookResp>({ type: 'GET_HOOK_STATUS', tabId: originTabId });
    if (hookResp.success) setHookAlive(hookResp.data.alive);

    // Use the selected component, or fall back to 'global' (single-component /
    // unattributed case — same as pre-picker behaviour).
    const effectiveId = selectedId ?? 'global';

    type DJResponse = { success: true; data: { source: string; dataJson: unknown; timestamp: number } | null } | { success: false; error: string };
    const djResp = await chrome.runtime.sendMessage<unknown, DJResponse>({ type: 'GET_DATAJSON', tabId: originTabId, componentId: effectiveId });
    if (djResp.success && djResp.data) {
      setDataJson({ source: djResp.data.source, data: djResp.data.dataJson, timestamp: djResp.data.timestamp });
    } else {
      setDataJson(null);
    }

    type CTResponse = { success: true; data: CallTraceEntry[] } | { success: false; error: string };
    const ctResp = await chrome.runtime.sendMessage<unknown, CTResponse>({ type: 'GET_CALL_TRACE', tabId: originTabId, componentId: effectiveId });
    if (ctResp.success) setCallTrace(ctResp.data);

    type EventResponse = { success: true; data: FlexCardEventEntry[] } | { success: false; error: string };
    const eventResp = await chrome.runtime.sendMessage<unknown, EventResponse>({ type: 'GET_FLEXCARD_EVENTS', tabId: originTabId, componentId: effectiveId });
    if (eventResp.success) setFlexCardEvents(eventResp.data);
  }, [originTabId, selectedId]);

  useEffect(() => {
    if (!originTabId) return;
    // The Salesforce page may predate extension installation, in which case
    // declarative content scripts never ran. Ensure both bridge and MAIN hook
    // when the Debugger is first opened; no Salesforce page reload is required.
    setHookChecking(true);
    void (async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'ENSURE_DEBUG_HOOK', tabId: originTabId });
      } catch (_) {
        // poll() below determines the user-facing status.
      } finally {
        await poll();
        setHookChecking(false);
      }
    })();
    intervalRef.current = setInterval(() => void poll(), 1500);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [originTabId, poll]);

  useEffect(() => {
    if (!originTabId) return;
    type UrlResp = { success: true; data: { url: string } } | { success: false; error: string };
    chrome.runtime.sendMessage<unknown, UrlResp>({ type: 'GET_TAB_URL', tabId: originTabId })
      .then(r => { if (r.success) { try { setTabUrl(new URL(r.data.url).hostname); } catch { setTabUrl(r.data.url); } } })
      .catch(() => {});
  }, [originTabId]);

  const handleReload = async () => {
    if (!originTabId) return;
    setReloading(true);
    setInventory([]);
    setSelectedId(null);
    setDataJson(null);
    setCallTrace([]);
    setFlexCardEvents([]);
    await chrome.runtime.sendMessage({ type: 'RELOAD_TAB', tabId: originTabId });
    setTimeout(() => setReloading(false), 3000);
  };

  const handleClearTrace = async () => {
    if (!originTabId) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_CALL_TRACE', tabId: originTabId, componentId: selectedId ?? 'global' });
    setCallTrace([]);
  };

  const handleClearEvents = async () => {
    if (!originTabId) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_FLEXCARD_EVENTS', tabId: originTabId, componentId: selectedId ?? 'global' });
    setFlexCardEvents([]);
  };

  const reversed = [...callTrace].reverse();
  const reversedEvents = [...flexCardEvents].reverse();

  // What to show in the body when no component is selected yet
  const noSelection = hookAlive && inventory.length > 1 && !selectedId;

  return (
    <div className="debugger-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Sub-tab bar */}
      <div className="dbg-tabs">
        <button className={`dbg-tab${subTab === 'datajson' ? ' dbg-tab--active' : ''}`} onClick={() => setSubTab('datajson')}>
          DataJSON
        </button>
        <button className={`dbg-tab${subTab === 'events' ? ' dbg-tab--active' : ''}`} onClick={() => setSubTab('events')}>
          Events
          {flexCardEvents.length > 0 && <span className="dbg-tab__badge">{flexCardEvents.length}</span>}
        </button>
        <button className={`dbg-tab${subTab === 'calltrace' ? ' dbg-tab--active' : ''}`} onClick={() => setSubTab('calltrace')}>
          Call Trace
          {callTrace.length > 0 && <span className="dbg-tab__badge">{callTrace.length}</span>}
        </button>
        <div className="dbg-tabs__spacer" />
        {tabUrl && <span className="dbg-tab-url" title={tabUrl}>{tabUrl}</span>}
        {subTab === 'calltrace' && callTrace.length > 0 && (
          <button className="dbg-clear-btn" onClick={handleClearTrace}>✕ Clear</button>
        )}
        {subTab === 'events' && flexCardEvents.length > 0 && (
          <button className="dbg-clear-btn" onClick={handleClearEvents}>✕ Clear</button>
        )}
      </div>

      {/* Component picker — shown only when 2+ components exist on the page */}
      {inventory.length > 1 && (
        <ComponentPicker
          components={inventory}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {/* ── DataJSON pane ── */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: subTab === 'datajson' ? 'flex' : 'none', flexDirection: 'column' }}>
        {noSelection ? (
          <div className="dj-waiting">
            <div className="dj-waiting__icon">⬡</div>
            <p>{inventory.length} components on this page</p>
            <p className="dj-waiting__sub">Select one above to inspect its DataJSON state.</p>
          </div>
        ) : !dataJson ? (
          <div className="dj-waiting">
            <div className="dj-waiting__icon">{hookChecking ? '…' : hookAlive ? '⬡' : '⚠'}</div>
            <p>{hookChecking
              ? 'Connecting debugger…'
              : hookAlive
              ? selectedId
                ? (inventory.find(c => c.id === selectedId)?.kind === 'FlexCard'
                  ? 'Waiting for FlexCard data…'
                  : 'Waiting for OmniScript…')
                : 'Waiting for component…'
                : 'Hook not injected'}</p>
            <p className="dj-waiting__sub">
              {hookChecking
                ? 'Attaching to the current Salesforce tab. No page reload is required.'
                : hookAlive
                ? selectedId && inventory.find(c => c.id === selectedId)?.kind === 'FlexCard'
                  ? 'Hook is active. FlexCard state updates every 1.5 s and after each data-source call.'
                  : 'Hook is active. Navigate to a page with an OmniScript or FlexCard and interact with it.'
                : 'Click Reload Salesforce tab to inject the hook, then interact with an OmniScript.'}
            </p>
            <button className="btn btn--sm dj-waiting__reload" disabled={reloading || hookChecking} onClick={handleReload}>
              {reloading ? 'Reloading…' : '↺ Reload Salesforce tab'}
            </button>
          </div>
        ) : (
          <>
            <div className="dj-toolbar">
              <span className="dj-toolbar__title">DataJSON</span>
              <span className="dj-toolbar__source">{dataJson.source}</span>
              <span className="dj-toolbar__time">updated {new Date(dataJson.timestamp).toLocaleTimeString()}</span>
              <button className="dj-copy-btn" onClick={() => void navigator.clipboard.writeText(JSON.stringify(dataJson.data, null, 2))}>
                ⧉ Copy
              </button>
            </div>
            {dataJson.source !== 'FlexCard' && !('omniProcessId' in (dataJson.data as Record<string, unknown>)) && (
              <div className="dj-partial-banner">
                ⚠ Partial state — system keys appear after first interaction
              </div>
            )}
            <JsonTree data={dataJson.data} />
          </>
        )}
      </div>

      {/* FlexCard client-side event pane */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: subTab === 'events' ? 'block' : 'none' }}>
        {noSelection ? (
          <div className="dj-waiting">
            <div className="dj-waiting__icon">◇</div>
            <p>{inventory.length} components on this page</p>
            <p className="dj-waiting__sub">Select a FlexCard above to inspect its client-side events.</p>
          </div>
        ) : reversedEvents.length === 0 ? (
          <div className="dj-waiting">
            <div className="dj-waiting__icon">◇</div>
            <p>{hookChecking ? 'Connecting debugger…' : hookAlive ? 'Waiting for FlexCard events…' : 'Hook not injected'}</p>
            <p className="dj-waiting__sub">
              {hookChecking
                ? 'Attaching to the current Salesforce tab. No page reload is required.'
                : hookAlive
                ? 'Interact with the FlexCard. Actions and record-update events appear here; backend requests remain in Call Trace.'
                : 'Reload the Salesforce tab to inject the debugger hook.'}
            </p>
          </div>
        ) : (
          reversedEvents.map((entry, i) => <FlexCardEventCard key={i} entry={entry} />)
        )}
      </div>

      {/* ── Call Trace pane ── */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: subTab === 'calltrace' ? 'block' : 'none' }}>
        {noSelection ? (
          <div className="dj-waiting">
            <div className="dj-waiting__icon">◎</div>
            <p>{inventory.length} components on this page</p>
            <p className="dj-waiting__sub">Select one above to see its Call Trace.</p>
          </div>
        ) : reversed.length === 0 ? (
          <div className="dj-waiting">
            <div className="dj-waiting__icon">{hookChecking ? '…' : hookAlive ? '◎' : '⚠'}</div>
            <p>{hookChecking ? 'Connecting debugger…' : hookAlive ? 'Waiting for calls…' : 'Hook not injected'}</p>
            <p className="dj-waiting__sub">
              {hookChecking
                ? 'Attaching to the current Salesforce tab. No page reload is required.'
                : hookAlive
                ? selectedId && inventory.find(c => c.id === selectedId)?.kind === 'FlexCard'
                  ? 'Interact with the FlexCard to record its IP, DataRaptor, and Apex calls.'
                  : 'Interact with an OmniScript or FlexCard to record its Apex, IP, DataRaptor and REST calls.'
                : 'Reload the Salesforce tab to inject the debugger hook, then interact with the component.'}
            </p>
            <button className="btn btn--sm dj-waiting__reload" disabled={reloading || hookChecking} onClick={handleReload}>
              {reloading ? 'Reloading…' : '↺ Reload Salesforce tab'}
            </button>
          </div>
        ) : (
          reversed.map((entry, i) => <CallTraceCard key={i} entry={entry} />)
        )}
      </div>
    </div>
  );
}
