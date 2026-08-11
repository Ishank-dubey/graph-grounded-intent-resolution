// Runs in world: "MAIN" (real page JS context).
// Salesforce uses Lightning Web Security (LWS) which wraps everything in Proxies.
// CRITICAL: Never pass LWS Proxy objects directly to window.postMessage — the
// structured-clone algorithm throws DataCloneError on Proxies.
// Solution: always JSON.stringify → send as string → JSON.parse in bridge.

(function () {
  if ((window as unknown as Record<string, unknown>)['__omniDebugInstalled']) return;
  (window as unknown as Record<string, unknown>)['__omniDebugInstalled'] = true;

  // ── Stable component IDs ─────────────────────────────────────────────────────
  // Each top-level OmniScript/FlexCard element gets an ID on first sight.
  //
  // IMPORTANT — Proxy identity problem:
  // In LWS-enabled orgs, the same DOM element can be returned as different Proxy
  // objects by different DOM traversal calls (queryShadowTopLevel vs queryShadowAll).
  // WeakMap keys on the Proxy instance, NOT the underlying element, so
  //   compIdMap.get(proxyA) !== compIdMap.get(proxyB)
  // even when proxyA and proxyB both wrap the same element.
  //
  // Fix: store the ID as a DOM attribute on the element itself ('data-omni-dbg-id').
  // Attributes live on the underlying DOM node and are accessible through any Proxy
  // wrapper, so getOrAssignId always returns the same ID regardless of which Proxy
  // was returned by the current traversal path.
  const compIdMap = new WeakMap<Element, string>();
  let compIdCounter = 0;
  const OMNI_DBG_ATTR = 'data-omni-dbg-id';

  function getOrAssignId(el: Element): string {
    // 1. Attribute-first: read ID from the element itself (stable across Proxy instances)
    try {
      const existing = el.getAttribute(OMNI_DBG_ATTR);
      if (existing) {
        // Also warm WeakMap so same-proxy repeated lookups are free
        try { if (!compIdMap.has(el)) compIdMap.set(el, existing); } catch (_) {}
        return existing;
      }
    } catch (_) {}

    // 2. Assign a fresh ID
    const id = `comp-${++compIdCounter}`;

    // Write to the element itself (survives future Proxy re-wrapping)
    try { el.setAttribute(OMNI_DBG_ATTR, id); } catch (_) {}
    // Also WeakMap for same-proxy-instance fast reads
    try { compIdMap.set(el, id); } catch (_) {}

    return id;
  }

  // ── Component discovery helpers ──────────────────────────────────────────────
  // Tag name = "namespace-componentname" in kebab-case.
  // Covers: managed package (omnistudio), native core (runtime_omnistudio_omniscript),
  // Vlocity CMT/INS managed packages, and legacy c-namespace.
  // Known top-level host element tags. Used as a fast-path exact lookup.
  // NOTE: runtime_omnistudio_omniscript-omniscript-header is intentionally
  // excluded — it is an internal sub-component that renders INSIDE omni-script,
  // not a separate top-level component. Including it inflates the inventory count.
  const OMNI_TAGS = [
    // ── OmniScript host elements ────────────────────────────────────────────
    'omnistudio-omni-script',                            // managed package
    'runtime_omnistudio-omniscript',                     // native core (runtime_omnistudio namespace)
    'runtime_omnistudio_omniscript-omni-script',         // native core (runtime_omnistudio_omniscript namespace)
    'vlocity_cmt-omni-script',                          // Vlocity CMT
    'vlocity_ins-omni-script',                          // Vlocity INS
    'c-omni-script',                                    // legacy / community
    // ── FlexCard host elements ───────────────────────────────────────────────
    'omnistudio-flex-card',                              // managed package
    'runtime_omnistudio_flexcards-flex-card',            // native core
    'vlocity_cmt-flex-card',                            // Vlocity CMT
    'vlocity_ins-flex-card',                            // Vlocity INS
    'c-flex-card',                                      // legacy / community
  ];
  // Set for O(1) exact lookup
  const OMNI_TAGS_SET = new Set(OMNI_TAGS);

  // Match any element whose tag name signals an OmniScript or FlexCard component.
  // Exact-match the known list first (fast path), then fall back to substring
  // matching to catch namespace variants not yet in the list above (e.g. new SF
  // release prefixes, custom org namespaces, or Vlocity sub-packages).
  function isOmniTag(tag: string): boolean {
    if (OMNI_TAGS_SET.has(tag)) return true;
    return (
      tag.includes('omni-script') || tag.includes('omniscript') || tag.includes('omni_script') ||
      tag.includes('flex-card')   || tag.includes('flexcard')
    );
  }

  function kindForTag(tag: string): 'OmniScript' | 'FlexCard' | 'Unknown' {
    if (tag.includes('flex-card') || tag.includes('flexcard')) return 'FlexCard';
    if (tag.includes('omni-script') || tag.includes('omniscript') || tag.includes('omni_script')) return 'OmniScript';
    return 'Unknown';
  }

  function labelForElement(el: Element): string {
    // Try to extract a human-readable label from the LWC VM component internals.
    for (const k of ['__lwcVM', '_lwcVM', '__vm', '__lwcInternal']) {
      try {
        const vm = (el as unknown as Record<string, unknown>)[k];
        if (!vm) continue;
        const comp = ((vm as Record<string, unknown>)['component'] ?? vm) as Record<string, unknown>;
        // OmniScript: jsonDef has Type/SubType
        const jd = comp['jsonDef'] as Record<string, unknown> | undefined;
        if (jd?.['Type'] && jd?.['SubType']) return `${jd['Type']} / ${jd['SubType']}`;
        if (jd?.['name']) return String(jd['name']);
        // FlexCard: cardName or flexCardDef.Name
        if (comp['cardName']) return String(comp['cardName']);
        const fcd = comp['flexCardDef'] as Record<string, unknown> | undefined;
        if (fcd?.['Name']) return String(fcd['Name']);
        // IP: type + subType on component root
        if (comp['type'] && comp['subType']) return `${comp['type']} / ${comp['subType']}`;
      } catch (_) {}
    }
    // Fallback: tag name without namespace prefix
    const parts = el.tagName.toLowerCase().split('-');
    return parts.slice(-2).join('-');
  }

  // querySelectorAll doesn't pierce shadow DOM — walk the tree manually.
  // Accepts a predicate so callers can use flexible matching (substring / regex)
  // without being restricted to an exact tag-name set.
  //
  // Full traversal: visits every element including those nested inside matching ones.
  // Used by patchComponents and checkForOmniElements so that ALL OmniScript/FlexCard
  // elements (including child scripts embedded inside a parent) receive runMode='debug'.
  function queryShadowAll(root: Document | ShadowRoot | Element, match: (tag: string) => boolean): Element[] {
    const found: Element[] = [];
    function walk(node: Document | ShadowRoot | Element) {
      const children = (node as Element).children ?? (node as Document | ShadowRoot).children;
      for (const child of Array.from(children)) {
        const tag = child.tagName.toLowerCase();
        if (match(tag)) found.push(child);
        if ((child as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
          walk((child as Element & { shadowRoot: ShadowRoot }).shadowRoot);
        }
        walk(child);
      }
    }
    walk(root);
    return found;
  }

  // Top-level-only traversal: when a matching element is found it is recorded but
  // NOT recursed into. Child OmniScripts / FlexCards embedded inside a parent's
  // shadow DOM are therefore excluded. Used exclusively by buildInventory so the
  // picker only surfaces the outermost (user-facing) components, not internal ones.
  function queryShadowTopLevel(root: Document | ShadowRoot | Element, match: (tag: string) => boolean): Element[] {
    const found: Element[] = [];
    function walk(node: Document | ShadowRoot | Element) {
      const children = (node as Element).children ?? (node as Document | ShadowRoot).children;
      for (const child of Array.from(children)) {
        const tag = child.tagName.toLowerCase();
        if (match(tag)) {
          found.push(child);
          // Stop here — don't descend into this element's shadow or children.
          // Any OmniScript/FlexCard inside is a child component, not a top-level one.
        } else {
          if ((child as Element & { shadowRoot?: ShadowRoot }).shadowRoot) {
            walk((child as Element & { shadowRoot: ShadowRoot }).shadowRoot);
          }
          walk(child);
        }
      }
    }
    walk(root);
    return found;
  }

  function buildInventory(): Array<{ id: string; tag: string; kind: string; label: string }> {
    const seen = new Set<string>();
    const result: Array<{ id: string; tag: string; kind: string; label: string }> = [];
    // Use top-level traversal: only outermost OS/FC elements; nested child scripts excluded.
    const all = queryShadowTopLevel(document, isOmniTag);
    for (const el of all) {
      const id = getOrAssignId(el);
      if (seen.has(id)) continue;
      seen.add(id);
      const tag = el.tagName.toLowerCase();
      result.push({ id, tag, kind: kindForTag(tag), label: labelForElement(el) });
    }
    return result;
  }

  function postInventory() {
    const inventory = buildInventory();
    // Must stringify before postMessage — LWS Proxy values can't be structured-cloned
    const str = safeStringify(inventory);
    if (!str) return;
    try {
      window.postMessage({ __omniDebug: true, __type: 'inventory', inventoryStr: str, timestamp: Date.now() }, '*');
    } catch (_) {}
  }

  // ── Attribution: which top-level component fired this event? ────────────────
  // omniaggregate / omniactiondebug both bubble with composed:true.
  //
  // Strategy (three levels, tried in order):
  //
  // 1. composedPath() walk — works in synthetic shadow DOM (managed package orgs)
  //    and in native shadow when the listener is inside the same realm.
  //
  // 2. e.target fallback — in native shadow DOM (runtime_omnistudio namespace)
  //    the browser RETARGETS the event: e.target at the document listener is
  //    the shadow HOST element, i.e. the top-level OmniScript/FlexCard element.
  //    This is reliable even when composedPath() is filtered by LWS.
  //
  // 3. Single-inventory fallback — if both above fail (e.g. LWS fully hides the
  //    element) but there is exactly one top-level component in the DOM, attribute
  //    to that component. Avoids silently losing data to the 'global' bucket.
  function findOwnerInPath(e: Event): string | null {
    // 1. composedPath walk
    try {
      const path = e.composedPath() as EventTarget[];
      for (const node of path) {
        if (!(node instanceof Element)) continue;
        const tag = node.tagName.toLowerCase();
        if (isOmniTag(tag)) return getOrAssignId(node);
      }
    } catch (_) {}

    // 2. e.target retargeting (native shadow DOM)
    try {
      const target = e.target;
      if (target instanceof Element) {
        const tag = target.tagName.toLowerCase();
        if (isOmniTag(tag)) return getOrAssignId(target);
      }
    } catch (_) {}

    // 3. Single-component fallback
    try {
      const topLevel = queryShadowTopLevel(document, isOmniTag);
      if (topLevel.length === 1) return getOrAssignId(topLevel[0]);
    } catch (_) {}

    return null;
  }

  // ── Safe serialise: strips LWS Proxies into plain objects ──────────────────
  // In LWS-enabled orgs each LWC namespace has its own sandboxed scope.
  // CustomEvent.detail and its nested values may be LWS Proxy objects which
  // throw when JSON.stringify tries to enumerate their properties.
  // Strategy: direct stringify first (fast path), then shallow property-by-property
  // copy to unwrap the top-level Proxy, then string coercion as a last resort.
  function safeStringify(val: unknown): string | null {
    // 1. Fast path — works when values are plain objects or simple primitives
    try { return JSON.stringify(val); } catch (_) { /* fall through */ }

    // 2. Shallow copy path — iterates own keys with per-property error isolation
    //    to unwrap an LWS Proxy wrapping a plain-object-shaped value
    if (typeof val === 'object' && val !== null) {
      try {
        const plain: Record<string, unknown> = {};
        for (const k of Object.keys(val as object)) {
          try { plain[k] = (val as Record<string, unknown>)[k]; } catch { plain[k] = '[inaccessible]'; }
        }
        const s = JSON.stringify(plain);
        if (s) return s;
      } catch (_) { /* fall through */ }
    }

    // 3. String coercion — always succeeds, loses structure but guarantees a non-null result
    try { return JSON.stringify(String(val)); } catch (_) { return null; }
  }

  function postDataJSON(source: string, componentId: string, dataJson: unknown) {
    const str = safeStringify(dataJson);
    if (!str) return;
    try {
      window.postMessage({ __omniDebug: true, __type: 'datajson', source, componentId, dataJsonStr: str, timestamp: Date.now() }, '*');
    } catch (_) {}
  }

  function postCallTrace(params: unknown, response: unknown, elementType: string, elementLabel: string, componentId: string) {
    const paramsStr = safeStringify(params);
    const responseStr = safeStringify(response);
    if (!paramsStr) return;
    try {
      window.postMessage({
        __omniDebug: true,
        __type: 'calltrace',
        paramsStr,
        responseStr: responseStr ?? 'null',
        elementType,
        elementLabel,
        componentId,
        timestamp: Date.now(),
      }, '*');
    } catch (_) {}
  }

  function postFlexCardEvent(eventName: string, detail: unknown, componentId: string, source: string) {
    const detailStr = safeStringify(detail) ?? 'null';
    try {
      window.postMessage({
        __omniDebug: true,
        __type: 'flexcardevent',
        eventName,
        detailStr,
        componentId,
        source,
        timestamp: Date.now(),
      }, '*');
    } catch (_) {}
  }

  // Capture FlexCard events at dispatch time, before FlexCardMixin handlers can
  // stop propagation. This also sees events emitted inside closed shadow roots.
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  function findFlexCardHost(target: EventTarget): Element | null {
    let node: unknown = target;
    let owner: Element | null = null;
    const visited = new Set<unknown>();
    for (let i = 0; node && i < 40 && !visited.has(node); i++) {
      visited.add(node);
      if (node instanceof Element) {
        const tag = node.tagName.toLowerCase();
        // Keep walking through shadow hosts. The last FlexCard encountered is
        // the outer picker component, not an internal forcegenerated element.
        if (kindForTag(tag) === 'FlexCard') owner = node;
        try {
          const closest = node.closest(OMNI_TAGS.join(','));
          if (closest && kindForTag(closest.tagName.toLowerCase()) === 'FlexCard') owner = closest;
        } catch (_) {}
      }
      try {
        if (node instanceof ShadowRoot) {
          node = node.host;
        } else {
          const root = (node as Node).getRootNode?.();
          node = root instanceof ShadowRoot
            ? root.host
            : (node as Node).parentNode;
        }
      } catch (_) { break; }
    }
    return owner;
  }

  EventTarget.prototype.dispatchEvent = function(event: Event): boolean {
    try {
      // FlexCard uses CustomEvents for its runtime protocol. Capture every one,
      // rather than maintaining a release-sensitive allowlist of event names.
      if (event instanceof CustomEvent) {
        const host = findFlexCardHost(this);
        if (host) {
          postFlexCardEvent(event.type, (event as CustomEvent).detail, getOrAssignId(host), 'dispatch');
        }
      }
    } catch (_) {}
    return nativeDispatchEvent.call(this, event);
  };

  // ── Native FlexCard debugger postMessage channel ────────────────────────────
  // FlexCard preview posts richer state/action payloads for the builder's own
  // debug panel. Capture those messages when they are present (for example in
  // the builder preview iframe) without trying to force preview mode at runtime.
  // On normal Lightning pages this channel is deliberately silent because core
  // gates it on both isPreview and _isInsideIframe; the DOM events and network
  // interception below remain the runtime path.
  const flexCardNativeState = new Map<string, unknown>();

  function mergeFlexCardNativeState(componentId: string, key: string, detail: unknown): unknown {
    if (key === 'FullJSON') return detail;

    const current = flexCardNativeState.get(componentId);
    const state = current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

    if (key === 'dataSource.records') {
      const dataSource = state['dataSource'];
      state['dataSource'] = {
        ...(dataSource && typeof dataSource === 'object' && !Array.isArray(dataSource)
          ? dataSource as Record<string, unknown>
          : {}),
        records: detail,
      };
    } else if (key === 'dataSource.config') {
      const dataSource = state['dataSource'];
      state['dataSource'] = {
        ...(dataSource && typeof dataSource === 'object' && !Array.isArray(dataSource)
          ? dataSource as Record<string, unknown>
          : {}),
        config: detail,
      };
    } else {
      state[key] = detail;
    }
    return state;
  }

  window.addEventListener('message', (event: MessageEvent) => {
    try {
      let message: unknown = event.data;
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch (_) { return; }
      }
      if (!message || typeof message !== 'object') return;

      const native = message as Record<string, unknown>;
      const name = String(native['name'] ?? '');
      if (name === 'cardatajson') {
        const key = String(native['key'] ?? '');
        if (!key || key === 'null') return;
        const componentId = findOwnerInPath(event) ?? 'global';
        const state = mergeFlexCardNativeState(componentId, key, native['detail']);
        flexCardNativeState.set(componentId, state);
        postDataJSON('FlexCard', componentId, state);
      } else if (name === 'actionDebuggerJson') {
        const detail = native['detail'];
        if (!detail || typeof detail !== 'object') return;
        const action = detail as Record<string, unknown>;
        const label = String(action['name'] ?? action['title'] ?? 'FlexCard action');
        const componentId = findOwnerInPath(event) ?? 'global';
        postFlexCardEvent(label, detail, componentId, 'preview-debug');
      }
    } catch (_) {}
  }, true);

  // ── Dedup ────────────────────────────────────────────────────────────────────
  const recentKeys: Record<string, number> = {};
  // 200 ms window: prevents double-recording when both the XHR/fetch intercept
  // AND the omniactiondebug event fire for the same call (they arrive within
  // ~5–50 ms of each other).  Kept tight so rapid back-to-back calls to the
  // same IP are still captured as separate entries.
  const DEDUP_MS = 200;

  function isDupe(cls: string, method: string): boolean {
    const k = `${cls}:${method}`;
    const now = Date.now();
    if (recentKeys[k] && now - recentKeys[k] < DEDUP_MS) return true;
    recentKeys[k] = now;
    return false;
  }
  function markSeen(cls: string, method: string) { recentKeys[`${cls}:${method}`] = Date.now(); }

  function classify(cls: string, method: string): string {
    const m = method.toLowerCase();
    const c = cls.toLowerCase();
    // Shape A uses methodName = "integrationProcedureKeyAction" (no suffix)
    // Shape B uses sMethodName = "integrationProcedureKeyAction_<Key>"
    if (m.startsWith('integrationprocedurekeyaction')) return 'integration-procedure-action';
    if (m.includes('dataraptor') || c.includes('dataraptor')) return 'dataraptor-action';
    // IPService class name is another signal
    if (c.includes('ipservice') || c.includes('integrationprocedure')) return 'integration-procedure-action';
    return 'apex';
  }

  // Match any OmniStudio-related Aura descriptor.  Keep this in sync with the
  // broader regex in background.ts → parseAuraMessage.  Using a broad pattern
  // prevents silently dropping calls from less common controllers
  // (OmniProcessService, OmniScriptController, Vlocity namespace variants, etc.)
  function isOmniDescriptor(d: string): boolean {
    return /omni|businessprocessdisplay|genericinvoke/i.test(d);
  }

  // When the IP is routed through the GENERIC ApexAction controller
  // ("aura.ApexAction.execute=1" in the URL), the Aura descriptor is
  // "apex://ApexActionController/ACTION$execute" — which has no OmniScript
  // keyword in it.  We detect the OmniScript intent by checking the inner
  // classname/method that lives inside action.params.
  function isApexActionDescriptor(d: string): boolean {
    return /ApexAction|ACTION\$execute/i.test(d);
  }

  // Given the inner class name (from action.params.classname or the sClassName
  // extracted from nested params), decide whether it looks like an OmniStudio call.
  function isOmniClass(cls: string, mthd: string): boolean {
    return /omni|integrationprocedure|ipservice|businessprocess|dataraptor|flexcard/i.test(cls + ' ' + mthd);
  }

  function parseAuraBody(body: string): Record<string, unknown> | null {
    try {
      const trimmed = body.trimStart();
      // Direct JSON body — newer Aura / LDS implementations send the message object
      // directly rather than form-encoding it.
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return JSON.parse(trimmed) as Record<string, unknown>;
      }
      // Classic form-encoded body: message=<URL-encoded JSON>
      const idx = body.indexOf('message=');
      if (idx === -1) return null;
      const rest = body.slice(idx + 8);
      const end = rest.indexOf('&');
      return JSON.parse(decodeURIComponent(end === -1 ? rest : rest.slice(0, end))) as Record<string, unknown>;
    } catch (_) { return null; }
  }

  function processAura(auraMsg: Record<string, unknown>, responseText: string) {
    const actions = auraMsg['actions'] as Array<Record<string, unknown>> | undefined;
    if (!actions) return;
    let rd: Record<string, unknown> | null = null;
    try { rd = JSON.parse(responseText) as Record<string, unknown>; } catch (_) {}

    for (const action of actions) {
      const descriptor = String(action['descriptor'] ?? '');
      const outerParams = (action['params'] as Record<string, unknown> | undefined) ?? {};

      // ── Route 1: OmniStudio-specific controller (IOmniscriptRuntimeConnect, etc.) ──
      if (isOmniDescriptor(descriptor)) {
        // Four param shapes observed in the wild:
        //
        // Shape A1 — IOmniscriptRuntimeConnect.genericInvoke (LDS nested):
        //   outerParams.omniscriptRuntimeGenericInvokeInputRepresentation.params
        //     { sClassName, sMethodName, input, options, checkPermission }
        //
        // Shape A2 — IOmniscriptRuntimeConnect.genericInvoke (LDS direct):
        //   outerParams.omniscriptRuntimeGenericInvokeInputRepresentation
        //     { sClassName, sMethodName, input, options }
        //
        // Shape B — OmniscriptRuntimeController (legacy Apex):
        //   outerParams.params.{ sClassName, sMethodName, input, options }
        //
        // Shape C — flat: class/method directly on outerParams

        let p: Record<string, unknown>;
        const ldsWrap = outerParams['omniscriptRuntimeGenericInvokeInputRepresentation'] as Record<string, unknown> | undefined;
        if (ldsWrap) {
          p = (ldsWrap['params'] && typeof ldsWrap['params'] === 'object')
            ? (ldsWrap['params'] as Record<string, unknown>)  // A1
            : ldsWrap;                                          // A2
        } else if (outerParams['params'] && typeof outerParams['params'] === 'object') {
          p = outerParams['params'] as Record<string, unknown>;  // B
        } else {
          p = outerParams;                                       // C
        }

        const cls = String(p['sClassName'] ?? p['className'] ?? '');
        const method = String(p['sMethodName'] ?? p['methodName'] ?? descriptor.split('/ACTION$')[1] ?? '');
        if (!cls && !method) continue;  // can't extract names — skip silently

        // For BusinessProcessDisplay* descriptors, only record if OmniStudio-specific
        // IP params (sClassName / sMethodName) are present in the body.  Without this
        // guard, framework bootstrap calls (isOmniStudioTemplateAPIEnabled, LWCPrep, etc.)
        // leak through when the Aura body's params contain className = 'BusinessProcessDisplayController'
        // but no actual sClassName / sMethodName IP identity fields.
        if (/businessprocessdisplay/i.test(descriptor) && !p['sClassName'] && !p['sMethodName']) continue;

        if (isDupe(cls, method)) continue;

        let input: unknown = p['input'];
        let options: unknown = p['options'];
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) {} }
        if (typeof options === 'string') { try { options = JSON.parse(options); } catch (_) {} }

        let resp: unknown = null;
        const ra = rd?.['actions'] as Array<Record<string, unknown>> | undefined;
        if (ra) for (const a of ra) { if (a['id'] === action['id']) { resp = a['returnValue']; break; } }

        const ipKey = (options as Record<string, unknown> | undefined)?.['integrationProcedureKey'];
        const label = ipKey ? String(ipKey) : (cls || method);
        postCallTrace(
          { sClassName: cls, sMethodName: method, input, options },
          resp,
          classify(cls, method),
          label,
          'global',
        );

      // ── Route 2: Generic ApexAction controller (aura.ApexAction.execute=1) ──
      } else if (isApexActionDescriptor(descriptor)) {
        const innerCls = String(outerParams['classname'] ?? outerParams['className'] ?? outerParams['class'] ?? '');
        const innerMthd = String(outerParams['method'] ?? outerParams['methodName'] ?? '');

        // ── Route 2a: FlexRuntime.doEncryptedDatasourceFlex (FlexCard datasource) ──
        // This call carries globalKey / actionElementId instead of sClassName / sMethodName,
        // so it bypasses both isOmniClass and the sClassName guard below.  Handle it here
        // before those guards run, extract records from the returnValue, and post DataJSON.
        if (innerCls === 'FlexRuntime' && innerMthd === 'doEncryptedDatasourceFlex') {
          const fc = (outerParams['params'] as Record<string, unknown> | undefined) ?? {};
          const globalKey = String(fc['globalKey'] ?? '');
          const actionElementId = String(fc['actionElementId'] ?? '');
          if (globalKey) {
            // Extract returnValue from the matching response action
            let returnValue: unknown = null;
            const ra2 = rd?.['actions'] as Array<Record<string, unknown>> | undefined;
            if (ra2) for (const a of ra2) { if (a['id'] === action['id']) { returnValue = a['returnValue']; break; } }

            // Parse records: returnValue is a JSON string
            let records: unknown = returnValue;
            if (typeof records === 'string') { try { records = JSON.parse(records); } catch (_) {} }
            // Unwrap Integration Procedure result shape: { error:"OK", IPResult:{...} }
            if (records && typeof records === 'object' && !Array.isArray(records)) {
              const r = records as Record<string, unknown>;
              if (r['error'] === 'OK' && r['IPResult'] !== undefined) {
                records = r['IPResult'];
              }
            }

            // cardName = first slash-segment of globalKey (e.g. "ishank" from "ishank/Developer/1.0")
            const cardName = globalKey.split('/')[0];

            // Resolve componentId — may already be known from a prior 3s probe
            const compId = fcKeyToComponentId.get(cardName) ?? 'global';

            postCallTrace(
              { globalKey, actionElementId, isFileBased: fc['isFileBased'] },
              returnValue,
              'flexcard-datasource',
              `FC:${globalKey}`,
              compId,
            );

            if (records !== null && records !== undefined) {
              if (compId !== 'global') {
                // Mapping already established — persist in cache and post immediately
                fcXhrState.set(compId, records);
                postDataJSON('FlexCard', compId, { records });
              } else {
                // Mapping not yet established — queue for the next main poll cycle
                fcPendingDataJson.set(cardName, records);
              }
            }
          }
          continue;
        }

        // Only trace OmniStudio-related Apex calls — ignore RecordUI, UI bootstrap, etc.
        if (!isOmniClass(innerCls, innerMthd)) continue;

        const innerP = (outerParams['params'] && typeof outerParams['params'] === 'object')
          ? (outerParams['params'] as Record<string, unknown>)
          : outerParams;

        const cls = String(innerP['sClassName'] ?? innerP['className'] ?? innerCls);
        const method = String(innerP['sMethodName'] ?? innerP['methodName'] ?? innerMthd);
        // Framework bootstrap calls (getOrganizationId, LWCPrep, isOmniStudioTemplateAPIEnabled, …)
        // never carry OmniStudio IP params — their nested params object has no sClassName /
        // sMethodName.  Real IP invocations always set at least one of these.  Skip if both absent.
        if (!innerP['sClassName'] && !innerP['sMethodName']) continue;
        if (isDupe(cls, method)) continue;

        let input: unknown = innerP['input'] ?? innerP['inputMap'] ?? outerParams['params'];
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch (_) {} }
        let options: unknown = innerP['options'];
        if (typeof options === 'string') { try { options = JSON.parse(options); } catch (_) {} }

        let resp: unknown = null;
        const ra = rd?.['actions'] as Array<Record<string, unknown>> | undefined;
        if (ra) for (const a of ra) { if (a['id'] === action['id']) { resp = a['returnValue']; break; } }

        const ipKey = (options as Record<string, unknown> | undefined)?.['integrationProcedureKey'];
        // For ApexAction path, sMethodName IS the IP key (e.g. 'Test_Test').
        // Prefer method over cls so the label shows the IP name, not the service class.
        const label = ipKey ? String(ipKey) : (method || cls);
        postCallTrace(
          { sClassName: cls, sMethodName: method, input, options },
          resp,
          classify(cls, method),
          label,
          'global',
        );

      // ── Any other descriptor — silently ignored ────────────────────────────
      } else {
        // Not an OmniStudio call; skip without emitting any diagnostic noise.
      }
    }
  }

  // ── XHR intercept ────────────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  type AugXHR = XMLHttpRequest & { _ourl?: string; _ometh?: string };

  // LWS may prevent setting custom properties on native objects — use a WeakMap
  // as the primary URL store and _ourl as a fallback.
  const xhrUrlMap = new WeakMap<XMLHttpRequest, string>();

  XMLHttpRequest.prototype.open = function(this: AugXHR, method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
    const urlStr = String(url ?? '');
    try { xhrUrlMap.set(this, urlStr); } catch (_) {}
    this._ourl = urlStr;
    this._ometh = method;
    return _open.call(this, method, url, async, username as string, password as string);
  };

  XMLHttpRequest.prototype.send = function(this: AugXHR, body?: Document | XMLHttpRequestBodyInit | null) {
    // Prefer WeakMap (more reliable in LWS) then fall back to the _ourl property
    const url = xhrUrlMap.get(this) ?? this._ourl ?? '';
    const isAura = /\/aura(\?|$)/.test(url) || url.includes('/s/sfsites/aura');

    if (isAura) {
      // Normalise body to a string regardless of type.
      // Salesforce Aura sends: string, URLSearchParams, or FormData — all containing 'message='.
      let bodyStr: string | null = null;
      if (typeof body === 'string') {
        bodyStr = body;
      } else if (body instanceof URLSearchParams) {
        bodyStr = body.toString();
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        try {
          const msg = (body as FormData).get('message');
          if (typeof msg === 'string') bodyStr = `message=${encodeURIComponent(msg)}`;
        } catch (_) {}
      }
      const auraMsg = bodyStr ? parseAuraBody(bodyStr) : null;
      if (auraMsg) {
        this.addEventListener('load', () => { try { processAura(auraMsg, this.responseText); } catch (_) {} });
      }
    } else {
      // ── Non-Aura Salesforce API calls (Integration Procedures via REST, Connect API, etc.) ──
      // OmniStudio IPs can be invoked via:
      //   /services/data/vXX/connect/omnistudio/integrationprocedures/{Type}/{SubType}
      //   /services/apexrest/{namespace}/v1/integrationprocedures/{Type_SubType}
      //   /api/v1/integrationprocedures/...
      // These are XHR calls in MAIN world just like Aura calls — we can intercept them here.
      const isSfApi = (url.includes('.salesforce.com') || url.includes('.force.com')) &&
        /\/(services|connect|api)\//i.test(url);

      if (isSfApi) {
        const shortPath = url.replace(/^https?:\/\/[^/]+/, '');

        // Capture request body as parsed JSON (or raw string fallback)
        let reqInput: unknown = null;
        if (typeof body === 'string') {
          try { reqInput = JSON.parse(body); } catch (_) { reqInput = body; }
        } else if (body instanceof URLSearchParams) {
          reqInput = Object.fromEntries(body.entries());
        }

        this.addEventListener('load', () => {
          try {
            let resp: unknown = null;
            try { resp = JSON.parse(this.responseText); } catch (_) {}

            // Extract semantic label from URL segments
            // /connect/omnistudio/integrationprocedures/TypeName/SubType
            const ipMatch = shortPath.match(/integrationprocedures\/([^/?]+)(?:\/([^/?]+))?/i);
            const drMatch = shortPath.match(/datatransforms?\/([^/?]+)|dataraptors?\/([^/?]+)/i);

            let className: string;
            let methodName: string;
            let elementType: string;

            if (ipMatch) {
              const ipType = ipMatch[1] ?? '';
              const ipSub = ipMatch[2] ?? '';
              className = ipSub ? `${ipType}/${ipSub}` : ipType;
              methodName = ipSub ? `${ipType}/${ipSub}` : ipType;
              elementType = 'integration-procedure-action';
            } else if (drMatch) {
              const drName = drMatch[1] ?? drMatch[2] ?? '';
              className = drName;
              methodName = drName;
              elementType = 'dataraptor-action';
            } else {
              // Generic label from last 2 URL segments
              const parts = shortPath.split('/').filter(Boolean);
              className = 'Salesforce API';
              methodName = parts.slice(-2).join('/');
              elementType = classify('', methodName);
            }

            if (!isDupe(className, methodName)) {
              markSeen(className, methodName);
              postCallTrace(
                { sClassName: className, sMethodName: methodName, input: reqInput },
                resp,
                elementType,
                className,
                'global',
              );
            }
          } catch (_) {}
        });
      }
    }
    return _send.apply(this, arguments as unknown as [Document | XMLHttpRequestBodyInit | null | undefined]);
  };

  // ── fetch intercept ──────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const isAura = /\/aura(\?|$)/.test(url) || url.includes('/s/sfsites/aura');
      const p = _fetch.apply(window, [input, init] as Parameters<typeof fetch>);
      if (!isAura) return p;

      // Normalise body to string — String(FormData) produces '[object FormData]'
      // so we must handle each body type explicitly.
      let bodyStr: string | null = null;
      const rawBody = init?.body;
      if (typeof rawBody === 'string') {
        bodyStr = rawBody;
      } else if (rawBody instanceof URLSearchParams) {
        bodyStr = rawBody.toString();
      } else if (typeof FormData !== 'undefined' && rawBody instanceof FormData) {
        try {
          const msg = (rawBody as FormData).get('message');
          if (typeof msg === 'string') bodyStr = `message=${encodeURIComponent(msg)}`;
        } catch (_) {}
      }

      if (!bodyStr) return p;
      const auraMsg = parseAuraBody(bodyStr);
      if (!auraMsg) return p;
      return p.then((r: Response) => {
        r.clone().text().then((t: string) => { try { processAura(auraMsg, t); } catch (_) {} }).catch(() => {});
        return r;
      });
    };
  }

  // ── Patch-diagnostic tracker ─────────────────────────────────────────────────
  // Post a one-time synthetic trace entry the first time each component is
  // successfully found + runMode-patched.  This appears in the Call Trace pane
  // as a "Hook attached" entry so the user can confirm the whole postMessage →
  // background → panel chain is working even before any real action is called.
  const patchedElements = new WeakSet<Element>();
  // Track elements for which we already posted a VM-probe diagnostic (once per element).
  const vmDiagPosted = new WeakSet<Element>();
  // Track elements that have already had a per-element omniaggregate listener attached.
  const listenedElements = new WeakSet<Element>();
  // Track FlexCard elements for which we have scheduled a delayed post-load probe.
  const fcDelayedProbeScheduled = new WeakSet<Element>();

  // ── Per-component state maps ─────────────────────────────────────────────────
  // Each top-level component gets its own state record.
  // Key: componentId string (e.g. "comp-1")
  const _stateMap = new Map<string, Record<string, unknown>>();

  // ── FlexCard XHR correlation maps ───────────────────────────────────────────
  // FlexCard data is fetched via Apex: FlexRuntime.doEncryptedDatasourceFlex.
  // The XHR fires with a globalKey (e.g. "ishank/Developer/1.0") but no DOM
  // reference. We correlate to a componentId via the L2 element tag name probed
  // 3s after the card loads.
  //
  // cardName = globalKey.split('/')[0]  (e.g. "ishank")
  // L2 tag: forcegenerated-flex-card_{cardName}___salesforce___1___false[_gen]
  //
  // fcKeyToComponentId: cardName → componentId  (populated by main poll or 3s probe)
  // fcPendingDataJson:  cardName → records      (queued when XHR fires before mapping)
  // fcXhrState:        componentId → records   (persistent XHR cache merged into every poll)
  const fcKeyToComponentId = new Map<string, string>();
  const fcPendingDataJson = new Map<string, unknown>();
  const fcXhrState = new Map<string, unknown>();

  // ── omniaggregate processing ─────────────────────────────────────────────────
  // Two events fire per field change:
  //
  // 1. Leaf event:  data = "productC" (primitive), dataJsonPath = "Step1:Select1"
  // 2. Rollup event: data = { Select1: "productC" } (object), elementId = "Step1"
  //
  // Strategy:
  // - data is an object with system keys → full state, replace _stateMap wholesale
  // - data is a primitive → leaf change; use dataJsonPath to patch _stateMap
  // - data is an object without system keys → step rollup (leaf already handled it)
  //
  // KNOWN LIMITATION: The initial full-state omniaggregate fires during LWC
  // hydration — before the side panel is open and before this hook can listen.
  // omniscriptrequeststateupdate nudges the component to re-emit, but native core
  // may not handle it. Per-element listeners (added in patchComponents) are the
  // primary fix — they know the component ID without any attribution logic.

  function applyOmniAggregateDetail(detail: Record<string, unknown>, componentId: string): void {
    const _state = _stateMap.get(componentId) ?? {};

    let data: unknown;
    try { data = detail['data']; } catch (_) { return; }
    if (data === undefined) return; // null is valid — field was cleared

    const str = safeStringify(data);
    if (!str) return;
    const plain = JSON.parse(str) as unknown;

    if (typeof plain === 'object' && plain !== null && !Array.isArray(plain)) {
      const obj = plain as Record<string, unknown>;
      const isFull = 'omniProcessId' in obj || 'ContextId' in obj || 'userId' in obj;
      if (isFull || Object.keys(_state).length === 0) {
        _stateMap.set(componentId, obj);
        postDataJSON('OmniScript', componentId, obj);
        postInventory();
      }
      // else: step rollup event — leaf already handled it
    } else {
      // Primitive leaf change — dataJsonPath = "Step1:Select1"
      const path = typeof detail['dataJsonPath'] === 'string' ? detail['dataJsonPath'] as string : null;
      if (!path) return;
      const parts = path.split(':').filter(Boolean);
      if (parts.length === 0) return;

      const newState = JSON.parse(safeStringify(_state) ?? '{}') as Record<string, unknown>;
      let cur: unknown = newState;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return;
        const node = (cur as Record<string, unknown>)[p];
        if (node === null || typeof node !== 'object') {
          (cur as Record<string, unknown>)[p] = {};
        }
        cur = (cur as Record<string, unknown>)[p];
      }
      const last = parts[parts.length - 1];
      if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
        (cur as Record<string, unknown>)[last] = plain;
      }
      _stateMap.set(componentId, newState);
      postDataJSON('OmniScript', componentId, newState);
    }
  }

  // ── Document-level omniaggregate listener (attribution fallback) ─────────────
  // This catches events that weren't stopped by a per-element listener below.
  // In managed-package / synthetic-shadow orgs, composedPath() attribution works
  // here. In native-shadow / LWS orgs it usually fails (returns 'global') —
  // the per-element listener is the reliable path for those.
  //
  // The one-time diagnostic entry tells us whether the event reaches here at all
  // and what componentId is resolved, which is useful for diagnosing attribution.
  const omniAggDocFirstSeen = new Set<string>();

  document.addEventListener('omniaggregate', (e: Event) => {
    try {
      const detail = (e as CustomEvent).detail;
      if (!detail) return;

      const componentId = findOwnerInPath(e) ?? 'global';

      // One-time diagnostic so Call Trace shows that omniaggregate IS firing
      // and which bucket it lands in at the document level.
      if (!omniAggDocFirstSeen.has(componentId)) {
        omniAggDocFirstSeen.add(componentId);
        let targetDesc = 'unknown';
        try {
          const t = e.target;
          targetDesc = t instanceof Element ? t.tagName.toLowerCase() : String(t);
        } catch (_) {}
        postCallTrace(
          { sClassName: '__OmniDebugHook__', sMethodName: 'omniAggDocFirst', targetTag: targetDesc },
          { message: `omniaggregate reached document listener, attributed to: "${componentId}"`, targetTag: targetDesc },
          'hook-diagnostic',
          `↳ omniaggregate (doc-level) → "${componentId}"`,
          componentId,
        );
      }

      applyOmniAggregateDetail(detail as Record<string, unknown>, componentId);
    } catch (_) {}
  }, true);

  // ── FlexCard state events ─────────────────────────────────────────────────────
  // FlexCards fire custom events after their data source loads.
  // Try multiple known event names to capture state as early as possible
  // (in addition to the DOM-poll fallback in patchComponents below).
  // These events are composed + bubbling so findOwnerInPath works normally.
  const FC_STATE_EVENTS = ['omnicardaggregate', 'flexcardchange', 'flexcardstatechange', 'omnicardstatechange'];
  for (const evName of FC_STATE_EVENTS) {
    document.addEventListener(evName, (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail;
        if (!detail) return;
        const componentId = findOwnerInPath(e) ?? 'global';
        // Pull card state from whichever field the event uses
        const cardState =
          (detail as Record<string, unknown>)['cardData'] ??
          (detail as Record<string, unknown>)['state'] ??
          (detail as Record<string, unknown>)['data'] ??
          (detail as Record<string, unknown>)['contextData'] ??
          detail;
        if (cardState !== undefined && cardState !== null) {
          postDataJSON('FlexCard', componentId, cardState);
        }
      } catch (_) {}
    }, true);
  }

  // ── omniactiondebug (debug mode) ─────────────────────────────────────────────
  document.addEventListener('omniactiondebug', (e: Event) => {
    try {
      const detail = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!detail) return;
      const p = detail['params'] as Record<string, unknown> | undefined;
      markSeen(String(p?.['sClassName'] ?? ''), String(p?.['sMethodName'] ?? ''));
      const componentId = findOwnerInPath(e) ?? 'global';
      postCallTrace(
        p ?? {},
        detail['response'],
        String((detail['element'] as Record<string, unknown>)?.['elementType'] ?? ''),
        String((detail['element'] as Record<string, unknown>)?.['label'] ?? ''),
        componentId,
      );
    } catch (_) {}
  }, true);

  // ── DOM poll: force runMode='debug' + post inventory ────────────────────────
  // runMode is an @api public property on the OmniScript LWC component.
  // Setting it to 'debug' makes handleActionEvents call sendDataToDebugConsole
  // after every Apex/IP/DataRaptor action, which dispatches the omniactiondebug
  // event we already listen to — giving us full call trace in player mode.
  // We also post the current component inventory every poll cycle so the panel
  // stays up to date as components mount/unmount.

  // Poll: force runMode='debug' so omniactiondebug fires on every action call.
  function patchComponents() {
    // isOmniTag intentionally recognizes generated/internal FlexCard tags so the
    // shadow traversal can inspect them. State and event listeners, however,
    // must be owned by the outer component that appears in the picker; otherwise
    // updates are stored under an internal component ID the user cannot select.
    const topLevelIds = new Set(
      queryShadowTopLevel(document, isOmniTag).map(getOrAssignId),
    );

    for (const el of queryShadowAll(document, isOmniTag)) {
      const componentId = getOrAssignId(el);
      const isTopLevel = topLevelIds.has(componentId);

      // Primary approach: set runMode directly as a DOM element property.
      // LWC @api properties are accessible as HTML element properties from
      // the MAIN world even in LWS-enabled orgs — LWS restricts cross-namespace
      // JS object access but not DOM element property setters.
      try {
        const elAny = el as unknown as Record<string, unknown>;
        if (elAny['runMode'] !== 'debug') {
          elAny['runMode'] = 'debug';
        }
      } catch (_) {}

      // Fallback: try via LWC VM internals (older SF versions / non-LWS orgs).
      // Extra key names cover naming variations across LWC versions.
      for (const k of ['__lwcVM', '_lwcVM', '__vm', '__lwcInternal', '__lwcComponent', '__component']) {
        try {
          const vm = (el as unknown as Record<string, unknown>)[k];
          if (!vm) continue;
          const comp = (vm as Record<string, unknown>)['component'] ?? vm;
          if (!comp || typeof comp !== 'object') continue;
          const c = comp as Record<string, unknown>;
          // Attempt even when runMode is undefined (not yet initialised)
          if (c['runMode'] !== 'debug') {
            try { c['runMode'] = 'debug'; } catch (_) {}
          }
        } catch (_) {}
      }

      // One-time diagnostic trace so the panel confirms:
      //   (a) the hook found this component, and
      //   (b) the full postMessage → content.ts → background → panel chain works.
      // This appears as a greyed "Hook attached" entry before any real calls.
      if (!patchedElements.has(el)) {
        patchedElements.add(el);
        const tag = el.tagName.toLowerCase();
        const label = labelForElement(el);
        postCallTrace(
          { sClassName: '__OmniDebugHook__', sMethodName: 'hookAttached', tag },
          { status: 'debug mode activated', label },
          'hook-diagnostic',
          `↳ Hook attached: ${label || tag}`,
          componentId,
        );
      }

      const kind = kindForTag(el.tagName.toLowerCase());

      // ── FlexCard: per-element event listeners ────────────────────────────────────
      // FlexCard mixin's fireEventToParent dispatches events with bubbles:true,
      // composed:true from the inner generated FlexCard element. With composed:true
      // the event crosses the wrapper's shadow boundary and reaches the wrapper host
      // element — same mechanism as omniaggregate for OmniScript.
      //
      // Key events to listen for:
      //   updateparent — fired (via fireEventToParent) whenever records change after
      //                  a data-source load, data action, or setValues action.
      //                  detail shape: { records: [...] }
      //   omniaggregate — inner FlexCard also re-dispatches this when OmniScript data
      //                   changes feed into the card (see flexCardMixin line ~4966).
      if (kind === 'FlexCard' && isTopLevel && !listenedElements.has(el)) {
        listenedElements.add(el);
        const fcElTag = el.tagName.toLowerCase();
        postCallTrace(
          { sClassName: '__OmniDebugHook__', sMethodName: 'fcListenerAttached', tag: fcElTag },
          { message: `FlexCard per-element listeners attached to ${fcElTag}` },
          'hook-diagnostic',
          `↳ FC listeners → ${fcElTag} (${componentId})`,
          componentId,
        );

        // ── State events → DataJSON pane ──────────────────────────────────────
        // updateparent carries { records: [...] } after data loads / actions.
        // The other events may carry card state under various field names.
        const FC_STATE_EL_EVENTS = ['updateparent', 'omniaggregate',
          'omnicardaggregate', 'flexcardchange', 'flexcardstatechange', 'omnicardstatechange',
          'cardstatechange', 'flexcarddatachange', 'carddatachange'];
        for (const evName of FC_STATE_EL_EVENTS) {
          try {
            el.addEventListener(evName, (e: Event) => {
              try {
                const detail = (e as CustomEvent).detail;
                if (!detail) return;
                const detailObj = detail as Record<string, unknown>;
                const records = detailObj['records'];
                if (records !== undefined && records !== null) {
                  postDataJSON('FlexCard', componentId, { records });
                  return;
                }
                const payload =
                  detailObj['cardData'] ??
                  detailObj['state'] ??
                  detailObj['data'] ??
                  detailObj['contextData'] ??
                  detail;
                if (payload !== undefined && payload !== null) {
                  postDataJSON('FlexCard', componentId, payload);
                }
              } catch (_) {}
            }, true);
          } catch (_) {}
        }

      }

      // ── OmniScript: per-element event listener (primary for LWS native-shadow) ──
      // In LWS-enabled orgs, document-level event attribution fails because
      // composedPath() is filtered and e.target is retargeted to a non-OmniScript
      // ancestor element. Attaching the listener directly on the host element
      // bypasses attribution entirely — the componentId is captured in the closure.
      //
      // omniaggregate (composed:true, bubbles:true) propagates from inside the
      // shadow root up through the host element, so this captures all field changes.
      if (kind === 'OmniScript' && !listenedElements.has(el)) {
        listenedElements.add(el);

        // Diagnostic: one-time "element listener attached" trace so we can confirm
        // the listener was successfully added to this element.
        const elTag = el.tagName.toLowerCase();
        postCallTrace(
          { sClassName: '__OmniDebugHook__', sMethodName: 'elListenerAttached', tag: elTag },
          { message: `per-element omniaggregate listener attached to ${elTag}` },
          'hook-diagnostic',
          `↳ omniaggregate listener → ${elTag} (${componentId})`,
          componentId,
        );

        // OmniScript event names to try. The standard is 'omniaggregate'.
        // Try additional names in case native core uses a different event.
        const OS_STATE_EVENTS = ['omniaggregate', 'omniScriptAggregateUpdate', 'omnistatechange', 'omniScriptStateChange'];
        for (const evName of OS_STATE_EVENTS) {
          try {
            el.addEventListener(evName, (e: Event) => {
              try {
                const detail = (e as CustomEvent).detail;
                if (!detail) return;
                applyOmniAggregateDetail(detail as Record<string, unknown>, componentId);
              } catch (_) {}
            }, true); // capture phase
          } catch (_) {}
        }

        // Request current state immediately — OmniScript will re-dispatch omniaggregate
        // with the full current DataJSON if it handles this event.
        requestStateFromElement(el);
      }

      // ── Direct @api property probe (LWS-safe; works when VM keys are blocked) ─
      // @api properties in LWC are part of the element's public DOM interface and
      // accessible as element properties from MAIN world even in LWS-enabled orgs.
      // This is the same mechanism that lets us set el.runMode = 'debug'.
      // Polling happens every 1.5 s so initial state is captured without needing
      // omniscriptrequeststateupdate to be handled by the component.
      if (kind === 'OmniScript') {
        const elAny = el as unknown as Record<string, unknown>;
        for (const prop of ['jsonData', 'omniJsonData', 'dataJson', 'omniData', 'omniScriptData', 'scriptData', 'formData']) {
          try {
            const val = elAny[prop];
            if (val !== undefined && val !== null) {
              postDataJSON('OmniScript', componentId, val);
              break;
            }
          } catch (_) {}
        }
      }

      // ── FlexCard: inner-element @api probe via shadowRoot ───────────────────────
      // The component tree is THREE levels deep:
      //
      //   runtime_omnistudio-flexcard          ← el (detected by isOmniTag)
      //     #shadow-root
      //       runtime_omnistudio-generated-flexcard   ← level-1 child
      //         #shadow-root
      //           <dynamic component>          ← level-2 child (FlexCardMixin applied here)
      //             .records  ← @api records with the actual fetched data
      //
      // flexcard.js has a simple `@api records` pass-through (set by parent, not the
      // card's own fetched data). generatedFlexcard.js is the async dynamic loader.
      // The innermost dynamic component (FlexCardMixin) holds the real records.
      //
      // LWC open-mode shadow roots and @api properties both survive LWS proxying.
      // Polls every 1.5 s to catch state after the async import() completes.
      if (kind === 'FlexCard' && isTopLevel) {
        let fcState: Record<string, unknown> = {};
        const wrapperAny = el as unknown as Record<string, unknown>;

        // Always collect wrapper-level @api context (recordId, omniJsonData)
        try { const rid = wrapperAny['recordId']; if (rid !== undefined && rid !== null) fcState['recordId'] = rid; } catch (_) {}
        try { const omni = wrapperAny['omniJsonData']; if (omni !== undefined && omni !== null) fcState['omniJsonData'] = omni; } catch (_) {}

        // Traverse up to THREE shadowRoot levels to reach the FlexCardMixin component.
        //
        // Level layout (on Lightning Out / dynamic-import path):
        //   L0: runtime_omnistudio-flexcard (el, the wrapper)
        //   L1: runtime_omnistudio-generated-flexcard (async loader)
        //   L2: <forcegenerated-xxx> (uses FlexCardMixin, has @api records)
        //
        // On the laf/templateApi wire path (on-platform, no namespace), the
        // generated-flexcard render() returns the FlexCard layout template directly.
        // In that case the actual FlexCardMixin component may sit at L2 or L3
        // depending on how the template is structured, so we go one extra level.
        let foundRecords = false;
        try {
          const sr1 = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
          if (sr1) {
            for (const child1 of Array.from(sr1.children)) {
              // L1: check directly (e.g. when FlexCardMixin is on generated-flexcard itself)
              const c1any = child1 as unknown as Record<string, unknown>;
              let recs1: unknown;
              try { recs1 = c1any['records']; } catch (_) {}
              if (recs1 !== undefined && recs1 !== null) {
                fcState['records'] = recs1;
                foundRecords = true;
                break;
              }
              // L2: descend into generated-flexcard's shadow root
              const sr2 = (child1 as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
              if (sr2) {
                for (const child2 of Array.from(sr2.children)) {
                  // Skip the loading spinner
                  if ((child2 as Element).classList?.contains('generated-flexcard-spinner')) continue;
                  const c2tag = child2.tagName.toLowerCase();

                  // Establish cardName→componentId mapping as soon as the forceGenerated
                  // element appears (runs every 1.5 s, so it catches any load speed).
                  // Drain any XHR records that arrived before the mapping was set.
                  if (c2tag.startsWith('forcegenerated-flex-card_')) {
                    const fcCardName = c2tag.replace('forcegenerated-flex-card_', '').split('___')[0];
                    if (fcCardName) {
                      if (!fcKeyToComponentId.has(fcCardName)) {
                        fcKeyToComponentId.set(fcCardName, componentId);
                      }
                      const pending = fcPendingDataJson.get(fcCardName);
                      if (pending !== undefined) {
                        fcXhrState.set(componentId, pending);
                        fcPendingDataJson.delete(fcCardName);
                      }
                    }
                  }

                  const c2any = child2 as unknown as Record<string, unknown>;
                  let recs2: unknown;
                  try { recs2 = c2any['records']; } catch (_) {}
                  if (recs2 !== undefined && recs2 !== null) {
                    fcState['records'] = recs2;
                    foundRecords = true;
                    break;
                  }
                  // L3: one level deeper (wire-path: layout <div> wraps the actual component)
                  const sr3 = (child2 as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                  if (sr3) {
                    for (const child3 of Array.from(sr3.children)) {
                      const c3any = child3 as unknown as Record<string, unknown>;
                      let recs3: unknown;
                      try { recs3 = c3any['records']; } catch (_) {}
                      if (recs3 !== undefined && recs3 !== null) {
                        fcState['records'] = recs3;
                        foundRecords = true;
                        break;
                      }
                    }
                  }
                  if (foundRecords) break;
                }
              }
              if (foundRecords) break;
            }
          }
        } catch (_) {}

        // Merge persisted XHR records into fcState so they survive across poll cycles.
        // The main poll posts fcState every 1.5 s; without this merge it overwrites the
        // XHR records with just { recordId: '...' } on every cycle.
        if (!foundRecords) {
          const xhrRecs = fcXhrState.get(componentId);
          if (xhrRecs !== undefined) {
            fcState['records'] = xhrRecs;
          }
        }

        // One-time EARLY diagnostic: snapshot the shadow tree at first detection
        // (likely during the loading spinner phase — see also the 3s delayed probe below).
        if (!vmDiagPosted.has(el)) {
          vmDiagPosted.add(el);
          let shadowDump = 'no shadowRoot';
          try {
            const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
            if (sr) {
              const l1tags = Array.from(sr.children).map(c => c.tagName.toLowerCase());
              const l2tags: string[] = [];
              const l3tags: string[] = [];
              for (const c1 of Array.from(sr.children)) {
                const sr2 = (c1 as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr2) {
                  for (const c2 of Array.from(sr2.children)) {
                    const isSpinner = (c2 as Element).classList?.contains('generated-flexcard-spinner');
                    l2tags.push(isSpinner ? `${c2.tagName.toLowerCase()}(spinner)` : c2.tagName.toLowerCase());
                    const sr3 = (c2 as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                    if (sr3) l3tags.push(...Array.from(sr3.children).map(c => c.tagName.toLowerCase()));
                  }
                }
              }
              shadowDump = `L1:[${l1tags.join(',')}] L2:[${l2tags.join(',')}] L3:[${l3tags.join(',')}]`;
            }
          } catch (_) { shadowDump = '[inaccessible]'; }
          postCallTrace(
            { sClassName: '__OmniDebugHook__', sMethodName: 'fcShadowProbe', tag: el.tagName.toLowerCase() },
            { message: 'FlexCard shadow probe (early / may be spinner)', shadowChildren: shadowDump, recordsFound: foundRecords },
            'hook-diagnostic',
            `↳ FC early probe: ${shadowDump}`,
            componentId,
          );
        }

        // Delayed post-load probe (fires once, 3 s after first detection).
        // By this time the dynamic import should have resolved and the spinner
        // replaced by the actual forceGenerated component. Dumps L1/L2/L3 tags
        // and reports what @api records returns at each level so we can see
        // definitively whether property access works and where the data lives.
        if (!fcDelayedProbeScheduled.has(el)) {
          fcDelayedProbeScheduled.add(el);
          setTimeout(() => {
            try {
              const l1tags: string[] = [];
              const l2tags: string[] = [];
              const l3tags: string[] = [];
              const recReport: string[] = [];

              const sr1d = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
              if (sr1d) {
                for (const c1 of Array.from(sr1d.children)) {
                  l1tags.push(c1.tagName.toLowerCase());
                  const c1a = c1 as unknown as Record<string, unknown>;
                  let r1: unknown;
                  try { r1 = c1a['records']; } catch (e) { r1 = `[err:${(e as Error).message}]`; }
                  recReport.push(`L1.records=${r1 === undefined ? 'undef' : r1 === null ? 'null' : Array.isArray(r1) ? `array(${(r1 as unknown[]).length})` : typeof r1}`);

                  const sr2d = (c1 as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                  if (sr2d) {
                    for (const c2 of Array.from(sr2d.children)) {
                      const isSpinner = (c2 as Element).classList?.contains('generated-flexcard-spinner');
                      const c2tag = c2.tagName.toLowerCase();
                      l2tags.push(isSpinner ? `${c2tag}(spinner)` : c2tag);

                      // ── FlexCard XHR correlation: establish globalKey → componentId ────
                      // The forceGenerated element tag encodes the card name as the first
                      // '___'-separated segment: forcegenerated-flex-card_{name}___...
                      // Register now so any future doEncryptedDatasourceFlex XHR can
                      // resolve the componentId.  Also drain any result that arrived before
                      // this probe ran (i.e. XHR completed within the first 3 seconds).
                      if (!isSpinner && c2tag.startsWith('forcegenerated-flex-card_')) {
                        const fcCardName = c2tag.replace('forcegenerated-flex-card_', '').split('___')[0];
                        if (fcCardName && !fcKeyToComponentId.has(fcCardName)) {
                          fcKeyToComponentId.set(fcCardName, componentId);
                        }
                        const pending = fcPendingDataJson.get(fcCardName);
                        if (pending !== undefined) {
                          fcXhrState.set(componentId, pending);
                          try { postDataJSON('FlexCard', componentId, { records: pending }); } catch (_) {}
                          fcPendingDataJson.delete(fcCardName);
                        }
                      }

                      const c2a = c2 as unknown as Record<string, unknown>;
                      let r2: unknown;
                      try { r2 = c2a['records']; } catch (e) { r2 = `[err:${(e as Error).message}]`; }
                      const r2desc = r2 === undefined ? 'undef' : r2 === null ? 'null' : Array.isArray(r2) ? `array(${(r2 as unknown[]).length})` : typeof r2;
                      recReport.push(`L2[${c2tag}].records=${r2desc}`);
                      // If records found via @api prop (non-LWS env), post as DataJSON
                      if (r2 !== undefined && r2 !== null) {
                        try { postDataJSON('FlexCard', componentId, { records: r2 }); } catch (_) {}
                      }

                      if (!isSpinner) {
                        const sr3d = (c2 as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                        if (sr3d) {
                          for (const c3 of Array.from(sr3d.children)) {
                            const c3tag = c3.tagName.toLowerCase();
                            l3tags.push(c3tag);
                            const c3a = c3 as unknown as Record<string, unknown>;
                            let r3: unknown;
                            try { r3 = c3a['records']; } catch (e) { r3 = `[err:${(e as Error).message}]`; }
                            const r3desc = r3 === undefined ? 'undef' : r3 === null ? 'null' : Array.isArray(r3) ? `array(${(r3 as unknown[]).length})` : typeof r3;
                            recReport.push(`L3[${c3tag}].records=${r3desc}`);
                            if (r3 !== undefined && r3 !== null) {
                              try { postDataJSON('FlexCard', componentId, { records: r3 }); } catch (_) {}
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }

              const diagSummary = `L1:[${l1tags}] L2:[${l2tags}] L3:[${l3tags}] | ${recReport.join('; ')}`;
              postCallTrace(
                { sClassName: '__OmniDebugHook__', sMethodName: 'fcPostLoadProbe', tag: el.tagName.toLowerCase() },
                { message: '3s post-load FlexCard shadow probe', l1tags, l2tags, l3tags, recReport },
                'hook-diagnostic',
                `↳ FC 3s probe: ${diagSummary}`,
                componentId,
              );
            } catch (_) {}
          }, 3000);
        }

        if (Object.keys(fcState).length > 0) {
          postDataJSON('FlexCard', componentId, fcState);
        }
      }

      // ── LWC VM probing (tertiary fallback for non-LWS orgs) ──────────────────
      // VM probing is blocked by LWS in native-shadow orgs (returns undefined for
      // all __lwcVM etc. keys). For FlexCard, the per-element listener + shadowRoot
      // @api probe above are the primary mechanisms; VM probing is a tertiary fallback
      // for older managed-package orgs where LWS is not active.
      // The diagnostic fires when a VM key IS found but no state property matched.
      if ((kind === 'FlexCard' && isTopLevel) || kind === 'OmniScript') {
        let probeSucceeded = false;

        for (const vmKey of ['__lwcVM', '_lwcVM', '__vm', '__lwcInternal', '__lwcComponent', '__component']) {
          try {
            const vm = (el as unknown as Record<string, unknown>)[vmKey];
            if (!vm) continue;

            const comp = (
              (vm as Record<string, unknown>)['component'] ??
              (vm as Record<string, unknown>)['context']?.['component' as never] ??
              vm
            ) as Record<string, unknown>;

            let probeState: unknown;
            if (kind === 'FlexCard') {
              probeState =
                comp['cardData'] ??
                comp['contextData'] ??
                comp['state'] ??
                comp['data'];
            } else {
              probeState =
                comp['jsonData'] ?? comp['omniJsonData'] ?? comp['dataJson'] ??
                comp['scriptData'] ?? comp['formData'] ?? comp['omniData'] ??
                comp['omniScriptData'] ?? comp['currentJsonData'] ?? comp['aggregateData'] ??
                comp['_jsonData'] ?? comp['_omniJsonData'] ?? comp['jsonState'] ?? comp['dataState'];
            }

            if (probeState !== undefined && probeState !== null) {
              postDataJSON(kind, componentId, probeState);
              probeSucceeded = true;
              break;
            }

            // Diagnostic: VM key found but no state property matched — list accessible props.
            if (!vmDiagPosted.has(el)) {
              vmDiagPosted.add(el);
              let propDump = '';
              try {
                const allKeys = Object.getOwnPropertyNames(comp as object);
                let protoKeys: string[] = [];
                try {
                  const proto = Object.getPrototypeOf(comp as object);
                  if (proto) protoKeys = Object.getOwnPropertyNames(proto as object);
                } catch (_) {}
                const combined = [...new Set([...allKeys, ...protoKeys])]
                  .filter(k => !k.startsWith('_') && k !== 'constructor')
                  .slice(0, 40);
                propDump = combined.join(', ');
              } catch (_) { propDump = '[inaccessible]'; }

              postCallTrace(
                { sClassName: '__OmniDebugHook__', sMethodName: 'vmProbeDiag', vmKey, tag: el.tagName.toLowerCase() },
                {
                  message: 'VM key found but no state property matched. Accessible component properties:',
                  accessibleProps: propDump,
                  triedProps: 'jsonData, omniJsonData, dataJson, scriptData, formData, omniData, omniScriptData, ...',
                },
                'hook-diagnostic',
                `↳ VM probe (${el.tagName.toLowerCase()}) — state not found, see response`,
                componentId,
              );
            }

            break;
          } catch (_) {}
        }

        void probeSucceeded;
      }
    }
    // Post updated inventory on every patch cycle
    postInventory();
  }

  // ── MutationObserver: trigger a synthetic re-render when OmniScript mounts ───
  // The initial full-state omniaggregate fires during LWC first render — before
  // the panel is open. Watch for OmniScript elements appearing in the DOM, then
  // dispatch a custom event that nudges OmniScript to re-emit its current state.
  // OmniScript listens for 'omniscriptrequeststateupdate' and re-dispatches
  // omniaggregate with the full current DataJSON.
  function requestStateFromElement(el: Element) {
    try {
      el.dispatchEvent(new CustomEvent('omniscriptrequeststateupdate', { bubbles: true, composed: true }));
    } catch (_) {}
  }

  function checkForOmniElements() {
    for (const el of queryShadowAll(document, isOmniTag)) {
      requestStateFromElement(el);
    }
  }

  // ── DOM-ready setup ──────────────────────────────────────────────────────────
  // page-hook runs at document_start — document.body may be null here.
  // All DOM access (querySelectorAll, observe) must wait until body exists.
  function onBodyReady() {
    // Run immediately in case OmniScript is already on the page
    checkForOmniElements();
    patchComponents();

    // Watch for OmniScript mounting dynamically.
    // Call patchComponents immediately when a new OmniScript/FlexCard appears in the
    // DOM so runMode='debug' is set before the component makes its first action call.
    const observer = new MutationObserver(() => {
      checkForOmniElements();
      patchComponents();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) {
    onBodyReady();
  } else {
    document.addEventListener('DOMContentLoaded', onBodyReady);
  }

  // Interval is safe to start early — querySelectorAll inside patchComponents
  // returns empty when body isn't ready, which is harmless.
  setInterval(patchComponents, 1500);

  // ── Heartbeat — lets the panel confirm the hook is alive ────────────────────
  // Send once at injection time, then every 3 s so the panel knows the hook
  // is still alive (not just that it was alive once at page load).
  function sendHeartbeat() {
    try {
      window.postMessage({ __omniDebug: true, __type: 'heartbeat', timestamp: Date.now() }, '*');
    } catch (_) {}
  }
  sendHeartbeat();
  setInterval(sendHeartbeat, 3000);
})();
