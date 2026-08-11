import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ComponentRef, ComponentType } from '../src/types/bundle.js';
import type { HeadlessGraph, HeadlessNode } from '../src/datapack/exporter.js';
import { buildFullGraphPrompt, nodeSearchText } from '../src/headless/graphPrompt.js';

type Domain = 'onboarding' | 'billing' | 'claims' | 'service' | 'orders';
type Method = 'lexical-top1' | 'graph-expanded';
type IntentCase = { id: string; domain: Domain; text: string; expectedKeys: string[] };
type Metric = { precision: number; recall: number; f1: number };

const DOMAINS: Domain[] = ['onboarding', 'billing', 'claims', 'service', 'orders'];
const SIZES = [20, 50, 100, 200, 500];
const TIMING_RUNS = 100;
const WARMUP_RUNS = 20;
const DOMAIN_WORDS: Record<Domain, string[]> = {
  onboarding: ['onboarding', 'identity', 'credit', 'applicant', 'account'],
  billing: ['billing', 'invoice', 'payment', 'balance', 'statement'],
  claims: ['claims', 'incident', 'policy', 'damage', 'adjuster'],
  service: ['service', 'case', 'support', 'entitlement', 'resolution'],
  orders: ['orders', 'cart', 'product', 'fulfillment', 'pricing'],
};

const INTENT_TEMPLATES = [
  (domain: Domain) => `show the ${domain} journey`,
  (domain: Domain) => `which components fetch data for ${domain}`,
  (domain: Domain) => `trace the ${domain} service chain`,
  (domain: Domain) => `what runs when the user submits ${domain}`,
  (domain: Domain) => `find the display and data dependencies for ${domain}`,
];

function key(type: ComponentType, domain: Domain, index: number): string {
  if (type === 'OmniScript') return `OmniScript/${domain}/Journey${index}/English/1`;
  if (type === 'IntegrationProcedure') return `IntegrationProcedure/${domain}/Service${index}/1`;
  if (type === 'OmniUiCard') return `OmniUiCard/${domain}Summary${index}/Developer/1`;
  return `DataRaptor/${domain}Data${index}`;
}

function ref(type: ComponentType, domain: Domain, index: number): ComponentRef {
  const words = DOMAIN_WORDS[domain];
  const base: ComponentRef = {
    type,
    matchingKey: key(type, domain, index),
    id: `${type.slice(0, 2)}-${domain}-${index}`,
    name: `${domain}-${type}-${index}`,
    version: 1,
    isActive: true,
    description: `${words.join(' ')} capability for ${domain}`,
  };
  if (type === 'OmniScript') base.osSteps = `3 steps: ${words[1]}, ${words[2]}, Review`;
  if (type === 'IntegrationProcedure') {
    base.ipSteps = `Steps (3): DR-Extract ${domain}Data, Conditional, Response`;
    base.ipInput = JSON.stringify({ contextId: 'string', domain });
    base.ipOutput = JSON.stringify({ status: 'string', domain });
  }
  if (type === 'OmniUiCard') base.cardType = 'Parent';
  if (type === 'DataRaptor') {
    base.drType = 'Extract';
    base.sourceObject = `${domain[0].toUpperCase()}${domain.slice(1)}__c`;
    base.inputType = 'JSON';
    base.outputType = 'JSON';
  }
  return base;
}

