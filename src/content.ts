// Isolated-world bridge: receives postMessages from page-hook (MAIN world)
// and forwards to background service worker via chrome.runtime.sendMessage.
//
// IMPORTANT: page-hook sends all data as JSON *strings* (not objects) because
// Salesforce LWS wraps everything in Proxy objects that can't be structurally
// cloned. We parse here before forwarding.

/**
 * Send a message to the background service worker, ignoring all errors.
 *
 * Two failure modes must both be handled:
 *   1. Synchronous throw  — "Extension context invalidated" when the extension
 *      is reloaded/updated while this content script is still running in the tab.
 *      chrome.runtime.sendMessage() throws immediately in this case; .catch()
 *      alone cannot intercept a synchronous exception.
 *   2. Promise rejection  — background worker temporarily inactive or other
 *      transient error.  Handled by the .catch(() => {}) below.
 */
function sendSafe(msg: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (_) {
    // Context invalidated — extension was reloaded.  The old content script
    // will be replaced on the next navigation; nothing we can do here.
  }
}

const bridgeWindow = window as unknown as Record<string, unknown>;
if (!bridgeWindow['__omniDebugBridgeInstalled']) {
  bridgeWindow['__omniDebugBridgeInstalled'] = true;

window.addEventListener('message', (event) => {
  // Salesforce Lightning (LWS) posts internal inter-component messages to window.
  // Their event.data is an LWS Proxy object; accessing ANY property on it from
  // outside the LWS sandbox throws a cross-namespace access error.
  // Use try/catch on the guard: a throw here means it is NOT our message — skip it.
  let d: Record<string, unknown> | null = null;
  try {
    d = event.data as Record<string, unknown> | null;
    if (!d || !d['__omniDebug']) return;
  } catch (_) { return; }

  const type = d['__type'] as string | undefined;

  if (type === 'heartbeat') {
    // Confirm hook is alive — send to background so panel can show status
    sendSafe({ type: 'HOOK_ALIVE', timestamp: d['timestamp'] as number });
    return;
  }

  if (type === 'inventory') {
    // inventory is sent as a JSON string (inventoryStr) to survive LWS Proxy cloning
    let inventory: unknown = [];
    try { inventory = JSON.parse(d['inventoryStr'] as string); } catch (_) {}
    sendSafe({ type: 'INVENTORY_UPDATE', inventory: inventory as Record<string, unknown>[], timestamp: d['timestamp'] as number });
    return;
  }

  if (type === 'calltrace') {
    let params: unknown = null;
    let response: unknown = null;
    try { params = JSON.parse(d['paramsStr'] as string); } catch (_) {}
    try { response = JSON.parse(d['responseStr'] as string); } catch (_) {}
    sendSafe({
      type: 'CALL_TRACE_UPDATE',
      callTrace: {
        params,
        response,
        element: { label: d['elementLabel'], type: d['elementType'] },
      },
      componentId: (d['componentId'] as string | undefined) ?? 'global',
      timestamp: d['timestamp'] as number,
    });
    return;
  }

  if (type === 'flexcardevent') {
    let detail: unknown = null;
    try { detail = JSON.parse(d['detailStr'] as string); } catch (_) {}
    sendSafe({
      type: 'FLEXCARD_EVENT_UPDATE',
      event: {
        name: d['eventName'] as string,
        detail,
        source: d['source'] as string,
      },
      componentId: (d['componentId'] as string | undefined) ?? 'global',
      timestamp: d['timestamp'] as number,
    });
    return;
  }

  if (type === 'datajson') {
    let dataJson: unknown = null;
    try { dataJson = JSON.parse(d['dataJsonStr'] as string); } catch (_) {}
    if (dataJson === null) return;
    sendSafe({
      type: 'DATAJSON_UPDATE',
      source: d['source'] as string,
      componentId: (d['componentId'] as string | undefined) ?? 'global',
      dataJson: dataJson as Record<string, unknown>,
      timestamp: d['timestamp'] as number,
    });
    return;
  }
});
}
