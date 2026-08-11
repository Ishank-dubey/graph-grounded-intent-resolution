# OmniStudio Tools — Design Document

## Overview

OmniStudio Tools is a Chrome/Edge browser extension that gives Salesforce
developers and admins a first-class developer toolbelt for OmniStudio: live
DataJSON inspection, backend call tracing, DataPack export/import, and an
intent-driven Headless planner — all docked natively to the browser as a Side
Panel.

---

## Goals

1. **Zero-friction access** — one toolbar click, panel docks to browser, no
   separate window to manage.
2. **Works in player mode** — no debug flag required to see DataJSON or Call Trace.
3. **Read the real runtime** — hooks directly into OmniScript LWC events and
   component state, not scraping the DOM.
4. **Governed execution** — observation features are read-only; Headless writes
   occur only after explicit user confirmation and execute through existing
   Salesforce Integration Procedure or Data Mapper APIs.

---

## Extension Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser Side Panel  (chrome-extension:// origin)                       │
│  panel.html + panel.js                                                  │
│  • Feature tabs: DataPack | Profiler | Debugger | Headless | Migration  │
│  • Polls background every 1.5 s for DataJSON + CallTrace                │
│  • Calls Salesforce REST/Tooling API directly for DataPack ops          │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │ chrome.runtime.sendMessage
┌────────────────────────────────▼────────────────────────────────────────┐
│  Service Worker  (background.js)                                        │
│  • dataJsonStore   Map<tabId, {source, dataJson, timestamp}>            │
│  • callTraceStore  Map<tabId, Array<{callTrace, timestamp}>> (ring 50)  │
│  • hookAliveStore  Map<tabId, timestamp>                                │
│  • Injects page-hook.js via chrome.scripting.executeScript on tab load  │
│  • Sets chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})│
└──────────────┬──────────────────────────────────────────────────────────┘
               │ chrome.runtime.sendMessage
┌──────────────▼──────────────────────────────────────────────────────────┐
│  content.js  [ISOLATED world]                                           │
│  • Receives postMessage from page-hook (MAIN world)                     │
│  • Decodes JSON strings (never raw Proxy objects)                       │
│  • Forwards to background as DATAJSON_UPDATE / CALL_TRACE_UPDATE        │
└──────────────▲──────────────────────────────────────────────────────────┘
               │ window.postMessage  (JSON strings only — LWS Proxy safe)
