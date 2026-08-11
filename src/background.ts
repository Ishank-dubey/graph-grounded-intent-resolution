import { getSessionForTab, getSessionForDomain, listAllOrgSessions } from './auth.js';
import type { OrgSession } from './auth.js';
import { SalesforceAPI } from './sf-api.js';
import { listComponents, exportComponents, preflight } from './datapack/exporter.js';
import { importBundle } from './datapack/importer.js';
import type { ComponentType, OmniBundle } from './types/bundle.js';
import type { ComponentInfo } from './types/debugger.js';

// Track the tab that was active when the extension icon was clicked
let originTabId: number | null = null;

// Domain-to-tab map: populated by tabs.onUpdated so we can attribute webRequest
// calls with tabId=-1 (Salesforce service-worker requests) even after an SW restart
// when originTabId hasn't been restored yet.
const sfDomainToTabId = new Map<string, number>();

// SF URL patterns that should receive the page-hook (must match manifest host_permissions)
const SF_URL_PATTERNS = [
  'https://*.salesforce.com/*',
  'https://*.force.com/*',
];

function isSalesforceUrl(url: string): boolean {
  return /https:\/\/[^/]+(\.salesforce\.com|\.force\.com)\//.test(url);
}

// The `scripting` permission in manifest.json is required specifically for this function.
// page-hook.js must run in world: 'MAIN' (not ISOLATED) so it shares the same JavaScript
// heap as Salesforce Lightning Web Components. That is the only way to intercept the
// omniaggregate / omniactiondebug CustomEvents before LWS (Lightning Web Security) wraps
// them in a Proxy that severs cross-realm object identity.
// chrome.scripting.executeScript with world: 'MAIN' is the only MV3 API that supports this;
// content_scripts with world: 'MAIN' only inject on initial page load and cannot be
// re-triggered programmatically after a navigation or manual reload.
async function injectPageHook(tabId: number): Promise<boolean> {
  try {
    // The MAIN-world hook posts through window.postMessage, so the isolated-world
    // bridge must exist first. Declarative content scripts do not run retroactively
    // when the extension is installed/reloaded while a Salesforce tab is open.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['dist/content.js'],
      world: 'ISOLATED',
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ['dist/page-hook.js'],
      world: 'MAIN',
    });
    // A previously installed hook ignores reinjection via its installation guard.
    // Prompt an immediate heartbeat instead of waiting up to three seconds for its
    // interval, so the first Debugger render can report the correct status.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: () => window.postMessage({ __omniDebug: true, __type: 'heartbeat', timestamp: Date.now() }, '*'),
    });
    return true;
  } catch (_e) {
    // Tab may not be ready yet or URL not permitted — silently ignore
    return false;
  }
}

// Inject page-hook into SF tabs when they finish loading.
// Also keep the domain→tab map current so webRequest can attribute requests when
// the SW just restarted and originTabId hasn't been restored from session storage yet.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isSalesforceUrl(tab.url)) {
    try {
      const domain = new URL(tab.url).hostname;
      sfDomainToTabId.set(domain, tabId);
      chrome.storage.session.set({ sfDomainToTabId: Object.fromEntries(sfDomainToTabId) }).catch(() => {});
    } catch (_) {}
    void injectPageHook(tabId);
  }
});

// Inventory of top-level OmniScript/FlexCard components per tab
const inventoryStore = new Map<number, ComponentInfo[]>();

// Latest DataJSON per tab, keyed by componentId
// Map<tabId, Map<componentId, {source, dataJson, timestamp}>>
const dataJsonStore = new Map<number, Map<string, { source: string; dataJson: unknown; timestamp: number }>>();

// Call trace log per tab, keyed by componentId (ring buffer, max 50 per component)
// Map<tabId, Map<componentId, Array<{callTrace, timestamp}>>>
const callTraceStore = new Map<number, Map<string, Array<{ callTrace: unknown; timestamp: number }>>>();
const CALL_TRACE_MAX = 50;

// Client-side FlexCard events are separate from backend call trace.
const flexCardEventStore = new Map<number, Map<string, Array<{ event: unknown; timestamp: number }>>>();
const FLEXCARD_EVENT_MAX = 100;


