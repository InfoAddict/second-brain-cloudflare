import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDatabase, resetDatabaseInit } from "../../src/db/init";
import { makeTestEnv } from "../helpers/make-env";

type CapturedResult = { results: Record<string, unknown>[] };

const captured = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../fixtures/production-schema-probe.json"), "utf8"),
) as CapturedResult[];
const capturedRows = captured.flatMap(result => result.results);
const isProbe = (sql: string) => sql.includes("sqlite_master") && sql.includes("pragma_table_info");

afterEach(resetDatabaseInit);

describe("production schema probe fixture", () => {
  it("recognises captured production metadata without scheduling schema DDL", async () => {
    const scheduled: string[] = [];
    let probeCalls = 0;
    const DB = {
      prepare(sql: string) {
        if (isProbe(sql)) {
          probeCalls++;
          return {
            bind: () => ({ all: async () => ({ success: true, results: capturedRows }) }),
          };
        }
        scheduled.push(sql);
        return { bind: () => ({ all: async () => ({ success: true, results: [] }) }) };
      },
      exec(sql: string) {
        scheduled.push(sql);
        return Promise.resolve();
      },
      batch(statements: unknown[]) {
        scheduled.push(`batch:${statements.length}`);
        return Promise.resolve([]);
      },
    } as unknown as D1Database;

    await initializeDatabase(makeTestEnv(undefined, { DB }));

    expect(captured).toHaveLength(7);
    expect(probeCalls).toBe(1);
    expect(scheduled).toEqual([]);
  });
});
