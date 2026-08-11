import { describe, expect, test } from 'bun:test';
import { normalizeDataMapperResult } from './dataMapperResponse.js';

describe('normalizeDataMapperResult', () => {
  test('extracts created record IDs from an encoded Load response', () => {
    const inner = {
      responseType: 'JSON',
      createdObjectsByType: { CreateAccounts: { Account: ['001-test'] } },
      hasErrors: false,
      drSObjectResults: {
        Account_1: [{ UpsertSObjectType: 'Account', Id: '001-test', UpsertSuccess: true, Name: 'Headless' }],
      },
      rolledBack: false,
      error: 'OK',
      statusCode: 200,
    };
    const encoded = JSON.stringify(inner).replace(/"/g, '&quot;');

    const result = normalizeDataMapperResult({ error: '', response: [encoded], status: 'Success' });

    expect(result.success).toBe(true);
    expect(result.createdIdsByObject.Account).toEqual(['001-test']);
    expect(result.records[0]).toMatchObject({ objectType: 'Account', id: '001-test', success: true });
  });

  test('surfaces a Data Mapper error hidden inside a successful HTTP response', () => {
    const inner = JSON.stringify({ hasErrors: true, error: 'Name is required', statusCode: 400 });
    const result = normalizeDataMapperResult({ error: '', response: [inner], status: 'Success' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Name is required');
  });

  test('extracts multiple queried Account records from a decoded Extract response', () => {
    const inner = {
      response: [{
        accounts: [
          { Id: '001-first', Name: 'IshankHeadless' },
          { Id: '001-second', Name: 'Ishank-headless-test' },
        ],
      }],
      hasErrors: false,
      error: 'OK',
      statusCode: 200,
    };

    const result = normalizeDataMapperResult({ error: '', response: [inner], status: 'Success' });

    expect(result.success).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.records).toEqual([
      { objectType: 'Account', id: '001-first', success: true, values: { Id: '001-first', Name: 'IshankHeadless' } },
      { objectType: 'Account', id: '001-second', success: true, values: { Id: '001-second', Name: 'Ishank-headless-test' } },
    ]);
  });

  test('extracts queried records from an HTML-encoded Extract response', () => {
    const inner = JSON.stringify({
      response: [{ accounts: [{ Id: '001-encoded', Name: 'Ishank' }] }],
      hasErrors: false,
      error: 'OK',
      statusCode: 200,
    }).replace(/"/g, '&quot;');

    const result = normalizeDataMapperResult({ error: '', response: [inner], status: 'Success' });

    expect(result.records[0]).toMatchObject({ objectType: 'Account', id: '001-encoded' });
  });

  test('recovers records when normalizing a previously normalized response envelope', () => {
    const original = {
      error: '',
      response: [JSON.stringify({
        response: [{ contacts: [{ Id: '003-first', Name: 'Pat' }, { Id: '003-second', Name: 'Patricia' }] }],
        hasErrors: false,
        error: 'OK',
        statusCode: 200,
      }).replace(/"/g, '&quot;')],
      status: 'Success',
    };
    const first = normalizeDataMapperResult(original);
    const recovered = normalizeDataMapperResult({
      error: first.error,
      response: first.response,
      status: first.status,
    });

    expect(recovered.records).toHaveLength(2);
    expect(recovered.records[0]).toMatchObject({ objectType: 'Contact', id: '003-first' });
  });

  test('rejects a standalone inner error even when the outer status is successful', () => {
    const result = normalizeDataMapperResult({
      error: '',
      response: [{ error: 'Account filter is invalid', statusCode: 200 }],
      status: 'Success',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Account filter is invalid');
  });
});