type NetworkTrace = {
  params: { sClassName: string; sMethodName: string; input?: unknown; options?: unknown };
  element: { label: string; type: string };
};

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function classifyNetworkCall(className: string, methodName: string, url: string): string {
  const value = `${className} ${methodName} ${url}`.toLowerCase();
  if (value.includes('integrationprocedure') || value.includes('ipservice') || value.includes('omni-global')) {
    return 'integration-procedure-action';
  }
  if (value.includes('dataraptor') || value.includes('datamapper') || value.includes('datatransform')) {
    return 'dataraptor-action';
  }
  if (url.includes('/services/apexrest/')) return 'rest';
  return 'apex';
}

function parseAuraMessage(message: string, url: string): NetworkTrace[] {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(message) as Record<string, unknown>; } catch (_) { return []; }

  const actions = parsed['actions'];
  if (!Array.isArray(actions)) return [];

  const traces: NetworkTrace[] = [];
  for (const rawAction of actions) {
    if (!rawAction || typeof rawAction !== 'object') continue;
    const action = rawAction as Record<string, unknown>;
    const descriptor = String(action['descriptor'] ?? '');
    const outerParams = (action['params'] && typeof action['params'] === 'object')
      ? action['params'] as Record<string, unknown>
      : {} as Record<string, unknown>;

    let className: string;
    let methodName: string;
    let inputParam: unknown;
    let optionsParam: unknown;

    const isOmniDesc = /omni|businessprocessdisplay|genericinvoke/i.test(descriptor);
    const isApexAction = !isOmniDesc && /ApexAction|ACTION\$execute/i.test(descriptor);

    if (isOmniDesc) {
      // ── Route 1: OmniStudio controller (IOmniscriptRuntimeConnect, etc.) ──
      // Four shapes (A1, A2, B, C) — see page-hook.ts processAura for commentary.
      let p: Record<string, unknown>;
      const ldsWrap = outerParams['omniscriptRuntimeGenericInvokeInputRepresentation'];
      if (ldsWrap && typeof ldsWrap === 'object') {
        const lw = ldsWrap as Record<string, unknown>;
        p = (lw['params'] && typeof lw['params'] === 'object')
          ? (lw['params'] as Record<string, unknown>)  // A1
          : lw;                                          // A2
      } else if (outerParams['params'] && typeof outerParams['params'] === 'object') {
        p = outerParams['params'] as Record<string, unknown>;  // B
      } else {
        p = outerParams;                                       // C
      }
      className = String(p['sClassName'] ?? p['className'] ?? '');
      methodName = String(p['sMethodName'] ?? p['methodName'] ?? descriptor.split('/ACTION$')[1] ?? '');
      // For BusinessProcessDisplay* descriptors, require OmniStudio IP params to be present.
      // Bootstrap calls (isOmniStudioTemplateAPIEnabled, LWCPrep, etc.) don't have sClassName/sMethodName.
      if (/businessprocessdisplay/i.test(descriptor) && !p['sClassName'] && !p['sMethodName']) continue;
      inputParam = p['input'];
      optionsParam = p['options'];

    } else if (isApexAction) {
      // ── Route 2: Generic ApexAction controller (aura.ApexAction.execute=1) ──
      // The actual IP class/method sit on outerParams.classname / outerParams.method.
      // Only trace if the inner class looks OmniStudio-related.
      const innerCls = String(outerParams['classname'] ?? outerParams['className'] ?? outerParams['class'] ?? '');
      const innerMthd = String(outerParams['method'] ?? outerParams['methodName'] ?? '');
      const isOmniCls = /omni|integrationprocedure|ipservice|businessprocess|dataraptor|flexcard/i.test(innerCls + ' ' + innerMthd);
      if (!isOmniCls) continue;

      const innerP = (outerParams['params'] && typeof outerParams['params'] === 'object')
        ? (outerParams['params'] as Record<string, unknown>)
        : outerParams;
      className = String(innerP['sClassName'] ?? innerP['className'] ?? innerCls);
      methodName = String(innerP['sMethodName'] ?? innerP['methodName'] ?? innerMthd);
      // Framework bootstrap calls (getOrganizationId, LWCPrep, etc.) have no sClassName /
      // sMethodName in their nested params — real IP invocations always set at least one.
      if (!innerP['sClassName'] && !innerP['sMethodName']) continue;
      inputParam = innerP['input'] ?? innerP['inputMap'];
      optionsParam = innerP['options'];

    } else {
      continue;  // Not an OmniStudio descriptor
    }

    if (!className && !methodName) continue;

    const input = parseJsonString(inputParam);
    const options = parseJsonString(optionsParam);
    const optionsObject = options && typeof options === 'object' ? options as Record<string, unknown> : undefined;
    // For ApexAction path, methodName IS the IP key (e.g. 'Test_Test') — prefer it over className.
    const label = String(optionsObject?.['integrationProcedureKey'] ?? methodName ?? className);

    traces.push({
      params: { sClassName: className, sMethodName: methodName, input, options },
      element: { label, type: classifyNetworkCall(className, methodName, url) },
    });
  }
  return traces;
}

