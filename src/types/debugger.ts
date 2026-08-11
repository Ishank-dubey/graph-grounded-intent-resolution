/** A top-level OmniScript or FlexCard component discovered on the active Salesforce page. */
export interface ComponentInfo {
  /** Stable browser-session ID assigned by page-hook, e.g. "comp-1" */
  id: string;
  /** Lowercase DOM tag name, e.g. "omnistudio-omni-script" */
  tag: string;
  /** Broad component kind */
  kind: 'OmniScript' | 'FlexCard' | 'Unknown';
  /** Human-readable label extracted from LWC component internals, e.g. "SalesOrder / Create" */
  label: string;
}
