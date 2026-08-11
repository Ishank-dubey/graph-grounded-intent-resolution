import { SalesforceAPI, omniObjectName, omniFieldName } from '../sf-api.js';
import type { OmniNamespace } from '../sf-api.js';
import type {
  ComponentType,
  ComponentRef,
  IpStepInputMapping,
  OmniBundle,
  BundleEntry,
  OmniScriptRecord,
  OmniElementRecord,
  OmniUiCardRecord,
  OmniDataTransformRecord,
  OmniDataTransformItemRecord,
  PreflightResult,
} from '../types/bundle.js';
import { computeDependencies, scanElementForDeps, extractExternalRefs } from './dependency.js';
import { queryCompilations, parseCompilation } from './compilation.js';

function dedupeDeps(refs: ComponentRef[]): ComponentRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => { if (seen.has(r.matchingKey)) return false; seen.add(r.matchingKey); return true; });
}

export interface ExportOptions {
  includeDeps: boolean;
  activeOnly: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Record helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the `attributes` blob (added by SOQL API) and any key whose value is null.
 * Returns a shallow copy — does not mutate the input.
 */
function stripRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === 'attributes') continue;
    if (v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Strips managed-package namespace prefixes and __c suffix from field names
 * returned by SOQL on managed-package objects.
 *
 * Example:  "vlocity_cmt__Type__c" → "Type"
 *           "vlocity_cmt__IsIntegrationProcedure__c" → "IsIntegrationProcedure"
 *           "Id" / "Name" / "IsActive" → unchanged (no prefix)
 *
 * No-op when ns === 'native'.  Always skips the "attributes" blob added by
 * the SOQL API.
 */
function normalizeOmniRecord(row: Record<string, unknown>, ns: OmniNamespace): Record<string, unknown> {
  if (ns === 'native') return row;
  const prefix = `${ns}__`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'attributes') continue;
    if (k.startsWith(prefix) && k.endsWith('__c')) {
      // Strip "vlocity_cmt__" prefix and "__c" suffix
      const normalized = k.slice(prefix.length, -3);
      out[normalized] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listing helpers
// ─────────────────────────────────────────────────────────────────────────────

interface OmniProcessRow {
  Id: string;
  Name: string;
  Type: string;
  SubType: string;
  Language: string;
  VersionNumber: number;
  IsActive: boolean;
  IsIntegrationProcedure: boolean;
  LastModifiedDate: string;
  Description: string | null;
}

interface OmniUiCardRow {
  Id: string;
  Name: string;
  AuthorName: string;
  VersionNumber: number;
  IsActive: boolean;
  LastModifiedDate: string;
  Description: string | null;
  OmniUiCardType: string | null;
}

interface OmniDataTransformRow {
  Id: string;
  Name: string;
  VersionNumber: number;
  IsActive: boolean;
  LastModifiedDate: string;
  Description: string | null;
  /** Extract | Load | Transform | Turbo — the most important single DR field */
  Type: string | null;
  /** SObject used as input on a Load DR */
  SourceObject: string | null;
  /** JSON | XML | SObject */
  InputType: string | null;
  /** JSON | XML | SObject | PDF | Document */
  OutputType: string | null;
}

export async function listComponents(
  api: SalesforceAPI,
  type: ComponentType,
  activeOnly: boolean,
  ns: OmniNamespace = 'native',
): Promise<ComponentRef[]> {
  switch (type) {
    case 'OmniScript': {
      const obj   = omniObjectName('OmniProcess', ns);
      const fIP   = omniFieldName('IsIntegrationProcedure', ns);
      const fType = omniFieldName('Type', ns);
      const fSub  = omniFieldName('SubType', ns);
      const fLang = omniFieldName('Language', ns);
      const fDesc = omniFieldName('Description', ns);
      const rawRows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, Name, ${fType}, ${fSub}, ${fLang}, VersionNumber, IsActive, ${fDesc}, LastModifiedDate FROM ${obj} WHERE ${fIP} = false${activeOnly ? ' AND IsActive = true' : ''} ORDER BY ${fType}, ${fSub}`,
      );
      return rawRows.map((raw) => {
        const rec = normalizeOmniRecord(raw, ns) as unknown as OmniProcessRow;
        return {
          type: 'OmniScript' as ComponentType,
          matchingKey: `OmniScript/${rec.Type}/${rec.SubType}/${rec.Language}/${rec.VersionNumber}`,
          id: rec.Id,
          name: `${rec.Type}/${rec.SubType} (${rec.Language})`,
          version: rec.VersionNumber,
          isActive: rec.IsActive,
          ...(rec.Description ? { description: rec.Description } : {}),
        };
      });
    }

    case 'IntegrationProcedure': {
      const obj   = omniObjectName('OmniProcess', ns);
      const fIP   = omniFieldName('IsIntegrationProcedure', ns);
      const fType = omniFieldName('Type', ns);
      const fSub  = omniFieldName('SubType', ns);
      const fLang = omniFieldName('Language', ns);
      const fDesc = omniFieldName('Description', ns);
      const rawRows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, Name, ${fType}, ${fSub}, ${fLang}, VersionNumber, IsActive, ${fDesc}, LastModifiedDate FROM ${obj} WHERE ${fIP} = true${activeOnly ? ' AND IsActive = true' : ''} ORDER BY ${fType}, ${fSub}`,
      );
      return rawRows.map((raw) => {
        const rec = normalizeOmniRecord(raw, ns) as unknown as OmniProcessRow;
        return {
          type: 'IntegrationProcedure' as ComponentType,
          matchingKey: `IntegrationProcedure/${rec.Type}/${rec.SubType}/${rec.VersionNumber}`,
          id: rec.Id,
          name: `${rec.Type}/${rec.SubType}`,
          version: rec.VersionNumber,
          isActive: rec.IsActive,
          // ConnectAPI invocation key — used in integrationProcedureExecute()
          ipInvocationKey: `${rec.Type}_${rec.SubType}`,
          ...(rec.Description ? { description: rec.Description } : {}),
        };
      });
    }

    case 'OmniUiCard': {
      const obj       = omniObjectName('OmniUiCard', ns);
      const fAuthor   = omniFieldName('AuthorName', ns);
      const fCardType = omniFieldName('OmniUiCardType', ns);
      const fDesc     = omniFieldName('Description', ns);
      const rawRows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, Name, ${fAuthor}, VersionNumber, IsActive, ${fDesc}, ${fCardType}, LastModifiedDate FROM ${obj}${activeOnly ? ' WHERE IsActive = true' : ''} ORDER BY Name`,
      );
      return rawRows.map((raw) => {
        const rec = normalizeOmniRecord(raw, ns) as unknown as OmniUiCardRow;
        return {
          type: 'OmniUiCard' as ComponentType,
          matchingKey: `OmniUiCard/${rec.Name}/${rec.AuthorName}/${rec.VersionNumber}`,
          id: rec.Id,
          name: rec.Name,
          version: rec.VersionNumber,
          isActive: rec.IsActive,
          ...(rec.Description ? { description: rec.Description } : {}),
          ...(rec.OmniUiCardType ? { cardType: rec.OmniUiCardType } : {}),
        };
      });
    }

    case 'DataRaptor': {
      const obj        = omniObjectName('OmniDataTransform', ns);
      const fType      = omniFieldName('Type', ns);
      const fSrcObj    = omniFieldName('SourceObject', ns);
      const fInputType = omniFieldName('InputType', ns);
      const fOutType   = omniFieldName('OutputType', ns);
      const fDesc      = omniFieldName('Description', ns);
      const rawRows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, Name, VersionNumber, IsActive, ${fDesc}, ${fType}, ${fSrcObj}, ${fInputType}, ${fOutType}, LastModifiedDate FROM ${obj}${activeOnly ? ' WHERE IsActive = true' : ''} ORDER BY Name`,
      );
      return rawRows.map((raw) => {
        const rec = normalizeOmniRecord(raw, ns) as unknown as OmniDataTransformRow;
        return {
          type: 'DataRaptor' as ComponentType,
          matchingKey: `DataRaptor/${rec.Name}`,
          id: rec.Id,
          name: rec.Name,
          version: rec.VersionNumber,
          isActive: rec.IsActive,
          ...(rec.Description ? { description: rec.Description } : {}),
          ...(rec.Type         ? { drType:       rec.Type         } : {}),
          ...(rec.SourceObject ? { sourceObject: rec.SourceObject } : {}),
          ...(rec.InputType    ? { inputType:    rec.InputType    } : {}),
          ...(rec.OutputType   ? { outputType:   rec.OutputType   } : {}),
        };
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Build individual BundleEntry per component type
// ─────────────────────────────────────────────────────────────────────────────

async function buildEntryForOmniScript(
  api: SalesforceAPI,
  ref: ComponentRef,
): Promise<BundleEntry> {
  // 1. Query the process record — use only fields present in all Core orgs
  const processRaw = await api.findOne<Record<string, unknown>>(
    `SELECT Id, Name, Type, SubType, Language, VersionNumber, IsActive, IsIntegrationProcedure, Description, PropertySetConfig FROM OmniProcess WHERE Id = '${ref.id}'`,
  );

  if (!processRaw) {
    throw new Error(`OmniProcess not found: ${ref.id}`);
  }

  // 2. Query elements — core fields only
  const rawElements = await api.queryAll<Record<string, unknown>>(
    `SELECT Id, Name, Type, PropertySetConfig, ParentElementId, Level, SequenceNumber FROM OmniProcessElement WHERE OmniProcessId = '${ref.id}' ORDER BY Level, SequenceNumber`,
  );

  // 3. Strip attributes, remove nulls, set IsActive=false, remove Id
  const cleanProcess = stripRecord(processRaw);
  cleanProcess['IsActive'] = false; // always export inactive for safety
  delete cleanProcess['Id'];

  // 4. Build element records with _sourceId/_sourceParentId
  const elements: OmniElementRecord[] = rawElements.map((el) => {
    const clean = stripRecord(el);
    const sourceId = String(el['Id']);
    const sourceParentId = el['ParentElementId'] ? String(el['ParentElementId']) : null;
    delete clean['Id'];
    delete clean['OmniProcessId'];
    delete clean['ParentElementId'];
    return { _sourceId: sourceId, _sourceParentId: sourceParentId, ...clean } as OmniElementRecord;
  });

  // 5. Compute dependencies from process-level + element-level PropertySetConfig
  const processPsc = processRaw['PropertySetConfig'] as string | Record<string, unknown> | null | undefined;
  const deps = computeDependencies(rawElements, processPsc);

  // 6. Scan for external refs (Apex classes, LWC components) — informational only,
  //    stored in the bundle so preflight can warn when they are absent in target org.
  const externalRefs = extractExternalRefs(rawElements);

  return {
    type: ref.type,
    matchingKey: ref.matchingKey,
    exportedAt: new Date().toISOString(),
    process: cleanProcess as OmniScriptRecord,
    elements,
    dependencies: deps.map((d) => d.matchingKey),
    ...(externalRefs.length > 0 ? { externalRefs } : {}),
  };
}

async function buildEntryForOmniUiCard(
  api: SalesforceAPI,
  ref: ComponentRef,
): Promise<BundleEntry> {
  const recordRaw = await api.findOne<Record<string, unknown>>(
    `SELECT Id, Name, AuthorName, OmniUiCardType, VersionNumber, IsActive, Description, PropertySetConfig, DataSourceConfig FROM OmniUiCard WHERE Id = '${ref.id}'`,
  );

  if (!recordRaw) {
    throw new Error(`OmniUiCard not found: ${ref.id}`);
  }

  const clean = stripRecord(recordRaw);
  clean['IsActive'] = false;
  delete clean['Id'];

  // Scan PropertySetConfig + DataSourceConfig for deps
  // PropertySetConfig is the main card config (actions, components, DR/IP/OS refs)
  // DataSourceConfig holds data-loading configuration and may also reference DRs
  const psc = recordRaw['PropertySetConfig'] as string | Record<string, unknown> | null | undefined;
  const dsc = recordRaw['DataSourceConfig'] as string | Record<string, unknown> | null | undefined;
  const deps = dedupeDeps([
    ...scanElementForDeps(psc),
    ...scanElementForDeps(dsc),
  ]);

  return {
    type: ref.type,
    matchingKey: ref.matchingKey,
    exportedAt: new Date().toISOString(),
    card: clean as OmniUiCardRecord,
    dependencies: deps.map((d) => d.matchingKey),
  };
}

async function buildEntryForDataRaptor(
  api: SalesforceAPI,
  ref: ComponentRef,
): Promise<BundleEntry> {
  const transformRaw = await api.findOne<Record<string, unknown>>(
    `SELECT Id, Name, Type, VersionNumber, IsActive, Description, InputType, OutputType, SourceObject, GlobalKey, UniqueName, Namespace, RequiredPermission, OverrideKey FROM OmniDataTransform WHERE Id = '${ref.id}'`,
  );

  if (!transformRaw) {
    throw new Error(`OmniDataTransform not found: ${ref.id}`);
  }

  const rawItems = await api.queryAll<Record<string, unknown>>(
    `SELECT Id, Name, OmniDataTransformationId, GlobalKey,` +
    ` InputObjectName, InputObjectQuerySequence, InputFieldName,` +
    ` OutputObjectName, OutputCreationSequence, OutputFieldName, OutputFieldFormat,` +
    ` DefaultValue, TransformValueMappings,` +
    ` IsDisabled, IsUpsertKey, IsRequiredForUpsert,` +
    ` LinkedFieldName, LinkedObjectSequence,` +
    ` LookupByFieldName, LookupObjectName, LookupReturnedFieldName,` +
    ` FilterDataType, FilterGroup, FilterOperator, FilterValue,` +
    ` FormulaExpression, FormulaConverted, FormulaResultPath, FormulaSequence,` +
    ` MigrationAttribute, MigrationCategory, MigrationGroup, MigrationKey,` +
    ` MigrationPattern, MigrationProcess, MigrationType, MigrationValue` +
    ` FROM OmniDataTransformItem WHERE OmniDataTransformationId = '${ref.id}' ORDER BY Name`,
  );

  const cleanTransform = stripRecord(transformRaw);
  cleanTransform['IsActive'] = false;
  delete cleanTransform['Id'];

  const transformItems: OmniDataTransformItemRecord[] = rawItems.map((item) => {
    const clean = stripRecord(item);
    delete clean['Id'];
    delete clean['OmniDataTransformationId'];
    return clean as OmniDataTransformItemRecord;
  });

  return {
    type: ref.type,
    matchingKey: ref.matchingKey,
    exportedAt: new Date().toISOString(),
    transform: cleanTransform as OmniDataTransformRecord,
    transformItems,
    dependencies: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight check
// ─────────────────────────────────────────────────────────────────────────────

export async function preflight(
  api: SalesforceAPI,
  bundle: OmniBundle,
): Promise<PreflightResult[]> {
  const results: PreflightResult[] = [];

  for (const entry of bundle.entries) {
    try {
      const result = await preflightEntry(api, entry);
      results.push(result);
    } catch (err) {
      results.push({
        matchingKey: entry.matchingKey,
        action: 'create',
        targetVersion: 1,
        existingVersions: [],
        activeVersion: null,
        displayName: entry.matchingKey,
      });
    }
  }

  return results;
}

async function preflightEntry(
  api: SalesforceAPI,
  entry: BundleEntry,
): Promise<PreflightResult> {
  const mk = entry.matchingKey;

  switch (entry.type) {
    case 'OmniScript':
    case 'IntegrationProcedure': {
      const proc = (entry.process ?? {}) as Partial<OmniScriptRecord>;
      const type = proc.Type as string;
      const subType = proc.SubType as string;
      const lang = proc.Language ?? 'English';
      const isIP = entry.type === 'IntegrationProcedure';

      const rows = await api.queryAll<{ VersionNumber: number; IsActive: boolean }>(
        `SELECT VersionNumber, IsActive FROM OmniProcess WHERE Type = '${type}' AND SubType = '${subType}' AND Language = '${lang}' AND IsIntegrationProcedure = ${isIP} ORDER BY VersionNumber ASC`,
      );

      const existingVersions = rows.map((r) => r.VersionNumber);
      const activeVersion = rows.find((r) => r.IsActive)?.VersionNumber ?? null;
      const maxVer = existingVersions.length > 0 ? Math.max(...existingVersions) : 0;
      const targetVersion = maxVer + 1;
      const displayName = isIP
        ? `IntegrationProcedure/${type}/${subType}/${lang}`
        : `OmniScript/${type}/${subType}/${lang}`;

      // ── Check external references in target org ────────────────────────────
      // Apex classes and LWC components referenced in elements cannot be
      // imported by this tool — warn if they are absent in the target org so
      // the user knows those actions will fail at runtime.
      const warnings: string[] = [];
      if (entry.externalRefs && entry.externalRefs.length > 0) {
        const apexNames = entry.externalRefs
          .filter((r) => r.kind === 'ApexClass')
          .map((r) => r.name);
        const lwcNames = entry.externalRefs
          .filter((r) => r.kind === 'LWC')
          .map((r) => r.name);

        if (apexNames.length > 0) {
          try {
            const inList = apexNames.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(',');
            const found = await api.queryAll<{ Name: string }>(
              `SELECT Name FROM ApexClass WHERE Name IN (${inList})`,
            );
            const foundSet = new Set(found.map((r) => r.Name));
            for (const name of apexNames) {
              if (!foundSet.has(name)) {
                warnings.push(`Apex class '${name}' not found in target org — Remote Action elements referencing it will fail at runtime.`);
              }
            }
          } catch (_) { /* ApexClass may not be queryable — skip */ }
        }

        if (lwcNames.length > 0) {
          try {
            const inList = lwcNames.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(',');
            const found = await api.queryAll<{ ApiName: string }>(
              `SELECT ApiName FROM LightningComponentBundle WHERE ApiName IN (${inList})`,
            );
            const foundSet = new Set(found.map((r) => r.ApiName));
            for (const name of lwcNames) {
              if (!foundSet.has(name)) {
                warnings.push(`LWC component '${name}' not found in target org — Custom LWC elements referencing it will fail at runtime.`);
              }
            }
          } catch (_) { /* LightningComponentBundle may not be queryable — skip */ }
        }
      }

      return {
        matchingKey: mk,
        action: 'create',
        targetVersion,
        existingVersions,
        activeVersion,
        displayName,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    case 'OmniUiCard': {
      const card = (entry.card ?? {}) as Partial<OmniUiCardRecord>;
      const name = card.Name as string;
      const author = card.AuthorName ?? '';

      const rows = await api.queryAll<{ VersionNumber: number; IsActive: boolean }>(
        `SELECT VersionNumber, IsActive FROM OmniUiCard WHERE Name = '${name}' AND AuthorName = '${author}' ORDER BY VersionNumber ASC`,
      );

      const existingVersions = rows.map((r) => r.VersionNumber);
      const activeVersion = rows.find((r) => r.IsActive)?.VersionNumber ?? null;
      const maxVer = existingVersions.length > 0 ? Math.max(...existingVersions) : 0;
      const targetVersion = maxVer + 1;

      return { matchingKey: mk, action: 'create', targetVersion, existingVersions, activeVersion, displayName: `OmniUiCard/${name}` };
    }

    case 'DataRaptor': {
      const transform = (entry.transform ?? {}) as Partial<OmniDataTransformRecord>;
      const name = transform.Name as string;

      // DataRaptor: VersionNumber exists on OmniDataTransform too
      const rows = await api.queryAll<{ VersionNumber: number; IsActive: boolean }>(
        `SELECT VersionNumber, IsActive FROM OmniDataTransform WHERE Name = '${name}' ORDER BY VersionNumber ASC`,
      );

      const existingVersions = rows.map((r) => r.VersionNumber).filter((v) => v != null);
      const activeVersion = rows.find((r) => r.IsActive)?.VersionNumber ?? null;
      const maxVer = existingVersions.length > 0 ? Math.max(...existingVersions) : 0;
      const targetVersion = maxVer + 1;

      return { matchingKey: mk, action: 'create', targetVersion, existingVersions, activeVersion, displayName: `DataRaptor/${name}` };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export function — BFS over the dependency graph
// ─────────────────────────────────────────────────────────────────────────────

export async function exportComponents(
  api: SalesforceAPI,
  components: ComponentRef[],
  opts: ExportOptions,
  orgUrl: string,
): Promise<OmniBundle> {
  const visited = new Set<string>();
  const queue: ComponentRef[] = [...components];
  const entries: BundleEntry[] = [];

  // Lazy cache for resolving matchingKey → ComponentRef with id
  const refCache = new Map<string, ComponentRef[]>();

  async function getRefByMatchingKey(matchingKey: string, type: ComponentType): Promise<ComponentRef | null> {
    if (!refCache.has(type)) {
      const all = await listComponents(api, type, false);
      refCache.set(type, all);
    }
    const list = refCache.get(type) ?? [];

    // Exact match (most cases — DataRaptor keys include no version suffix)
    const exact = list.find((r) => r.matchingKey === matchingKey);
    if (exact) return exact;

    // Prefix match: dep scanner returns "OmniScript/Type/SubType" or
    // "IntegrationProcedure/Type/SubType" without language/version suffix.
    // Real matchingKeys include all parts: OmniScript/Type/SubType/English/3.
    // Pick the ACTIVE version first; fall back to the highest version number.
    const lower = matchingKey.toLowerCase();
    const matches = list.filter((r) => {
      const rLower = r.matchingKey.toLowerCase();
      return rLower === lower || rLower.startsWith(lower + '/');
    });
    if (matches.length === 0) return null;
    const active = matches.find((r) => r.isActive);
    if (active) return active;
    return matches.sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
  }

  while (queue.length > 0) {
    const ref = queue.shift()!;
    if (visited.has(ref.matchingKey)) continue;
    visited.add(ref.matchingKey);

    // Ensure we have an Id
    let resolvedRef = ref;
    if (!resolvedRef.id) {
      const found = await getRefByMatchingKey(resolvedRef.matchingKey, resolvedRef.type);
      if (!found) {
        // Dependency not found in this org — record an empty entry
        entries.push({
          type: ref.type,
          matchingKey: ref.matchingKey,
          exportedAt: new Date().toISOString(),
          dependencies: [],
        });
        continue;
      }
      resolvedRef = found;
    }

    let entry: BundleEntry;
    try {
      switch (resolvedRef.type) {
        case 'OmniScript':
        case 'IntegrationProcedure':
          entry = await buildEntryForOmniScript(api, resolvedRef);
          break;
        case 'OmniUiCard':
          entry = await buildEntryForOmniUiCard(api, resolvedRef);
          break;
        case 'DataRaptor':
          entry = await buildEntryForDataRaptor(api, resolvedRef);
          break;
      }
    } catch (err) {
      // Re-throw with context so the caller surfaces a real error message
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to export ${resolvedRef.matchingKey}: ${msg}`);
    }

    entries.push(entry);

    // Queue dependencies for BFS expansion if requested
    if (opts.includeDeps) {
      for (const depKey of entry.dependencies) {
        if (!visited.has(depKey)) {
          // Infer type from matching key prefix
          const depType = inferTypeFromMatchingKey(depKey);
          if (depType) {
            queue.push({ type: depType, matchingKey: depKey, name: depKey });
          }
        }
      }
    }
  }

  return {
    formatVersion: '2.0',
    exportDate: new Date().toISOString(),
    exportOrg: orgUrl,
    entries,
  };
}

function inferTypeFromMatchingKey(matchingKey: string): ComponentType | null {
  if (matchingKey.startsWith('OmniScript/')) return 'OmniScript';
  if (matchingKey.startsWith('IntegrationProcedure/')) return 'IntegrationProcedure';
  if (matchingKey.startsWith('OmniUiCard/')) return 'OmniUiCard';
  if (matchingKey.startsWith('DataRaptor/')) return 'DataRaptor';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Headless Graph builder
//
// Fetches all 4 component types in parallel, scans every PropertySetConfig /
// Definition blob for dependency field references, and resolves raw dep keys
// (from the scanner) against the real matchingKey set.  Unresolved deps
// (components that exist only as file-based metadata and have no DB row) are
// kept as "external" nodes so the graph is still complete.
// ─────────────────────────────────────────────────────────────────────────────

export interface HeadlessNode {
  ref: ComponentRef;
  /** matchingKeys of dependencies (may include external keys not in nodes) */
  deps: string[];
  /** matchingKeys of things that depend on this node (reverse edges) */
  dependents: string[];
}

export interface InferredDataFlowEdge {
  /** Data Mapper that returns or creates the record ID */
  source: string;
  /** Data Mapper that can consume the record ID */
  target: string;
  kind: 'recordId';
  /** Whether the source returns existing records or creates new records. */
  sourceOperation: 'query' | 'write';
  /** Multiple query matches require an explicit user choice before binding. */
  selectionPolicy: 'automaticSingle' | 'userSelectMultiple';
  outputObject: string;
  inputField: string;
  /** Fixed rule evidence strength, not a calibrated probability. */
  edgeEvidenceScore: number;
  ruleId: 'RID-EXACT-v1' | 'RID-QUERY-v1';
  calibrated: false;
  evidence: string[];
}

export interface HeadlessGraph {
  nodes: HeadlessNode[];
  /** Contract-compatible edges inferred from DR outputs to DR inputs, never authored dependencies */
  inferredEdges?: InferredDataFlowEdge[];
  /** ISO timestamp */
  builtAt: string;
  /** Org URL the graph was built from */
  orgUrl: string;
}

function splitSchemaNames(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * Infers exact-name record-ID handoffs between directly callable Data Mappers.
 * A Data Mapper that creates or queries an object can feed a later matching ID input.
 * These edges are candidates for planning, not proof of an authored workflow.
 */
export function inferDataFlowEdges(nodes: HeadlessNode[]): InferredDataFlowEdge[] {
  const producers = nodes.filter((node) =>
    node.ref.type === 'DataRaptor' &&
    ['load', 'extract'].some((type) => (node.ref.drType ?? '').toLowerCase().includes(type)),
  );
  const consumers = nodes.filter((node) =>
    node.ref.type === 'DataRaptor' &&
    (node.ref.drType ?? '').toLowerCase().includes('load'),
  );
  const edges: InferredDataFlowEdge[] = [];
  const seen = new Set<string>();

  for (const producer of producers) {
    const isQuery = (producer.ref.drType ?? '').toLowerCase().includes('extract');
    const outputObjects = isQuery
      ? splitSchemaNames(producer.ref.sourceObject || producer.ref.drInputObjects)
      : splitSchemaNames(producer.ref.drOutputObjects);
    for (const outputObject of outputObjects) {
      const expectedInput = `${outputObject.replace(/__c$/i, '')}Id`;
      for (const consumer of consumers) {
        if (consumer.ref.matchingKey === producer.ref.matchingKey) continue;
        const inputField = consumer.ref.drInputFields?.find(
          (field) => field.toLowerCase() === expectedInput.toLowerCase(),
        );
        if (!inputField) continue;
        const edgeKey = `${producer.ref.matchingKey}\x00${consumer.ref.matchingKey}\x00${inputField}`;
        if (seen.has(edgeKey)) continue;
        seen.add(edgeKey);
        const evidence = [
          `${producer.ref.name} ${isQuery ? 'queries' : 'writes'} ${outputObject}`,
          `${consumer.ref.name} accepts ${inputField}`,
        ];
        const description = consumer.ref.description || consumer.ref.aiDescription;
        if (description) evidence.push(`Consumer description: ${description}`);
        edges.push({
          source: producer.ref.matchingKey,
          target: consumer.ref.matchingKey,
          kind: 'recordId',
          sourceOperation: isQuery ? 'query' : 'write',
          selectionPolicy: isQuery ? 'userSelectMultiple' : 'automaticSingle',
          outputObject,
          inputField,
          edgeEvidenceScore: 0.95,
          ruleId: isQuery ? 'RID-QUERY-v1' : 'RID-EXACT-v1',
          calibrated: false,
          evidence,
        });
      }
    }
  }
  return edges;
}

// ─────────────────────────────────────────────────────────────────────────────
// IP element step summariser
//
// Parses OmniProcessElement rows for an IP and produces a compact one-liner
// suitable for inclusion in the LLM prompt, e.g.:
//   "Steps (4): HTTP-GET /api/credit, DR-Extract AccountProfile,
//    Conditional: creditScore<600, Set: rating=A"
//
// Element types (from PropertySetConfig.type or Name) we recognise:
//   "HTTP Action"         → HTTP-{method} {endpoint}
//   "DataRaptor Action"   → DR-{drType} {bundle}
//   "Integration Procedure" → IP-Call {ipKey}
//   "Conditional"         → Conditional: {condition snippet}
//   "Loop"                → Loop
//   "Assignment"/"Set"    → Set
//   "Response Action"     → Response
//   (others)              → {raw type}
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produces a compact summary of an OmniScript's step structure.
 * Level-1 elements are Step/Group containers whose Name is user-visible.
 * Level-2 elements are the action elements inside each step.
 *
 * Example output:
 *   "3 steps: PersonalInfo, AddressDetails, Review (+Apex:BillingService, DR:AccountLoad)"
 */
function summariseOsElements(elements: Array<Record<string, unknown>>): string | undefined {
  if (elements.length === 0) return undefined;

  const stepNames: string[] = [];
  const actionSet = new Set<string>();

  for (const elem of elements) {
    const level = (elem['Level'] as number | null) ?? 1;
    const elemType = (elem['Type'] as string | null)?.trim() ?? '';
    const name = (elem['Name'] as string | null)?.trim() ?? '';
    const lower = elemType.toLowerCase();

    let psc: Record<string, unknown> | null = null;
    try {
      const raw = elem['PropertySetConfig'];
      if (typeof raw === 'string') psc = JSON.parse(raw) as Record<string, unknown>;
      else if (raw && typeof raw === 'object') psc = raw as Record<string, unknown>;
    } catch (_) { /* ignore */ }

    if (level === 1) {
      // Top-level containers: Step, Group, Block, Navigation step
      if (['step', 'group', 'block', 'navigation'].includes(lower) || lower.endsWith('step')) {
        if (name && !stepNames.includes(name)) stepNames.push(name.slice(0, 40));
      }
    } else {
      // Action elements inside steps — collect notable external references
      if (lower.includes('remote') || lower === 'apex' || lower.includes('apex action') || lower.includes('apex call')) {
        const cls = ((psc?.['className'] as string | undefined) ?? (psc?.['sClassName'] as string | undefined) ?? '').slice(0, 30);
        actionSet.add(cls ? `Apex:${cls}` : 'Apex');
      } else if (lower.includes('dataraptor') || lower === 'dr' || lower.includes('data raptor')) {
        const bundle = ((psc?.['bundle'] as string | undefined) ?? (psc?.['bundleName'] as string | undefined) ?? '').slice(0, 30);
        actionSet.add(bundle ? `DR:${bundle}` : 'DR');
      } else if (lower.includes('integration procedure') || lower === 'ip' || lower.includes('ip call')) {
        const key = ((psc?.['integrationProcedureKey'] as string | undefined) ?? (psc?.['ipKey'] as string | undefined) ?? '').slice(0, 30);
        actionSet.add(key ? `IP:${key}` : 'IP');
      } else if (lower === 'omniscript' || lower.includes('child omniscript') || lower.includes('child script')) {
        const script = ((psc?.['scriptName'] as string | undefined) ?? (psc?.['omniScriptName'] as string | undefined) ?? '').slice(0, 30);
        actionSet.add(script ? `Child:${script}` : 'ChildOS');
      } else if (lower === 'lwc' || lower.includes('custom lwc') || lower.includes('lightning component')) {
        const comp = ((psc?.['componentName'] as string | undefined) ?? (psc?.['lwcName'] as string | undefined) ?? '').slice(0, 30);
        actionSet.add(comp ? `LWC:${comp}` : 'LWC');
      }
    }
  }

  if (stepNames.length === 0) return undefined;

  const shown = stepNames.slice(0, 6);
  const ellipsis = stepNames.length > 6 ? ' …' : '';
  const stepsStr = `${stepNames.length} step${stepNames.length !== 1 ? 's' : ''}: ${shown.join(', ')}${ellipsis}`;
  const actions = Array.from(actionSet).slice(0, 5);
  const actionsStr = actions.length > 0 ? ` (+${actions.join(', ')})` : '';
  return stepsStr + actionsStr;
}

function summariseIpElements(elements: Array<Record<string, unknown>>): string | undefined {
  if (elements.length === 0) return undefined;

  const snippets: string[] = [];
  for (const elem of elements) {
    // Ignore Level > 1 children to keep the summary flat + manageable
    const level = (elem['Level'] as number | null) ?? 1;
    if (level > 1) continue;

    const elemType = (elem['Type'] as string | null)?.trim() ?? '';
    let psc: Record<string, unknown> | null = null;
    try {
      const raw = elem['PropertySetConfig'];
      if (typeof raw === 'string') psc = JSON.parse(raw) as Record<string, unknown>;
      else if (raw && typeof raw === 'object') psc = raw as Record<string, unknown>;
    } catch (_) { /* ignore */ }

    const lower = elemType.toLowerCase();

    if (lower.includes('http') || lower === 'remote action') {
      // HTTP callout — extract method + endpoint
      const method = (psc?.['httpMethod'] as string || psc?.['method'] as string || 'HTTP').toUpperCase();
      const path = (psc?.['url'] as string || psc?.['path'] as string || psc?.['endpoint'] as string || '').split('?')[0].slice(0, 60);
      snippets.push(path ? `${method} ${path}` : `${method}-Action`);
    } else if (lower.includes('dataraptor') || lower.includes('data raptor') || lower === 'dr') {
      const bundle = (psc?.['bundle'] as string || psc?.['bundleName'] as string || '').slice(0, 40);
      const drType = (psc?.['type'] as string || '').slice(0, 12);
      snippets.push(bundle ? `DR-${drType || 'Action'} ${bundle}` : `DR-${drType || 'Action'}`);
    } else if (lower.includes('integration procedure') || lower === 'ip call') {
      const ipKey = (psc?.['integrationProcedureKey'] as string || psc?.['ipKey'] as string || '').slice(0, 40);
      snippets.push(ipKey ? `IP-Call ${ipKey}` : 'IP-Call');
    } else if (lower === 'conditional' || lower.includes('condition')) {
      // Try to get a tiny condition expression
      const cond = (psc?.['conditionLogic'] as string || psc?.['condition'] as string || '').slice(0, 40);
      snippets.push(cond ? `Conditional: ${cond}` : 'Conditional');
    } else if (lower === 'loop') {
      snippets.push('Loop');
    } else if (lower === 'set' || lower === 'assignment' || lower === 'setvariable') {
      snippets.push('Set');
    } else if (lower === 'response') {
      snippets.push('Response');
    } else if (elemType) {
      snippets.push(elemType.slice(0, 20));
    }
  }

  if (snippets.length === 0) return undefined;
  // Cap at 6 steps in the summary to keep prompts readable
  const shown = snippets.slice(0, 6);
  const suffix = snippets.length > 6 ? ` (+${snippets.length - 6} more)` : '';
  return `Steps (${snippets.length}): ${shown.join(', ')}${suffix}`;
}

export async function buildHeadlessGraph(
  api: SalesforceAPI,
  orgUrl: string,
): Promise<HeadlessGraph> {
  // ── 0. Detect namespace once — 'native', 'vlocity_cmt', or 'vlocity_ins' ──
  // All SOQL in this function uses omniObjectName/omniFieldName so that
  // managed-package orgs (vlocity_cmt / vlocity_ins) return results correctly.
  // normalizeOmniRecord strips namespace prefixes from all returned rows so
  // downstream code (summariseIpElements, computeDependencies, etc.) always
  // reads standard field names regardless of org type.
  const ns = await api.ns();
  // Shorthands to keep query strings readable
  const op  = (base: Parameters<typeof omniObjectName>[0]) => omniObjectName(base, ns);
  const f   = (field: string) => omniFieldName(field, ns);
  const nrm = (row: Record<string, unknown>) => normalizeOmniRecord(row, ns);

  // ── 1. Fetch all component refs in parallel ────────────────────────────────
  const [osRefs, ipRefs, cardRefs, drRefs] = await Promise.all([
    listComponents(api, 'OmniScript', false, ns),
    listComponents(api, 'IntegrationProcedure', false, ns),
    listComponents(api, 'OmniUiCard', false, ns),
    listComponents(api, 'DataRaptor', false, ns),
  ]);

  const allRefs: ComponentRef[] = [...osRefs, ...ipRefs, ...cardRefs, ...drRefs];
  const knownKeys = new Set(allRefs.map((r) => r.matchingKey));
  const idToRef = new Map(allRefs.filter((r) => r.id).map((r) => [r.id!, r]));

  // ── 2. Fetch elements for all OmniProcess records (OS + IP) in parallel ───
  // We chunk into batches of 200 IDs to stay under SOQL IN limits
  const processIds = [...osRefs, ...ipRefs].map((r) => r.id).filter((id): id is string => !!id);

  const CHUNK = 200;
  const elementChunks: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < processIds.length; i += CHUNK) {
    const chunk = processIds.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    const rows = await api.queryAll<Record<string, unknown>>(
      `SELECT ${f('OmniProcessId')}, ${f('Type')}, ${f('Level')}, ${f('SequenceNumber')}, ${f('PropertySetConfig')} FROM ${op('OmniProcessElement')} WHERE ${f('OmniProcessId')} IN (${idList}) ORDER BY ${f('Level')}, ${f('SequenceNumber')}`,
    );
    elementChunks.push(rows.map(nrm));
  }

  // Group elements by OmniProcessId
  const elementsByProcess = new Map<string, Array<Record<string, unknown>>>();
  for (const chunk of elementChunks) {
    for (const row of chunk) {
      const pid = row['OmniProcessId'] as string;
      if (!elementsByProcess.has(pid)) elementsByProcess.set(pid, []);
      elementsByProcess.get(pid)!.push(row);
    }
  }

  // Also fetch process-level PropertySetConfig + Description for each OS/IP
  const processChunks: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < processIds.length; i += CHUNK) {
    const chunk = processIds.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    const rows = await api.queryAll<Record<string, unknown>>(
      `SELECT Id, ${f('PropertySetConfig')}, ${f('Description')} FROM ${op('OmniProcess')} WHERE Id IN (${idList})`,
    );
    processChunks.push(rows.map(nrm));
  }
  const processPscById = new Map<string, string | Record<string, unknown> | null>();
  const processDescById = new Map<string, string>();
  for (const chunk of processChunks) {
    for (const row of chunk) {
      const id = row['Id'] as string;
      processPscById.set(id, row['PropertySetConfig'] as string | Record<string, unknown> | null);
      if (row['Description']) processDescById.set(id, row['Description'] as string);
    }
  }

  // ── Fetch AiGeneratedDescription + IP typed I/O (minApi 256/264 — guarded) ─
  // These fields may not exist on older orgs/API versions — we try and silently skip.
  const processAiDescById = new Map<string, string>();
  const ipInputById = new Map<string, string>();
  const ipOutputById = new Map<string, string>();
  const ipIds = ipRefs.map((r) => r.id).filter((id): id is string => !!id);
  const allProcessIds = [...processIds]; // OS + IP

  try {
    // AiGeneratedDescription — minApi 264 — query all OmniProcess
    const fAi = f('AiGeneratedDescription');
    for (let i = 0; i < allProcessIds.length; i += CHUNK) {
      const chunk = allProcessIds.slice(i, i + CHUNK);
      const idList = chunk.map((id) => `'${id}'`).join(',');
      const rows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, ${fAi} FROM ${op('OmniProcess')} WHERE Id IN (${idList}) AND ${fAi} != null`,
      );
      for (const rawRow of rows) {
        const row = nrm(rawRow);
        if (row['AiGeneratedDescription']) {
          processAiDescById.set(row['Id'] as string, row['AiGeneratedDescription'] as string);
        }
      }
    }
  } catch (_) { /* field not available on this org — skip */ }

  try {
    // IntegrationProcedureInput/Output — minApi 256 — IP only
    const fIn  = f('IntegrationProcedureInput');
    const fOut = f('IntegrationProcedureOutput');
    for (let i = 0; i < ipIds.length; i += CHUNK) {
      const chunk = ipIds.slice(i, i + CHUNK);
      const idList = chunk.map((id) => `'${id}'`).join(',');
      const rows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, ${fIn}, ${fOut} FROM ${op('OmniProcess')} WHERE Id IN (${idList})`,
      );
      for (const rawRow of rows) {
        const row = nrm(rawRow);
        const id = row['Id'] as string;
        if (row['IntegrationProcedureInput'])  ipInputById.set(id,  row['IntegrationProcedureInput']  as string);
        if (row['IntegrationProcedureOutput']) ipOutputById.set(id, row['IntegrationProcedureOutput'] as string);
      }
    }
  } catch (_) { /* field not available on this org — skip */ }

  // ── 2b. Fetch OmniProcessCompilation trees (preferred enrichment source) ────
  // Compilation records contain the fully-resolved step tree with per-step
  // additionalInput maps — the source of ipStepInputMappings for NLP slot-filling.
  // Silently returns an empty map if the object doesn't exist on this org.
  const compilationsByProcess = await queryCompilations(api, processIds, ns);

  // ── 3. Fetch card PropertySetConfig + DataSourceConfig + Description ───────
  // OmniUiCard has no Definition field — deps live in PropertySetConfig (main
  // card config) and DataSourceConfig (data-loading config, may reference DRs).
  const cardIds = cardRefs.map((r) => r.id).filter((id): id is string => !!id);
  const cardDscById = new Map<string, string | Record<string, unknown> | null>();
  const cardPscById = new Map<string, string | Record<string, unknown> | null>();
  const cardDescById = new Map<string, string>();
  const cardAiDescById = new Map<string, string>();
  const fCardPsc  = f('PropertySetConfig');
  const fCardDsc  = f('DataSourceConfig');
  const fCardDesc = f('Description');
  const fCardAi   = f('AiGeneratedDescription');
  for (let i = 0; i < cardIds.length; i += CHUNK) {
    const chunk = cardIds.slice(i, i + CHUNK);
    const idList = chunk.map((id) => `'${id}'`).join(',');
    // AiGeneratedDescription guarded — may not exist on older orgs (minApi 264)
    let rawRows: Array<Record<string, unknown>> = [];
    try {
      rawRows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, ${fCardPsc}, ${fCardDsc}, ${fCardDesc}, ${fCardAi} FROM ${op('OmniUiCard')} WHERE Id IN (${idList})`,
      );
    } catch (_) {
      // Fallback without AiGeneratedDescription if field not available
      rawRows = await api.queryAll<Record<string, unknown>>(
        `SELECT Id, ${fCardPsc}, ${fCardDsc}, ${fCardDesc} FROM ${op('OmniUiCard')} WHERE Id IN (${idList})`,
      );
    }
    for (const rawRow of rawRows) {
      const row = nrm(rawRow);
      const id = row['Id'] as string;
      cardDscById.set(id, row['DataSourceConfig'] as string | Record<string, unknown> | null);
      cardPscById.set(id, row['PropertySetConfig'] as string | Record<string, unknown> | null);
      if (row['Description']) cardDescById.set(id, row['Description'] as string);
      if (row['AiGeneratedDescription']) cardAiDescById.set(id, row['AiGeneratedDescription'] as string);
    }
  }

  // ── 3a. Fetch OmniDataTransformItem input/output object paths ────────────
  // Each item row is one "Mapped Field" as shown in the DataMapper UI.
  //   OmniDataTransformItem.InputObjectName  = JSON path root being read
  //                                            (e.g. "AccountData")
  //   OmniDataTransformItem.OutputObjectName = SObject/path root being written
  //                                            (e.g. "Account")
  //
  // Collecting the DISTINCT values per DR gives a concise semantic description:
  //   drInputObjects  → "AccountData, ContactData"  (what feeds the mapping)
  //   drOutputObjects → "Account, Contact"          (what the DR reads/writes)
  const drIds = drRefs.map((r) => r.id).filter((id): id is string => !!id);
  const drInputObjectsById  = new Map<string, Set<string>>();
  const drOutputObjectsById = new Map<string, Set<string>>();
  // InputFieldName values per DR — used to infer IP slot-filling fields when
  // additionalInput has no %VarName% references (Case B) or there are no
  // compilation records at all (Case C).
  const drInputFieldsById = new Map<string, Set<string>>();

  if (drIds.length > 0) {
    try {
      const fDrTransId   = f('OmniDataTransformationId');
      const fDrInputObj  = f('InputObjectName');
      const fDrOutObj    = f('OutputObjectName');
      const fDrInputFld  = f('InputFieldName');
      for (let i = 0; i < drIds.length; i += CHUNK) {
        const chunk = drIds.slice(i, i + CHUNK);
        const idList = chunk.map((id) => `'${id}'`).join(',');
        const rows = await api.queryAll<Record<string, unknown>>(
          `SELECT ${fDrTransId}, ${fDrInputObj}, ${fDrOutObj}, ${fDrInputFld} ` +
          `FROM ${op('OmniDataTransformItem')} WHERE ${fDrTransId} IN (${idList})`,
        );
        for (const rawRow of rows) {
          const row = nrm(rawRow);
          const pid        = row['OmniDataTransformationId'] as string;
          const inputObj   = (row['InputObjectName']  as string | null)?.trim();
          const outputObj  = (row['OutputObjectName'] as string | null)?.trim();
          const inputField = (row['InputFieldName']   as string | null)?.trim();
          if (inputObj) {
            if (!drInputObjectsById.has(pid))  drInputObjectsById.set(pid,  new Set());
            drInputObjectsById.get(pid)!.add(inputObj);
          }
          if (outputObj) {
            if (!drOutputObjectsById.has(pid)) drOutputObjectsById.set(pid, new Set());
            drOutputObjectsById.get(pid)!.add(outputObj);
          }
          if (inputField) {
            if (!drInputFieldsById.has(pid)) drInputFieldsById.set(pid, new Set());
            drInputFieldsById.get(pid)!.add(inputField);
          }
        }
      }
    } catch (_) { /* item table unavailable or empty — skip */ }
  }

  // Enrich DR refs — these fields flow through to graphPrompt + render tree
  for (const ref of drRefs) {
    if (!ref.id) continue;
    const inputs  = drInputObjectsById.get(ref.id);
    const outputs = drOutputObjectsById.get(ref.id);
    if (inputs?.size)  ref.drInputObjects  = Array.from(inputs).sort().join(', ');
    if (outputs?.size) ref.drOutputObjects = Array.from(outputs).sort().join(', ');
    // Load fields are payload keys; Extract fields are query filters. Both are
    // valid direct Data Mapper inputs and must be visible to the planner.
    const drType = (ref.drType ?? '').toLowerCase();
    if (drType.includes('load') || drType.includes('extract')) {
      const fields = drInputFieldsById.get(ref.id);
      if (fields?.size) ref.drInputFields = Array.from(fields).sort();
    }
  }

  // Build name → inputFields lookup for Load-type DRs only.
  // Load DRs (Post Actions) accept a JSON input payload and write to Salesforce.
  // Their InputFieldName values are the JSON keys the DR expects — exactly the
  // fields the caller IP must supply.  Extract/Transform DRs are excluded because
  // their InputFieldName values are Salesforce object fields, not IP input params.
  const drInputFieldsByName = new Map<string, string[]>();
  for (const ref of drRefs) {
    if (!ref.id) continue;
    const isLoad = (ref.drType ?? '').toLowerCase().includes('load');
    if (!isLoad) continue;
    const fields = drInputFieldsById.get(ref.id);
    if (fields?.size) {
      drInputFieldsByName.set(ref.name, Array.from(fields).sort());
    }
  }

  // ── 4. Compute raw dep refs per component ─────────────────────────────────
  // Raw deps from the scanner are fuzzy: they contain type/name but may not
  // match the exact matchingKey format (version, language differences, etc.)
  // We normalise by stripping the version suffix and looking up by prefix.
  function resolveDepKey(rawKey: string): string | null {
    // Exact match (most common for DataRaptor: "DataRaptor/Name")
    if (knownKeys.has(rawKey)) return rawKey;

    // Try prefix match: "OmniScript/Type/SubType" → match any version
    // matchingKey format: OmniScript/Type/SubType/Lang/Version
    //                     IntegrationProcedure/Type/SubType/Version
    //                     OmniUiCard/Name/Author/Version
    //                     DataRaptor/Name
    const parts = rawKey.split('/');
    if (parts.length >= 3) {
      const prefix = parts.slice(0, 3).join('/').toLowerCase();
      for (const k of knownKeys) {
        if (k.toLowerCase().startsWith(prefix + '/') || k.toLowerCase() === prefix) {
          return k;
        }
      }
    }
    if (parts.length >= 2) {
      const prefix2 = parts.slice(0, 2).join('/').toLowerCase();
      for (const k of knownKeys) {
        if (k.toLowerCase().startsWith(prefix2 + '/') || k.toLowerCase() === prefix2) {
          return k;
        }
      }
    }
    return null; // unresolved — file-based component
  }

  const nodeMap = new Map<string, HeadlessNode>();
  for (const ref of allRefs) {
    nodeMap.set(ref.matchingKey, { ref, deps: [], dependents: [] });
  }

  // Scan OS + IP — backfill Description, AiGeneratedDescription, IP I/O contracts,
  // and ipStepInputMappings (from OmniProcessCompilation — preferred enrichment source)
  for (const ref of [...osRefs, ...ipRefs]) {
    if (!ref.id) continue;
    if (!ref.description  && processDescById.has(ref.id))   ref.description  = processDescById.get(ref.id);
    if (!ref.aiDescription && processAiDescById.has(ref.id)) ref.aiDescription = processAiDescById.get(ref.id);
    if (ref.type === 'IntegrationProcedure') {
      if (!ref.ipInput  && ipInputById.has(ref.id))  ref.ipInput  = ipInputById.get(ref.id);
      if (!ref.ipOutput && ipOutputById.has(ref.id)) ref.ipOutput = ipOutputById.get(ref.id);
    }

    const node        = nodeMap.get(ref.matchingKey)!;
    const compilation = compilationsByProcess.get(ref.id);

    if (compilation) {
      // Compilation path — richer: exact deps, full step tree, per-step input mappings
      const parsed = parseCompilation(compilation);
      if (!ref.ipSteps            && parsed.ipSteps)                  ref.ipSteps            = parsed.ipSteps;
      if (!ref.ipSchematic        && parsed.schematic.length > 0)     ref.ipSchematic        = parsed.schematic;
      if (!ref.ipStepInputMappings && parsed.stepInputMappings.length > 0) {
        ref.ipStepInputMappings = parsed.stepInputMappings;
      }
      if (ref.type === 'IntegrationProcedure') {
        if (!ref.ipInput  && parsed.ipInput)  ref.ipInput  = parsed.ipInput;
        if (!ref.ipOutput && parsed.ipOutput) ref.ipOutput = parsed.ipOutput;
      }

      // Backfill: when %VarName% refs are absent (Case B — static additionalInput
      // values or no additionalInput at all), infer inputFields from the DR's own
      // OmniDataTransformItem.InputFieldName values.
      // We only infer for Load-type DRs (Post Actions that write data); Extract DRs
      // have InputFieldName = Salesforce object fields, not IP input params.
      if (ref.ipStepInputMappings && drInputFieldsByName.size > 0) {
        ref.ipStepInputMappings = ref.ipStepInputMappings.map((m) => {
          if (m.inputFields.length > 0 || !m.drBundle) return m;
          const inferred = drInputFieldsByName.get(m.drBundle);
          return inferred?.length ? { ...m, inputFields: inferred } : m;
        });
      }

      // Deps from dMap/rMap — more reliable than PSC scanning
      for (const depKey of parsed.depKeys) {
        const resolved = resolveDepKey(depKey);
        if (resolved && resolved !== ref.matchingKey && !node.deps.includes(resolved)) {
          node.deps.push(resolved);
        }
      }
    } else {
      // Element fallback — for orgs without compilation records (pre-230 or unactivated IPs)
      const elements = elementsByProcess.get(ref.id) ?? [];
      if (ref.type === 'IntegrationProcedure' && !ref.ipSteps && elements.length > 0) {
        const summary = summariseIpElements(elements);
        if (summary) ref.ipSteps = summary;
      }
      if (ref.type === 'OmniScript' && !ref.osSteps && elements.length > 0) {
        const summary = summariseOsElements(elements);
        if (summary) ref.osSteps = summary;
      }

      // Element fallback: construct ipStepInputMappings from OmniProcessElement rows
      // (Case C — no OmniProcessCompilation records, e.g. IP activated via DataPack
      // without triggering the Designer's compile step).
      // Regex inline here so compilation.ts's private extractIpVariables() isn't needed.
      if (ref.type === 'IntegrationProcedure' && !ref.ipStepInputMappings && elements.length > 0) {
        const varPat = /^%\s*([^%]+?)\s*%$/;
        const fallbackMappings: IpStepInputMapping[] = [];
        for (const elem of elements) {
          const level = (elem['Level'] as number | null) ?? 1;
          if (level > 1) continue;
          const elemType = ((elem['Type'] as string | null) ?? '').trim();
          const lower = elemType.toLowerCase();
          if (!lower.includes('dataraptor') && !lower.includes('data raptor')) continue;

          let psc: Record<string, unknown> | null = null;
          try {
            const raw = elem['PropertySetConfig'];
            if (typeof raw === 'string') psc = JSON.parse(raw) as Record<string, unknown>;
            else if (raw && typeof raw === 'object') psc = raw as Record<string, unknown>;
          } catch (_) { /* skip */ }
          if (!psc) continue;

          const bundle   = ((psc['bundle'] as string) || (psc['bundleName'] as string) || '').trim();
          if (!bundle) continue;
          const sendOnly = (psc['sendOnlyAdditionalInput'] as boolean) ?? false;
          const addIn    = (psc['additionalInput'] as Record<string, unknown>) ?? {};
          const stepName = ((elem['Name'] as string) || elemType).trim();

          // Extract %VarName% refs first
          const inputFields: string[] = [];
          for (const value of Object.values(addIn)) {
            if (typeof value !== 'string') continue;
            const m = value.trim().match(varPat);
            if (m) { const v = m[1].trim(); if (v && !inputFields.includes(v)) inputFields.push(v); }
          }
          // Fall back to DR's own InputFieldName values when no %VarName% refs found
          const finalFields = inputFields.length > 0
            ? inputFields
            : (drInputFieldsByName.get(bundle) ?? []);

          fallbackMappings.push({ stepName, stepType: elemType, drBundle: bundle, inputFields: finalFields, sendOnlyAdditionalInput: sendOnly });
        }
        if (fallbackMappings.length > 0) ref.ipStepInputMappings = fallbackMappings;
      }

      const processPsc = processPscById.get(ref.id) ?? null;
      const rawDeps = computeDependencies(elements, processPsc);
      for (const raw of rawDeps) {
        const resolved = resolveDepKey(raw.matchingKey);
        if (resolved && resolved !== ref.matchingKey && !node.deps.includes(resolved)) {
          node.deps.push(resolved);
        }
      }
    }
  }

  // Scan FlexCards — backfill Description + AiGeneratedDescription
  for (const ref of cardRefs) {
    if (!ref.id) continue;
    if (!ref.description && cardDescById.has(ref.id)) ref.description = cardDescById.get(ref.id);
    if (!ref.aiDescription && cardAiDescById.has(ref.id)) ref.aiDescription = cardAiDescById.get(ref.id);
    const psc = cardPscById.get(ref.id) ?? null;
    const dsc = cardDscById.get(ref.id) ?? null;
    const rawDeps = dedupeDeps([
      ...scanElementForDeps(psc),
      ...scanElementForDeps(dsc),
    ]);
    const node = nodeMap.get(ref.matchingKey)!;
    for (const raw of rawDeps) {
      const resolved = resolveDepKey(raw.matchingKey);
      if (resolved && resolved !== ref.matchingKey && !node.deps.includes(resolved)) {
        node.deps.push(resolved);
      }
    }
  }

  // DataRaptor is a leaf — no outbound deps to scan

  // ── 5. Build reverse edges (dependents) ───────────────────────────────────
  for (const node of nodeMap.values()) {
    for (const depKey of node.deps) {
      const depNode = nodeMap.get(depKey);
      if (depNode && !depNode.dependents.includes(node.ref.matchingKey)) {
        depNode.dependents.push(node.ref.matchingKey);
      }
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    inferredEdges: inferDataFlowEdges(Array.from(nodeMap.values())),
    builtAt: new Date().toISOString(),
    orgUrl,
  };
}
