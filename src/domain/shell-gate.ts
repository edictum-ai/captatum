export type ShellGateReason =
  | "empty-spa-shell"
  | "structured-data-found"
  | "content-present";

export interface ShellGateEvidence {
  jsRequired: boolean;
  reason: ShellGateReason;
  textLength: number;
  wordCount: number;
  scriptCount: number;
  appRootFound: boolean;
  structuredDataFound: boolean;
}
