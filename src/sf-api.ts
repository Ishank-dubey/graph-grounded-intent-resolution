// OmniStudio ships in three flavours, each with different object API names:
//   native      → OmniProcess, OmniUiCard, OmniDataTransform  (no namespace)
//   vlocity_cmt → vlocity_cmt__OmniProcess__c, …
//   vlocity_ins → vlocity_ins__OmniProcess__c, …
export type OmniNamespace = 'native' | 'vlocity_cmt' | 'vlocity_ins';

export function omniObjectName(base: 'OmniProcess' | 'OmniUiCard' | 'OmniDataTransform' | 'OmniProcessElement' | 'OmniDataTransformItem' | 'OmniProcessCompilation', ns: OmniNamespace): string {
  if (ns === 'native') return base;
  // Managed package: prefix__Base__c
  const map: Record<string, string> = {
    OmniProcess:            `${ns}__OmniProcess__c`,
    OmniProcessElement:     `${ns}__OmniProcessElement__c`,
    OmniProcessCompilation: `${ns}__OmniProcessCompilation__c`,
    OmniUiCard:             `${ns}__OmniUiCard__c`,
    OmniDataTransform:      `${ns}__OmniDataTransform__c`,
    OmniDataTransformItem:  `${ns}__OmniDataTransformItem__c`,
  };
  return map[base] ?? base;
}

// Field names that differ between native and managed
export function omniFieldName(field: string, ns: OmniNamespace): string {
  if (ns === 'native') return field;
  // All custom fields on managed objects have the namespace prefix
  // Standard fields (Id, Name, IsActive, LastModifiedDate) stay the same
  const standardFields = new Set(['Id', 'Name', 'IsActive', 'LastModifiedDate', 'VersionNumber']);
  if (standardFields.has(field)) return field;
  return `${ns}__${field}__c`;
}

/**
 * Module-level cache: orgDomain → latest API version string (e.g. "v69.0").
 * Persists across message handler invocations within the same service-worker
 * lifetime so we only call GET /services/data/ once per org per session.
 */
const orgApiVersionCache = new Map<string, string>();

export class SalesforceAPI {
  private readonly orgDomain: string;
  private readonly sid: string;
  private apiVersion: string;          // mutable — updated by detectLatestApiVersion()
  private _namespace: OmniNamespace | null = null;

  constructor(orgDomain: string, sid: string, apiVersion = 'v62.0') {
    this.orgDomain = orgDomain;
    this.sid = sid;
    // Use a previously-detected version for this domain if one is cached,
    // otherwise fall back to the caller-supplied value.
    this.apiVersion = orgApiVersionCache.get(orgDomain) ?? apiVersion;
  }

  /** Return the active API version string (e.g. "v69.0"). */
  getApiVersion(): string {
    return this.apiVersion;
  }

  /**
   * Probe GET /services/data/ (the public versions endpoint) to find the
   * highest API version this org supports, then cache and apply it.
   *
   * Call once after construction.  All subsequent requests — including the
   * OmniScript compile endpoint — automatically use the detected version.
   * Safe to call redundantly; the cache prevents extra network round-trips.
   */
  async detectLatestApiVersion(): Promise<void> {
    // Already resolved for this domain in this SW session
    if (orgApiVersionCache.has(this.orgDomain)) return;

    try {
      const resp = await fetch(`https://${this.orgDomain}/services/data/`, {
        headers: { Authorization: `Bearer ${this.sid}` },
      });
      if (!resp.ok) return;
      const versions = (await resp.json()) as Array<{ version: string }>;
      if (Array.isArray(versions) && versions.length > 0) {
        // Sort descending by numeric version, pick the highest
        const sorted = [...versions].sort(
          (a, b) => parseFloat(b.version) - parseFloat(a.version),
        );
        const latest = `v${sorted[0].version}`;
        orgApiVersionCache.set(this.orgDomain, latest);
        this.apiVersion = latest;
      }
    } catch (_) {
      // Network failure or parse error — keep the default/fallback version
    }
  }

  // Detect which OmniStudio namespace is installed by probing object existence.
  // Result is cached — only one API call per SalesforceAPI instance.
  async detectNamespace(): Promise<OmniNamespace> {
    if (this._namespace) return this._namespace;
    // Try native first (most common in modern orgs)
    for (const ns of ['native', 'vlocity_cmt', 'vlocity_ins'] as OmniNamespace[]) {
      try {
        const obj = omniObjectName('OmniProcess', ns);
        await this.request<unknown>('GET', `/services/data/${this.apiVersion}/sobjects/${obj}`);
        this._namespace = ns;
        return ns;
      } catch (_) {
        // 404 or error → try next
      }
    }
    // Default to native if nothing responds — SOQL will fail with a clear error
    this._namespace = 'native';
    return 'native';
  }

