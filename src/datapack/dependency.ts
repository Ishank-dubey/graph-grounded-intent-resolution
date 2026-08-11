import type { ComponentRef, ComponentType, ExternalRef } from '../types/datapack.js';

// ─────────────────────────────────────────────────────────────────────────────
// Dependency scanner
//
// OmniStudio components form an arbitrary-depth graph:
//
//   OmniScript → child OmniScript, IP, DataRaptor, FlexCard
//   FlexCard   → child FlexCard, OmniScript (action), IP, DataRaptor
//   IP         → child IP, DataRaptor
//   DataRaptor → (leaf — no further component refs)
//
// The BFS in exportComponents handles the traversal to arbitrary depth.
// This scanner's ONLY job is to find every outbound edge in a single
// PropertySetConfig / Definition blob by recognising reference field names.
//
// HOW TO ADD A NEW FIELD: append one line to FIELD_MAP:
//   ['fieldName', 'ComponentType', 'parseStrategy']
//
// Parse strategies:
//   'typeSubType_'   → "Type_SubType"   split on first underscore
//   'typeSubType/'   → "Type/SubType"   split on slash
//   'typeSubTypeAny' → tries slash first, falls back to underscore
//   'name'           → raw value used as-is (DataRaptor bundle name, card name)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively scan a PropertySetConfig / Definition blob and return every
 * component reference found inside it.
 */
export function scanElementForDeps(
  propertySetConfig: string | Record<string, unknown> | null | undefined,
): ComponentRef[] {
  let obj: Record<string, unknown> | null = null;

  if (typeof propertySetConfig === 'string') {
    try {
      obj = JSON.parse(propertySetConfig) as Record<string, unknown>;
    } catch {
      return [];
    }
  } else if (propertySetConfig !== null && typeof propertySetConfig === 'object') {
    obj = propertySetConfig;
  }

  if (!obj) return [];

  const found: ComponentRef[] = [];
  scanObject(obj, found);
  return dedupe(found);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field-name registry
// Each entry: [fieldName, componentType, parseStrategy]
//
// Parse strategies:
//   'typeSubType_'   → "Type_SubType"  (split on first _, rest is SubType)
//   'typeSubType/'   → "Type/SubType"  (split on /)
//   'typeSubTypeAny' → tries both _ and / separators
//   'name'           → raw string, used as-is for DataRaptor/FlexCard names
// ─────────────────────────────────────────────────────────────────────────────

type ParseStrategy = 'typeSubType_' | 'typeSubType/' | 'typeSubTypeAny' | 'name';

const FIELD_MAP: Array<[string, ComponentType, ParseStrategy]> = [
  // ── Integration Procedure → child IP ──────────────────────────────────────
  // IP "Integration Procedure Call" action element — calls another IP
  ['integrationProcedureKey',  'IntegrationProcedure', 'typeSubType_'],
  ['ipMethod',                 'IntegrationProcedure', 'typeSubType_'],
  ['ipKey',                    'IntegrationProcedure', 'typeSubType_'],
  // FlexCard action of type IP
  ['procedureKey',             'IntegrationProcedure', 'typeSubType_'],
  ['iProcedureKey',            'IntegrationProcedure', 'typeSubType_'],

  // ── Integration Procedure / OmniScript → DataRaptor ───────────────────────
  // DataRaptor Extract / Transform / Load action element (in both OS and IP)
  ['bundle',                   'DataRaptor', 'name'],
  ['bundleName',               'DataRaptor', 'name'],
  ['dataRaptorBundle',         'DataRaptor', 'name'],
  // Pre/post transform bundles wired on DataRaptor action elements
  ['preTransformBundle',       'DataRaptor', 'name'],
  ['postTransformBundle',      'DataRaptor', 'name'],
  // Explicit extract/load/transform bundle fields (alternate naming in some orgs)
  ['extractBundleName',        'DataRaptor', 'name'],
  ['loadBundleName',           'DataRaptor', 'name'],
  ['transformBundleName',      'DataRaptor', 'name'],

  // ── Child OmniScript inside OmniScript ────────────────────────────────────
  ['scriptName',               'OmniScript', 'typeSubTypeAny'],
  ['omniScriptName',           'OmniScript', 'typeSubTypeAny'],
  ['childScriptKey',           'OmniScript', 'typeSubTypeAny'],

  // ── FlexCard embedded inside OmniScript ───────────────────────────────────
  ['cardName',                 'OmniUiCard', 'name'],
  ['flexCardName',             'OmniUiCard', 'name'],
  ['omniUiCardName',           'OmniUiCard', 'name'],

  // ── OmniScript launched from FlexCard action ──────────────────────────────
  ['scriptKey',                'OmniScript', 'typeSubTypeAny'],
  ['omniscriptKey',            'OmniScript', 'typeSubTypeAny'],
  ['omniScriptKey',            'OmniScript', 'typeSubTypeAny'],

  // ── Child FlexCard inside FlexCard ────────────────────────────────────────
  ['childCardName',            'OmniUiCard', 'name'],
  ['embeddedCardName',         'OmniUiCard', 'name'],
];

const FIELD_LOOKUP = new Map(FIELD_MAP.map(([k, t, s]) => [k, { type: t, strategy: s }]));

function parseRef(
  val: string,
  type: ComponentType,
  strategy: ParseStrategy,
): ComponentRef | null {
  val = val.trim();
  if (!val) return null;

  if (strategy === 'name') {
    // DataRaptor / FlexCard — whole value is the name
    const prefix = type === 'DataRaptor' ? 'DataRaptor' : 'OmniUiCard';
    return { type, matchingKey: `${prefix}/${val}`, name: val };
  }

  // Type_SubType or Type/SubType parsing
  let typePart: string;
  let subTypePart: string;

  if (strategy === 'typeSubType_' || (strategy === 'typeSubTypeAny' && !val.includes('/'))) {
    const idx = val.indexOf('_');
    if (idx === -1) return null;
    typePart = val.slice(0, idx);
    subTypePart = val.slice(idx + 1); // SubType may itself contain underscores
  } else {
    // typeSubType/ or typeSubTypeAny with slash present
    const parts = val.split('/');
    if (parts.length < 2) return null;
    typePart = parts[0];
    subTypePart = parts[1];
  }

  if (!typePart || !subTypePart) return null;

  const prefix = type === 'OmniScript' ? 'OmniScript' : 'IntegrationProcedure';
  return { type, matchingKey: `${prefix}/${typePart}/${subTypePart}`, name: val };
}

function scanObject(obj: Record<string, unknown>, found: ComponentRef[]): void {
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string') {
      const entry = FIELD_LOOKUP.get(key);
      if (entry) {
        const ref = parseRef(val, entry.type, entry.strategy as ParseStrategy);
        if (ref) found.push(ref);
      }
    }

    // Recurse into nested objects and arrays — the graph can be arbitrarily deep
    if (val !== null && typeof val === 'object') {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            scanObject(item as Record<string, unknown>, found);
          }
        }
      } else {
        scanObject(val as Record<string, unknown>, found);
      }
    }
  }
}