function decodeRequestBody(body: chrome.webRequest.WebRequestBody | null | undefined): string | null {
  if (!body) return null;
  // application/x-www-form-urlencoded — Chrome parses the fields into formData
  const formMessage = body.formData?.['message']?.[0];
  if (formMessage) return formMessage;
  // application/json or other content types — body arrives as raw bytes
  const chunks = body.raw?.flatMap((part) => {
    if (!part.bytes) return [];
    try { return Array.from(new Uint8Array(part.bytes)); } catch (_) { return []; }
  }) ?? [];
  if (chunks.length === 0) return null;
  try { return new TextDecoder().decode(new Uint8Array(chunks)); } catch (_) { return null; }
}

// Dedup window for merging webRequest (null response) with XHR (real response) for
// the SAME single invocation.  Kept at 5 s to cover slow IPs.  The logic below ensures
// rapid back-to-back calls to the same IP are always recorded as separate entries.
const TRACE_DEDUP_MS = 5_000;

function appendCallTrace(tabId: number, componentId: string, callTrace: unknown, timestamp: number): void {
  const byComp = callTraceStore.get(tabId) ?? new Map<string, Array<{ callTrace: unknown; timestamp: number }>>();
  const log = byComp.get(componentId) ?? [];

  // Dedup: the same IP call can arrive from two sources —
  //   • webRequest (onBeforeRequest, fires FIRST, response always null)
  //   • CALL_TRACE_UPDATE from page-hook XHR load listener (fires AFTER response, has real data)
  //
  // Rules:
  //   1. New has real response + old had null  → UPGRADE in-place (same call, richer data)
  //   2. New has no response (webRequest)      → SKIP (old already has something better)
  //   3. New has real response + old has real  → NEW invocation, fall through and ADD
  type CT = { params?: { sClassName?: string; sMethodName?: string }; response?: unknown };
  const newCt = callTrace as CT | null;
  const newCls = newCt?.params?.sClassName ?? '';
  const newMthd = newCt?.params?.sMethodName ?? '';
  const newHasResponse = newCt?.response !== null && newCt?.response !== undefined;

  if (newCls || newMthd) {
    const dupeIdx = log.findIndex(entry => {
      const e = entry.callTrace as CT | null;
      return (e?.params?.sClassName ?? '') === newCls &&
             (e?.params?.sMethodName ?? '') === newMthd &&
             Math.abs(entry.timestamp - timestamp) < TRACE_DEDUP_MS;
    });
    if (dupeIdx !== -1) {
      const oldCt = log[dupeIdx].callTrace as CT | null;
      const oldHasResponse = oldCt?.response !== null && oldCt?.response !== undefined;
      if (!oldHasResponse && newHasResponse) {
        // Rule 1: upgrade null-response entry with the richer XHR trace
        log[dupeIdx] = { callTrace, timestamp };
        byComp.set(componentId, log);
        callTraceStore.set(tabId, byComp);
        return;
      }
      if (!newHasResponse) {
        // Rule 2: incoming has no response (another webRequest); old already has data — skip
        return;
      }
      // Rule 3: both have real responses → distinct new invocation → fall through to append
    }
  }

  log.push({ callTrace, timestamp });
  if (log.length > CALL_TRACE_MAX) log.shift();
  byComp.set(componentId, log);
  callTraceStore.set(tabId, byComp);
}

