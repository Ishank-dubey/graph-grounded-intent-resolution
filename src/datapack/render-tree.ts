import type { HeadlessGraph } from './exporter.js';
import type { ComponentType } from '../types/bundle.js';
import type {
  GraphRenderTree,
  RenderNode,
  RenderEdge,
  RenderNodeType,
  RenderNodeData,
} from '../types/render-tree.js';

// ─────────────────────────────────────────────────────────────────────────────
// ComponentType → React Flow node type mapping
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_TO_RENDER: Record<ComponentType, RenderNodeType> = {
  OmniScript:           'omniScript',
  IntegrationProcedure: 'integrationProcedure',
  OmniUiCard:           'omniUiCard',
  DataRaptor:           'dataRaptor',
};

const COMP_TYPES: ComponentType[] = [
  'OmniScript',
  'IntegrationProcedure',
  'OmniUiCard',
  'DataRaptor',
];

// ─────────────────────────────────────────────────────────────────────────────
// toRenderTree — pure, synchronous, safe to call on every render cycle
//
// Converts a HeadlessGraph (built from a live org or loaded from a JSON file)
// into a GraphRenderTree that any React Flow / Cytoscape / D3 SDK can consume
// directly.  Layout (dagre, ELK, etc.) is the caller's responsibility — all
// positions are set to {x:0,y:0}.
//
// Edge deduplication: uses a Set with '\x00' separator to avoid prefix
// collisions between matchingKeys that share a common substring.
// ─────────────────────────────────────────────────────────────────────────────

export function toRenderTree(graph: HeadlessGraph): GraphRenderTree {
  const edges: RenderEdge[] = [];
  let edgeIdx = 0;
  const seenEdges = new Set<string>();

  const nodes: RenderNode[] = graph.nodes.map((node): RenderNode => {
    const ref = node.ref;

    // Build outbound edges for this node — caller → dependency direction
    for (const depKey of node.deps) {
      const edgeKey = `${ref.matchingKey}\x00${depKey}`;
      if (!seenEdges.has(edgeKey)) {
        seenEdges.add(edgeKey);
        edges.push({ id: `e${edgeIdx++}`, source: ref.matchingKey, target: depKey, kind: 'dependency' });
      }
    }

    const data: RenderNodeData = {
      matchingKey:   ref.matchingKey,
      componentType: ref.type,
      name:          ref.name,
      // Omit optional fields when absent — keeps JSON clean for inspection
      ...(ref.version  !== undefined && ref.version  !== null ? { version:  ref.version  } : {}),
      ...(ref.isActive !== undefined && ref.isActive !== null ? { isActive: ref.isActive } : {}),
      ...(ref.description   ? { description:   ref.description   } : {}),
      ...(ref.aiDescription ? { aiDescription: ref.aiDescription } : {}),
      // DataRaptor fields
      ...(ref.drType         ? { drType:         ref.drType         } : {}),
      ...(ref.sourceObject   ? { sourceObject:   ref.sourceObject   } : {}),
      ...(ref.inputType      ? { inputType:      ref.inputType      } : {}),
      ...(ref.outputType     ? { outputType:     ref.outputType     } : {}),
      ...(ref.drInputObjects  ? { drInputObjects:  ref.drInputObjects  } : {}),
      ...(ref.drOutputObjects ? { drOutputObjects: ref.drOutputObjects } : {}),
      ...(ref.drInputFields?.length ? { drInputFields: ref.drInputFields } : {}),
      // IntegrationProcedure fields
      ...(ref.ipInvocationKey ? { ipInvocationKey: ref.ipInvocationKey } : {}),
      ...(ref.ipInput  ? { ipInput:  ref.ipInput  } : {}),
      ...(ref.ipOutput ? { ipOutput: ref.ipOutput } : {}),
      ...(ref.ipSteps  ? { ipSteps:  ref.ipSteps  } : {}),
      // OmniScript fields
      ...(ref.osSteps ? { osSteps: ref.osSteps } : {}),
      // FlexCard fields
      ...(ref.cardType ? { cardType: ref.cardType } : {}),
      // Structured step schematic (IP/OS, from OmniProcessCompilation)
      ...(ref.ipSchematic?.length        ? { ipSchematic:        ref.ipSchematic        } : {}),
      ...(ref.ipStepInputMappings?.length ? { ipStepInputMappings: ref.ipStepInputMappings } : {}),
      // Salesforce record ID
      ...(ref.id ? { sfId: ref.id } : {}),
      // Pre-computed edge counts
      depCount:       node.deps.length,
      dependentCount: node.dependents.length,
    };

    return {
      id:       ref.matchingKey,
      type:     TYPE_TO_RENDER[ref.type],
      data,
      position: { x: 0, y: 0 },
    };
  });

  for (const inferred of graph.inferredEdges ?? []) {
    const edgeKey = `inferred\x00${inferred.source}\x00${inferred.target}\x00${inferred.inputField}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    edges.push({
      id: `e${edgeIdx++}`,
      source: inferred.source,
      target: inferred.target,
      kind: 'inferredDataFlow',
      data: {
        sourceOperation: inferred.sourceOperation,
        selectionPolicy: inferred.selectionPolicy,
        outputObject: inferred.outputObject,
        inputField: inferred.inputField,
        edgeEvidenceScore: inferred.edgeEvidenceScore,
        ruleId: inferred.ruleId,
        calibrated: inferred.calibrated,
        evidence: inferred.evidence,
      },
    });
  }

  const byType = Object.fromEntries(
    COMP_TYPES.map((t) => [t, graph.nodes.filter((n) => n.ref.type === t).length]),
  ) as Record<ComponentType, number>;

  return {
    schemaVersion: '1.0',
    builtAt:       graph.builtAt,
    orgUrl:        graph.orgUrl,
    totalNodes:    nodes.length,
    totalEdges:    edges.length,
    byType,
    nodes,
    edges,
  };
}
