// Re-export everything from the new bundle format (v2.0)
// Old references to ComponentType, ComponentRef, ImportResult etc. still resolve here.
export * from './bundle.js';

// ─── Legacy DataPack format (v1.0) — kept for backward compatibility ──────────

/** A raw SObject record as it appears inside VlocityDataPackData */
export interface DataPackSObjectRecord {
  VlocityMatchingRecordSourceKey?: string;
  [field: string]: unknown;
}

/** A dependency reference (points to another entry in the same bundle) */
export interface DataPackLookupRef {
  VlocityDataPackType: string;
  VlocityMatchingRecordSourceKey: string;
}

/** One entry in a legacy DataPack bundle (one component + its child records) */
export interface DataPackEntry {
  VlocityDataPackType: string;
  VlocityMatchingRecordSourceKey: string;
  VlocityDataPackStatus: 'Success' | 'Error' | 'Pending';
  /** SObject records: key = object API name, value = array of records */
  VlocityDataPackData: Record<string, DataPackSObjectRecord[]>;
  /** Declared dependency refs */
  VlocityLookupRecordList?: DataPackLookupRef[];
}

/** The top-level legacy export bundle (v1.0 format) */
export interface DataPackBundle {
  exportDate: string;
  exportSource: 'omnistudio-datapack-poc';
  exportOrg: string;
  version: '1.0';
  dataPacks: DataPackEntry[];
}