// OmniStudio's LDS runtime can bypass page-level XHR/fetch. webRequest observes
// the browser transport itself, including Aura genericInvoke and newer Connect
// API calls, without modifying the request.
//
// NOTE: Salesforce Lightning registers its own service worker (e.g. lwr-cache/sw.js)
// which intercepts and re-issues Aura POST requests.  Those SW-issued requests arrive
// here with details.tabId === -1 (no tab).  We must not skip them; instead we
// attribute them to the tab currently being debugged (originTabId).
//
// NOTE: Chrome 115+ classifies page fetch() calls as resource type 'fetch' rather
// than 'xmlhttprequest'.  Removing the types filter avoids silently dropping those.
// We still return early for non-POST requests, so the extra callbacks are cheap.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.method !== 'POST') return;

  // Attribute service-worker requests (tabId=-1) to the currently-debugged tab.
  // originTabId is the first choice; sfDomainToTabId (restored from session storage) is
  // the fallback for when the extension SW has just restarted and originTabId is null.
  let effectiveTabId = details.tabId;
  if (effectiveTabId < 0) {
    if (originTabId !== null) {
      effectiveTabId = originTabId;
    } else {
      try {
        const domain = new URL(details.url).hostname;
        const mapped = sfDomainToTabId.get(domain);
        if (mapped !== undefined) effectiveTabId = mapped;
        else return;
      } catch (_) { return; }
    }
  }

  const requestUrl = details.url.toLowerCase();
  const isAura = requestUrl.includes('/aura') || requestUrl.includes('/sfsites/aura');
  if (isAura) {
    const body = decodeRequestBody(details.requestBody);
    if (!body) {
      // Chrome MV3 service-worker limitation: requestBody is null for some fetch() POSTs.
      // Only record a fallback trace if the URL is an OmniStudio IP endpoint —
      // analytics pings, bootstrap calls, etc. are silently dropped here.
      const isIpEndpoint = /IOmniscriptRuntimeConnect|ApexAction\.execute/i.test(details.url);
      if (!isIpEndpoint) return;
      const auraPath = new URL(details.url).pathname;
      appendCallTrace(effectiveTabId, 'global', {
        params: { sClassName: 'AuraEndpoint', sMethodName: auraPath, input: null, options: null },
        response: null,
        element: { label: auraPath, type: 'apex' },
      }, details.timeStamp);
      return;
    }
    let message = body.trimStart();
    if (!message.startsWith('{') && !message.startsWith('[')) {
      // URL-encoded form body — extract the 'message' field
      try { message = new URLSearchParams(message).get('message') ?? message; } catch (_) {}
    }
    for (const trace of parseAuraMessage(message, details.url)) {
      appendCallTrace(effectiveTabId, 'global', { ...trace, response: null }, details.timeStamp);
    }
    // If parseAuraMessage produced no traces (non-OmniStudio Aura call), don't record noise.
    return;
  }

  // OmniStudio Connect REST API — covers both the dash-separated variants AND
  // the newer omnistudio path: /connect/omnistudio/integrationprocedures/...
  // Previously had '/connect/omni-' which missed '/connect/omnistudio/'.
  const isOmniConnect = requestUrl.includes('/connect/omni');
  const isApexRest = requestUrl.includes('/services/apexrest/');
  // Salesforce Connect API base path: /services/data/vXX/connect/... (OmniStudio, etc.)
  const isConnectData = requestUrl.includes('/services/data/') && requestUrl.includes('/connect/');
  // OmniStudio-specific API paths used by native (non-Aura) runtime
  const isOmniApi = requestUrl.includes('/services/data/') && (
    requestUrl.includes('integrationprocedure') ||
    requestUrl.includes('datatransform') ||
    requestUrl.includes('omniscript') ||
    requestUrl.includes('flexcard')
  );

  if (isOmniConnect || isApexRest || isConnectData || isOmniApi) {
    const path = new URL(details.url).pathname;
    let label = 'Salesforce API';
    if (isApexRest) label = 'Apex REST';
    else if (isOmniConnect || isConnectData || isOmniApi) label = 'Omni Connect API';
    appendCallTrace(effectiveTabId, 'global', {
      params: { sClassName: label, sMethodName: path, input: decodeRequestBody(details.requestBody) },
      response: null,
      element: { label: path, type: classifyNetworkCall('', path, details.url) },
    }, details.timeStamp);
    return;
  }