export function makeGraph(size: number): { graph: HeadlessGraph; intents: IntentCase[] } {
  if (size < DOMAINS.length * 4) throw new Error(`Graph size must be at least ${DOMAINS.length * 4}`);
  const nodes: HeadlessNode[] = [];
  const chains = new Map<Domain, string[]>();
  for (const domain of DOMAINS) {
    const domainNodes = [
      ref('OmniUiCard', domain, 0),
      ref('OmniScript', domain, 0),
      ref('IntegrationProcedure', domain, 0),
      ref('DataRaptor', domain, 0),
    ];
    const keys = domainNodes.map((item) => item.matchingKey);
    chains.set(domain, keys);
    nodes.push(
      { ref: domainNodes[0], deps: [keys[1]], dependents: [] },
      { ref: domainNodes[1], deps: [keys[2]], dependents: [keys[0]] },
      { ref: domainNodes[2], deps: [keys[3]], dependents: [keys[1]] },
      { ref: domainNodes[3], deps: [], dependents: [keys[2]] },
    );
  }

  let index = 1;
  while (nodes.length < size) {
    const domain = DOMAINS[index % DOMAINS.length];
    const type: ComponentType = ['OmniScript', 'IntegrationProcedure', 'OmniUiCard', 'DataRaptor'][index % 4] as ComponentType;
    const distractor = ref(type, domain, index);
    distractor.description = `shared utility archive helper batch ${index}`;
    delete distractor.osSteps;
    delete distractor.ipSteps;
    delete distractor.ipInput;
    delete distractor.ipOutput;
    nodes.push({ ref: distractor, deps: [], dependents: [] });
    index++;
  }

  const graph: HeadlessGraph = {
    nodes: nodes.slice(0, size),
    builtAt: '2026-08-05T00:00:00.000Z',
    orgUrl: 'https://benchmark.example.salesforce.com',
  };
  const intents = DOMAINS.flatMap((domain) => INTENT_TEMPLATES.map((template, intentIndex) => ({
    id: `${domain}-${intentIndex + 1}`,
    domain,
    text: template(domain),
    expectedKeys: chains.get(domain)!.filter((candidate) => graph.nodes.some((node) => node.ref.matchingKey === candidate)),
  })));
  return { graph, intents };
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2) ?? []);
}

function scoreText(intent: string, node: HeadlessNode): number {
  const query = tokens(intent);
  const text = tokens(nodeSearchText(node));
  let score = 0;
  for (const word of query) if (text.has(word)) score++;
  return score;
}

export function retrieve(method: Method, intent: string, graph: HeadlessGraph): string[] {
  const ranked = graph.nodes
    .map((node) => ({ key: node.ref.matchingKey, score: scoreText(intent, node) }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const seeds = ranked.filter((item) => item.score > 0).slice(0, 1).map((item) => item.key);
  if (method === 'lexical-top1') return seeds;
  const nodeByKey = new Map(graph.nodes.map((node) => [node.ref.matchingKey, node]));
  const selected = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    const node = nodeByKey.get(candidate);
    for (const neighbour of [...(node?.deps ?? []), ...(node?.dependents ?? [])]) {
      if (selected.has(neighbour)) continue;
      selected.add(neighbour);
      queue.push(neighbour);
    }
  }
  return [...selected];
}

function metric(predicted: string[], expected: string[]): Metric {
  const prediction = new Set(predicted);
  const gold = new Set(expected);
  const truePositive = [...prediction].filter((item) => gold.has(item)).length;
  const precision = prediction.size ? truePositive / prediction.size : 0;
  const recall = gold.size ? truePositive / gold.size : 0;
  return { precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export async function runBenchmark() {
  const scales = [];
  const retrieval = [];
  for (const size of SIZES) {
    const { graph, intents } = makeGraph(size);
    const timings: number[] = [];
    let prompt = '';
    for (let run = 0; run < WARMUP_RUNS; run++) buildFullGraphPrompt(graph, intents[0].text);
    for (let run = 0; run < TIMING_RUNS; run++) {
      const start = performance.now();
      prompt = buildFullGraphPrompt(graph, intents[0].text);
      timings.push(performance.now() - start);
    }
    scales.push({
      nodes: graph.nodes.length,
      edges: graph.nodes.reduce((sum, node) => sum + node.deps.length, 0),
      promptChars: prompt.length,
      approximateTokens: Math.ceil(prompt.length / 4),
      meanPromptBuildMs: mean(timings),
      p95PromptBuildMs: percentile(timings, 0.95),
    });
    for (const method of ['lexical-top1', 'graph-expanded'] as const) {
      const rows = intents.map((intent) => metric(retrieve(method, intent.text, graph), intent.expectedKeys));
      retrieval.push({
        nodes: size,
        method,
        intents: rows.length,
        precision: mean(rows.map((row) => row.precision)),
        recall: mean(rows.map((row) => row.recall)),
        f1: mean(rows.map((row) => row.f1)),
      });
    }
  }

  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    design: {
      graphSizes: SIZES,
      intents: 25,
      domains: DOMAINS,
      methods: ['lexical-top1', 'graph-expanded'],
      seedBudget: 1,
      warmupRuns: WARMUP_RUNS,
      timingRuns: TIMING_RUNS,
      note: 'Deterministic synthetic benchmark; no LLM calls. Model evaluation is a separate experiment.',
    },
    scales,
    retrieval,
  };
  const outputPath = new URL('./headless-benchmark-results.json', import.meta.url);
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBenchmark();
}
