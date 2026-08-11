import type { HeadlessGraph, InferredDataFlowEdge } from '../datapack/exporter.js';

export interface ExistingRecordConflict {
  ipInvocationKey: string;
  objectType: string;
  queryBundle: string;
  targetBundle: string;
  targetField: string;
  edge: InferredDataFlowEdge;
}

/**
 * Rejects an IP that creates a new parent record when the intent asks to create
 * something for an existing parent and the graph contains a query-to-write path.
 */
export function findExistingRecordConflict(
  graph: HeadlessGraph,
  intent: string,
  ipInvocations: Array<{ ipInvocationKey: string }>,
): ExistingRecordConflict | null {
  if (
    ipInvocations.length === 0 ||
    !/\b(create|open|raise|file|submit|log)\b.*\b(for|against|under|related to|associated with)\b/i.test(intent)
  ) {
    return null;
  }

  const nodeByKey = new Map(graph.nodes.map((node) => [node.ref.matchingKey, node]));
  for (const invocation of ipInvocations) {
    const ipNode = graph.nodes.find((node) =>
      node.ref.type === 'IntegrationProcedure' &&
      node.ref.ipInvocationKey === invocation.ipInvocationKey,
    );
    if (!ipNode) continue;

    for (const edge of graph.inferredEdges ?? []) {
      if (edge.sourceOperation !== 'query') continue;
      const queryNode = nodeByKey.get(edge.source);
      const targetNode = nodeByKey.get(edge.target);
      if (!queryNode || !targetNode) continue;

      const createsParent = ipNode.deps.some((depKey) => {
        const dependency = nodeByKey.get(depKey);
        return dependency?.ref.type === 'DataRaptor' &&
          (dependency.ref.drType ?? '').toLowerCase().includes('load') &&
          (dependency.ref.drOutputObjects ?? '').split(',').some((objectType) =>
            objectType.trim().toLowerCase() === edge.outputObject.toLowerCase(),
          );
      });
      if (!createsParent) continue;

      return {
        ipInvocationKey: invocation.ipInvocationKey,
        objectType: edge.outputObject,
        queryBundle: queryNode.ref.name,
        targetBundle: targetNode.ref.name,
        targetField: edge.inputField,
        edge,
      };
    }
  }

  return null;
}

export function buildExistingRecordCorrection(conflict: ExistingRecordConflict): string {
  return [
    'APPLICATION POLICY REJECTED THE PREVIOUS PLAN.',
    `${conflict.ipInvocationKey} creates a new ${conflict.objectType}, but this intent refers to an existing ${conflict.objectType}.`,
    `Return corrected JSON using stepwise mode with only ${conflict.queryBundle} as the next invocation.`,
    `After execution, the graph edge policy requires selection when multiple ${conflict.objectType} records are returned, then binds only the selected Id to ${conflict.targetBundle}.${conflict.targetField}.`,
    `Do not invoke ${conflict.ipInvocationKey} and do not create a new ${conflict.objectType}.`,
  ].join('\n');
}