// No 'types' filter — Chrome 115+ classifies fetch() as type 'fetch' not 'xmlhttprequest';
// omitting the filter ensures we see all request types.  The URL filter + early POST check
// keep the listener fast.
}, { urls: SF_URL_PATTERNS }, ['requestBody']);

// Track whether the page hook is alive per tab (timestamp of last heartbeat)
const hookAliveStore = new Map<number, number>();

// ── Restore persisted state after SW restart ─────────────────────────────────
// Chrome MV3 service workers are killed when idle and restarted on the next event.
// All in-memory state (originTabId, sfDomainToTabId, hookAliveStore) is cleared on
// restart.  We persist critical identifiers to chrome.storage.session (which survives
// SW restarts within a browser session) and restore them here on startup.
void (async () => {
  try {
    type Stored = {
      originTabId?: number;
      sfDomainToTabId?: Record<string, number>;
      lastHookAlive?: Record<string, number>;
    };
    const stored = await chrome.storage.session.get(
      ['originTabId', 'sfDomainToTabId', 'lastHookAlive']
    ) as Stored;

    if (typeof stored.originTabId === 'number') {
      originTabId = stored.originTabId;
    }
    if (stored.sfDomainToTabId && typeof stored.sfDomainToTabId === 'object') {
      for (const [domain, tabId] of Object.entries(stored.sfDomainToTabId)) {
        if (typeof tabId === 'number') sfDomainToTabId.set(domain, tabId);
      }
    }
    // Pre-populate hookAliveStore so the panel does NOT flash "Hook not injected"
    // immediately after a SW restart (the real heartbeat arrives within ~3 seconds).
    if (stored.lastHookAlive && typeof stored.lastHookAlive === 'object') {
      for (const [tabIdStr, ts] of Object.entries(stored.lastHookAlive)) {
        const tabId = Number(tabIdStr);
        if (!isNaN(tabId) && typeof ts === 'number') hookAliveStore.set(tabId, ts);
      }
    }
  } catch (_) {}
})();

// Make toolbar icon toggle the side panel directly (no separate window)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// When the user switches to an SF tab, capture it as the origin tab.
// Only SF tabs update originTabId — switching to a non-SF tab (gmail, etc.) must NOT
// overwrite the correct SF tab ID.
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId).then((tab) => {
    if (tab.url && isSalesforceUrl(tab.url)) {
      originTabId = activeInfo.tabId;
      chrome.storage.session.set({ originTabId: activeInfo.tabId }).catch(() => {});
      void injectPageHook(activeInfo.tabId);
    }
  }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  // onClicked only fires if setPanelBehavior didn't handle it —
  // keep as fallback to capture the tab id and inject the hook
  const tid = tab.id ?? null;
  if (tid && tab.url && isSalesforceUrl(tab.url)) {
    originTabId = tid;
    chrome.storage.session.set({ originTabId: tid }).catch(() => {});
    void injectPageHook(tid);
  }
});

type Message =
  | { type: 'GET_ORIGIN_TAB' }
  | { type: 'GET_AUTH'; tabId: number }
  | { type: 'LIST_SF_ORGS' }
  | { type: 'LIST_COMPONENTS'; tabId: number; orgDomain?: string; componentType: ComponentType; activeOnly: boolean }
  | {
      type: 'EXPORT_DATAPACK';
      tabId: number;
      orgDomain?: string;
      componentType: ComponentType;
      matchingKeys: string[];
      includeDeps: boolean;
      activeOnly: boolean;
    }
  | { type: 'PREFLIGHT'; tabId: number; orgDomain?: string; bundle: OmniBundle }
  | { type: 'IMPORT_DATAPACK'; tabId: number; orgDomain?: string; bundle: OmniBundle }
  | { type: 'INVENTORY_UPDATE'; inventory: ComponentInfo[]; timestamp: number }
  | { type: 'GET_INVENTORY'; tabId: number }
  | { type: 'DATAJSON_UPDATE'; source: string; componentId: string; dataJson: unknown; timestamp: number }
  | { type: 'GET_DATAJSON'; tabId: number; componentId: string }
  | { type: 'CALL_TRACE_UPDATE'; callTrace: unknown; componentId: string; timestamp: number }
  | { type: 'GET_CALL_TRACE'; tabId: number; componentId: string }
  | { type: 'CLEAR_CALL_TRACE'; tabId: number; componentId?: string }
  | { type: 'FLEXCARD_EVENT_UPDATE'; event: unknown; componentId: string; timestamp: number }
  | { type: 'GET_FLEXCARD_EVENTS'; tabId: number; componentId: string }
  | { type: 'CLEAR_FLEXCARD_EVENTS'; tabId: number; componentId?: string }
  | { type: 'RELOAD_TAB'; tabId: number }
  | { type: 'GET_TAB_URL'; tabId: number }
  | { type: 'HOOK_ALIVE'; timestamp: number }
  | { type: 'GET_HOOK_STATUS'; tabId: number }
  | { type: 'ENSURE_DEBUG_HOOK'; tabId: number }
  | { type: 'SET_ORIGIN_TAB'; tabId: number };

