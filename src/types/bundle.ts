/** Component types supported by this tool */
export type ComponentType = 'OmniScript' | 'IntegrationProcedure' | 'OmniUiCard' | 'DataRaptor';

/**
 * Per-step input requirement for an IP, extracted from
 * OmniProcessCompilation children[].propSetMap.additionalInput.
 * Used for NLP slot-filling: AI identifies which fields are provided
 * by the intent and which need to be collected from the user.
 */
export interface IpStepInputMapping {
  stepName: string;
  stepType: string;
  drBundle?: string;
  /** IP input variable names required by this step (from %VarName% refs) */
  inputFields: string[];
  sendOnlyAdditionalInput: boolean;
}

/**
 * One node in the structured step tree from OmniProcessCompilation.Content.
 * Used in ComponentRef.ipSchematic for canvas renderers.
 */
export interface IpStepNode {
  type: string;
  name?: string;
  drBundle?: string;
  drType?: string;
  httpMethod?: string;
  httpUrl?: string;
  ipKey?: string;
  condition?: string;
  inputFields?: string[];
  sendOnlyAdditionalInput?: boolean;
  children?: IpStepNode[];
}

/**
 * An external dependency referenced by an OmniScript/IP element but not
 * exportable by this tool (Apex class, custom LWC component).
 * Stored in BundleEntry.externalRefs for target-org preflight checks.
 */
export interface ExternalRef {
  /** 'ApexClass' | 'LWC' */
  kind: 'ApexClass' | 'LWC';
  /** Salesforce API name of the class or component */
  name: string;
}

/** A component reference (used in dependency lists and UI) */
export interface ComponentRef {
  type: ComponentType;
  /** Stable cross-org matching key, e.g. "OmniScript/SalesOrder/Create/English/1" */
  matchingKey: string;
  /** Salesforce record Id (may be absent in lookup refs) */
  id?: string;
  /** Display name */
  name: string;
  version?: number;
  isActive?: boolean;
  /**
   * Developer-authored description from the Salesforce record.
   * Highest-fidelity semantic signal for LLM intent resolution —
   * when present, more reliable than anything inferred from structure.
   */
  description?: string;
  /** AI-generated description (OmniProcess/OmniDataTransform/OmniUiCard, minApi 264) */
  aiDescription?: string;
  // ── DataRaptor-specific schema fields ────────────────────────────────────
  /** Extract | Load | Transform | Turbo */
  drType?: string;
  /**
   * For Extract: the SObject being queried (SOQL source).
   * For Load with InputType=SObject: the SObject being passed in as input.
   * From OmniDataTransform.SourceObject.
   */
  sourceObject?: string;
  /** JSON | XML | SObject */
  inputType?: string;
  /** JSON | XML | SObject | PDF | Document */
  outputType?: string;
  /**
   * Distinct InputObjectName values from OmniDataTransformItem rows.
   * For a Load DR: the JSON path roots in the IP's input payload that feed
   * the mappings (e.g. "AccountData, ContactData").
   * For an Extract DR: the input filter path roots.
   */
  drInputObjects?: string;
  /**
   * Distinct OutputObjectName values from OmniDataTransformItem rows.
   * For a Load DR: the SObjects being written (e.g. "Account, Contact").
   * For an Extract DR: the output path roots in the response JSON.
   */
  drOutputObjects?: string;
  /**
   * Distinct InputFieldName values from OmniDataTransformItem rows.
   * For Load Data Mappers these are JSON payload fields. For Extract Data Mappers
   * these are query filter fields. Both forms are direct invocation inputs.
   */
  drInputFields?: string[];
  // ── IP-specific schema fields ─────────────────────────────────────────────
  /**
   * ConnectAPI invocation key — passed to
   * ConnectAPI.OmniDesignerConnect.integrationProcedureExecute(ipInvocationKey, input).
   * Format: "Type_SubType", e.g. "Account_Create", "Credit_ScoreCheck".
   * Derived from OmniProcess.Type + "_" + OmniProcess.SubType.
   */
  ipInvocationKey?: string;
  /** IP typed input contract (JSON, minApi 256) */
  ipInput?: string;
  /** IP typed output contract (JSON, minApi 256) */
  ipOutput?: string;
  /**
   * Compact step-level summary for IntegrationProcedure nodes.
   * Example: "Steps (3): HTTP-GET /credit/v2/score, DR-Extract AccountProfile, Conditional: creditScore<600"
   * Only populated for IntegrationProcedure nodes where element details are meaningful.
   */
  ipSteps?: string;
  /**
   * Compact step-level summary for OmniScript nodes.
   * Example: "3 steps: PersonalInfo, AddressDetails, Review (+Apex:BillingService, DR:AccountLoad)"
   * Only populated for OmniScript nodes where step structure is meaningful for intent resolution.
   */
  osSteps?: string;
  // ── FlexCard-specific ─────────────────────────────────────────────────────
  /** OmniUiCardType enum value */
  cardType?: string;
  /**
   * Structured step tree from OmniProcessCompilation.Content (children[]).
   * Used by canvas renderers to draw the IP's internal flow.
   */
  ipSchematic?: IpStepNode[];
  /**
   * Per-step input requirements from OmniProcessCompilation.
   * Populated by the headless graph builder when compilation records exist.
   * Used for NLP slot-filling in the AI planner.
   */
  ipStepInputMappings?: IpStepInputMapping[];
}