┌──────────────┴──────────────────────────────────────────────────────────┐
│  page-hook.js  [MAIN world — runs in page's JS context]                 │
│                                                                         │
│  Observation sources:                                                   │
│  1. document.addEventListener('omniaggregate', ...)    ← DataJSON       │
│  2. document.addEventListener('omniactiondebug', ...)  ← Call Trace     │
│  3. XHR intercept (XMLHttpRequest.prototype.open/send) ← fallback       │
│  4. fetch intercept (window.fetch)                     ← fallback       │
│  5. DOM poll setInterval(1500ms):                                       │
│     • reads comp._jsonData / comp.jsonDef.response                      │
│     • sets comp.runMode = 'debug' to unlock omniactiondebug             │
│                                                                         │
│  All data JSON.stringify'd before postMessage                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Feature: Debugger Tab

### DataJSON sub-tab

Displays the live OmniScript DataJSON as a collapsible tree. Auto-updates
whenever an `omniaggregate` event fires.

- Tree auto-expands 2 levels deep
- Click any leaf row to copy merge field (`%keyName%`) to clipboard
- Copy button exports full JSON
- Source badge shows OmniScript vs FlexCard
- Timestamp shows when data was last updated

### Call Trace sub-tab

Displays a chronological list of backend action calls (newest first).

Each card shows:
- Type badge: **IP** (teal) | **DataRaptor** (green) | **Apex** (blue) | **REST** (purple)
- Human-readable label (`options.integrationProcedureKey` or class name)
- Timestamp
- Click to expand → Request JSON + Response JSON with horizontal scroll

**How call tracing works:**
1. DOM poll sets `comp.runMode = 'debug'` on the OmniScript header component
2. This makes `handleActionEvents` call `sendDataToDebugConsole` after every action
3. `sendDataToDebugConsole` dispatches `omniactiondebug` CustomEvent
4. `page-hook` captures it and posts to content bridge
5. Background appends to ring buffer (max 50 per tab)

XHR/fetch intercept provides a secondary capture path for non-LDS calls
(REST actions, off-platform).

---

## Feature: DataPack Tab

Export and import OmniStudio components as JSON bundles.

### Export flow
1. Panel calls Salesforce REST API to list components (OmniScript, IP, DataRaptor, FlexCard)
2. User selects components + options (include deps, active only)
3. Panel calls Tooling API to export each component with its elements/items
4. Bundle saved as `omnistudio-bundle-<date>.json`

### Import flow
1. User drops a bundle JSON file
2. Pre-flight check: query existing versions, show what will be created
3. User confirms → import creates records via REST API
4. Results shown per component (created / error)

### Bundle format (v2.0)
```json
{
  "formatVersion": "2.0",
  "exportDate": "ISO timestamp",
  "exportOrg": "org domain",
  "entries": [
    {
      "type": "OmniScript | IntegrationProcedure | OmniUiCard | DataRaptor",
      "matchingKey": "Type/SubType/Language",
      "exportedAt": "ISO timestamp",
      "dependencies": ["matchingKey", ...],
      "process": { ...OmniProcess record... },
      "elements": [ ...OmniProcessElement records... ]
    }
  ]
}
```

---

## Feature: Headless Intent Planner

The Headless tab treats active OmniStudio metadata as a governed capability
catalog. It resolves a natural-language goal to either:

- an Integration Procedure that already models the complete workflow,
- one atomic Data Mapper operation, or
- a sequential chain of compatible Data Mapper operations.

The LLM plans and supplies parameters. Salesforce executes every operation and
enforces runtime permissions, CRUD/FLS, sharing, validation, and Data Mapper/IP
behavior.

### Graph model

Let the capability graph be:

```math
G = (V, E_A, E_I)
```

where:

| Symbol | Meaning |
|---|---|
| `V` | Discovered OmniScripts, Integration Procedures, DataRaptors, and FlexCards, each carrying activation state |
| `E_A` | Authored dependency edges extracted from OmniStudio metadata |
| `E_I` | Inferred compatibility edges derived from Data Mapper contracts |

An authored edge `(u,v) ∈ E_A` means component `u` explicitly references or
invokes component `v`. For example:

```text
IntegrationProcedure/ishank/ishank/1
  ├── DataRaptor/CreateAccounts
  └── DataRaptor/CreateCase
```

An inferred edge does **not** claim that the customer authored a workflow. It
means only that the output contract of one atomic capability can satisfy an
input contract of another.

### Inferred record-ID edges

For a Load Data Mapper `d`, define:

```math
O(d) = \{\text{object API names written by } d\}
```

```math
I(d) = \{\text{input field names accepted by } d\}
```

For two distinct Load Data Mappers `u` and `v`, infer a record-ID edge when:

```math
\exists o \in O(u) : \operatorname{normalize}(o) + \text{"Id"} \in I(v)
```

The comparison is case-insensitive. `normalize` removes the `__c` suffix before
constructing the expected ID input. The resulting edge is:

```math
e = (u, v, \text{recordId}, o, o\text{Id}, c_e)
```

The current exact-contract rule assigns:

```math
c_e = 0.95
```

Developer-authored descriptions are retained as supporting evidence but do not
create the edge by themselves. This intentionally favors precision over recall.

Concrete example:

```text
CreateAccounts
  O(CreateAccounts) = {Account}
           |
           | inferred: Account.Id → AccountId
           | edge confidence = 0.95
           v
CreateCaseUsingAccount
  I(CreateCaseUsingAccount) = {AccountId, Subject, Priority, ...}
  O(CreateCaseUsingAccount) = {Case}
```

Serialized representation:

```json
{
  "source": "DataRaptor/CreateAccounts",
  "target": "DataRaptor/CreateCaseUsingAccount",
  "kind": "recordId",
  "outputObject": "Account",
  "inputField": "AccountId",
  "confidence": 0.95,
  "evidence": [
    "CreateAccounts writes Account",
    "CreateCaseUsingAccount accepts AccountId",
    "Consumer description: Creates a Case for an existing Account"
  ]
}
```

Inferred edges are stored in `HeadlessGraph.inferredEdges`, separate from
`HeadlessNode.deps`. `GraphRenderTree` marks them as `inferredDataFlow`, and
Mermaid renders them as dashed edges. This prevents compatibility from being
mistaken for an authored dependency.

### Deterministic planning mode

Technical compatibility and business relevance are independent. The exact
contract rule exposes a fixed, explicitly uncalibrated `edgeEvidenceScore`.
That value is diagnostic rule metadata; it is not a probability, authorization,
or planning-mode threshold.

The application-enforced mode depends on external invocation cardinality and
whether the proposal declares unfinished work:

```math
\operatorname{mode}(P,r) =
\begin{cases}
\text{one\_go}, & |P| = 1 \land r = \varnothing \\
\text{stepwise}, & |P| = 1 \land r \ne \varnothing
\end{cases}
```

| Mode | Planner output | Execution behavior |
|---|---|---|
| `one_go` | Exactly one atomic Data Mapper or one authored IP invocation | User confirms the invocation, then Salesforce executes it |
| `stepwise` | Exactly one next safe operation | Execute after confirmation, observe the real result, then re-plan |

The parser rejects mixed IP/Data Mapper proposals and any response containing
more than one external invocation. It derives the mode from the invocation and
`remainingGoal`, ignoring the model's requested label. A composed Data Mapper
flow is therefore always proposed and executed one observed operation at a time.

### Ordered invocation contract

The planner expresses dependencies and output bindings explicitly:

```json
{
  "planningMode": "stepwise",
  "remainingGoal": "Create a Case linked to the observed Account result.",
  "drInvocations": [
    {
      "invocationId": "createAccount",
      "drBundle": "CreateAccounts",
      "providedInputs": { "Name": "Ishank" }
    }
  ]
}
```

Derived inputs are not rendered as user-editable missing fields. They are
resolved only from normalized Salesforce execution results on a later
stepwise turn.

### Data Mapper result normalization

The Data Mapper Connect API returns an outer envelope whose `response[]` values
can contain HTML-encoded JSON. `normalizeDataMapperResult()` decodes this into:

```typescript
interface NormalizedDataMapperResult {
  success: boolean;
  status: string;
  error: string;
  createdIdsByObject: Record<string, string[]>;
  records: Array<{
    objectType: string;
    id?: string;
    success: boolean;
    values: Record<string, unknown>;
  }>;
  response: unknown[];
  raw: Record<string, unknown>;
}
```

Inner failures such as `hasErrors: true`, `rolledBack: true`, failed upserts, or
an error status are treated as failures even if the HTTP request succeeded.

### Resumable execution session

For stepwise planning, state is represented as:

```math
S_t = (g, r_t, C_t, A_t)
```

where:

| Symbol | Meaning |
|---|---|
| `g` | Original user goal |
| `r_t` | Remaining goal after step `t` |
| `C_t` | Set of completed invocation IDs |
| `A_t` | Typed artifacts returned by Salesforce |

After the user confirms action `a_t` and Salesforce returns result `y_t`, the
transition is:

```math
S_{t+1} = T(S_t, a_t, y_t)
         = (g, r_{t+1}, C_t \cup \{a_t.id\}, A_t \cup \operatorname{artifacts}(y_t))
```

The next action is selected from the updated evidence:

```math
a_{t+1} = \pi(G, S_{t+1})
```

The planner receives a `SESSION UPDATE` containing the original goal, remaining
goal, completed steps, and artifacts. It is instructed not to repeat a completed
write and not to invent artifact IDs.

```text
User goal
   |
   v
Plan next action or complete flow
   |
   v
Collect missing user inputs
   |
   v
User confirms state-changing operation
   |
   v
Salesforce executes IP/Data Mapper
   |
   v
Normalize result → completed step + typed artifacts
   |
   +── high-confidence complete flow: execute next dependency sequentially
   |
   └── stepwise: send SESSION UPDATE → re-plan remaining goal
```

### Safety invariants

For every execution session:

1. A state-changing step requires explicit user confirmation.
2. A step executes only after every `dependsOn` invocation succeeds.
3. A derived record ID must come from `A_t`, never from model text.
4. A completed invocation ID in `C_t` must not be executed again automatically.
5. Edge or intent confidence never overrides Salesforce authorization or errors.
6. Failure to resolve a required artifact stops the chain.
7. Inferred edges remain labeled as candidates throughout planning and rendering.

---

## Key Technical Constraints

### Salesforce Lightning Web Security (LWS)

LWS wraps all JavaScript objects in ES Proxy objects when running in the page
context. These Proxies cannot be passed through `window.postMessage` (structured
clone throws `DataCloneError`).

**Rule:** `page-hook.ts` always calls `JSON.stringify()` before posting. Never
pass a raw object from LWC component internals across the world boundary.

### LDS Wire Adapters bypass XHR

OmniScript IP/DataRaptor calls go through the Salesforce LDS engine
(`force/ldsAdaptersOmniRuntimeOneStoreApi → genericInvoke`), which uses an
internal HTTP stack that is **not** `window.XMLHttpRequest`. Patching XHR/fetch
will not intercept these calls.

**Solution:** Use the `omniactiondebug` event path instead (see above).

### Aura endpoint shape (empirically confirmed)

```
URL:  /aura?r=N&aura.IOmniscriptRuntimeConnect.genericInvoke=1
Body: message=<urlencoded JSON>

JSON shape:
{
  "actions": [{
    "descriptor": "aura://IOmniscriptRuntimeConnectController/ACTION$genericInvoke",
    "params": {
      "omniscriptRuntimeGenericInvokeInputRepresentation": {
        "params": {
          "input":     "<json string>",
          "options":   "<json string>",   // contains integrationProcedureKey
          "className": "omnistudiocore.IPService",
          "methodName": "integrationProcedureKeyAction"
        }
      }
    }
  }]
}
```

Note: descriptor is `IOmniscriptRuntimeConnectController`, not
`BusinessProcessDisplayController` (the legacy path used by older orgs).

### `event.source !== window` — do not use in content.ts

In MV3, the MAIN world and ISOLATED world have different `window` proxy objects.
This check always fails for cross-world postMessage. Use the `__omniDebug` flag
on the message payload as the filter instead.

---

## Side Panel Integration

Uses Chrome Side Panel API (`chrome.sidePanel`, Chrome 114+ / all Edge).

```json
// manifest.json
"permissions": ["sidePanel", ...],
"side_panel": { "default_path": "panel.html" }
```

```ts
// background.ts — one-time setup
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

The side panel runs at `chrome-extension://` origin — completely outside
the Salesforce DOM, immune to Salesforce's CSP and LWS.

**Tab tracking:** `originTabId` is set by `tabs.onActivated` (keeps in sync
as user switches tabs) and by `SET_ORIGIN_TAB` message from the panel
(fallback for first open).

---

## File Reference

| File | Role |
|---|---|
| `manifest.json` | Extension manifest — permissions, entry points, side_panel |
| `panel.html` | Side panel HTML skeleton — all tab structures |
| `panel.css` | Dark theme CSS — full panel UI |
| `src/background.ts` | Service worker — stores, injection, message routing |
| `src/content.ts` | Isolated world bridge — postMessage → runtime.sendMessage |
| `src/page-hook.ts` | MAIN world hook — events, XHR/fetch intercept, DOM poll |
| `src/panel.ts` | Side panel UI — all tab logic, polling, rendering |
| `src/auth.ts` | Salesforce session cookie extraction |
| `src/sf-api.ts` | Salesforce REST/Tooling API client |
| `src/datapack/exporter.ts` | DataPack export — queries + bundle assembly |
| `src/datapack/importer.ts` | DataPack import — record creation |
| `src/datapack/render-tree.ts` | HeadlessGraph → SDK-neutral GraphRenderTree |
| `src/headless/graphPrompt.ts` | Capability serialization + one-go/stepwise planner contract |
| `src/headless/dataMapperResponse.ts` | Data Mapper response normalization and artifact extraction |
| `src/headless-background.ts` | Headless graph, AI, IP, and Data Mapper message handlers |
| `src/panel/tabs/HeadlessTab.tsx` | Planner UI, sequential execution, and resumable session state |
| `src/types/bundle.ts` | TypeScript types for OmniBundle format |

---

## Roadmap

### v0.2 — Call Trace polish
- [ ] Elapsed time per call (ms) using `_readyTime`/`_stopTime`
- [ ] Filter bar: show only IP / only errors
- [ ] Collapse all / expand all button

### v0.3 — DataJSON polish
- [ ] Search/filter bar for key names
- [ ] Show diff from previous snapshot (highlight changed values)
- [ ] Pin specific keys to a "watch" panel

### v0.4 — Profiler tab
- [ ] Waterfall chart of action timing
- [ ] Identify slow actions (> threshold)
- [ ] Export timing report as CSV

### v0.5 — Migration tab
- [ ] Connect to two orgs simultaneously
- [ ] Diff DataPack between source and target org
- [ ] One-click promote

### Headless planner — implemented prototype
- [x] Build an annotated OmniStudio capability graph
- [x] Infer exact `Object → ObjectId` Data Mapper compatibility edges
- [x] Route single-operation intents to atomic Data Mappers
- [x] Build sequential Data Mapper chains with typed output propagation
- [x] Enforce deterministic one-go versus stepwise invocation cardinality
- [x] Re-plan from completed steps and real Salesforce artifacts
- [ ] Persist resumable sessions beyond the current panel lifetime
- [ ] Calibrate confidence thresholds on developer-labeled real-org data
- [ ] Add administrator policy for AI-exposed capabilities and operation risk