  // Convenience: get namespace, auto-detecting if needed
  async ns(): Promise<OmniNamespace> {
    return this.detectNamespace();
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown> | unknown,
  ): Promise<T> {
    const url = `https://${this.orgDomain}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.sid}`,
      'Content-Type': 'application/json',
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const resp = await fetch(url, init);

    // Allow 204 No Content (for PATCH responses) and 201 Created (INSERT).
    if (resp.status === 204 || resp.status === 404) {
      return undefined as unknown as T;
    }

    const text = await resp.text();

    if (!resp.ok) {
      const snippet = text.slice(0, 300);
      throw new Error(`SF API ${method} ${path} → ${resp.status}: ${snippet}`);
    }

    if (!text) return undefined as unknown as T;

    return JSON.parse(text) as T;
  }

  async queryAll<T>(soql: string): Promise<T[]> {
    const encoded = encodeURIComponent(soql);
    let path = `/services/data/${this.apiVersion}/query?q=${encoded}`;
    const results: T[] = [];

    while (true) {
      const data = await this.request<{
        records: T[];
        done: boolean;
        nextRecordsUrl?: string;
        totalSize?: number;
      }>('GET', path);

      // request() returns undefined for HTTP 404 — surface it as a real error
      // so callers get a clear message instead of a silent empty result.
      if (!data) {
        throw new Error('SOQL query returned no response (HTTP 404) — org session may have expired or the API version is unsupported');
      }

      results.push(...data.records);

      if (data.done || !data.nextRecordsUrl) break;

      // nextRecordsUrl may be a full URL or a relative path — normalise to path
      const next = data.nextRecordsUrl;
      path = next.startsWith('http') ? new URL(next).pathname + new URL(next).search : next;
    }

    return results;
  }

  async findOne<T>(soql: string): Promise<T | null> {
    const results = await this.queryAll<T>(soql);
    return results[0] ?? null;
  }