function dedupe(refs: ComponentRef[]): ComponentRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.matchingKey)) return false;
    seen.add(r.matchingKey);
    return true;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// External-ref extractor
//
// Scans OmniProcessElement rows for element types that reference external
// Salesforce artefacts (Apex classes, LWC components) that cannot be
// exported/imported by this tool.  Results are stored in BundleEntry.externalRefs
// and surfaced as preflight warnings when they are absent in the target org.
//
// Element type strings are lower-cased for case-insensitive matching because
// OmniStudio stores them inconsistently across org versions:
//   "Remote" | "remote" | "Custom Remote Action" etc.
// ─────────────────────────────────────────────────────────────────────────────

export function extractExternalRefs(elements: Array<Record<string, unknown>>): ExternalRef[] {
  const refs: ExternalRef[] = [];
  const seen = new Set<string>();

  for (const elem of elements) {
    const elemType = ((elem['Type'] as string | null | undefined) ?? '').trim().toLowerCase();

    let psc: Record<string, unknown> | null = null;
    try {
      const raw = elem['PropertySetConfig'];
      if (typeof raw === 'string') psc = JSON.parse(raw) as Record<string, unknown>;
      else if (raw && typeof raw === 'object') psc = raw as Record<string, unknown>;
    } catch (_) { /* malformed PSC — skip */ }

    // ── Apex Remote Action ────────────────────────────────────────────────────
    // Element.Type values observed:
    //   "Remote" (legacy), "Custom Remote Action", "Apex", "Apex Action"
    const isApex = elemType === 'remote' ||
      elemType === 'apex' ||
      elemType === 'apex action' ||
      elemType.includes('remote action') ||
      elemType.includes('apex');
    if (isApex && psc) {
      const className = (
        (psc['className'] as string | undefined) ??
        (psc['apexClass'] as string | undefined) ??
        (psc['sClassName'] as string | undefined) ??
        ''
      ).trim();
      if (className) {
        const k = `ApexClass:${className}`;
        if (!seen.has(k)) { seen.add(k); refs.push({ kind: 'ApexClass', name: className }); }
      }
    }

    // ── Custom LWC component ──────────────────────────────────────────────────
    // Element.Type values observed:
    //   "Custom LWC", "LWC", "Lightning Component"
    const isLwc = elemType === 'lwc' ||
      elemType === 'custom lwc' ||
      elemType === 'lightning component' ||
      elemType.includes('lwc') ||
      elemType.includes('lightning web component');
    if (isLwc && psc) {
      const lwcName = (
        (psc['componentName'] as string | undefined) ??
        (psc['lwcName'] as string | undefined) ??
        (psc['name'] as string | undefined) ??
        ''
      ).trim();
      if (lwcName) {
        const k = `LWC:${lwcName}`;
        if (!seen.has(k)) { seen.add(k); refs.push({ kind: 'LWC', name: lwcName }); }
      }
    }
  }

  return refs;
}

/**
 * Scan all elements' PropertySetConfig fields and return unique dependency refs.
 * Also accepts an optional process-level PropertySetConfig to scan.
 */
export function computeDependencies(
  elements: Array<Record<string, unknown>>,
  processPropertySetConfig?: string | Record<string, unknown> | null,
): ComponentRef[] {
  const all: ComponentRef[] = [];
  if (processPropertySetConfig) {
    all.push(...scanElementForDeps(processPropertySetConfig));
  }
  for (const elem of elements) {
    const psc = elem['PropertySetConfig'] as string | Record<string, unknown> | null | undefined;
    all.push(...scanElementForDeps(psc));
  }
  return dedupe(all);
}
