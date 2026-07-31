export type V1AcceptanceSummary = {
  candidateVersion: "1.0.0";
  bundleSha256: string;
  runCount: 12;
  workflowCount: 4;
};

export type V1AcceptancePartialSummary = {
  candidateVersion: "1.0.0";
  bundleSha256: string;
  runCount: number;
  workflowCount: number;
  complete: false;
};

export function validateV1AcceptancePartialLedger(
  value: unknown,
): V1AcceptancePartialSummary;
export function validateV1AcceptanceLedger(value: unknown): V1AcceptanceSummary;
