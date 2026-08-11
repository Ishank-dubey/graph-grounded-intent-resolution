import type { ComponentType } from './bundle.js';

// ─────────────────────────────────────────────────────────────────────────────
// GraphRenderTree — React Flow / Cytoscape / D3 compatible output format
//
// The `toRenderTree(graph)` function in `src/datapack/render-tree.ts` produces
// this from a `HeadlessGraph`.  Designed for the UI SDK renderer:
//
//   - `position: {x:0,y:0}` on every node — layout is the SDK's job (dagre/ELK)
//   - `relevantKeys` from AI turns are NOT embedded here; they are transient
//     UI state passed separately as `highlight: string[]` to the renderer so
//     the same tree JSON works across multiple AI planning turns
//   - Edge direction: source → target = caller → dependency (same as `deps`)
//   - Edge `id`: sequential `e0..eN` — matchingKeys may contain slashes/spaces
//     so opaque sequential IDs avoid any parsing issues
// ─────────────────────────────────────────────────────────────────────────────

export type RenderNodeType =
  | 'omniScript'
  | 'integrationProcedure'
  | 'omniUiCard'
  | 'dataRaptor';

export interface RenderNodeData {
  matchingKey: string;
  componentType: ComponentType;
  name: string;
  version?: number;
  isActive?: boolean;
  description?: string;
  aiDescription?: string;
  // DataRaptor-specific schema fields
  drType?: string;
  sourceObject?: string;
  inputType?: string;
  outputType?: string;
  /** Comma-separated distinct InputObjectName values from OmniDataTransformItem */
  drInputObjects?: string;
  /** Comma-separated distinct OutputObjectName values from OmniDataTransformItem */
  drOutputObjects?: string;
  /** Direct invocation input fields for Load Data Mappers */
  drInputFields?: string[];
  // IntegrationProcedure-specific schema fields
  /** ConnectAPI invocation key: "Type_SubType" */
  ipInvocationKey?: string;
  ipInput?: string;
  ipOutput?: string;
  ipSteps?: string;
  // OmniScript-specific
  osSteps?: string;
  // FlexCard-specific
  cardType?: string;
  /** Per-step input requirements for NLP slot-filling (from OmniProcessCompilation) */
  ipStepInputMappings?: import('./bundle.js').IpStepInputMapping[];
  // Salesforce record ID (present when graph was built from a live org)
  sfId?: string;
  // Pre-computed edge counts — avoids traversal in the renderer
  depCount: number;
  dependentCount: number;
}

export interface RenderNode {
  /** Equals `matchingKey` — stable, human-readable, cross-org consistent */
  id: string;
  type: RenderNodeType;
  data: RenderNodeData;
  /** Always {x:0,y:0} — layout is delegated to the UI SDK (dagre/ELK/etc.) */
  position: { x: number; y: number };
}

export interface RenderEdge {
  /** Sequential opaque id: 'e0', 'e1', ... */
  id: string;
  /** matchingKey of the caller (has a dep on target) */
  source: string;
  /** matchingKey of the dependency */
  target: string;
  /** Authored component dependency or contract-inferred DR data flow */
  kind?: 'dependency' | 'inferredDataFlow';
  data?: {
    sourceOperation: 'query' | 'write';
    selectionPolicy: 'automaticSingle' | 'userSelectMultiple';
    outputObject: string;
    inputField: string;
    /** Fixed inference-rule evidence strength, not a calibrated probability. */
    edgeEvidenceScore: number;
    ruleId: string;
    calibrated: false;
    evidence: string[];
  };
}

export interface GraphRenderTree {
  /** Schema version — bump when shape changes */
  schemaVersion: '1.0';
  /** ISO timestamp of the HeadlessGraph build this tree was derived from */
  builtAt: string;
  /** Salesforce org URL the graph was built from */
  orgUrl: string;
  totalNodes: number;
  totalEdges: number;
  /** Component count by type — handy for stats strip in UI */
  byType: Record<ComponentType, number>;
  nodes: RenderNode[];
  edges: RenderEdge[];
}
