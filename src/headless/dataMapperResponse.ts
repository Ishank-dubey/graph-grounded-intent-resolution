export interface DataMapperRecordResult {
  objectType: string;
  id?: string;
  success: boolean;
  values: Record<string, unknown>;
}

export interface NormalizedDataMapperResult {
  success: boolean;
  status: string;
  error: string;
  createdIdsByObject: Record<string, string[]>;
  records: DataMapperRecordResult[];
  response: unknown[];
  raw: Record<string, unknown>;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseResponseItem(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const decoded = decodeEntities(value);
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return decoded;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function addCreatedId(target: Record<string, string[]>, objectType: string, id: unknown): void {
  if (typeof id !== 'string' || !id) return;
  const ids = target[objectType] ?? [];
  if (!ids.includes(id)) ids.push(id);
  target[objectType] = ids;
}

function inferObjectType(container: string, row: Record<string, unknown>): string {
  const attributes = asRecord(row['attributes']);
  if (typeof attributes?.['type'] === 'string' && attributes['type']) return attributes['type'];
  if (typeof row['objectType'] === 'string' && row['objectType']) return row['objectType'];

  const singular = container.endsWith('ies')
    ? `${container.slice(0, -3)}y`
    : container.endsWith('s')
      ? container.slice(0, -1)
      : container;
  return singular ? singular[0].toUpperCase() + singular.slice(1) : 'Record';
}

function addRecord(
  records: DataMapperRecordResult[],
  seen: Set<string>,
  objectType: string,
  row: Record<string, unknown>,
  success = true,
): void {
  const id = row['Id'];
  const key = `${objectType.toLowerCase()}\x00${typeof id === 'string' ? id : JSON.stringify(row)}`;
  if (seen.has(key)) return;
  seen.add(key);
  records.push({
    objectType,
    ...(typeof id === 'string' ? { id } : {}),
    success,
    values: row,
  });
}

function collectReturnedRecords(
  value: unknown,
  records: DataMapperRecordResult[],
  seen: Set<string>,
  container = '',
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReturnedRecords(item, records, seen, container);
    return;
  }

  const row = asRecord(value);
  if (!row) return;
  if (typeof row['Id'] === 'string') {
    addRecord(records, seen, inferObjectType(container, row), row);
    return;
  }

  for (const [key, nested] of Object.entries(row)) {
    collectReturnedRecords(nested, records, seen, key);
  }
}

/**
 * Converts the Connect API envelope and its HTML-encoded legacy response into
 * stable records and object IDs that subsequent Data Mapper steps can consume.
 */
export function normalizeDataMapperResult(raw: Record<string, unknown>): NormalizedDataMapperResult {
  const response = Array.isArray(raw['response'])
    ? (raw['response'] as unknown[]).map(parseResponseItem)
    : [];
  const createdIdsByObject: Record<string, string[]> = {};
  const records: DataMapperRecordResult[] = [];
  const seenRecords = new Set<string>();
  const errors: string[] = [];
  let hasInnerError = false;

  const outerError = typeof raw['error'] === 'string' ? raw['error'].trim() : '';
  const status = typeof raw['status'] === 'string' ? raw['status'] : '';
  if (outerError) errors.push(outerError);
  if (status && status.toLowerCase() !== 'success') hasInnerError = true;

  for (const item of response) {
    const parsed = asRecord(item);
    if (!parsed) continue;

    if (parsed['hasErrors'] === true || parsed['rolledBack'] === true) hasInnerError = true;
    const statusCode = Number(parsed['statusCode']);
    if (Number.isFinite(statusCode) && statusCode >= 400) hasInnerError = true;
    const innerError = typeof parsed['error'] === 'string' ? parsed['error'].trim() : '';
    if (innerError && innerError.toLowerCase() !== 'ok') {
      errors.push(innerError);
      hasInnerError = true;
    }

    collectReturnedRecords(parsed['response'], records, seenRecords);

    const createdByType = asRecord(parsed['createdObjectsByType']);
    if (createdByType) {
      for (const bundleResult of Object.values(createdByType)) {
        const byObject = asRecord(bundleResult);
        if (!byObject) continue;
        for (const [objectType, ids] of Object.entries(byObject)) {
          if (Array.isArray(ids)) ids.forEach((id) => addCreatedId(createdIdsByObject, objectType, id));
        }
      }
    }

    const sObjectResults = asRecord(parsed['drSObjectResults']);
    if (!sObjectResults) continue;
    for (const [resultKey, rawRows] of Object.entries(sObjectResults)) {
      if (!Array.isArray(rawRows)) continue;
      for (const rawRow of rawRows) {
        const row = asRecord(rawRow);
        if (!row) continue;
        const objectType = typeof row['UpsertSObjectType'] === 'string'
          ? row['UpsertSObjectType']
          : resultKey.replace(/_\d+$/, '');
        const id = row['Id'];
        addCreatedId(createdIdsByObject, objectType, id);
        addRecord(records, seenRecords, objectType, row, row['UpsertSuccess'] !== false);
        if (row['UpsertSuccess'] === false) hasInnerError = true;
      }
    }
  }

  const success = status.toLowerCase() === 'success' && !outerError && !hasInnerError;
  return {
    success,
    status,
    error: errors.join('; '),
    createdIdsByObject,
    records,
    response,
    raw,
  };
}
