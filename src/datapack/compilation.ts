import { SalesforceAPI, omniObjectName, omniFieldName } from '../sf-api.js';
import type { OmniNamespace } from '../sf-api.js';
import type { IpStepNode, IpStepInputMapping } from '../types/bundle.js';

// ─────────────────────────────────────────────────────────────────────────────
// OmniProcessCompilation — richer source for IP/OS graphs
//
// Each OmniProcessCompilation record is a chunk of the compiled JSON tree for
// one OmniProcess (IP or OmniScript). Large processes span multiple chunks
// ordered by Sequence; chunks must be concatenated before JSON.parse.
//
// Compiled tree root fields used here:
//   children[]     — step hierarchy (type, name, propSetMap, children)
//   dMap           — DataRaptor deps: { bundleName: "DataRaptor/Name" }
//   rMap           — IP/OS cross-refs: { key: "IntegrationProcedure/T/S/1" }
//   propSetMap     — root PSC: IntegrationProcedureInput/Output, etc.
//
// NOTE on dMap/rMap: these may be empty {} on some org versions even when the
// IP genuinely has DR/IP deps.  The children[] scan is the authoritative
// fallback — we always derive dep keys from BOTH sources.
//
// Available since minApiVersion 230.  Returns an empty map if the object does
// not exist on the org (queryAll throws a 400/404 SOQL error).
// ─────────────────────────────────────────────────────────────────────────────

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CompilationSummary {
  /** Flat text step summary for LLM prompt — replaces element-based ipSteps */
  ipSteps: string;
  /** Structured step tree for canvas renderers */
  schematic: IpStepNode[];
  /**
   * Dependency matchingKeys resolved from dMap + rMap + children[].
   * dMap/rMap may be empty on some org versions — children scan is the fallback.
   */
  depKeys: string[];
  /** I/O contracts from root propSetMap (fallback when dedicated fields absent) */
  ipInput?: string;
  ipOutput?: string;
  /**
   * Per-step input requirements extracted from children[].propSetMap.additionalInput.
   * Each entry maps a step (and its DR bundle) to the IP input variable names it needs.
   * Used for NLP slot-filling: AI identifies provided vs missing input fields.
   */
  stepInputMappings: IpStepInputMapping[];
}

// ─── Query + chunk reassembly ──────────────────────────────────────────────

/**
 * Queries OmniProcessCompilation for the given process IDs, reassembles
 * multi-chunk Content per process, and returns processId → parsed tree.
 *
 * Returns empty map silently if the object doesn't exist (pre-minApi-230 orgs).
 */
export async function queryCompilations(
  api: SalesforceAPI,
  processIds: string[],
  ns: OmniNamespace,
): Promise<Map<string, Record<string, unknown>>> {
  if (processIds.length === 0) return new Map();

  const op = (base: Parameters<typeof omniObjectName>[0]) => omniObjectName(base, ns);
  const f  = (field: string) => omniFieldName(field, ns);

  const CHUNK = 200;
  const rawChunks = new Map<string, Array<{ seq: number; content: string }>>();

  try {
    for (let i = 0; i < processIds.length; i += CHUNK) {
      const slice   = processIds.slice(i, i + CHUNK);
      const idList  = slice.map((id) => `'${id}'`).join(',');
      const rows    = await api.queryAll<Record<string, unknown>>(
        `SELECT ${f('OmniProcessId')}, ${f('Sequence')}, ${f('Content')} ` +
        `FROM ${op('OmniProcessCompilation')} ` +
        `WHERE ${f('OmniProcessId')} IN (${idList}) ` +
        `ORDER BY ${f('OmniProcessId')}, ${f('Sequence')}`,
      );
      for (const rawRow of rows) {
        const row     = normalizeRow(rawRow, ns);
        const pid     = row['OmniProcessId'] as string;
        const seq     = (row['Sequence'] as number) ?? 0;
        const content = (row['Content'] as string) ?? '';
        if (!rawChunks.has(pid)) rawChunks.set(pid, []);
        rawChunks.get(pid)!.push({ seq, content });
      }
    }
  } catch {
    // OmniProcessCompilation object doesn't exist on this org — silently skip
    return new Map();
  }

  const result = new Map<string, Record<string, unknown>>();
  for (const [pid, chunks] of rawChunks) {
    chunks.sort((a, b) => a.seq - b.seq);
    const full = chunks.map((c) => c.content).join('');
    try {
      result.set(pid, JSON.parse(full) as Record<string, unknown>);
    } catch {
      // Malformed JSON (truncated chunk or encoding issue) — skip
    }
  }
  return result;
}

