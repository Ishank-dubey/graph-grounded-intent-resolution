import { describe, expect, test } from 'bun:test';
import type { HeadlessGraph } from '../datapack/exporter.js';
import { buildExistingRecordCorrection, findExistingRecordConflict } from './planningGuard.js';

const graph: HeadlessGraph = {
  builtAt: '2026-08-11T00:00:00.000Z',
  orgUrl: 'https://example.my.salesforce.com',
  nodes: [
    {
      ref: {
        type: 'IntegrationProcedure', matchingKey: 'IntegrationProcedure/ishank/ishank/1',
        name: 'ishank/ishank', ipInvocationKey: 'ishank_ishank',
      },
      deps: ['DataRaptor/CreateAccounts', 'DataRaptor/CreateCase'], dependents: [],
    },
    {
      ref: {
        type: 'DataRaptor', matchingKey: 'DataRaptor/CreateAccounts', name: 'CreateAccounts',
        drType: 'Load', drOutputObjects: 'Account',
      },
      deps: [], dependents: ['IntegrationProcedure/ishank/ishank/1'],
    },
    {
      ref: {
        type: 'DataRaptor', matchingKey: 'DataRaptor/CreateCase', name: 'CreateCase',
        drType: 'Load', drOutputObjects: 'Case',
      },
      deps: [], dependents: ['IntegrationProcedure/ishank/ishank/1'],
    },
    {
      ref: {
        type: 'DataRaptor', matchingKey: 'DataRaptor/GetAccounts', name: 'GetAccounts',
        drType: 'Extract', sourceObject: 'Account', drInputFields: ['Name'],
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
  ],
  inferredEdges: [{
    source: 'DataRaptor/GetAccounts', target: 'DataRaptor/CreateCaseUsingAccount', kind: 'recordId',
    sourceOperation: 'query', selectionPolicy: 'userSelectMultiple',
    outputObject: 'Account', inputField: 'AccountId', edgeEvidenceScore: 0.95,
    ruleId: 'RID-QUERY-v1', calibrated: false,
    evidence: ['GetAccounts queries Account', 'CreateCaseUsingAccount accepts AccountId'],
  }],
};

describe('existing-record planning guard', () => {
  test('rejects an IP that creates a duplicate parent record', () => {
    const conflict = findExistingRecordConflict(
      graph,
      'create a service request for Ishank',
      [{ ipInvocationKey: 'ishank_ishank' }],
    );

    expect(conflict).toMatchObject({
      objectType: 'Account', queryBundle: 'GetAccounts',
      targetBundle: 'CreateCaseUsingAccount', targetField: 'AccountId',
    });
    expect(buildExistingRecordCorrection(conflict!)).toContain('Do not invoke ishank_ishank');
  });

  test('does not reject an explicit parent-creation intent', () => {
    expect(findExistingRecordConflict(
      graph,
      'create an account named Ishank',
      [{ ipInvocationKey: 'ishank_ishank' }],
    )).toBeNull();
  });
});
