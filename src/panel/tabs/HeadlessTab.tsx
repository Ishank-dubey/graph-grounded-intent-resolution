import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useExt } from '../context/ExtContext';
import { JsonTree } from '../components/JsonTree';
import type { ComponentType } from '../../types/bundle.js';
import type { HeadlessGraph, HeadlessNode } from '../../datapack/exporter.js';
import { buildFullGraphPrompt, TYPE_LABELS } from '../../headless/graphPrompt.js';
import { toRenderTree } from '../../datapack/render-tree.js';
import type { GraphRenderTree } from '../../types/render-tree.js';
import { AiSettings, loadAiConfig, aiButtonLabel } from '../components/AiSettings';
import type { AiConfig } from '../components/AiSettings';
import { resolvePlanningMode, type PlanningMode } from '../../headless/planningPolicy.js';
import { buildExistingRecordCorrection, findExistingRecordConflict } from '../../headless/planningGuard.js';
import { normalizeDataMapperResult } from '../../headless/dataMapperResponse.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type ViewMode = 'list' | 'json' | 'graph' | 'mermaid' | 'ai-prompt';
const HEADLESS_BUILD_ID = '2026.08.11-query-picker-2';

/** A single completed AI exchange */
type ConvTurn = {
  intent: string;
  relevantKeys: string[];
  /** IP invocation contracts returned by the AI — empty on old-format responses */
  ipInvocations: IpInvocation[];
  /** DR direct-call contracts returned by the AI — empty when IP path chosen */
  drInvocations: DrInvocation[];
  plan: string;
  /** Raw model response text (used for building follow-up message history) */
  rawResponse: string;
};

interface ExecutionArtifact {
  type: string;
  id: string;
  sourceInvocation: string;
  values: Record<string, unknown>;
}

interface CompletedExecutionStep {
  invocationId: string;
  capability: string;
  inputs: Record<string, unknown>;
  completedAt: string;
}

interface ExecutionSession {
  goal: string;
  planningMode: PlanningMode;
  remainingGoal: string;
  completedSteps: CompletedExecutionStep[];
  artifacts: ExecutionArtifact[];
}

/** Comparison between two consecutive graph builds */
type GraphDiff = {
  addedKeys: string[];
  removedKeys: string[];
  deltaEdges: number;
};

const COMP_TYPES: ComponentType[] = ['OmniScript', 'IntegrationProcedure', 'OmniUiCard', 'DataRaptor'];

const TYPE_COLORS: Record<ComponentType, string> = {
  OmniScript:           '#1a56db',
  IntegrationProcedure: '#059669',
  OmniUiCard:           '#7c3aed',
  DataRaptor:           '#d97706',
};

/**
 * Build the full Anthropic/OpenAI messages array for a query.
 *
 * First turn:  messages = [{ role:'user', content: fullGraphPrompt }]
 * Follow-up:  messages = [{ role:'user', content: fullGraphPrompt(turn0) },
 *                          { role:'assistant', content: turn0.rawResponse },
 *                          { role:'user', content: turn1.intent },
 *                          { role:'assistant', content: turn1.rawResponse }, ...]
 *              + last user message = currentIntent (follow-up question, no graph re-serialisation)
 */