export interface OmniScriptRecord {
  Name: string;
  Type: string;
  SubType: string;
  Language: string;
  VersionNumber: number;
  IsActive: boolean;
  IsIntegrationProcedure: boolean;
  PropertySetConfig?: string;
  IsReusable?: boolean;
  IsLwcEnabled?: boolean;
  RequiredPermission?: string;
  DisableMetadataCache?: boolean;
  [key: string]: unknown;
}

export interface OmniElementRecord {
  _sourceId: string;
  _sourceParentId: string | null;
  Name: string;
  Type: string;
  Level: number;
  SequenceNumber: number;
  PropertySetConfig?: string;
  IsActive?: boolean;
  SearchKey?: string;
  InternalNotes?: string;
  [key: string]: unknown;
}

export interface OmniUiCardRecord {
  Name: string;
  AuthorName: string;
  VersionNumber: number;
  IsActive: boolean;
  PropertySetConfig?: string;
  CardType?: string;
  [key: string]: unknown;
}

export interface OmniDataTransformRecord {
  Name: string;
  Type?: string;
  VersionNumber?: number;
  IsActive?: boolean;
  Description?: string;
  InputType?: string;
  OutputType?: string;
  SourceObject?: string;
  GlobalKey?: string;
  UniqueName?: string;
  Namespace?: string;
  RequiredPermission?: string;
  OverrideKey?: string;
  [key: string]: unknown;
}

export interface OmniDataTransformItemRecord {
  Name: string;
  GlobalKey?: string;
  // Input mapping
  InputObjectName?: string;
  InputObjectQuerySequence?: number;
  InputFieldName?: string;
  // Output mapping
  OutputObjectName?: string;
  OutputCreationSequence?: number;
  OutputFieldName?: string;
  OutputFieldFormat?: string;
  // Transform
  DefaultValue?: string;
  /** JSON blob containing key-value mappings to convert output values */
  TransformValueMappings?: string;
  // Upsert
  IsDisabled?: boolean;
  IsUpsertKey?: boolean;
  IsRequiredForUpsert?: boolean;
  LinkedFieldName?: string;
  LinkedObjectSequence?: number;
  LookupByFieldName?: string;
  LookupObjectName?: string;
  LookupReturnedFieldName?: string;
  // Filters
  FilterDataType?: string;
  FilterGroup?: number;
  FilterOperator?: string;
  FilterValue?: string;
  // Formulas
  FormulaExpression?: string;
  FormulaConverted?: string;
  FormulaResultPath?: string;
  FormulaSequence?: number;
  // DataPack migration fields
  MigrationAttribute?: string;
  MigrationCategory?: string;
  MigrationGroup?: string;
  MigrationKey?: string;
  MigrationPattern?: string;
  MigrationProcess?: string;
  MigrationType?: string;
  MigrationValue?: string;
  [key: string]: unknown;
}

export interface BundleEntry {
  type: ComponentType;
  /** e.g. "OmniScript/SalesOrder/Create/English/1" */
  matchingKey: string;
  exportedAt: string;
  // For OmniScript/IP
  process?: OmniScriptRecord;
  elements?: OmniElementRecord[];
  // For OmniUiCard
  card?: OmniUiCardRecord;
  // For DataRaptor
  transform?: OmniDataTransformRecord;
  transformItems?: OmniDataTransformItemRecord[];
  /** Declared dependencies (by matchingKey) */
  dependencies: string[];
  /**
   * External references (Apex classes, LWC components) found in elements.
   * These are NOT imported — they must exist in the target org.
   * Used by preflight to generate warnings when they are missing.
   */
  externalRefs?: ExternalRef[];
}

export interface OmniBundle {
  formatVersion: '2.0';
  exportDate: string;
  exportOrg: string;
  entries: BundleEntry[];
}

/** Pre-flight result per entry */
export interface PreflightResult {
  matchingKey: string;
  action: 'create';             // always create — never update
  targetVersion: number;        // the version number that WILL be used on insert
  existingVersions: number[];   // all versions already present in the org (empty = brand new)
  activeVersion: number | null; // the currently active version, if any
  displayName: string;          // human-readable: "OmniScript/Child/Second/English"
  /**
   * Non-blocking warnings about external dependencies (Apex classes, LWC) that
   * are referenced in this component but not present in the target org.
   * The import still proceeds — but referenced elements will fail at runtime.
   */
  warnings?: string[];
}

/** Import result per entry */
export interface ImportResult {
  matchingKey: string;
  action: 'created' | 'skipped' | 'error';
  id?: string;
  /** Hard failure message — shown in red */
  error?: string;
  /** Informational note (e.g. "activate manually") — shown in amber, not a failure */
  note?: string;
}

/** An org session discovered in the browser — used in the DataPack org picker */
export interface OrgInfo {
  tabId: number;
  orgDomain: string;
  orgUrl: string;
  /** Tab title or org domain — displayed as the human-readable label in the picker */
  label: string;
}