// ─── Parse compiled tree ───────────────────────────────────────────────────

/**
 * Extracts a CompilationSummary from one parsed OmniProcessCompilation tree.
 *
 * Dep resolution strategy (in order, deduplicated):
 *   1. dMap values — "DataRaptor/BundleName" direct refs (may be empty)
 *   2. rMap values — "IntegrationProcedure/T/S/V" cross-refs (may be empty)
 *   3. children[] scan — bundle / ipKey from propSetMap (always present)
 *
 * Step input extraction:
 *   children[].propSetMap.additionalInput values matching %VarName% are the
 *   IP input variable names required by that step.  These drive the NLP
 *   slot-filling response (providedInputs / missingInputs).
 */
export function parseCompilation(tree: Record<string, unknown>): CompilationSummary {
  // ── Dependency keys from dMap + rMap ──────────────────────────────────────
  const depKeys: string[] = [];

  const dMap = tree['dMap'] as Record<string, string> | null | undefined;
  const rMap = tree['rMap'] as Record<string, string> | null | undefined;
  if (dMap) {
    for (const v of Object.values(dMap)) {
      if (v && typeof v === 'string' && !depKeys.includes(v)) depKeys.push(v);
    }
  }
  if (rMap) {
    for (const v of Object.values(rMap)) {
      if (v && typeof v === 'string' && !depKeys.includes(v)) depKeys.push(v);
    }
  }

  // ── I/O contracts from root propSetMap ────────────────────────────────────
  const rootPsc  = (tree['propSetMap'] as Record<string, unknown> | null | undefined) ?? {};
  const ipInput  = rootPsc['IntegrationProcedureInput']  as string | undefined || undefined;
  const ipOutput = rootPsc['IntegrationProcedureOutput'] as string | undefined || undefined;

  // ── Step tree from children[] ─────────────────────────────────────────────
  const rawChildren = (tree['children'] as Array<Record<string, unknown>> | undefined) ?? [];
  const schematic   = rawChildren.map(toStepNode).filter((n): n is IpStepNode => n !== null);

  // ── Supplement dep keys from children[] (dMap/rMap may be empty) ──────────
  // Walk the full tree and collect every DR bundle + IP invocation key found.
  collectChildDeps(rawChildren, depKeys);

  // ── Per-step input mappings (for NLP slot-filling) ────────────────────────
  const stepInputMappings = extractStepInputMappings(rawChildren);

  // ── Text summary ──────────────────────────────────────────────────────────
  const ipSteps = buildTextSummary(schematic, rawChildren.length);

  return { ipSteps, schematic, depKeys, ipInput, ipOutput, stepInputMappings };
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function normalizeRow(row: Record<string, unknown>, ns: OmniNamespace): Record<string, unknown> {
  if (ns === 'native') return row;
  const prefix = `${ns}__`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'attributes') continue;
    if (k.startsWith(prefix) && k.endsWith('__c')) {
      out[k.slice(prefix.length, -3)] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Walk the children[] tree and push any DataRaptor bundle or IP invocation
 * key found in propSetMap into depKeys (deduplicated).
 * This supplements dMap/rMap which can be empty on some org versions.
 */
function collectChildDeps(
  children: Array<Record<string, unknown>>,
  depKeys: string[],
): void {
  for (const child of children) {
    const type  = ((child['type'] as string) || '').toLowerCase();
    const psc   = (child['propSetMap'] as Record<string, unknown> | null | undefined) ?? {};
    const lower = type.toLowerCase();

    if (lower.includes('dataraptor') || lower.includes('data raptor')) {
      const bundle = (psc['bundle'] as string) || (psc['bundleName'] as string) || '';
      if (bundle) {
        const key = `DataRaptor/${bundle}`;
        if (!depKeys.includes(key)) depKeys.push(key);
      }
    } else if (
      lower.includes('integration procedure') ||
      lower === 'ipcall' || lower === 'ip call' || lower.includes('ip action')
    ) {
      const ipKey = (
        (psc['integrationProcedureKey'] as string) ||
        (psc['iPKey']   as string) ||
        (psc['ipKey']   as string) || ''
      );
      if (ipKey) {
        // ipKey format is typically "Type_SubType" — map to matchingKey prefix
        const parts = ipKey.split('_');
        if (parts.length >= 2) {
          const candidate = `IntegrationProcedure/${parts[0]}/${parts.slice(1).join('/')}`;
          if (!depKeys.includes(candidate)) depKeys.push(candidate);
        }
      }
    }

    // Recurse into nested children
    const nested = (child['children'] as Array<Record<string, unknown>> | undefined) ?? [];
    if (nested.length > 0) collectChildDeps(nested, depKeys);
  }
}

/**
 * Extracts per-step input requirements from top-level children[].
 *
 * For each step whose propSetMap.additionalInput contains %VarName% values,
 * returns an IpStepInputMapping recording:
 *   - which DR bundle the step calls
 *   - which IP input variable names are required
 *   - whether the step forwards only the additionalInput or the full payload
 *
 * %VarName% matching is intentionally lenient: strips leading/trailing
 * whitespace inside the % delimiters ("% Subject%" → "Subject").
 */
function extractStepInputMappings(
  children: Array<Record<string, unknown>>,
): IpStepInputMapping[] {
  const mappings: IpStepInputMapping[] = [];

  for (const child of children) {
    const type     = ((child['type'] as string) || '').trim();
    const name     = ((child['name'] as string) || '').trim();
    const psc      = (child['propSetMap'] as Record<string, unknown> | null | undefined) ?? {};
    const lower    = type.toLowerCase();

    // Only DataRaptor step types have meaningful additionalInput for this purpose
    if (!lower.includes('dataraptor') && !lower.includes('data raptor')) continue;

    const bundle   = (psc['bundle']   as string) || (psc['bundleName'] as string) || '';
    const drType   = (psc['type']     as string) || '';
    const sendOnly = (psc['sendOnlyAdditionalInput'] as boolean) ?? false;
    const addIn    = (psc['additionalInput'] as Record<string, unknown>) ?? {};

    const inputFields = extractIpVariables(addIn);
    if (inputFields.length === 0 && !bundle) continue;

    mappings.push({
      stepName:               name || type,
      stepType:               type,
      ...(bundle ? { drBundle: bundle } : {}),
      inputFields,
      sendOnlyAdditionalInput: sendOnly,
    });
  }

  return mappings;
}

/**
 * From an additionalInput map, extract the IP input variable names —
 * the values that match the pattern %VarName% (with optional inner whitespace).
 *
 * additionalInput: { "Name": "%Name%", "Subject": "% Subject%" }
 *   → ["Name", "Subject"]
 *
 * Static values (hardcoded strings, not %...%) are NOT returned since the
 * caller doesn't need to provide them.
 */
function extractIpVariables(additionalInput: Record<string, unknown>): string[] {
  const fields: string[] = [];
  // Matches %...% with optional inner whitespace: "%Name%", "% Subject%"
  const varPat = /^%\s*([^%]+?)\s*%$/;
  for (const value of Object.values(additionalInput)) {
    if (typeof value !== 'string') continue;
    const m = value.trim().match(varPat);
    if (m) {
      const varName = m[1].trim();
      if (varName && !fields.includes(varName)) fields.push(varName);
    }
  }
  return fields;
}

function toStepNode(elem: Record<string, unknown>): IpStepNode | null {
  const type = ((elem['type'] as string) || (elem['Type'] as string) || '').trim();
  if (!type) return null;

  const name = (elem['name'] as string) || (elem['label'] as string) || undefined;
  const psc  = (elem['propSetMap'] as Record<string, unknown> | null | undefined) ?? {};
  const rawKids = (elem['children'] as Array<Record<string, unknown>> | undefined) ?? [];

  const node: IpStepNode = { type };
  if (name) node.name = name;

  const lower = type.toLowerCase();

  if (lower.includes('dataraptor') || lower.includes('data raptor')) {
    const bundle = (psc['bundle'] as string) || (psc['bundleName'] as string) || '';
    const drType = (psc['type']   as string) || (psc['drType']    as string) || '';
    if (bundle) node.drBundle = bundle;
    if (drType) node.drType   = drType;

    // Input field requirements — drives NLP slot-filling in the graph prompt
    const addIn = (psc['additionalInput'] as Record<string, unknown>) ?? {};
    const inputFields = extractIpVariables(addIn);
    if (inputFields.length > 0) node.inputFields = inputFields;
    const sendOnly = psc['sendOnlyAdditionalInput'] as boolean | undefined;
    if (sendOnly !== undefined) node.sendOnlyAdditionalInput = sendOnly;

  } else if (lower.includes('http') || lower === 'remoteaction' || lower === 'remote action') {
    node.httpMethod = (
      (psc['httpMethod'] as string) || (psc['method'] as string) || 'HTTP'
    ).toUpperCase();
    node.httpUrl = (
      (psc['url'] as string) || (psc['path'] as string) || (psc['endpoint'] as string) || ''
    ).split('?')[0].slice(0, 60);

  } else if (
    lower.includes('integration procedure') || lower === 'ipcall' ||
    lower === 'ip call' || lower.includes('ip action')
  ) {
    const ipKey =
      (psc['integrationProcedureKey'] as string) ||
      (psc['iPKey']                   as string) ||
      (psc['ipKey']                   as string) || '';
    if (ipKey) node.ipKey = ipKey;

  } else if (lower === 'conditional' || lower.includes('condition')) {
    const cond = (
      (psc['conditionLogic'] as string) || (psc['condition'] as string) || ''
    ).slice(0, 80);
    if (cond) node.condition = cond;
  }

  const kids = rawKids.map(toStepNode).filter((n): n is IpStepNode => n !== null);
  if (kids.length > 0) node.children = kids;

  return node;
}

/**
 * Flat text summary of the step tree — optimised for LLM context tokens.
 * Depth-first walk, at most 10 snippets before truncating.
 * For DR steps with inputFields, appends the field list.
 */
function buildTextSummary(steps: IpStepNode[], totalTopLevel: number): string {
  if (steps.length === 0) return '';

  const snippets: string[] = [];

  function walk(nodes: IpStepNode[]): void {
    for (const n of nodes) {
      const lower = n.type.toLowerCase();
      let label: string;

      if (lower.includes('dataraptor') || lower.includes('data raptor')) {
        const base = n.drBundle
          ? `DR-${n.drType || 'Action'} ${n.drBundle}`
          : `DR-${n.drType || 'Action'}`;
        // Append input fields if known (e.g. "DR-Post CreateAccounts[Name]")
        label = n.inputFields?.length
          ? `${base}[${n.inputFields.join(',')}]`
          : base;
      } else if (lower.includes('http') || lower === 'remoteaction' || lower === 'remote action') {
        label = n.httpUrl
          ? `${n.httpMethod || 'HTTP'} ${n.httpUrl}`
          : `${n.httpMethod || 'HTTP'}-Action`;
      } else if (lower.includes('integration procedure') || lower === 'ipcall' || lower === 'ip call') {
        label = n.ipKey ? `IP-Call ${n.ipKey}` : 'IP-Call';
      } else if (lower === 'conditional' || lower.includes('condition')) {
        label = n.condition ? `Conditional: ${n.condition}` : 'Conditional';
      } else if (lower === 'loop') {
        label = n.name ? `Loop: ${n.name}` : 'Loop';
      } else if (
        lower === 'setvariable' || lower === 'set' ||
        lower === 'assignment'  || lower.includes('setvariable')
      ) {
        label = n.name ? `Set ${n.name}` : 'Set';
      } else if (lower === 'response' || lower.includes('response action')) {
        label = 'Response';
      } else {
        label = n.name ? `${n.type} ${n.name}` : n.type;
      }

      snippets.push(label);
      if (n.children?.length) walk(n.children);
    }
  }

  walk(steps);

  if (snippets.length === 0) return '';
  const shown  = snippets.slice(0, 10);
  const suffix = snippets.length > 10 ? ` (+${snippets.length - 10} more)` : '';
  return `Steps (${totalTopLevel}): ${shown.join(', ')}${suffix}`;
}