function buildApiMessages(
  graph: HeadlessGraph,
  history: ConvTurn[],
  currentIntent: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (history.length === 0) {
    return [{ role: 'user', content: buildFullGraphPrompt(graph, currentIntent) }];
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  messages.push({ role: 'user', content: buildFullGraphPrompt(graph, history[0].intent) });
  messages.push({ role: 'assistant', content: history[0].rawResponse });
  for (let i = 1; i < history.length; i++) {
    messages.push({ role: 'user', content: history[i].intent });
    messages.push({ role: 'assistant', content: history[i].rawResponse });
  }
  messages.push({ role: 'user', content: currentIntent });
  return messages;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mermaid generator
// ─────────────────────────────────────────────────────────────────────────────

function buildMermaidDiagram(
  graph: HeadlessGraph,
  relevantKeys: Set<string>,
): string {
  const nodeById = new Map<string, HeadlessNode>(
    graph.nodes.map((n) => [n.ref.matchingKey, n]),
  );

  // Determine scope: if AI has identified relevant nodes, show them + direct neighbours
  // for context.  Otherwise show ALL (capped at 80 to keep Mermaid renderable).
  let includedKeys: Set<string>;
  if (relevantKeys.size > 0) {
    includedKeys = new Set<string>(relevantKeys);
    for (const node of graph.nodes) {
      if (relevantKeys.has(node.ref.matchingKey)) {
        node.deps.forEach((k) => includedKeys.add(k));
        node.dependents.forEach((k) => includedKeys.add(k));
      }
    }
    for (const edge of graph.inferredEdges ?? []) {
      if (relevantKeys.has(edge.source) || relevantKeys.has(edge.target)) {
        includedKeys.add(edge.source);
        includedKeys.add(edge.target);
      }
    }
  } else {
    includedKeys = new Set(graph.nodes.map((n) => n.ref.matchingKey));
  }

  if (includedKeys.size > 80) {
    return (
      `%% Graph has ${includedKeys.size} nodes — too large to render as Mermaid.\n` +
      `%% Run a business-intent query first to narrow to relevant components,\n` +
      `%% then switch to the Mermaid view to see the focused subgraph.`
    );
  }

  // Assign stable short IDs
  const idMap = new Map<string, string>();
  let idx = 0;
  for (const key of includedKeys) {
    idMap.set(key, `n${idx++}`);
  }

  const lines: string[] = ['graph LR'];
  lines.push('  classDef os fill:#1a56db,stroke:#1245b0,color:#fff');
  lines.push('  classDef ip fill:#059669,stroke:#047857,color:#fff');
  lines.push('  classDef fc fill:#7c3aed,stroke:#6d28d9,color:#fff');
  lines.push('  classDef dr fill:#d97706,stroke:#b45309,color:#fff');
  lines.push('  classDef rel stroke:#e11d48,stroke-width:3px');

  // Node declarations
  for (const key of includedKeys) {
    const node = nodeById.get(key);
    const id = idMap.get(key)!;
    const label = (node ? node.ref.name : key)
      .replace(/"/g, "'")
      .replace(/[[\]{}|]/g, ' ')
      .slice(0, 40);
    lines.push(`  ${id}["${label}"]`);
    const type = node?.ref.type ?? 'OmniScript';
    const cls = type === 'OmniScript' ? 'os'
      : type === 'IntegrationProcedure' ? 'ip'
      : type === 'OmniUiCard' ? 'fc'
      : 'dr';
    lines.push(`  class ${id} ${cls}`);
    if (relevantKeys.has(key)) lines.push(`  class ${id} rel`);
  }

  // Edges
  const seenEdges = new Set<string>();
  for (const key of includedKeys) {
    const node = nodeById.get(key);
    if (!node) continue;
    const fromId = idMap.get(key)!;
    for (const depKey of node.deps) {
      if (!includedKeys.has(depKey)) continue;
      const toId = idMap.get(depKey);
      if (!toId) continue;
      const edge = `${fromId}>${toId}`;
      if (seenEdges.has(edge)) continue;
      seenEdges.add(edge);
      lines.push(`  ${fromId} --> ${toId}`);
    }
  }
  for (const edge of graph.inferredEdges ?? []) {
    if (!includedKeys.has(edge.source) || !includedKeys.has(edge.target)) continue;
    const fromId = idMap.get(edge.source);
    const toId = idMap.get(edge.target);
    if (!fromId || !toId) continue;
    const edgeKey = `inferred>${fromId}>${toId}>${edge.inputField}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    const selection = edge.selectionPolicy === 'userSelectMultiple' ? ' (select if multiple)' : '';
    lines.push(`  ${fromId} -. "${edge.outputObject} Id → ${edge.inputField}${selection}" .-> ${toId}`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function downloadJson(filename: string, data: unknown) {
  downloadText(filename, JSON.stringify(data, null, 2));
}

interface MissingInput {
  field: string;
  forStep?: string;
  /** Natural-language question to prompt the user */
  prompt?: string;
  /** true = enrichment/conditional field — IP can execute without it */
  optional?: boolean;
}

interface IpInvocation {
  ipInvocationKey: string;
  purpose?: string;
  /** Input field values extracted directly from the NLP intent */
  providedInputs?: Record<string, string>;
  /** Required fields not mentioned in the intent — UI should ask for these */
  missingInputs?: MissingInput[];
  /** Legacy: raw input contract string (old response format) */
  inputContract?: string | null;
}

interface DrInvocation {
  /** Stable ID used by dependency and output bindings within a DR chain */
  invocationId: string;
  /** DataRaptor name — used as the DataMapper API path segment */
  drBundle: string;
  /** Load | Extract | Transform | Turbo Extract */
  drType: string;
  purpose?: string;
  /** Input field values extracted directly from the NLP intent */
  providedInputs?: Record<string, string>;
  /** Prior invocation IDs that must complete successfully before this step */
  dependsOn?: string[];
  /** Inputs populated from records created by an earlier Data Mapper step */
  derivedInputs?: DerivedInput[];
  /** Fields not mentioned in the intent — UI should ask for these */
  missingInputs?: MissingInput[];
}

interface DerivedInput {
  field: string;
  fromInvocation: string;
  objectType: string;
}

interface DataMapperExecutionResult {
  success: boolean;
  status: string;
  error: string;
  createdIdsByObject: Record<string, string[]>;
  records: Array<{ objectType: string; id?: string; success: boolean; values: Record<string, unknown> }>;
  response: unknown[];
  raw: Record<string, unknown>;
}

function createdIdForObject(result: DataMapperExecutionResult | undefined, objectType: string): string | undefined {
  if (!result) return undefined;
  const matchingRecords = result.records.filter((candidate) =>
    candidate.success &&
    candidate.objectType.toLowerCase() === objectType.toLowerCase() &&
    !!candidate.id,
  );
  if (matchingRecords.length === 1) return matchingRecords[0].id;
  if (matchingRecords.length > 1) return undefined;
  const match = Object.entries(result.createdIdsByObject)
    .find(([candidate]) => candidate.toLowerCase() === objectType.toLowerCase());
  return match?.[1]?.length === 1 ? match[1][0] : undefined;
}

function recoverDataMapperRecords(result: DataMapperExecutionResult): DataMapperExecutionResult {
  if (result.records.length > 0) return result;
  const recovered = normalizeDataMapperResult(result.raw);
  return recovered.records.length > 0 ? { ...result, records: recovered.records } : result;
}

function inferredEdgesForNode(graph: HeadlessGraph | null, matchingKey: string) {
  return (graph?.inferredEdges ?? []).filter(
    (edge) => edge.source === matchingKey || edge.target === matchingKey,
  );
}

// ── Shared helper — parse a missingInputs[] array from the AI response ──────
function parseMissingInputs(raw: unknown): MissingInput[] {
  if (!Array.isArray(raw)) return [];
  const result: MissingInput[] = [];
  for (const m of raw as unknown[]) {
    if (m && typeof m === 'object' && 'field' in m) {
      const mi = m as Record<string, unknown>;
      result.push({
        field:    String(mi['field']  ?? ''),
        forStep:  typeof mi['forStep'] === 'string' ? mi['forStep']  : undefined,
        prompt:   typeof mi['prompt']  === 'string' ? mi['prompt']   : undefined,
        optional: mi['optional'] === true,
      });
    }
  }
  return result;
}

// ── Shared helper — parse a providedInputs{} object from the AI response ────
function parseProvidedInputs(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const provided: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    provided[k] = String(v);
  }
  return Object.keys(provided).length > 0 ? provided : undefined;
}

function parseAiResponse(text: string): {
  relevantKeys: string[];
  plan: string;
  ipInvocations: IpInvocation[];
  drInvocations: DrInvocation[];
  planningMode: PlanningMode;
  remainingGoal: string;
} | null {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      relevantKeys?: unknown;
      ipInvocations?: unknown;
      invocations?: unknown;        // backward compat — old schema used "invocations"
      drInvocations?: unknown;
      planningMode?: unknown;
      remainingGoal?: unknown;
      plan?: unknown;
    };
    if (!Array.isArray(parsed.relevantKeys)) return null;

    // ── Parse ipInvocations[] (new key) or invocations[] (backward compat) ──
    const ipInvocations: IpInvocation[] = [];
    const rawIpInv = parsed.ipInvocations ?? parsed.invocations;
    if (Array.isArray(rawIpInv)) {
      for (const inv of rawIpInv as unknown[]) {
        if (inv && typeof inv === 'object' && 'ipInvocationKey' in inv) {
          const i = inv as Record<string, unknown>;
          ipInvocations.push({
            ipInvocationKey: String(i['ipInvocationKey'] ?? ''),
            purpose:         typeof i['purpose']       === 'string' ? i['purpose']       : undefined,
            inputContract:   typeof i['inputContract']  === 'string' ? i['inputContract']  : null,
            providedInputs:  parseProvidedInputs(i['providedInputs']),
            missingInputs:   parseMissingInputs(i['missingInputs']),
          });
        }
      }
    }

    // ── Parse drInvocations[] ─────────────────────────────────────────────────
    const drInvocations: DrInvocation[] = [];
    if (Array.isArray(parsed.drInvocations)) {
      for (const inv of parsed.drInvocations as unknown[]) {
        if (inv && typeof inv === 'object' && 'drBundle' in inv) {
          const i = inv as Record<string, unknown>;
          const invocationId = String(i['invocationId'] ?? i['drBundle'] ?? `dr-${drInvocations.length + 1}`);
          const derivedInputs: DerivedInput[] = [];
          if (Array.isArray(i['derivedInputs'])) {
            for (const rawBinding of i['derivedInputs'] as unknown[]) {
              if (!rawBinding || typeof rawBinding !== 'object') continue;
              const binding = rawBinding as Record<string, unknown>;
              if (!binding['field'] || !binding['fromInvocation'] || !binding['objectType']) continue;
              derivedInputs.push({
                field: String(binding['field']),
                fromInvocation: String(binding['fromInvocation']),
                objectType: String(binding['objectType']),
              });
            }
          }
          drInvocations.push({
            invocationId,
            drBundle:       String(i['drBundle'] ?? ''),
            drType:         String(i['drType']   ?? 'Load'),
            purpose:        typeof i['purpose']  === 'string' ? i['purpose'] : undefined,
            dependsOn:      Array.isArray(i['dependsOn']) ? (i['dependsOn'] as unknown[]).map(String) : undefined,
            derivedInputs:  derivedInputs.length > 0 ? derivedInputs : undefined,
            providedInputs: parseProvidedInputs(i['providedInputs']),
            missingInputs:  parseMissingInputs(i['missingInputs']),
          });
        }
      }
    }

    const remainingGoal = typeof parsed.remainingGoal === 'string' ? parsed.remainingGoal : '';
    const planningMode = resolvePlanningMode(ipInvocations.length, drInvocations.length, remainingGoal);
    if (!planningMode) return null;

    return {
      relevantKeys:  (parsed.relevantKeys as unknown[]).map(String),
      ipInvocations,
      drInvocations,
      planningMode,
      remainingGoal,
      plan: typeof parsed.plan === 'string' ? parsed.plan : '',
    };
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export default function HeadlessTab() {
  const { originTabId } = useExt();

  const [graph, setGraph]             = useState<HeadlessGraph | null>(null);
  const [building, setBuilding]       = useState(false);
  const [buildError, setBuildError]   = useState<string | null>(null);
  const [buildStatus, setBuildStatus] = useState<string>('Waiting for tab…');

  // File-load pathway (for real IP/DR data experiments without a live session)
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const loadedTreeRef = useRef<GraphRenderTree | null>(null);
  const [loadedFromFile, setLoadedFromFile] = useState(false);
  // Graph JSON view state
  const [renderCopied, setRenderCopied] = useState(false);

  const [intent, setIntent]           = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewMode, setViewMode]       = useState<ViewMode>('list');
  const [copied, setCopied]           = useState(false);

  // Conversation history (all completed turns, not the current in-flight one)
  const [convHistory, setConvHistory] = useState<ConvTurn[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Snapshot diff between consecutive graph builds
  const prevGraphRef = useRef<HeadlessGraph | null>(null);
  const [graphDiff, setGraphDiff]     = useState<GraphDiff | null>(null);

  // Search / filter
  const [searchQuery, setSearchQuery] = useState('');
  const [focusRelevant, setFocusRelevant] = useState(false);

  // AI provider config
  const [aiCfg, setAiCfg]               = useState<AiConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // AI result (current turn)
  const [aiThinking, setAiThinking]         = useState(false);
  const [aiPlan, setAiPlan]                 = useState<string | null>(null);
  const [aiError, setAiError]               = useState<string | null>(null);
  const [planExpanded, setPlanExpanded]     = useState(true);
  const [relevantKeys, setRelevantKeys]     = useState<Set<string>>(new Set());
  const [aiInvocations, setAiInvocations]   = useState<IpInvocation[]>([]);

  // IP execution form state — keyed by ipInvocationKey
  const [ipFormInputs, setIpFormInputs] = useState<Record<string, Record<string, string>>>({});
  const [ipExecuting,  setIpExecuting]  = useState<string | null>(null);
  const [ipResults,    setIpResults]    = useState<Record<string, { success: boolean; data?: unknown; error?: string }>>({});

  // DR direct-execution form state — keyed by invocationId (a bundle may appear twice in a chain)
  const [aiDrInvocations, setAiDrInvocations] = useState<DrInvocation[]>([]);
  const [drFormInputs,    setDrFormInputs]    = useState<Record<string, Record<string, string>>>({});
  const [drExecuting,     setDrExecuting]     = useState<string | null>(null);
  const [drResults,       setDrResults]       = useState<Record<string, { success: boolean; data?: DataMapperExecutionResult; error?: string }>>({});
  const [executionSession, setExecutionSession] = useState<ExecutionSession | null>(null);
  const [selectedRecordIds, setSelectedRecordIds] = useState<Record<string, string>>({});

  // ── AI config ──────────────────────────────────────────────────────────────
  useEffect(() => { void loadAiConfig().then(setAiCfg); }, []);

  // ── Graph diff ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!graph) return;
    const prev = prevGraphRef.current;
    prevGraphRef.current = graph;
    if (!prev) return; // first build — no diff to show

    const prevKeys = new Set(prev.nodes.map((n) => n.ref.matchingKey));
    const curKeys  = new Set(graph.nodes.map((n) => n.ref.matchingKey));
    const addedKeys   = [...curKeys].filter((k) => !prevKeys.has(k));
    const removedKeys = [...prevKeys].filter((k) => !curKeys.has(k));
    const prevEdges = prev.nodes.reduce((s, n) => s + n.deps.length, 0) + (prev.inferredEdges?.length ?? 0);
    const curEdges  = graph.nodes.reduce((s, n) => s + n.deps.length, 0) + (graph.inferredEdges?.length ?? 0);
    const deltaEdges = curEdges - prevEdges;

    if (addedKeys.length > 0 || removedKeys.length > 0 || deltaEdges !== 0) {
      setGraphDiff({ addedKeys, removedKeys, deltaEdges });
    } else {
      setGraphDiff(null);
    }
  }, [graph]);

  // ── Graph build ────────────────────────────────────────────────────────────
  const buildGraph = useCallback(async () => {
    if (!originTabId) {
      setBuildStatus('No Salesforce tab detected — click the extension icon on a Salesforce page first.');
      return;
    }
    setBuilding(true);
    setBuildError(null);
    setBuildStatus('Querying org metadata…');
    setGraph(null);
    setAiPlan(null);
    setAiError(null);
    setRelevantKeys(new Set());
    setConvHistory([]);
    setSearchQuery('');
    setFocusRelevant(false);
    setLoadedFromFile(false);
    loadedTreeRef.current = null;

    type Resp = { success: true; data: HeadlessGraph } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, Resp>({
        type: 'BUILD_HEADLESS_GRAPH',
        tabId: originTabId,
      });
      if (!resp.success) throw new Error(resp.error);
      setGraph(resp.data);
      setBuildStatus(`Graph ready — ${resp.data.nodes.length} components`);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
      setBuildStatus('Build failed');
    } finally {
      setBuilding(false);
    }
  }, [originTabId]);

  useEffect(() => {
    if (originTabId) {
      setBuildStatus('Querying org metadata…');
      void buildGraph();
    } else {
      setBuildStatus('No Salesforce tab detected — click the extension icon on a Salesforce page first.');
    }
  }, [originTabId, buildGraph]);

  // ── Ask AI ─────────────────────────────────────────────────────────────────
  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!graph || !intent.trim() || !originTabId) return;

    setAiThinking(true);
    setAiPlan(null);
    setAiError(null);
    setRelevantKeys(new Set());
    setAiInvocations([]);
    setAiDrInvocations([]);
    setPlanExpanded(true);

    const currentIntent = intent.trim();
    const messages = buildApiMessages(graph, convHistory, currentIntent);

    type Resp = { success: true; data: { text: string } } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, Resp>({
        type: 'EINSTEIN_QUERY',
        tabId: originTabId,
        // prompt = last user message (single-turn fallback for Einstein)
        prompt: messages[messages.length - 1].content,
        messages,
      });
      if (!resp.success) throw new Error(resp.error);

      let rawText = resp.data.text;
      let parsed = parseAiResponse(rawText);
      const conflict = parsed
        ? findExistingRecordConflict(graph, currentIntent, parsed.ipInvocations)
        : null;
      if (conflict) {
        const correction = buildExistingRecordCorrection(conflict);
        const correctedMessages = [
          ...messages,
          { role: 'assistant' as const, content: rawText },
          { role: 'user' as const, content: correction },
        ];
        const corrected = await chrome.runtime.sendMessage<unknown, Resp>({
          type: 'EINSTEIN_QUERY',
          tabId: originTabId,
          prompt: correction,
          messages: correctedMessages,
        });
        if (!corrected.success) throw new Error(corrected.error);
        rawText = corrected.data.text;
        parsed = parseAiResponse(rawText);
        if (!parsed) throw new Error('AI returned an invalid corrected planning response');
        const repeatedConflict = findExistingRecordConflict(graph, currentIntent, parsed.ipInvocations);
        if (repeatedConflict) {
          throw new Error(`Plan rejected: ${repeatedConflict.ipInvocationKey} would create a duplicate ${repeatedConflict.objectType}. Use ${repeatedConflict.queryBundle} first.`);
        }
      }
      const newRelevant      = parsed ? parsed.relevantKeys  : [];
      const newPlan          = parsed ? parsed.plan          : rawText;
      const newInvocations   = parsed ? parsed.ipInvocations : [];
      const newDrInvocations = parsed ? parsed.drInvocations : [];

      if (parsed) {
        setExecutionSession((previous) => ({
          goal: previous?.goal ?? currentIntent,
          planningMode: parsed.planningMode,
          remainingGoal: parsed.remainingGoal,
          completedSteps: previous?.completedSteps ?? [],
          artifacts: previous?.artifacts ?? [],
        }));
      }

      setRelevantKeys(new Set(newRelevant));
      setAiPlan(newPlan);
      setAiInvocations(newInvocations);
      setAiDrInvocations(newDrInvocations);

      // Append to conversation history
      setConvHistory((prev) => [
        ...prev,
        {
          intent: currentIntent,
          relevantKeys:  newRelevant,
          ipInvocations: newInvocations,
          drInvocations: newDrInvocations,
          plan:          newPlan,
          rawResponse:   rawText,
        },
      ]);

      setIntent(''); // clear input for next follow-up
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiThinking(false);
    }
  };

  const handleClear = () => {
    setIntent('');
    setAiPlan(null);
    setAiError(null);
    setRelevantKeys(new Set());
    setAiInvocations([]);
    setAiDrInvocations([]);
    setConvHistory([]);
    setShowHistory(false);
    setFocusRelevant(false);
    setIpFormInputs({});
    setIpExecuting(null);
    setIpResults({});
    setDrFormInputs({});
    setDrExecuting(null);
    setDrResults({});
    setSelectedRecordIds({});
    setExecutionSession(null);
  };

  const replanSession = async (session: ExecutionSession) => {
    if (!graph || !originTabId || !session.remainingGoal.trim()) return;
    setAiThinking(true);
    setAiError(null);
    const sessionUpdate = [
      'SESSION UPDATE',
      `Original goal: ${session.goal}`,
      `Remaining goal: ${session.remainingGoal}`,
      `Completed steps: ${JSON.stringify(session.completedSteps)}`,
      `Available artifacts: ${JSON.stringify(session.artifacts)}`,
      'Plan the next safe operation. Do not repeat completed steps. Use the selected artifact ID for compatible derived inputs.',
    ].join('\n');
    const messages = buildApiMessages(graph, convHistory, sessionUpdate);
    type Resp = { success: true; data: { text: string } } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, Resp>({
        type: 'EINSTEIN_QUERY', tabId: originTabId,
        prompt: messages[messages.length - 1].content, messages,
      });
      if (!resp.success) throw new Error(resp.error);
      const parsed = parseAiResponse(resp.data.text);
      if (!parsed) throw new Error('AI returned an invalid stepwise planning response');
      const conflict = findExistingRecordConflict(graph, session.goal, parsed.ipInvocations);
      if (conflict) {
        throw new Error(`Plan rejected: ${conflict.ipInvocationKey} would create a duplicate ${conflict.objectType}. Use ${conflict.queryBundle} first.`);
      }
      setRelevantKeys(new Set(parsed.relevantKeys));
      setAiPlan(parsed.plan);
      setAiInvocations(parsed.ipInvocations);
      setAiDrInvocations(parsed.drInvocations);
      setExecutionSession({
        ...session,
        planningMode: parsed.planningMode,
        remainingGoal: parsed.remainingGoal,
      });
      setConvHistory((previous) => [...previous, {
        intent: sessionUpdate,
        relevantKeys: parsed.relevantKeys,
        ipInvocations: parsed.ipInvocations,
        drInvocations: parsed.drInvocations,
        plan: parsed.plan,
        rawResponse: resp.data.text,
      }]);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : String(error));
    } finally {
      setAiThinking(false);
    }
  };

  // ── Execute IP ─────────────────────────────────────────────────────────────
  const handleExecuteIp = async (inv: IpInvocation) => {
    if (!originTabId) return;
    const key = inv.ipInvocationKey;
    setIpExecuting(key);
    setIpResults((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    // Merge all provided inputs (from AI) + user-typed form values
    const formVals = ipFormInputs[key] ?? {};
    const merged: Record<string, unknown> = {
      ...(inv.providedInputs ?? {}),
      ...formVals,
    };

    type Resp = { success: true; data: unknown } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, Resp>({
        type: 'EXECUTE_IP',
        tabId: originTabId,
        ipKey: key,
        input: merged,
      });
      setIpResults((prev) => ({ ...prev, [key]: resp }));
    } catch (e) {
      setIpResults((prev) => ({
        ...prev,
        [key]: { success: false, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setIpExecuting(null);
    }
  };

  // ── Execute DR ─────────────────────────────────────────────────────────────
  const handleExecuteDr = async (inv: DrInvocation) => {
    if (!originTabId) return;
    const key = inv.invocationId;
    setDrExecuting(key);
    setDrResults((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

    const formVals = drFormInputs[key] ?? {};
    const derived: Record<string, string> = {};
    for (const binding of inv.derivedInputs ?? []) {
      const source = drResults[binding.fromInvocation];
      const sessionArtifact = executionSession?.artifacts.find((artifact) =>
        artifact.sourceInvocation === binding.fromInvocation &&
        artifact.type.toLowerCase() === binding.objectType.toLowerCase(),
      );
      const id = sessionArtifact?.id
        ?? (source?.success ? createdIdForObject(source.data, binding.objectType) : undefined);
      if (!id) {
        setDrResults((prev) => ({
          ...prev,
          [key]: {
            success: false,
            error: `Waiting for ${binding.fromInvocation} to return a selected ${binding.objectType} record for ${binding.field}.`,
          },
        }));
        setDrExecuting(null);
        return;
      }
      derived[binding.field] = id;
    }
    const merged: Record<string, unknown> = {
      ...(inv.providedInputs ?? {}),
      ...formVals,
      ...derived,
    };

    type Resp = { success: true; data: DataMapperExecutionResult } | { success: false; error: string };
    try {
      const resp = await chrome.runtime.sendMessage<unknown, Resp>({
        type: 'EXECUTE_DR',
        tabId: originTabId,
        drBundle: inv.drBundle,
        drType:   inv.drType,
        input:    merged,
      });
      if (resp.success) {
        const data = recoverDataMapperRecords(resp.data);
        setDrResults((prev) => ({ ...prev, [key]: { success: true, data } }));
        const artifacts: ExecutionArtifact[] = data.records
          .filter((record): record is typeof record & { id: string } => !!record.id)
          .map((record) => ({
            type: record.objectType,
            id: record.id,
            sourceInvocation: key,
            values: record.values,
          }));
        const session = executionSession;
        if (session) {
          const updated: ExecutionSession = {
            ...session,
            completedSteps: [...session.completedSteps, {
              invocationId: key,
              capability: inv.drBundle,
              inputs: merged,
              completedAt: new Date().toISOString(),
            }],
            artifacts: artifacts.length === 1 ? [...session.artifacts, artifacts[0]] : session.artifacts,
          };
          setExecutionSession(updated);
          if (artifacts.length === 1 && updated.planningMode === 'stepwise' && updated.remainingGoal.trim()) {
            await replanSession(updated);
          }
        }
      } else {
        setDrResults((prev) => ({ ...prev, [key]: resp }));
      }
    } catch (e) {
      setDrResults((prev) => ({
        ...prev,
        [key]: { success: false, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setDrExecuting(null);
    }
  };

  const handleSelectRecord = async (invocationId: string, candidates: ExecutionArtifact[]) => {
    const selectedId = selectedRecordIds[invocationId];
    const selected = candidates.find((candidate) => candidate.id === selectedId);
    if (!selected || !executionSession) return;

    const updated: ExecutionSession = {
      ...executionSession,
      artifacts: [
        ...executionSession.artifacts.filter((artifact) => artifact.sourceInvocation !== invocationId),
        selected,
      ],
    };
    setExecutionSession(updated);
    if (updated.planningMode === 'stepwise' && updated.remainingGoal.trim()) {
      await replanSession(updated);
    }
  };

  // ── Derived state ──────────────────────────────────────────────────────────
  const nodeByKey = new Map(graph?.nodes.map((n) => [n.ref.matchingKey, n]) ?? []);
  const selectedNode = selectedKey ? (nodeByKey.get(selectedKey) ?? null) : null;
  const selectedInferredEdges = selectedNode
    ? inferredEdgesForNode(graph, selectedNode.ref.matchingKey)
    : [];
  const totalEdges = graph
    ? graph.nodes.reduce((s, n) => s + n.deps.length, 0) + (graph.inferredEdges?.length ?? 0)
    : 0;

  // Apply search + focus filters to the node list
  const grouped = COMP_TYPES.map((type) => {
    let nodes = (graph?.nodes ?? []).filter((n) => n.ref.type === type);

    // Focus mode: hide non-relevant nodes when AI has results
    if (focusRelevant && relevantKeys.size > 0) {
      nodes = nodes.filter((n) => relevantKeys.has(n.ref.matchingKey));
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      nodes = nodes.filter(
        (n) =>
          n.ref.name.toLowerCase().includes(q) ||
          n.ref.matchingKey.toLowerCase().includes(q) ||
          (n.ref.description ?? '').toLowerCase().includes(q),
      );
    }

    // Sort: relevant first, then alphabetical
    nodes.sort((a, b) => {
      const aRel = relevantKeys.has(a.ref.matchingKey) ? 0 : 1;
      const bRel = relevantKeys.has(b.ref.matchingKey) ? 0 : 1;
      if (aRel !== bRel) return aRel - bRel;
      return a.ref.name.localeCompare(b.ref.name);
    });

    return { type, nodes };
  }).filter((g) => g.nodes.length > 0);

  const totalFiltered = grouped.reduce((s, g) => s + g.nodes.length, 0);

  // JSON export payload
  const jsonPayload = graph
    ? {
        builtAt: graph.builtAt, orgUrl: graph.orgUrl,
        totalNodes: graph.nodes.length, totalEdges,
        byType: Object.fromEntries(
          COMP_TYPES.map((t) => [t, graph.nodes.filter((n) => n.ref.type === t).length]),
        ),
        ...(relevantKeys.size > 0 ? { relevantKeys: Array.from(relevantKeys) } : {}),
        nodes: graph.nodes.map((n) => ({
          type: n.ref.type, name: n.ref.name,
          matchingKey: n.ref.matchingKey,
          relevant: relevantKeys.has(n.ref.matchingKey),
          version: n.ref.version, isActive: n.ref.isActive,
          deps: n.deps, dependents: n.dependents,
        })),
        authoredEdges: graph.nodes.flatMap((n) => n.deps.map((target) => ({
          source: n.ref.matchingKey,
          target,
          kind: 'authoredDependency' as const,
          edgeEvidenceScore: null,
        }))),
        inferredEdges: (graph.inferredEdges ?? []).map((edge) => ({
          ...edge,
          kind: 'candidateInferredBinding' as const,
        })),
      }
    : null;

  const aiPromptText = graph ? buildFullGraphPrompt(graph, intent || '<your intent here>') : '';
  const mermaidText  = graph ? buildMermaidDiagram(graph, relevantKeys) : '';
  // GraphRenderTree — derived from live graph or from a file-loaded render tree
  const renderTree = useMemo(
    () => graph ? toRenderTree(graph) : loadedTreeRef.current,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, loadedFromFile],
  );

  const handleCopyPrompt = async () => {
    if (!aiPromptText) return;
    await navigator.clipboard.writeText(aiPromptText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const providerLabel = aiCfg?.provider === 'anthropic' ? 'Claude'
    : aiCfg?.provider === 'openai' ? 'OpenAI'
    : 'Einstein';

  const hasConvHistory = convHistory.length > 0;
  const isFollowUp     = hasConvHistory && !!aiPlan;
  const modeLabel = executionSession?.planningMode === 'one_go'
    ? 'One-go: one external invocation'
    : 'Stepwise: observe and replan';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>

      {/* AI Settings overlay */}
      {showSettings && (
        <AiSettings
          onClose={() => setShowSettings(false)}
          onSaved={(cfg) => { setAiCfg(cfg); setShowSettings(false); }}
        />
      )}

      {/* Banner */}
      <div className="headless-banner">
        <div className="headless-banner__left">
          <span className="headless-banner__title">Universal Graph</span>
          <span className="headless-banner__pill">Experimental</span>
        </div>
        <button
          className="headless-banner__gear"
          onClick={() => setShowSettings(true)}
          title="AI provider settings"
        >
          ⚙
          {aiCfg && aiCfg.provider !== 'einstein' && (
            <span className="headless-banner__gear-badge">
              {aiCfg.provider === 'anthropic' ? 'Claude' : 'GPT'}
            </span>
          )}
        </button>
        <p className="headless-banner__sub">
          Describe a business intent — the full component graph is sent to {providerLabel} to identify relevant components and produce an execution plan.
          {hasConvHistory && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              {convHistory.length} turn{convHistory.length !== 1 ? 's' : ''} in context.
            </span>
          )}
        </p>
      </div>

      {/* Build status strip */}
      <div className="headless-build-status">
        <span className={`headless-build-status__dot headless-build-status__dot--${
          building ? 'building' : (graph || loadedFromFile) ? 'ready' : buildError ? 'error' : 'waiting'
        }`} />
        <span className="headless-build-status__text">{
          building        ? 'Building graph…' :
          graph           ? `Graph ready — ${graph.nodes.length} components, ${totalEdges} edges · ${HEADLESS_BUILD_ID}` :
          buildError      ? `Build failed: ${buildError}` :
          buildStatus
        }</span>
        {loadedFromFile && (
          <span style={{ marginLeft: 6, color: 'var(--green-500, #22c55e)', fontSize: 11, fontStyle: 'italic' }}>
            📂 from file
          </span>
        )}
        {buildError && (
          <button className="headless-build-status__retry btn btn--sm" onClick={() => void buildGraph()}>
            ↺ Retry
          </button>
        )}
        {graph && (
          <button className="headless-build-status__retry btn btn--sm" onClick={() => void buildGraph()} disabled={building}>
            ↺ Rebuild
          </button>
        )}
        {/* Load from JSON file — for offline validation with real org data */}
        <button
          className="btn btn--sm"
          style={{ marginLeft: 4 }}
          onClick={() => fileInputRef.current?.click()}
          disabled={building}
          title="Load a HeadlessGraph or GraphRenderTree JSON from file"
        >
          ↑ Load JSON
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
              try {
                const data = JSON.parse(ev.target?.result as string) as Record<string, unknown>;
                const nodes = data['nodes'];
                if (Array.isArray(nodes) && nodes.length > 0 && (nodes[0] as Record<string, unknown>)['ref']) {
                  // HeadlessGraph — build render tree from it
                  loadedTreeRef.current = null;
                  setGraph(data as unknown as HeadlessGraph);
                  setLoadedFromFile(true);
                  setBuildStatus(`Loaded from file — ${(data as unknown as HeadlessGraph).nodes.length} components`);
                  setBuildError(null);
                  setViewMode('graph');
                } else if (data['schemaVersion'] === '1.0') {
                  // Pre-built GraphRenderTree — show directly
                  loadedTreeRef.current = data as unknown as GraphRenderTree;
                  setGraph(null);
                  setLoadedFromFile(true);
                  setBuildStatus('Loaded GraphRenderTree from file');
                  setBuildError(null);
                  setViewMode('graph');
                } else {
                  setBuildError('Unrecognised JSON (expected HeadlessGraph or GraphRenderTree v1.0)');
                }
              } catch {
                setBuildError('Failed to parse JSON file');
              }
            };
            reader.readAsText(file);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
      </div>

      {/* Snapshot diff banner */}
      {graphDiff && (
        <div className="headless-diff-bar">
          <span className="headless-diff-bar__icon">⟳</span>
          <span className="headless-diff-bar__text">
            Graph changed since last build:
            {graphDiff.addedKeys.length > 0 && (
              <span className="headless-diff-bar__added"> +{graphDiff.addedKeys.length} added</span>
            )}
            {graphDiff.removedKeys.length > 0 && (
              <span className="headless-diff-bar__removed"> −{graphDiff.removedKeys.length} removed</span>
            )}
            {graphDiff.deltaEdges !== 0 && (
              <span className="headless-diff-bar__edges"> {graphDiff.deltaEdges > 0 ? '+' : ''}{graphDiff.deltaEdges} edges</span>
            )}
          </span>
          <button className="headless-diff-bar__dismiss" onClick={() => setGraphDiff(null)}>✕</button>
        </div>
      )}

      {/* Intent bar */}
      <form className="headless-query-bar" onSubmit={(e) => void handleAsk(e)}>
        <input
          className="headless-query-input"
          placeholder={
            building    ? 'Building graph…' :
            !graph      ? 'Waiting for graph…' :
            aiThinking  ? `${providerLabel} is thinking…` :
            isFollowUp  ? `Ask a follow-up question (${convHistory.length} turns in context)…` :
            'Describe a business intent — e.g. account onboarding, billing setup'
          }
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
          disabled={!graph || building || aiThinking}
        />
        <button
          className="btn btn--primary headless-query-btn"
          type="submit"
          disabled={!graph || building || aiThinking || !intent.trim()}
        >
          {aiThinking ? '…' : aiButtonLabel(aiCfg)}
        </button>
        {(aiPlan || aiError || intent || hasConvHistory) && !aiThinking && (
          <button className="btn headless-clear-btn" type="button" onClick={handleClear} title="Clear conversation">
            &#x2715;
          </button>
        )}
      </form>

      {/* Scrollable area: AI results + body together */}
      <div className="headless-scroll-area">

      {executionSession && (
        <div className="headless-session-bar">
          <div className="headless-session-bar__header">
            <strong>{executionSession.planningMode === 'one_go' ? 'One-go policy' : 'Stepwise policy'}</strong>
            <span className={`headless-session-bar__confidence headless-session-bar__confidence--${executionSession.planningMode === 'one_go' ? 'one-go' : 'stepwise'}`}>
              {modeLabel}
            </span>
          </div>
          <div className="headless-session-bar__scores">
            Policy mode is determined by external invocation count, not model confidence.
            {executionSession.completedSteps.length > 0 && ` · ${executionSession.completedSteps.length} completed`}
            {executionSession.artifacts.length > 0 && ` · ${executionSession.artifacts.length} artifact${executionSession.artifacts.length !== 1 ? 's' : ''}`}
          </div>
          {executionSession.remainingGoal && (
            <div className="headless-session-bar__goal">Remaining: {executionSession.remainingGoal}</div>
          )}
        </div>
      )}

      {/* AI result panel (current turn) */}
      {(aiThinking || aiPlan || aiError) && (
        <div className="headless-einstein-bar">
          <div className="headless-einstein-bar__header">
            <span className="headless-einstein-label">
              <span className="headless-einstein-label__icon">&#10022;</span>
              {providerLabel}
              {relevantKeys.size > 0 && (
                <span className="headless-einstein-label__count">
                  {relevantKeys.size} component{relevantKeys.size !== 1 ? 's' : ''} identified
                </span>
              )}
              {isFollowUp && (
                <span className="headless-einstein-label__turn">Turn {convHistory.length}</span>
              )}
            </span>
            {aiThinking && <span className="headless-einstein-thinking">Analysing {graph?.nodes.length} components…</span>}
            {aiPlan && (
              <>
                {hasConvHistory && (
                  <button
                    className="headless-einstein-toggle"
                    style={{ marginRight: 4 }}
                    onClick={() => setShowHistory((v) => !v)}
                  >
                    {showHistory ? '▲ History' : '▼ History'}
                  </button>
                )}
                <button className="headless-einstein-toggle" onClick={() => setPlanExpanded((v) => !v)}>
                  {planExpanded ? '▲ Collapse' : '▼ Expand'}
                </button>
                <button className="headless-einstein-copy" onClick={() => void navigator.clipboard.writeText(aiPlan)}>
                  ⎘ Copy
                </button>
                <button className="headless-einstein-dismiss" onClick={() => { setAiPlan(null); setAiError(null); setRelevantKeys(new Set()); }}>
                  &#x2715;
                </button>
              </>
            )}
            {aiError && (
              <button className="headless-einstein-dismiss" onClick={() => setAiError(null)}>
                &#x2715;
              </button>
            )}
          </div>

          {/* Conversation history (previous turns) */}
          {showHistory && convHistory.length > 1 && (
            <div className="headless-conv-history">
              {convHistory.slice(0, -1).map((turn, i) => (
                <div key={i} className="headless-conv-turn">
                  <div className="headless-conv-turn__intent">
                    <span className="headless-conv-turn__label">Turn {i + 1}:</span>
                    {turn.intent}
                  </div>
                  <pre className="headless-conv-turn__plan">{turn.plan}</pre>
                </div>
              ))}
            </div>
          )}

          {aiPlan && planExpanded && (
            <pre className="headless-einstein-result">{aiPlan}</pre>
          )}

          {/* DR direct-invocation contracts — single-step DataMapper calls */}
          {aiDrInvocations.length > 0 && planExpanded && (
            <div className="headless-invocations">
              <div className="headless-invocations-title">
                ⚡ DataRaptor Invocation{aiDrInvocations.length !== 1 ? 's' : ''} ({aiDrInvocations.length})
                <span className="headless-invocations-hint">
                  — POST /connect/omni-global/data-mapper/execute/
                </span>
              </div>
              {aiDrInvocations.map((inv, i) => {
                const key              = inv.invocationId;
                const formVals         = drFormInputs[key] ?? {};
                const derivedFields    = new Set((inv.derivedInputs ?? []).map((binding) => binding.field));
                const missing          = (inv.missingInputs ?? []).filter((input) => !derivedFields.has(input.field));
                const requiredMissing  = missing.filter((m) => !m.optional);
                const optionalMissing  = missing.filter((m) => m.optional);
                const allFilled        = requiredMissing.every((m) => formVals[m.field]?.trim());
                const result           = drResults[key];
                const isRunning        = drExecuting === key;
                const returnedArtifacts: ExecutionArtifact[] = result?.success
                  ? (result.data?.records ?? [])
                      .filter((record): record is typeof record & { id: string } => !!record.id)
                      .map((record) => ({
                        type: record.objectType,
                        id: record.id,
                        sourceInvocation: key,
                        values: record.values,
                      }))
                  : [];
                const dependencyIds    = new Set([
                  ...(inv.dependsOn ?? []),
                  ...(inv.derivedInputs ?? []).map((binding) => binding.fromInvocation),
                ]);
                const dependenciesReady = [...dependencyIds].every((id) => drResults[id]?.success);
                const resolvedDerived = (inv.derivedInputs ?? []).map((binding) => ({
                  ...binding,
                  value: executionSession?.artifacts.find((artifact) =>
                      artifact.sourceInvocation === binding.fromInvocation &&
                      artifact.type.toLowerCase() === binding.objectType.toLowerCase(),
                    )?.id
                    ?? createdIdForObject(drResults[binding.fromInvocation]?.data, binding.objectType),
                }));

                return (
                  <div key={i} className="headless-invocation-row">
                    <div className="headless-invocation-row-header">
                      <span className="headless-invocation-key">{key}</span>
                      <span className="headless-invocation-purpose">{inv.drBundle}</span>
                      <span className="headless-invocation-purpose" style={{ color: '#d97706', fontWeight: 600 }}>
                        {inv.drType}
                      </span>
                      {inv.purpose && (
                        <span className="headless-invocation-purpose">{inv.purpose}</span>
                      )}
                    </div>

                    {/* Provided inputs — extracted from NLP */}
                    {inv.providedInputs && Object.keys(inv.providedInputs).length > 0 && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label">✓ From intent:</span>
                        <div className="headless-invocation-fields">
                          {Object.entries(inv.providedInputs).map(([k, v]) => (
                            <span key={k} className="headless-invocation-field-chip headless-invocation-field-chip--provided">
                              {k} = <em>{v}</em>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Inputs bound to records created by earlier DR steps */}
                    {resolvedDerived.length > 0 && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label">↳ From prior step:</span>
                        <div className="headless-invocation-fields">
                          {resolvedDerived.map((binding) => (
                            <span key={binding.field} className="headless-invocation-field-chip headless-invocation-field-chip--provided">
                              {binding.field} = <em>{binding.value ?? `waiting for ${binding.fromInvocation}`}</em>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Required missing inputs */}
                    {requiredMissing.length > 0 && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label headless-invocation-section-label--missing">
                          ⚠ Required ({requiredMissing.length} field{requiredMissing.length !== 1 ? 's' : ''}):
                        </span>
                        <div className="headless-invocation-form">
                          {requiredMissing.map((m, j) => (
                            <div key={j} className="headless-invocation-form-row">
                              <label className="headless-invocation-form-label">
                                {m.prompt ?? m.field}
                              </label>
                              <input
                                className="headless-invocation-form-input"
                                type="text"
                                placeholder={m.field}
                                value={formVals[m.field] ?? ''}
                                onChange={(e) => setDrFormInputs((prev) => ({
                                  ...prev,
                                  [key]: { ...(prev[key] ?? {}), [m.field]: e.target.value },
                                }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Optional / conditional inputs */}
                    {optionalMissing.length > 0 && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label headless-invocation-section-label--optional">
                          ◎ Optional ({optionalMissing.length} field{optionalMissing.length !== 1 ? 's' : ''}):
                        </span>
                        <div className="headless-invocation-form">
                          {optionalMissing.map((m, j) => (
                            <div key={j} className="headless-invocation-form-row">
                              <label className="headless-invocation-form-label headless-invocation-form-label--optional">
                                {m.prompt ?? m.field}
                              </label>
                              <input
                                className="headless-invocation-form-input headless-invocation-form-input--optional"
                                type="text"
                                placeholder={`${m.field} (optional)`}
                                value={formVals[m.field] ?? ''}
                                onChange={(e) => setDrFormInputs((prev) => ({
                                  ...prev,
                                  [key]: { ...(prev[key] ?? {}), [m.field]: e.target.value },
                                }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* No missing inputs */}
                    {missing.length === 0 && !inv.providedInputs && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label">Ready to execute (no input required)</span>
                      </div>
                    )}

                    {/* Execute button */}
                    {originTabId && dependenciesReady && (requiredMissing.length === 0 || allFilled) && !result && (
                      <button
                        className="headless-invocation-execute-btn"
                        style={{ background: '#d97706' }}
                        onClick={() => void handleExecuteDr(inv)}
                        disabled={isRunning}
                      >
                        {isRunning ? '⏳ Executing…' : '⚡ Execute DataRaptor'}
                      </button>
                    )}
                    {originTabId && !dependenciesReady && !result && (
                      <span className="headless-invocation-execute-hint">
                        Complete {Array.from(dependencyIds).filter((id) => !drResults[id]?.success).join(', ')} first
                      </span>
                    )}
                    {originTabId && requiredMissing.length > 0 && !allFilled && (
                      <span className="headless-invocation-execute-hint">
                        Fill {requiredMissing.filter((m) => !formVals[m.field]?.trim()).length} required field{requiredMissing.filter((m) => !formVals[m.field]?.trim()).length !== 1 ? 's' : ''} to execute
                      </span>
                    )}

                    {/* Execution result */}
                    {result && (
                      <div className={`headless-invocation-result${result.success ? ' headless-invocation-result--ok' : ' headless-invocation-result--err'}`}>
                        <div className="headless-invocation-result-header">
                          {result.success ? '✓ DataRaptor executed successfully' : '✕ Execution failed'}
                          <button
                            className="headless-invocation-result-clear"
                            onClick={() => setDrResults((prev) => {
                              const next = { ...prev }; delete next[key]; return next;
                            })}
                          >
                            ✕
                          </button>
                        </div>
                        <pre className="headless-invocation-result-body">
                          {result.success
                            ? JSON.stringify(result.data, null, 2)
                            : result.error}
                        </pre>
                      </div>
                    )}

                    {result?.success && returnedArtifacts.length > 1 && (
                      <div className="headless-record-picker">
                        <div className="headless-record-picker__title">
                          Select the {returnedArtifacts[0].type} to use for the next step
                        </div>
                        <div className="headless-record-picker__options">
                          {returnedArtifacts.map((artifact) => {
                            const label = typeof artifact.values['Name'] === 'string'
                              ? artifact.values['Name']
                              : artifact.id;
                            return (
                              <label key={artifact.id} className="headless-record-picker__option">
                                <input
                                  type="radio"
                                  name={`record-${key}`}
                                  value={artifact.id}
                                  checked={selectedRecordIds[key] === artifact.id}
                                  onChange={() => setSelectedRecordIds((previous) => ({
                                    ...previous,
                                    [key]: artifact.id,
                                  }))}
                                />
                                <span>
                                  <strong>{label}</strong>
                                  <code>{artifact.id}</code>
                                </span>
                              </label>
                            );
                          })}
                        </div>
                        <button
                          className="headless-invocation-execute-btn"
                          style={{ background: '#d97706' }}
                          disabled={!selectedRecordIds[key] || aiThinking}
                          onClick={() => void handleSelectRecord(key, returnedArtifacts)}
                        >
                          {aiThinking ? 'Planning next step...' : `Use selected ${returnedArtifacts[0].type}`}
                        </button>
                      </div>
                    )}

                    {result?.success && returnedArtifacts.length === 0 && (
                      <div className="headless-record-picker headless-record-picker--empty">
                        <div className="headless-record-picker__title">No records matched this query</div>
                        <div className="headless-record-picker__message">
                          Change the query input and run this step again. The workflow will not advance without an observed record artifact.
                        </div>
                        <button
                          className="headless-invocation-execute-btn"
                          style={{ background: '#d97706' }}
                          onClick={() => setDrResults((previous) => {
                            const next = { ...previous };
                            delete next[key];
                            return next;
                          })}
                        >
                          Edit query and retry
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* IP Invocation contracts — the execution-ready output */}
          {aiInvocations.length > 0 && planExpanded && (
            <div className="headless-invocations">
              <div className="headless-invocations-title">
                🔌 IP Invocation{aiInvocations.length !== 1 ? 's' : ''} ({aiInvocations.length})
                <span className="headless-invocations-hint">
                  — ConnectAPI.OmniDesignerConnect.integrationProcedureExecute()
                </span>
              </div>
              {aiInvocations.map((inv, i) => {
                const key           = inv.ipInvocationKey;
                const formVals      = ipFormInputs[key] ?? {};
                const missing       = inv.missingInputs ?? [];
                const requiredMissing = missing.filter((m) => !m.optional);
                const optionalMissing = missing.filter((m) => m.optional);
                const allFilled     = requiredMissing.every((m) => formVals[m.field]?.trim());
                const result        = ipResults[key];
                const isRunning     = ipExecuting === key;

                return (
                  <div key={i} className="headless-invocation-row">
                    <div className="headless-invocation-row-header">
                      <span className="headless-invocation-key">{key}</span>
                      {inv.purpose && (
                        <span className="headless-invocation-purpose">{inv.purpose}</span>
                      )}
                    </div>

                    {/* Provided inputs — extracted from NLP */}
                    {inv.providedInputs && Object.keys(inv.providedInputs).length > 0 && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label">✓ From intent:</span>
                        <div className="headless-invocation-fields">
                          {Object.entries(inv.providedInputs).map(([k, v]) => (
                            <span key={k} className="headless-invocation-field-chip headless-invocation-field-chip--provided">
                              {k} = <em>{v}</em>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Required missing inputs */}
                    {requiredMissing.length > 0 && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label headless-invocation-section-label--missing">
                          ⚠ Required ({requiredMissing.length} field{requiredMissing.length !== 1 ? 's' : ''}):
                        </span>
                        <div className="headless-invocation-form">
                          {requiredMissing.map((m, j) => (
                            <div key={j} className="headless-invocation-form-row">
                              <label className="headless-invocation-form-label">
                                {m.prompt ?? m.field}
                                {m.forStep && (
                                  <span className="headless-invocation-form-step"> ({m.forStep})</span>
                                )}
                              </label>
                              <input
                                className="headless-invocation-form-input"
                                type="text"
                                placeholder={m.field}
                                value={formVals[m.field] ?? ''}
                                onChange={(e) => setIpFormInputs((prev) => ({
                                  ...prev,
                                  [key]: { ...(prev[key] ?? {}), [m.field]: e.target.value },
                                }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Optional / conditional inputs */}
                    {optionalMissing.length > 0 && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label headless-invocation-section-label--optional">
                          ◎ Optional ({optionalMissing.length} field{optionalMissing.length !== 1 ? 's' : ''}):
                        </span>
                        <div className="headless-invocation-form">
                          {optionalMissing.map((m, j) => (
                            <div key={j} className="headless-invocation-form-row">
                              <label className="headless-invocation-form-label headless-invocation-form-label--optional">
                                {m.prompt ?? m.field}
                                {m.forStep && (
                                  <span className="headless-invocation-form-step"> ({m.forStep})</span>
                                )}
                              </label>
                              <input
                                className="headless-invocation-form-input headless-invocation-form-input--optional"
                                type="text"
                                placeholder={`${m.field} (optional)`}
                                value={formVals[m.field] ?? ''}
                                onChange={(e) => setIpFormInputs((prev) => ({
                                  ...prev,
                                  [key]: { ...(prev[key] ?? {}), [m.field]: e.target.value },
                                }))}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* No missing inputs — all ready to execute */}
                    {missing.length === 0 && !inv.providedInputs && (
                      <div className="headless-invocation-section">
                        <span className="headless-invocation-section-label">Ready to execute (no input required)</span>
                      </div>
                    )}

                    {/* Execute button — enabled once required fields are filled */}
                    {originTabId && (requiredMissing.length === 0 || allFilled) && !result && (
                      <button
                        className="headless-invocation-execute-btn"
                        onClick={() => void handleExecuteIp(inv)}
                        disabled={isRunning}
                      >
                        {isRunning ? '⏳ Executing…' : '▶ Execute IP'}
                      </button>
                    )}
                    {originTabId && requiredMissing.length > 0 && !allFilled && (
                      <span className="headless-invocation-execute-hint">
                        Fill {requiredMissing.filter((m) => !formVals[m.field]?.trim()).length} required field{requiredMissing.filter((m) => !formVals[m.field]?.trim()).length !== 1 ? 's' : ''} to execute
                      </span>
                    )}

                    {/* Execution result */}
                    {result && (
                      <div className={`headless-invocation-result${result.success ? ' headless-invocation-result--ok' : ' headless-invocation-result--err'}`}>
                        <div className="headless-invocation-result-header">
                          {result.success ? '✓ IP executed successfully' : '✕ Execution failed'}
                          <button
                            className="headless-invocation-result-clear"
                            onClick={() => setIpResults((prev) => {
                              const next = { ...prev }; delete next[key]; return next;
                            })}
                          >
                            ✕
                          </button>
                        </div>
                        <pre className="headless-invocation-result-body">
                          {result.success
                            ? JSON.stringify(result.data, null, 2)
                            : result.error}
                        </pre>
                      </div>
                    )}

                    {/* Legacy: raw input contract */}
                    {inv.inputContract && !inv.providedInputs && (
                      <pre className="headless-invocation-contract">{inv.inputContract}</pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {aiError && (
            <div className="headless-einstein-error">{aiError}</div>
          )}
        </div>
      )}

      {/* Body */}
      <div className="headless-body">

        {/* Left pane */}
        <div className="headless-list">
          <div className="headless-list-header">
            <span>
              {building ? 'Building graph…'
                : relevantKeys.size > 0 && !searchQuery && !focusRelevant
                ? `${relevantKeys.size} relevant · ${graph?.nodes.length ?? 0} total`
                : searchQuery || focusRelevant
                ? `${totalFiltered} shown · ${graph?.nodes.length ?? 0} total`
                : `Full graph — ${graph?.nodes.length ?? '…'} nodes, ${totalEdges} edges`}
            </span>
            <div className="headless-view-toggle">
              {(['list', 'json', 'graph', 'mermaid', 'ai-prompt'] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  className={`headless-toggle-btn${viewMode === m ? ' active' : ''}`}
                  onClick={() => setViewMode(m)}
                  disabled={!graph && !loadedFromFile && !building}
                >
                  {m === 'ai-prompt' ? 'Prompt'
                    : m === 'mermaid' ? 'Mermaid'
                    : m === 'graph'   ? 'Graph JSON'
                    : m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Search + focus toolbar — only in list view */}
          {viewMode === 'list' && graph && !building && (
            <div className="headless-filter-bar">
              <input
                className="headless-search-input"
                type="text"
                placeholder="Search components…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  className="headless-search-clear"
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
              {relevantKeys.size > 0 && (
                <button
                  className={`headless-focus-btn${focusRelevant ? ' headless-focus-btn--active' : ''}`}
                  onClick={() => setFocusRelevant((v) => !v)}
                  title={focusRelevant ? 'Show all components' : 'Show only AI-identified components'}
                >
                  ✦ {focusRelevant ? 'Focused' : 'Focus'}
                </button>
              )}
            </div>
          )}

          {!originTabId ? (
            <div className="headless-empty">
              <div style={{ fontSize: 22, marginBottom: 8 }}>⚠</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No Salesforce tab</div>
              <div style={{ fontSize: 11, color: 'var(--gray-400)', lineHeight: 1.5 }}>
                Navigate to a Salesforce page, then click the OmniStudio Tools icon.
              </div>
            </div>
          ) : building ? (
            <div className="headless-empty">
              <div className="headless-build-spinner">&#9672;</div>
              Building graph — querying all component types…
            </div>
          ) : buildError ? (
            <div className="headless-empty headless-empty--error">
              <div style={{ marginBottom: 6, fontWeight: 600 }}>Build failed</div>
              {buildError}
              <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={() => void buildGraph()}>
                Retry
              </button>
            </div>
          ) : viewMode === 'json' ? (
            <div className="headless-pre-wrap">
              <div className="headless-pre-toolbar">
                <button className="headless-pre-action" onClick={() => jsonPayload && downloadJson('omnistudio-graph.json', jsonPayload)}>
                  &#8595; Download JSON
                </button>
              </div>
              <pre className="headless-json">{JSON.stringify(jsonPayload, null, 2)}</pre>
            </div>
          ) : viewMode === 'graph' ? (
            <div className="headless-pre-wrap">
              <div className="headless-pre-toolbar">
                <span className="headless-pre-desc">
                  {renderTree
                    ? `GraphRenderTree — ${renderTree.totalNodes} nodes, ${renderTree.totalEdges} edges (schema v${renderTree.schemaVersion})`
                    : 'No graph — build one or load a JSON file'}
                </span>
                {renderTree && (
                  <>
                    <button
                      className="headless-pre-action"
                      onClick={() => {
                        void navigator.clipboard.writeText(JSON.stringify(renderTree, null, 2));
                        setRenderCopied(true);
                        setTimeout(() => setRenderCopied(false), 2000);
                      }}
                    >
                      {renderCopied ? '✓ Copied' : '⎘ Copy Render JSON'}
                    </button>
                    <button
                      className="headless-pre-action"
                      onClick={() => downloadJson(
                        `omnistudio-render-tree-${new Date().toISOString().slice(0, 10)}.json`,
                        renderTree,
                      )}
                    >
                      &#8595; Download
                    </button>
                  </>
                )}
              </div>
              {renderTree && (
                <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--gray-400)', fontFamily: 'monospace', borderBottom: '1px solid var(--border)' }}>
                  {((['OmniScript', 'IntegrationProcedure', 'OmniUiCard', 'DataRaptor'] as ComponentType[])
                    .map((t) => renderTree.byType[t] > 0 ? `${TYPE_LABELS[t]}: ${renderTree.byType[t]}` : null)
                    .filter(Boolean) as string[])
                    .join(' | ')}
                </div>
              )}
              <pre className="headless-json">{renderTree ? JSON.stringify(renderTree, null, 2) : ''}</pre>
            </div>
          ) : viewMode === 'mermaid' ? (
            <div className="headless-pre-wrap">
              <div className="headless-pre-toolbar">
                <span className="headless-pre-desc">
                  {relevantKeys.size > 0
                    ? `Relevant subgraph + direct neighbours (${relevantKeys.size} relevant)`
                    : `Full graph — ${graph?.nodes.length ?? 0} nodes`}
                </span>
                <button
                  className="headless-pre-action"
                  onClick={() => void navigator.clipboard.writeText(mermaidText)}
                >
                  ⎘ Copy
                </button>
                <button className="headless-pre-action" onClick={() => downloadText('omnistudio-graph.mmd', mermaidText)}>
                  &#8595; Download .mmd
                </button>
              </div>
              <pre className="headless-json">{mermaidText}</pre>
            </div>
          ) : viewMode === 'ai-prompt' ? (
            <div className="headless-pre-wrap">
              <div className="headless-pre-toolbar">
                <span className="headless-pre-desc">Full prompt that will be sent to {providerLabel}</span>
                <button className="headless-pre-action" onClick={() => void handleCopyPrompt()}>
                  {copied ? '✓ Copied' : '⎘ Copy'}
                </button>
                <button className="headless-pre-action" onClick={() => downloadText('omnistudio-graph-prompt.txt', aiPromptText)}>
                  &#8595; Download
                </button>
              </div>
              <pre className="headless-json">{aiPromptText}</pre>
            </div>
          ) : grouped.length === 0 ? (
            <div className="headless-empty">
              {searchQuery || focusRelevant
                ? 'No components match the current filter.'
                : 'No components found in this org.'}
            </div>
          ) : (
            <div className="headless-groups">
              {grouped.map(({ type, nodes }) => (
                <div key={type} className="headless-group">
                  <div className="headless-group__header" style={{ borderLeftColor: TYPE_COLORS[type] }}>
                    <span className="headless-group__type">{TYPE_LABELS[type]}</span>
                    <span className="headless-group__count">
                      {relevantKeys.size > 0
                        ? `${nodes.filter((n) => relevantKeys.has(n.ref.matchingKey)).length} / ${nodes.length}`
                        : nodes.length}
                    </span>
                  </div>
                  {nodes.map((node) => {
                    const isRelevant = relevantKeys.has(node.ref.matchingKey);
                    return (
                      <div
                        key={node.ref.matchingKey}
                        className={[
                          'headless-node',
                          selectedKey === node.ref.matchingKey ? 'headless-node--selected' : '',
                          isRelevant ? 'headless-node--relevant' : '',
                          !isRelevant && relevantKeys.size > 0 && !focusRelevant ? 'headless-node--dimmed' : '',
                        ].filter(Boolean).join(' ')}
                        onClick={() => setSelectedKey(
                          selectedKey === node.ref.matchingKey ? null : node.ref.matchingKey,
                        )}
                      >
                        <span className="headless-node__dot" style={{ background: TYPE_COLORS[type] }} />
                        <span className="headless-node__name">{node.ref.name}</span>
                        {node.deps.length > 0 && (
                          <span className="headless-node__badge headless-node__badge--deps" title={`${node.deps.length} dependencies`}>
                            &#8595;{node.deps.length}
                          </span>
                        )}
                        {node.dependents.length > 0 && (
                          <span className="headless-node__badge headless-node__badge--used" title={`Used by ${node.dependents.length}`}>
                            &#8593;{node.dependents.length}
                          </span>
                        )}
                        {isRelevant && (
                          <span className="headless-node__relevant-badge">✦</span>
                        )}
                        {node.ref.isActive === false && (
                          <span className="headless-node__inactive">off</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right pane: node detail */}
        <div className="headless-detail">
          {selectedNode ? (
            <>
              <div className="headless-detail__header" style={{ borderLeftColor: TYPE_COLORS[selectedNode.ref.type] }}>
                <div className="headless-detail__type" style={{ color: TYPE_COLORS[selectedNode.ref.type] }}>
                  {TYPE_LABELS[selectedNode.ref.type]}
                  {relevantKeys.has(selectedNode.ref.matchingKey) && (
                    <span className="headless-node__relevant-badge" style={{ marginLeft: 6 }}>✦ relevant</span>
                  )}
                </div>
                <div className="headless-detail__name">{selectedNode.ref.name}</div>
                <div className="headless-detail__key">{selectedNode.ref.matchingKey}</div>
              </div>

              <div className="headless-detail__body">
                {(selectedNode.ref.description || selectedNode.ref.aiDescription) && (
                  <div className="headless-detail__description">
                    {selectedNode.ref.description || selectedNode.ref.aiDescription}
                    {!selectedNode.ref.description && selectedNode.ref.aiDescription && (
                      <span className="headless-detail__ai-badge">✦ AI</span>
                    )}
                  </div>
                )}
                <div className="headless-detail__row">
                  <span className="headless-detail__label">Version</span>
                  <span>{selectedNode.ref.version ?? '—'}</span>
                </div>
                <div className="headless-detail__row">
                  <span className="headless-detail__label">Active</span>
                  <span>{selectedNode.ref.isActive ? 'Yes' : 'No'}</span>
                </div>
                {selectedNode.ref.type === 'DataRaptor' && (
                  <>
                    {selectedNode.ref.drType && (
                      <div className="headless-detail__row">
                        <span className="headless-detail__label">DR Type</span>
                        <span>{selectedNode.ref.drType}</span>
                      </div>
                    )}
                    {selectedNode.ref.sourceObject && (
                      <div className="headless-detail__row">
                        <span className="headless-detail__label">Source</span>
                        <span className="headless-detail__mono">{selectedNode.ref.sourceObject}</span>
                      </div>
                    )}
                    {(selectedNode.ref.inputType || selectedNode.ref.outputType) && (
                      <div className="headless-detail__row">
                        <span className="headless-detail__label">I/O</span>
                        <span>{[selectedNode.ref.inputType, selectedNode.ref.outputType].filter(Boolean).join(' → ')}</span>
                      </div>
                    )}
                  </>
                )}
                {selectedNode.ref.type === 'IntegrationProcedure' && selectedNode.ref.ipSteps && (
                  <div className="headless-detail__row headless-detail__row--full">
                    <span className="headless-detail__label">Steps</span>
                    <span className="headless-detail__mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {selectedNode.ref.ipSteps.replace('Steps (', '').replace(/^\d+\): /, '')}
                    </span>
                  </div>
                )}
                {selectedNode.ref.type === 'OmniScript' && selectedNode.ref.osSteps && (
                  <div className="headless-detail__row headless-detail__row--full">
                    <span className="headless-detail__label">Steps</span>
                    <span className="headless-detail__mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {selectedNode.ref.osSteps}
                    </span>
                  </div>
                )}
                {selectedNode.ref.type === 'OmniUiCard' && selectedNode.ref.cardType && (
                  <div className="headless-detail__row">
                    <span className="headless-detail__label">Card Type</span>
                    <span>{selectedNode.ref.cardType}</span>
                  </div>
                )}
                <div className="headless-detail__row">
                  <span className="headless-detail__label">ID</span>
                  <span className="headless-detail__mono">{selectedNode.ref.id ?? '—'}</span>
                </div>
              </div>

              {selectedNode.deps.length > 0 && (
                <div className="headless-detail__section">
                  <div className="headless-detail__section-title">Authored dependencies ({selectedNode.deps.length})</div>
                  {selectedNode.deps.map((depKey) => {
                    const dep = nodeByKey.get(depKey);
                    return (
                      <div key={depKey} className="headless-detail__edge headless-detail__edge--dep" onClick={() => setSelectedKey(depKey)}>
                        {dep ? (
                          <>
                            <span className="headless-node__dot" style={{ background: TYPE_COLORS[dep.ref.type], flexShrink: 0 }} />
                            <span>{dep.ref.name}</span>
                            <span className="headless-detail__edge-type">Authored · {TYPE_LABELS[dep.ref.type]}</span>
                          </>
                        ) : (
                          <span className="headless-detail__edge-external" title={depKey}>{depKey}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedNode.dependents.length > 0 && (
                <div className="headless-detail__section">
                  <div className="headless-detail__section-title">Authored incoming ({selectedNode.dependents.length})</div>
                  {selectedNode.dependents.map((depKey) => {
                    const dep = nodeByKey.get(depKey);
                    return (
                      <div key={depKey} className="headless-detail__edge headless-detail__edge--used" onClick={() => setSelectedKey(depKey)}>
                        {dep ? (
                          <>
                            <span className="headless-node__dot" style={{ background: TYPE_COLORS[dep.ref.type], flexShrink: 0 }} />
                            <span>{dep.ref.name}</span>
                            <span className="headless-detail__edge-type">Authored · {TYPE_LABELS[dep.ref.type]}</span>
                          </>
                        ) : (
                          <span className="headless-detail__edge-external" title={depKey}>{depKey}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedInferredEdges.length > 0 && (
                <div className="headless-detail__section">
                  <div className="headless-detail__section-title">Candidate inferred bindings ({selectedInferredEdges.length})</div>
                  {selectedInferredEdges.map((edge) => {
                    const otherKey = edge.source === selectedNode.ref.matchingKey ? edge.target : edge.source;
                    const other = nodeByKey.get(otherKey);
                    return (
                      <div
                        key={`${edge.source}:${edge.target}:${edge.inputField}`}
                        className="headless-detail__edge headless-detail__edge--inferred"
                        onClick={() => setSelectedKey(otherKey)}
                      >
                        <span className="headless-detail__edge-dash" aria-hidden="true" />
                        <span>{other?.ref.name ?? otherKey}</span>
                        <span className="headless-detail__edge-type">
                          {edge.outputObject} → {edge.inputField} · evidence {edge.edgeEvidenceScore.toFixed(2)}*
                        </span>
                      </div>
                    );
                  })}
                  <div className="headless-detail__edge-note">
                    * Fixed {selectedInferredEdges[0].ruleId} rule value; uncalibrated and not execution approval.
                  </div>
                </div>
              )}

              {selectedNode.deps.length === 0 && selectedNode.dependents.length === 0 && selectedInferredEdges.length === 0 && (
                <div className="headless-detail__section">
                  <div className="headless-detail__section-title">Edges</div>
                  <div style={{ padding: '6px 14px', fontSize: 12, color: 'var(--gray-400)' }}>
                    No dependency edges found for this component.
                  </div>
                </div>
              )}

              <div className="headless-detail__governance">
                <div className="headless-detail__gov-title">Policy boundary</div>
                <p>Solid relationships are metadata-observed authored dependencies. Dashed relationships are candidate inferred bindings. The model proposes; application policy, user action, and Salesforce results decide whether execution advances.</p>
              </div>
            </>
          ) : (
            <div className="headless-detail-empty">
              <div className="headless-detail-empty__icon">&#9672;</div>
              <p>Select a node to inspect it</p>
              {!aiPlan && graph && (
                <p className="headless-detail-empty__sub">
                  Type a business intent above and click {aiButtonLabel(aiCfg)} — the full graph will be sent to {providerLabel}, which will identify relevant components (marked ✦) and produce an execution plan.
                </p>
              )}
              {aiPlan && relevantKeys.size > 0 && (
                <p className="headless-detail-empty__sub">
                  {relevantKeys.size} components identified (✦). Click any to inspect edges and metadata.
                  {hasConvHistory && ' Ask a follow-up question to refine.'}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      </div>{/* end headless-scroll-area */}

      {/* Stats footer */}
      {graph && !building && (
        <div className="headless-stats">
          {COMP_TYPES.map((t) => {
            const total = graph.nodes.filter((n) => n.ref.type === t).length;
            if (total === 0) return null;
            const rel = relevantKeys.size > 0
              ? graph.nodes.filter((n) => n.ref.type === t && relevantKeys.has(n.ref.matchingKey)).length
              : null;
            return (
              <span key={t} className="headless-stat">
                <span className="headless-stat__dot" style={{ background: TYPE_COLORS[t] }} />
                {rel !== null ? `${rel}/${total}` : total} {TYPE_LABELS[t]}
              </span>
            );
          })}
          <span className="headless-stat">{totalEdges} edges</span>
          {convHistory.length > 0 && (
            <span className="headless-stat" style={{ color: '#7c3aed' }}>
              {convHistory.length} turn{convHistory.length !== 1 ? 's' : ''}
            </span>
          )}
          <span className="headless-stat headless-stat--time">
            {new Date(graph.builtAt).toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}
