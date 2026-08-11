import type { ComponentType } from '../types/bundle.js';
import type { HeadlessGraph, HeadlessNode } from '../datapack/exporter.js';

export const TYPE_LABELS: Record<ComponentType, string> = {
  OmniScript: 'OmniScript',
  IntegrationProcedure: 'IP',
  OmniUiCard: 'FlexCard',
  DataRaptor: 'DataRaptor',
};

// ─────────────────────────────────────────────────────────────────────────────
// buildFullGraphPrompt
//
// Produces the LLM context for intent-to-component resolution.
//
// Architecture note (two-tier model):
//
//   SERVICE LAYER  (IP + DataRaptor)
//     IPs are callable REST services invoked via ConnectAPI:
//       ConnectAPI.OmniDesignerConnect.integrationProcedureExecute(
//           "Type_SubType",    ← ipInvocationKey
//           apexInput          ← matches ipInput contract
//       )
//     Load DataRaptors are also directly callable via the DataMapper REST API:
//       POST /connect/omni-global/data-mapper/execute/{DataMapperName}
//     → PRIMARY targets: NLP intent → IP invocation key (multi-step workflow)
//                                  OR DataMapper name (single atomic operation)
//
//   UI LAYER  (OmniScript + FlexCard)
//     OmniScripts render step-by-step forms/wizards.
//     FlexCards render card-based data displays.
//     → SECONDARY: resolved only when the intent is explicitly about UI rendering
//
// Response schema uses ipInvocations[] for IP calls and drInvocations[] for
// direct DataMapper calls — the routing rule determines which to populate.
// ─────────────────────────────────────────────────────────────────────────────

