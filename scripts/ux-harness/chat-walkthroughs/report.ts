/** Prints one client's scenario results in a form a human can verify by eye: the exact call
 * sequence, the exact reply, and the verdict, per scenario 6.4 asks for. */
import type { ScenarioResult } from "./common";
import { summarize } from "./common";

const TRUNCATE_AT = 240;
const short = (text: string): string => (text.length > TRUNCATE_AT ? `${text.slice(0, TRUNCATE_AT)}…[truncated for this report only]` : text);

const BADGE: Record<ScenarioResult["status"], string> = { pass: "PASS", pending: "PENDING", fail: "FAIL" };

export function printScenarios(clientLabel: string, scenarios: ScenarioResult[]): void {
  console.log(`\n${"=".repeat(70)}\n${clientLabel}\n${"=".repeat(70)}`);
  for (const sc of scenarios) {
    console.log(`\n[${sc.n}] ${sc.name}  ->  ${BADGE[sc.status]}`);
    for (const c of sc.calls) {
      console.log(`    call: ${c.tool}(${JSON.stringify(c.args)})`);
      const marker = c.notBuilt ? "  [tool not registered]" : "";
      if (c.reply !== undefined) console.log(`      reply: ${JSON.stringify(short(c.reply))}${marker}`);
      else if (c.errorMessage !== undefined) console.log(`      error: ${c.errorMessage}${marker}`);
    }
    console.log(`    note: ${sc.note}`);
  }
  const { pass, pending, fail } = summarize(scenarios);
  console.log(`\n${clientLabel} totals: ${pass} pass, ${pending} pending, ${fail} fail (of ${scenarios.length})`);
}

export function hasHardFailure(scenarios: ScenarioResult[]): boolean {
  return scenarios.some(s => s.status === "fail");
}