type MessageResponse =
  | { success: true; data: unknown; apiVersion?: string }
  | { success: false; error: string };

/**
 * Resolve a session from either an explicit org domain (DataPack org picker) or
 * the tab URL + cookie (legacy / current-tab flow).  orgDomain takes priority.
 */
async function getSession(tabId: number, orgDomain?: string): Promise<OrgSession | null> {
  if (orgDomain) return getSessionForDomain(orgDomain);
  return getSessionForTab(tabId);
}

/**
 * Create a SalesforceAPI instance and immediately detect the highest API
 * version the org supports (GET /services/data/).  Result is cached per
 * org domain for the lifetime of the service worker so subsequent calls
 * within the same session cost no extra round-trips.
 */
async function createApi(session: OrgSession): Promise<SalesforceAPI> {
  const api = new SalesforceAPI(session.orgDomain, session.sid, session.apiVersion);
  await api.detectLatestApiVersion();
  return api;
}

async function handleMessage(msg: Message, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  switch (msg.type) {
    case 'GET_ORIGIN_TAB': {
      return { success: true, data: { tabId: originTabId } };
    }

    case 'SET_ORIGIN_TAB': {
      originTabId = msg.tabId;
      chrome.storage.session.set({ originTabId: msg.tabId }).catch(() => {});
      void injectPageHook(msg.tabId);
      return { success: true, data: null };
    }

    case 'INVENTORY_UPDATE': {
      const tabId = sender.tab?.id;
      if (tabId) {
        inventoryStore.set(tabId, msg.inventory as ComponentInfo[]);
      }
      return { success: true, data: null };
    }

    case 'GET_INVENTORY': {
      return { success: true, data: inventoryStore.get(msg.tabId) ?? [] };
    }

    case 'DATAJSON_UPDATE': {
      const tabId = sender.tab?.id;
      if (tabId) {
        const byComp = dataJsonStore.get(tabId) ?? new Map<string, { source: string; dataJson: unknown; timestamp: number }>();
        byComp.set(msg.componentId, {
          source: msg.source,
          dataJson: msg.dataJson,
          timestamp: msg.timestamp,
        });
        dataJsonStore.set(tabId, byComp);
      }
      return { success: true, data: null };
    }

    case 'GET_DATAJSON': {
      const byComp = dataJsonStore.get(msg.tabId);
      if (!byComp) return { success: true, data: null };

      // Primary: exact componentId match (normal path)
      const specific = byComp.get(msg.componentId);
      if (specific) return { success: true, data: specific };

      // ── Fallback for LWS Proxy ID mismatch ────────────────────────────────
      // Before attribute-based stable IDs were added, buildInventory and
      // patchComponents could assign DIFFERENT comp-N IDs to the same element
      // if LWS returned different Proxy objects on each traversal.  After the
      // fix this should not happen for new sessions, but for existing cached
      // sessions (page-hook already injected at page load) the old WeakMap IDs
      // persist until the page is reloaded.
      //
      // Also handles: omniaggregate attribution failure in LWS
      // → event lands in 'global' instead of the specific component bucket.
      //
      // Safety guard: ONLY apply the fallback when the inventory shows ≤ 1
      // component, so we can be certain any DataJSON on this tab came from that
      // one component (not mixed data from a second component).
      if (msg.componentId !== 'global') {
        const inv = inventoryStore.get(msg.tabId) ?? [];
        if (inv.length <= 1) {
          // Try 'global' first (attribution failure path)
          const globalData = byComp.get('global');
          if (globalData) return { success: true, data: globalData };

          // Try any other comp-N key (Proxy ID mismatch path)
          for (const [k, v] of byComp.entries()) {
            if (k !== 'global') return { success: true, data: v };
          }
        }
      }

      return { success: true, data: null };
    }

    case 'CALL_TRACE_UPDATE': {
      const tabId = sender.tab?.id;
      if (tabId) {
        appendCallTrace(tabId, msg.componentId, msg.callTrace, msg.timestamp);
      }
      return { success: true, data: null };
    }

    case 'GET_CALL_TRACE': {
      const byComp = callTraceStore.get(msg.tabId);
      if (!byComp) return { success: true, data: [] };

      if (msg.componentId === 'global') {
        // 'global' = no specific component selected (panel hasn't identified a
        // component yet, or there are zero inventory entries).  Return ALL traces
        // across every bucket so that both unattributed XHR/webRequest traces
        // (stored under 'global') AND component-attributed omniactiondebug traces
        // (stored under 'comp-1', 'comp-2', etc. by findOwnerInPath) are visible.
        // This is the pre-picker behaviour: show everything.
        const allTraces = Array.from(byComp.values()).flat();
        allTraces.sort((a, b) => a.timestamp - b.timestamp);
        return { success: true, data: allTraces };
      }

      // Specific component selected: its own attributed traces + unattributed
      // network traces (XHR/fetch have no composedPath → always land in 'global').
      const componentLog = byComp.get(msg.componentId) ?? [];
      const globalLog = byComp.get('global') ?? [];
      return {
        success: true,
        data: [...componentLog, ...globalLog].sort((a, b) => a.timestamp - b.timestamp),
      };
    }

    case 'CLEAR_CALL_TRACE': {
      if (msg.componentId) {
        const byComp = callTraceStore.get(msg.tabId);
        byComp?.delete(msg.componentId);
        // The selected component view includes unattributed network calls.
        if (msg.componentId !== 'global') byComp?.delete('global');
      } else {
        // Clear all traces for this tab
        callTraceStore.delete(msg.tabId);
      }
      return { success: true, data: null };
    }

    case 'FLEXCARD_EVENT_UPDATE': {
      const tabId = sender.tab?.id;
      if (tabId) {
        const byComp = flexCardEventStore.get(tabId) ?? new Map<string, Array<{ event: unknown; timestamp: number }>>();
        const events = byComp.get(msg.componentId) ?? [];
        events.push({ event: msg.event, timestamp: msg.timestamp });
        if (events.length > FLEXCARD_EVENT_MAX) events.shift();
        byComp.set(msg.componentId, events);
        flexCardEventStore.set(tabId, byComp);
      }
      return { success: true, data: null };
    }

    case 'GET_FLEXCARD_EVENTS': {
      const byComp = flexCardEventStore.get(msg.tabId);
      if (!byComp) return { success: true, data: [] };
      if (msg.componentId === 'global') {
        return {
          success: true,
          data: Array.from(byComp.values()).flat().sort((a, b) => a.timestamp - b.timestamp),
        };
      }
      return {
        success: true,
        data: [...(byComp.get(msg.componentId) ?? []), ...(byComp.get('global') ?? [])]
          .sort((a, b) => a.timestamp - b.timestamp),
      };
    }

    case 'CLEAR_FLEXCARD_EVENTS': {
      if (msg.componentId) {
        const byComp = flexCardEventStore.get(msg.tabId);
        byComp?.delete(msg.componentId);
        if (msg.componentId !== 'global') byComp?.delete('global');
      } else {
        flexCardEventStore.delete(msg.tabId);
      }
      return { success: true, data: null };
    }

    case 'HOOK_ALIVE': {
      const tabId = sender.tab?.id;
      if (tabId) {
        hookAliveStore.set(tabId, msg.timestamp as number);
        // Persist so next SW restart can pre-populate hookAliveStore and avoid
        // the "Hook not injected" flash before the first real heartbeat arrives.
        const hookTs: Record<string, number> = {};
        hookTs[String(tabId)] = msg.timestamp as number;
        chrome.storage.session.set({ lastHookAlive: hookTs }).catch(() => {});
      }
      return { success: true, data: null };
    }

    case 'GET_HOOK_STATUS': {
      const last = hookAliveStore.get(msg.tabId) ?? 0;
      return { success: true, data: { alive: last > 0, lastSeen: last } };
    }

    case 'ENSURE_DEBUG_HOOK': {
      const installed = await injectPageHook(msg.tabId);
      if (!installed) return { success: false, error: 'Unable to inject debugger into this tab' };
      return { success: true, data: null };
    }

    case 'RELOAD_TAB': {
      dataJsonStore.delete(msg.tabId);
      callTraceStore.delete(msg.tabId);
      flexCardEventStore.delete(msg.tabId);
      hookAliveStore.delete(msg.tabId);
      inventoryStore.delete(msg.tabId);
      await chrome.tabs.reload(msg.tabId);
      // page-hook will be re-injected via tabs.onUpdated when status === 'complete'
      return { success: true, data: null };
    }

    case 'GET_TAB_URL': {
      const tab = await chrome.tabs.get(msg.tabId);
      return { success: true, data: { url: tab.url ?? '' } };
    }

    case 'GET_AUTH': {
      const session = await getSessionForTab(msg.tabId);
      if (!session) {
        return { success: false, error: 'No Salesforce session found for this tab' };
      }
      return {
        success: true,
        data: { orgUrl: session.orgUrl, orgDomain: session.orgDomain },
      };
    }

    case 'LIST_SF_ORGS': {
      const orgs = await listAllOrgSessions();
      return { success: true, data: orgs };
    }

    case 'LIST_COMPONENTS': {
      const session = await getSession(msg.tabId, msg.orgDomain);
      if (!session) {
        return { success: false, error: 'No Salesforce session found — open a Salesforce org in a browser tab' };
      }
      try {
        const api = await createApi(session);
        const components = await listComponents(api, msg.componentType, msg.activeOnly);
        return { success: true, data: components, apiVersion: api.getApiVersion() };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'EXPORT_DATAPACK': {
      const session = await getSession(msg.tabId, msg.orgDomain);
      if (!session) {
        return { success: false, error: 'No Salesforce session found — open a Salesforce org in a browser tab' };
      }
      const api = await createApi(session);

      // Get all refs for the type, filter to selected matching keys
      const allRefs = await listComponents(api, msg.componentType, msg.activeOnly);
      const selectedKeys = new Set(msg.matchingKeys);
      const selected = allRefs.filter((r) => selectedKeys.has(r.matchingKey));

      const bundle = await exportComponents(
        api,
        selected,
        { includeDeps: msg.includeDeps, activeOnly: msg.activeOnly },
        session.orgUrl,
      );

      return { success: true, data: bundle };
    }

    case 'PREFLIGHT': {
      const session = await getSession(msg.tabId, msg.orgDomain);
      if (!session) {
        return { success: false, error: 'No Salesforce session found — open a Salesforce org in a browser tab' };
      }
      const api = await createApi(session);
      const results = await preflight(api, msg.bundle);
      return { success: true, data: results };
    }

    case 'IMPORT_DATAPACK': {
      const session = await getSession(msg.tabId, msg.orgDomain);
      if (!session) {
        return { success: false, error: 'No Salesforce session found — open a Salesforce org in a browser tab' };
      }
      const api = await createApi(session);
      const results = await importBundle(api, msg.bundle);
      return { success: true, data: results };
    }

    default: {
      const unknownMessage = msg as { type?: string };
      return { success: false, error: `Unknown message type: ${unknownMessage.type ?? 'unknown'}` };
    }
  }
}

chrome.runtime.onMessage.addListener(
  (msg: Message, sender: chrome.runtime.MessageSender, sendResponse: (r: MessageResponse) => void) => {
    // headless-background.ts registers its own listener for these types.
    // Returning false here lets that listener claim the response instead of
    // the default case firing first with "Unknown message type".
    const msgType = (msg as { type?: string }).type;
    if (msgType === 'BUILD_HEADLESS_GRAPH' || msgType === 'EINSTEIN_QUERY' || msgType === 'EXECUTE_IP' || msgType === 'EXECUTE_DR' || msgType === 'TEST_AI_KEY') return false;

    handleMessage(msg, sender)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({
          success: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    // Return true to keep the message channel open for async response
    return true;
  },
);