  async insert(sobjectType: string, record: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ id: string; success: boolean; errors: unknown[] }>(
      'POST',
      `/services/data/${this.apiVersion}/sobjects/${sobjectType}/`,
      record,
    );
    if (!result.success) {
      throw new Error(`Insert ${sobjectType} failed: ${JSON.stringify(result.errors)}`);
    }
    return result.id;
  }

  async update(sobjectType: string, id: string, record: Record<string, unknown>): Promise<void> {
    await this.request<void>(
      'PATCH',
      `/services/data/${this.apiVersion}/sobjects/${sobjectType}/${id}`,
      record,
    );
  }

  /**
   * Composite tree insert — inserts up to 200 records at once.
   * Returns an array of created IDs in the same order as the input records.
   *
   * Note: /composite/tree requires each record to have a unique `referenceId`.
   */
  /**
   * Call the Salesforce Einstein Generative AI Models API.
   *
   * Endpoint: POST /einstein/ai/v1/generations
   * Requires Einstein Generative AI enabled in the org (Spring '24+).
   * Uses the existing session — no extra API key.
   *
   * Returns the first generated text, or throws with a human-readable message.
   */
  async einsteinGenerate(prompt: string, model = 'sfdc_ai__DefaultGPT4Omni'): Promise<string> {
    type EinsteinResp = {
      generations?: Array<{ text: string }>;
      message?: string;
      errorCode?: string;
    };

    const resp = await this.request<EinsteinResp>(
      'POST',
      '/einstein/ai/v1/generations',
      {
        prompt,
        model,
        parameters: { max_tokens: 2048, temperature: 0.2 },
      },
    );

    if (resp.generations && resp.generations.length > 0) {
      return resp.generations[0].text;
    }

    // Surface any error message from Einstein
    if (resp.message) throw new Error(`Einstein: ${resp.message}`);
    if (resp.errorCode) throw new Error(`Einstein error: ${resp.errorCode}`);
    throw new Error('Einstein returned no generations');
  }

  /**
   * Trigger the OmniScript compile step after activation.
   *
   * When an OmniScript is activated via a direct REST PATCH ({ IsActive: true }), Salesforce
   * updates the flag but does NOT run the normal activation flow.  The designer (and runtime)
   * look up a pre-compiled JSON in the OmniProcessCompilation table; if that row is absent they
   * return "OmniScript definition not found".
   *
   * The fix is to call the Connect API build-json endpoint with scriptState="compile".  This
   * path runs compileBP() + updateBPDefTable() which writes the compiled JSON to
   * OmniProcessCompilation — identical to what the Salesforce UI does when you click Activate.
   *
   * Endpoint: POST /services/data/{version}/connect/omni-designer/os/build-json
   * Source:   OmniscriptBuildJsonResource.java → OmniScriptServiceImpl.compile()
   *
   * Returns null on success, or an error string describing what went wrong.
   * Never throws — callers treat a non-null return as a non-fatal warning.
   */
  async compileOmniScript(processId: string, language: string): Promise<string | null> {
    let resp: { result?: string } | undefined;
    try {
      // Body fields sent flat — NOT nested under a "buildJson" key.
      // The Java resource class deserialises the POST body directly into
      // its input record, so wrapping fields under any key causes
      // JSON_PARSER_ERROR: Unrecognized field "...".
      resp = await this.request<{ result?: string }>(
        'POST',
        `/services/data/${this.apiVersion}/connect/omni-designer/os/build-json`,
        {
          sId: processId,
          scriptState: 'compile',
          bPreview: true,
          multiLangCode: language ?? 'English',
        },
      );
    } catch (httpErr) {
      // HTTP 4xx / 5xx — endpoint missing, auth failure, etc.
      return httpErr instanceof Error ? httpErr.message : String(httpErr);
    }

    // request() returns undefined for HTTP 404 — endpoint not deployed in this org
    if (resp == null) {
      return 'Compile endpoint returned 404 — OmniScript may not be usable in the designer until manually re-activated there';
    }

    // The compile endpoint returns HTTP 200 even when compilation fails internally.
    // The actual outcome is encoded in resp.result as a JSON string with an "error" key.
    if (resp.result) {
      try {
        const parsed = JSON.parse(resp.result) as { error?: string };
        if (parsed.error && parsed.error !== 'OK') {
          return `Compilation error: ${parsed.error}`;
        }
      } catch (_parseErr) {
        // result is not JSON — treat as success (some orgs return raw content)
      }
    }

    return null; // success
  }

  /**
   * Execute an Integration Procedure via the OmniStudio Connect REST API.
   *
   * Endpoint:
   *   POST /services/data/{version}/connect/omnistudio/integrationprocedures/{Type}/{SubType}
   *
   * The `key` parameter must be in "Type_SubType" format (as stored in `ipInvocationKey`).
   * It is split on the first underscore to form the URL path segments.
   *
   * Returns the raw response object from the IP — structure depends on the IP itself.
   * Throws on HTTP error or if the key format is invalid.
   */
  async executeIntegrationProcedure(
    key: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sep = key.indexOf('_');
    if (sep === -1) throw new Error(`Invalid ipInvocationKey "${key}" — expected "Type_SubType"`);
    const ipType = key.slice(0, sep);
    const ipSubType = key.slice(sep + 1);
    const result = await this.request<Record<string, unknown>>(
      'POST',
      `/services/data/${this.apiVersion}/connect/omnistudio/integrationprocedures/${ipType}/${ipSubType}`,
      input,
    );
    return result;
  }

  /**
   * Execute a DataRaptor directly via the OmniStudio DataMapper REST API.
   *
   * Endpoint:
   *   POST /services/data/{version}/connect/omni-global/data-mapper/execute/{DATA_MAPPER_NAME}
   *
   * Input format differs by DR type:
   *   Load DRs   — inputs is an array of records: JSON.stringify([{ ...fields, bundleName: name }])
   *                shouldIgnoreCommit: false  (performs actual DML writes to Salesforce)
   *   Extract/Transform — inputs is a filter/param object: JSON.stringify({ ...fields })
   *                shouldIgnoreCommit: true   (read-only, no DML)
   *
   * Returns the raw DataMapper response object.
   * Throws on HTTP error.
   */
  async executeDataMapper(
    name: string,
    input: Record<string, unknown>,
    drType: string,
  ): Promise<NormalizedDataMapperResult> {
    const isLoad = drType.toLowerCase().includes('load');

    // Load DRs expect an array of records with bundleName in each entry.
    // Extract/Transform DRs expect a flat filter/input object.
    const inputPayload = isLoad
      ? JSON.stringify([{ ...input, bundleName: name }])
      : JSON.stringify(input);

    const body = {
      dataMapperInput: {
        inputs: [inputPayload],
      },
      inputType: 'JSON',
      options: {
        ignoreCache: true,
        shouldIgnoreCommit: !isLoad,
        shouldSendLegacyResponse: true,
      },
    };

    const raw = await this.request<Record<string, unknown>>(
      'POST',
      `/services/data/${this.apiVersion}/connect/omni-global/data-mapper/execute/${encodeURIComponent(name)}`,
      body,
    );
    const result = normalizeDataMapperResult(raw);
    if (!result.success) {
      throw new Error(result.error || `Data Mapper ${name} returned status ${result.status || 'Error'}`);
    }
    return result;
  }

  async compositeInsert(
    sobjectType: string,
    records: Record<string, unknown>[],
  ): Promise<string[]> {
    const ids: string[] = [];
    const BATCH = 200;

    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH).map((rec, idx) => ({
        ...rec,
        referenceId: `ref${i + idx}`,
      }));

      const result = await this.request<{
        hasErrors: boolean;
        results: Array<{ referenceId: string; id: string; errors?: unknown[] }>;
      }>(
        'POST',
        `/services/data/${this.apiVersion}/composite/tree/${sobjectType}`,
        { records: batch },
      );

      if (result.hasErrors) {
        const first = result.results.find((r) => r.errors && r.errors.length > 0);
        throw new Error(`compositeInsert ${sobjectType} error: ${JSON.stringify(first?.errors)}`);
      }

      ids.push(...result.results.map((r) => r.id));
    }

    return ids;
  }
}
import { normalizeDataMapperResult } from './headless/dataMapperResponse.js';
import type { NormalizedDataMapperResult } from './headless/dataMapperResponse.js';
