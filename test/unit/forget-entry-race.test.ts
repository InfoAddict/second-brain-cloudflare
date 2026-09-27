/**
 * forgetEntry reports `deleted` only when its DELETE removed a row, so two racing
 * deleters (a sync and a purge) cannot both claim, and audit, one deletion.
 */
import { describe, it, expect, vi } from "vitest";
import { forgetEntry } from "../../src/capture/lifecycle";
import type { Env } from "../../src/env";

function envWhereDeleteChanges(changes: number) {
  const deleteByIds = vi.fn().mockResolvedValue({});
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => ({ vector_ids: '["v1"]' }),
          run: async () => ({ meta: { changes: sql.startsWith("DELETE FROM entries") ? changes : 0 } }),
        }),
      }),
    },
    VECTORIZE: { deleteByIds },
  } as unknown as Env;
  return { env, deleteByIds };
}

describe("forgetEntry", () => {
  it("reports deleted when the DELETE removed the row", async () => {
    const { env } = envWhereDeleteChanges(1);
    expect(await forgetEntry("x", env)).toEqual({ status: "deleted", vectorCount: 1 });
  });

  it("reports not_found, and touches no vectors, when a racing deleter got there first", async () => {
    const { env, deleteByIds } = envWhereDeleteChanges(0);
    expect(await forgetEntry("x", env)).toEqual({ status: "not_found" });
    expect(deleteByIds).not.toHaveBeenCalled();
  });
});
