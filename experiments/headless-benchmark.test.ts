import { describe, expect, test } from 'bun:test';
import { buildFullGraphPrompt } from '../src/headless/graphPrompt.js';
import { inferDataFlowEdges } from '../src/datapack/exporter.js';
import type { HeadlessNode } from '../src/datapack/exporter.js';
import { makeGraph, retrieve } from './headless-benchmark.js';
import { resolvePlanningMode } from '../src/headless/planningPolicy.js';

describe('headless benchmark', () => {
  test('uses the production prompt serializer', () => {
    const { graph, intents } = makeGraph(20);
    const prompt = buildFullGraphPrompt(graph, intents[0].text);

    expect(prompt).toContain('Components: 20 total');
    expect(prompt).toContain('[FlexCard] onboarding-OmniUiCard-0');
    expect(prompt).toContain('\u2192 uses: onboarding-OmniScript-0');
    expect(prompt).toContain('use stepwise mode and populate drInvocations[] with only the next operation');
    expect(prompt).toContain('"derivedInputs"');
    expect(prompt).toContain('Follow the graph edge metadata');
    expect(prompt).toContain('Apply its selectionPolicy');
    expect(prompt).toContain('Existing-record guard');
    expect(prompt).toContain('one_go: use only when the response contains exactly one external invocation that completes the goal');
    expect(prompt).not.toContain('edgeConfidence');
  });

  test('graph expansion recovers an intent execution chain', () => {
    const { graph, intents } = makeGraph(100);
    const intent = intents.find((item) => item.id === 'billing-1')!;

    const lexical = retrieve('lexical-top1', intent.text, graph);
    const expanded = retrieve('graph-expanded', intent.text, graph);

    expect(lexical).toHaveLength(1);
    expect(new Set(expanded)).toEqual(new Set(intent.expectedKeys));
  });

  test('rejects a fixture too small to include every gold chain', () => {
    expect(() => makeGraph(19)).toThrow('Graph size must be at least 20');
  });

  test('enforces one-go and stepwise invocation cardinality in application code', () => {
    expect(resolvePlanningMode(1, 0, '')).toBe('one_go');
    expect(resolvePlanningMode(0, 1, '')).toBe('one_go');
    expect(resolvePlanningMode(0, 1, 'Create the related Case')).toBe('stepwise');
    expect(resolvePlanningMode(0, 0, '')).toBe('stepwise');
    expect(resolvePlanningMode(1, 1, '')).toBeNull();
    expect(resolvePlanningMode(0, 2, 'Continue')).toBeNull();
  });

  test('infers an exact-rule Account Id handoff between Load Data Mappers', () => {
    const nodes: HeadlessNode[] = [
      {
        ref: {
          type: 'DataRaptor', matchingKey: 'DataRaptor/CreateAccounts', name: 'CreateAccounts',
          drType: 'Load', drOutputObjects: 'Account', drInputFields: ['Name'],
        },
        deps: [], dependents: [],
      },
      {
        ref: {
          type: 'DataRaptor', matchingKey: 'DataRaptor/CreateCaseUsingAccount', name: 'CreateCaseUsingAccount',
          drType: 'Load', drOutputObjects: 'Case', drInputFields: ['AccountId', 'Priority', 'Subject'],
          description: 'Creates a Case for an existing Account.',
        },
        deps: [], dependents: [],
      },
      {
        ref: {
          type: 'DataRaptor', matchingKey: 'DataRaptor/CreateCase', name: 'CreateCase',
          drType: 'Load', drOutputObjects: 'Case', drInputFields: ['Priority', 'Subject'],
        },
        deps: [], dependents: [],
      },
    ];

    expect(inferDataFlowEdges(nodes)).toEqual([expect.objectContaining({
      source: 'DataRaptor/CreateAccounts',
      target: 'DataRaptor/CreateCaseUsingAccount',
      outputObject: 'Account',
      inputField: 'AccountId',
      kind: 'recordId',
      sourceOperation: 'write',
      selectionPolicy: 'automaticSingle',
      edgeEvidenceScore: 0.95,
      ruleId: 'RID-EXACT-v1',
      calibrated: false,
    })]);
  });

  test('infers a queried Account Id handoff to a Load Data Mapper', () => {
    const nodes: HeadlessNode[] = [
      {
        ref: {
          type: 'DataRaptor', matchingKey: 'DataRaptor/GetAccounts', name: 'GetAccounts',
          drType: 'Extract', sourceObject: 'Account', drInputObjects: 'Account', drInputFields: ['Name'],
        },
        deps: [], dependents: [],
      },
      {
        ref: {
          type: 'DataRaptor', matchingKey: 'DataRaptor/CreateCaseUsingAccount', name: 'CreateCaseUsingAccount',
          drType: 'Load', drOutputObjects: 'Case', drInputFields: ['AccountId', 'Priority'],
        },
        deps: [], dependents: [],
      },
    ];

    const inferredEdges = inferDataFlowEdges(nodes);
    expect(inferredEdges).toEqual([expect.objectContaining({
      source: 'DataRaptor/GetAccounts',
      target: 'DataRaptor/CreateCaseUsingAccount',
      outputObject: 'Account',
      inputField: 'AccountId',
      sourceOperation: 'query',
      selectionPolicy: 'userSelectMultiple',
      ruleId: 'RID-QUERY-v1',
    })]);

    const prompt = buildFullGraphPrompt({
      nodes,
      inferredEdges,
      builtAt: '2026-08-11T00:00:00.000Z',
      orgUrl: 'https://example.my.salesforce.com',
    }, 'create a service request for Ishank');
    expect(prompt).toContain('execute/GetAccounts');
    expect(prompt).toContain('Input fields: Name');
    expect(prompt).toContain('CreateCaseUsingAccount.AccountId');
  });
});
