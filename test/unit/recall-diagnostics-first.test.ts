import { describe, expect, it } from "vitest";
import { observeRecallEnv } from "../../src/recall/diagnostics";
import type { Env } from "../../src/env";
import type { RecallDiagnostics } from "../../src/recall/types";

// D1 returns meta.rows_read on all() and run() only; first() returns the bare row (or column) with no meta.
function fakeEnv(rowsRead: number) {
  const statement = (rows: Record<string, unknown>[]): any => {
    const s: any = {
      bind: () => s,
      all: async () => ({ results: rows, meta: { rows_read: rowsRead } }),
      run: async () => ({ results: [], meta: { rows_read: rowsRead } }),
      first: async () => { throw new Error("first() has no meta: the observer must run it as all()"); },
      raw: async () => rows.map(r => Object.values(r)),
    };
    return s;
  };
  return { DB: { prepare: (sql: string) => statement(sql.includes("none") ? [] : [{ n: 7, name: "x" }]), batch: async () => [] }, AI: {}, VECTORIZE: {}, OAUTH_KV: {} } as unknown as Env;
}

describe("observeRecallEnv rows_read", () => {
  it("counts first() as all(): same statement, same rows_read, same return value", async () => {
    const diagnostics: RecallDiagnostics = {};
    const env = observeRecallEnv(fakeEnv(918), diagnostics);
    expect(await env.DB.prepare("df").bind("%a%").first()).toEqual({ n: 7, name: "x" });
    expect(await env.DB.prepare("df").first<string>("name")).toBe("x");
    expect(await env.DB.prepare("none").first()).toBeNull();
    expect(await env.DB.prepare("none").first("name")).toBeNull();
    await env.DB.prepare("q").all();
    expect(diagnostics.operations).toMatchObject({ d1Statements: 5, d1RowsRead: 5 * 918 });
  });

  it("still reports unknown (null) for raw(), whose result carries no meta, and never invents a number", async () => {
    const diagnostics: RecallDiagnostics = {};
    const env = observeRecallEnv(fakeEnv(3), diagnostics);
    await env.DB.prepare("q").raw();
    expect(diagnostics.operations).toMatchObject({ d1Statements: 1, d1RowsRead: null });
  });
});
