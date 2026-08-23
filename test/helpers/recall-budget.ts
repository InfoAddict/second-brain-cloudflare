import type { RecallSearchResult, RecallDiagnostics, RecallOperationDiagnostics } from "../../src/recall/types";

export interface RecallBudgetSnapshot extends RecallOperationDiagnostics {
  workerRequests: number;
  graphSeeds: number;
  expandedNodes: number;
  renderedResults: number;
}

export function snapshotRecallBudget(
  diagnostics: RecallDiagnostics,
  result: RecallSearchResult,
): RecallBudgetSnapshot {
  if (!diagnostics.operations) throw new Error("recall diagnostics did not observe operations");
  return {
    ...diagnostics.operations,
    workerRequests: 1,
    graphSeeds: diagnostics.rootSelections?.length ?? 0,
    expandedNodes: diagnostics.expandedIds?.length ?? 0,
    renderedResults: result.matches.length,
  };
}