export function buildFullGraphPrompt(graph: HeadlessGraph, intent: string): string {
  const nodeByKey = new Map(graph.nodes.map((node) => [node.ref.matchingKey, node]));
  const inferredFrom = new Map<string, typeof graph.inferredEdges>();
  const inferredTo = new Map<string, typeof graph.inferredEdges>();
  for (const edge of graph.inferredEdges ?? []) {
    inferredFrom.set(edge.source, [...(inferredFrom.get(edge.source) ?? []), edge]);
    inferredTo.set(edge.target, [...(inferredTo.get(edge.target) ?? []), edge]);
  }

  // Partition into service layer (IP + DR) and UI layer (OS + FlexCard)
  const ipNodes   = graph.nodes.filter((n) => n.ref.type === 'IntegrationProcedure');
  const drNodes   = graph.nodes.filter((n) => n.ref.type === 'DataRaptor');
  const osNodes   = graph.nodes.filter((n) => n.ref.type === 'OmniScript');
  const cardNodes = graph.nodes.filter((n) => n.ref.type === 'OmniUiCard');

  const lines: string[] = [
    'You are an OmniStudio AI Planner. Governance rule: PLAN and DISCOVER only — never execute business logic directly.',
    '',
    '## OmniStudio component graph',
    `Org: ${graph.orgUrl}`,
    `Components: ${graph.nodes.length} total` +
      ` (${ipNodes.length} IP, ${drNodes.length} DR, ${osNodes.length} OS, ${cardNodes.length} FlexCard)`,
    '',
    '## TIER 1 — Service Layer (Integration Procedures + DataRaptors)',
    '## IPs are the governed multi-step orchestration interface.',
    '## DataRaptors with "Invoke:" listed below are directly callable for atomic query or write operations.',
    '',
  ];

  // ── Integration Procedures ─────────────────────────────────────────────────
  if (ipNodes.length > 0) {
    lines.push('### Integration Procedures');
    for (const node of ipNodes) {
      const ref = node.ref;
      const depNames = node.deps.map((key) => nodeByKey.get(key)?.ref.name ?? key).join(', ');
      lines.push(`[IP] ${ref.name}  (active: ${ref.isActive ? 'yes' : 'no'}, key: ${ref.matchingKey})`);

      // Invocation contract — what the calling UI needs for ipInvocations
      if (ref.ipInvocationKey) {
        lines.push(`  Invoke: ConnectAPI.integrationProcedureExecute("${ref.ipInvocationKey}", input)`);
      }

      const description = ref.description || ref.aiDescription;
      if (description) lines.push(`  Purpose: "${description}"`);

      // Per-step input requirements — for NLP slot-filling
      // Shows which input fields each DR step needs, so the AI can identify
      // which fields were mentioned in the NLP and which are missing.
      if (ref.ipStepInputMappings && ref.ipStepInputMappings.length > 0) {
        lines.push('  Input fields by step:');
        for (const m of ref.ipStepInputMappings) {
          const target = m.drBundle ? `→ ${m.drBundle}` : `→ ${m.stepType}`;
          const fields = m.inputFields.length > 0
            ? m.inputFields.join(', ')
            : '(no variable inputs)';
          lines.push(`    [${m.stepName}] ${fields}  ${target}`);
        }
      } else if (ref.ipInput) {
        // Fall back to the typed input contract if no step mappings
        lines.push(`  Input contract: ${truncate(ref.ipInput, 300)}`);
      }

      if (ref.ipOutput) lines.push(`  Output contract: ${truncate(ref.ipOutput, 200)}`);
      if (ref.ipSteps)  lines.push(`  ${ref.ipSteps}`);
      if (depNames)     lines.push(`  → uses: ${depNames}`);
    }
    lines.push('');
  }

  // ── DataRaptors ────────────────────────────────────────────────────────────
  if (drNodes.length > 0) {
    lines.push('### DataRaptors');
    for (const node of drNodes) {
      const ref = node.ref;
      const usedBy = node.dependents.map((key) => nodeByKey.get(key)?.ref.name ?? key).join(', ');
      lines.push(`[DR] ${ref.name}  (active: ${ref.isActive ? 'yes' : 'no'}, key: ${ref.matchingKey})`);

      const description = ref.description || ref.aiDescription;
      if (description) lines.push(`  Purpose: "${description}"`);

      const schema: string[] = [];
      if (ref.drType)       schema.push(`type=${ref.drType}`);
      if (ref.sourceObject) schema.push(`source=${ref.sourceObject}`);
      if (ref.inputType)    schema.push(`inputFormat=${ref.inputType}`);
      if (ref.outputType)   schema.push(`outputFormat=${ref.outputType}`);
      if (schema.length > 0) lines.push(`  Schema: ${schema.join(', ')}`);

      // Mapped-field object paths — the "what" of the data operation
      if (ref.drInputObjects)  lines.push(`  Reads from: ${ref.drInputObjects}`);
      if (ref.drOutputObjects) lines.push(`  Writes to:  ${ref.drOutputObjects}`);

      // Load payload fields and Extract filter fields are both direct invocation inputs.
      const isCallableDr = ['load', 'extract'].some((type) =>
        (ref.drType ?? '').toLowerCase().includes(type),
      );
      if (isCallableDr && ref.drInputFields && ref.drInputFields.length > 0) {
        lines.push(`  Invoke: POST /connect/omni-global/data-mapper/execute/${ref.name}`);
        lines.push(`  Input fields: ${ref.drInputFields.join(', ')}`);
      }

      for (const edge of inferredFrom.get(ref.matchingKey) ?? []) {
        const target = nodeByKey.get(edge.target)?.ref.name ?? edge.target;
        const selection = edge.selectionPolicy === 'userSelectMultiple'
          ? '; select explicitly when multiple records match'
          : '';
        lines.push(`  ⇢ candidate inferred output [${edge.ruleId}, ${edge.sourceOperation}, evidence ${edge.edgeEvidenceScore.toFixed(2)}, uncalibrated]: returned ${edge.outputObject} Id can feed ${target}.${edge.inputField}${selection}`);
      }
      for (const edge of inferredTo.get(ref.matchingKey) ?? []) {
        const source = nodeByKey.get(edge.source)?.ref.name ?? edge.source;
        const selection = edge.selectionPolicy === 'userSelectMultiple'
          ? '; select explicitly when multiple records match'
          : '';
        lines.push(`  ⇠ candidate inferred input [${edge.ruleId}, ${edge.sourceOperation}, evidence ${edge.edgeEvidenceScore.toFixed(2)}, uncalibrated]: ${edge.inputField} can come from ${source}'s returned ${edge.outputObject} Id${selection}`);
      }

      if (usedBy) lines.push(`  ← called by: ${usedBy}`);
    }
    lines.push('');
  }

  // ── UI Layer ───────────────────────────────────────────────────────────────
  if (osNodes.length > 0 || cardNodes.length > 0) {
    lines.push('## TIER 2 — UI Layer (OmniScripts + FlexCards)');
    lines.push('## Resolve these only when the intent is explicitly about UI rendering / forms / card displays.');
    lines.push('');

    for (const node of [...osNodes, ...cardNodes]) {
      const ref = node.ref;
      const typeLabel = TYPE_LABELS[ref.type];
      const depNames = node.deps.map((key) => nodeByKey.get(key)?.ref.name ?? key).join(', ');
      lines.push(`[${typeLabel}] ${ref.name}  (active: ${ref.isActive ? 'yes' : 'no'}, key: ${ref.matchingKey})`);

      const description = ref.description || ref.aiDescription;
      if (description) lines.push(`  Purpose: "${description}"`);

      if (ref.type === 'OmniScript' && ref.osSteps) lines.push(`  ${ref.osSteps}`);
      if (ref.type === 'OmniUiCard' && ref.cardType) lines.push(`  CardType: ${ref.cardType}`);
      if (depNames) lines.push(`  → uses: ${depNames}`);
    }
    lines.push('');
  }

  // ── AI task ────────────────────────────────────────────────────────────────
  lines.push(
    '## User intent:',
    `"${intent}"`,
    '',
    '## Routing rule — choose EXACTLY ONE invocation path:',
    '- MULTI-STEP intent with an IP that covers the full workflow AND all required record relationships → populate ipInvocations[].',
    '- MULTI-STEP intent not correctly covered by an IP → use stepwise mode and populate drInvocations[] with only the next operation.',
    '  On later turns, use an observed prior Data Mapper record as a derived input when the next DR has a matching <Object>Id field.',
    '  Follow the graph edge metadata for the source operation, artifact object type, target input field, and selection policy.',
    '- SINGLE-STEP intent (one clear atomic operation on a single object) → populate drInvocations[]',
    '  Use only when a DR above has both "Invoke:" and "Input fields:" listed.',
    '- Do not choose an IP when its child DR lacks a field needed to express the requested relationship.',
    '- Existing-record guard: when the intent identifies an existing business entity by a non-ID attribute, do not choose a workflow that creates that entity. Prefer a graph query-to-write path when one exists.',
    '- When a graph edge has sourceOperation=query, use stepwise mode: query first, apply the edge selectionPolicy, then bind the selected artifact through the edge inputField.',
    '- Never populate both arrays at once.',
    '',
    '## Your task:',
    '1. Identify the relevant IPs and DRs (service layer is primary).',
    '2. Apply the routing rule to choose ipInvocations[] or drInvocations[].',
    '3. For the chosen invocation:',
    '   a. Extract any input field values the user already mentioned in the intent.',
    '   b. List all required fields from "Input fields by step" (IP) or "Input fields:" (DR) not yet provided.',
    '4. Apply the deterministic planning-mode policy:',
    '   - one_go: use only when the response contains exactly one external invocation that completes the goal: one atomic Data Mapper OR one authored IP. remainingGoal must be empty.',
    '   - stepwise: required when direct Data Mapper composition leaves unfinished work.',
    '   - In stepwise mode return ONLY the next operation and put the unfinished work in remainingGoal.',
    '   - Candidate inferred edges are evidence for planning, never authorization. Their evidence scores are fixed rule values, not probabilities.',
    '5. Return ONLY valid JSON in EXACTLY this format (no markdown, no extra text):',
    '{',
    '  "relevantKeys": ["<matchingKey1>", ...],',
    '  "planningMode": "<one_go|stepwise>",',
    '  "remainingGoal": "<unfinished goal after returned invocation(s), or empty when complete>",',
    '  "ipInvocations": [',
    '    {',
    '      "ipInvocationKey": "<Type_SubType>",',
    '      "purpose": "<one sentence describing what this IP does>",',
    '      "providedInputs": { "<field>": "<value from intent>" },',
    '      "missingInputs": [',
    '        { "field": "<fieldName>", "forStep": "<drBundle or stepName>", "prompt": "<ask the user this>", "optional": false }',
    '      ]',
    '    }',
    '  ],',
    '  "drInvocations": [',
    '    {',
    '      "invocationId": "<unique step id>",',
    '      "drBundle": "<DataRaptor name — must match a DR shown above with Invoke: listed>",',
    '      "drType": "<Load|Extract|Transform>",',
    '      "purpose": "<one sentence describing what this DR does>",',
    '      "dependsOn": ["<prior invocationId>"],',
    '      "providedInputs": { "<field>": "<value from intent>" },',
    '      "derivedInputs": [',
    '        { "field": "<target inputField from graph edge>", "fromInvocation": "<prior invocationId>", "objectType": "<outputObject from graph edge>" }',
    '      ],',
    '      "missingInputs": [',
    '        { "field": "<fieldName>", "prompt": "<ask the user this>", "optional": false }',
    '      ]',
    '    }',
    '  ],',
    '  "plan": "<execution plan: entry point → data flow → result>"',
    '}',
    '',
    'Rules:',
    '- Populate EXACTLY ONE of ipInvocations[] or drInvocations[] — the other must be [].',
    '- ipInvocations[]: use for multi-step IP workflows. Lists IPs only.',
    '- drInvocations[]: return exactly one DR. Only use a DR that has "Invoke:" listed above.',
    '- dependsOn may list a completed invocationId supplied in a SESSION UPDATE.',
    '- derivedInputs are supplied only from prior Data Mapper artifacts in a SESSION UPDATE. Do NOT repeat them in missingInputs.',
    '- Derive fields only from a graph edge whose outputObject and target inputField match. Apply its selectionPolicy before binding an artifact.',
    '- Lines labeled "candidate inferred" are contract-compatible candidates, not authored OmniStudio dependencies or execution approval.',
    '- Never describe an evidence score as confidence, probability, policy approval, or authorization.',
    '- one_go must contain exactly one IP invocation or one Data Mapper invocation and an empty remainingGoal.',
    '- Every multi-operation Data Mapper chain must use stepwise mode, return exactly one invocation, and include a non-empty remainingGoal.',
    '- In stepwise mode return exactly one invocation. The caller will execute it, add its real outputs to the session, and ask you to plan again.',
    '- When the intent contains a SESSION UPDATE, do not repeat a completed invocation. Use only the listed artifacts as derived values.',
    '- providedInputs: only include fields whose values are clearly stated in the intent.',
    '- missingInputs: one entry per field not covered by the intent. Set "optional" correctly:',
    '    optional: false  → the operation cannot run without this field (truly required).',
    '    optional: true   → enrichment/conditional field — operation runs fine without it.',
    '                       Also use optional:true for ALL fields belonging to conditional steps.',
    '  The "prompt" for optional fields must state that the user may leave the value blank.',
    '- If all fields are provided, missingInputs: [].',
    '- If no components match, return { "relevantKeys": [], "planningMode": "stepwise", "remainingGoal": "", "ipInvocations": [], "drInvocations": [], "plan": "No matching components found." }',
  );

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// nodeSearchText — all searchable tokens for a node (used by lexical retrieval)
// ─────────────────────────────────────────────────────────────────────────────

export function nodeSearchText(node: HeadlessNode): string {
  const ref = node.ref;
  return [
    ref.type,
    ref.name,
    ref.matchingKey,
    ref.ipInvocationKey,
    ref.description,
    ref.aiDescription,
    ref.drType,
    ref.sourceObject,
    ref.inputType,
    ref.outputType,
    ref.drInputObjects,
    ref.drOutputObjects,
    ref.drInputFields?.join(' '),
    ref.ipInput,
    ref.ipOutput,
    ref.ipSteps,
    ref.osSteps,
    ref.cardType,
  ].filter(Boolean).join(' ');
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
