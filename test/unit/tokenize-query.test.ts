import { describe, it, expect } from "vitest";
import { tokenizeQuery } from "../../src/text/tokenize";

describe("tokenizeQuery()", () => {
  it("preserves identifier-shaped tokens like version strings", () => {
    expect(tokenizeQuery("release v1.9")).toEqual(["release", "v1.9"]);
  });

  it("drops stopwords and 1-char tokens but keeps the meaningful ones", () => {
    expect(tokenizeQuery("What is the v1.9 release?")).toEqual(["v1.9", "release"]);
  });

  it("keeps identifier punctuation as literal token content", () => {
    expect(tokenizeQuery("ERR_TLS_90412 DATABASE_URL reconcile_ledger_batch_v2 50%_off 100%"))
      .toEqual(["err_tls_90412", "database_url", "reconcile_ledger_batch_v2", "50%_off", "100"]);
  });

  it("keeps the original edge-percent behavior", () => {
    expect(tokenizeQuery("9% APR 100% %discount")).toEqual(["apr", "100", "discount"]);
  });

  it("drops tokens made entirely of punctuation", () => {
    expect(tokenizeQuery("___ %% _% ＿％ useful")).toEqual(["useful"]);
  });

  it("deduplicates repeated tokens", () => {
    expect(tokenizeQuery("test test")).toEqual(["test"]);
  });

  it("returns an empty array when the query is all stopwords", () => {
    expect(tokenizeQuery("what is the")).toEqual([]);
  });

  it("pins the pre-#326 pipeline for ASCII input, identifiers included", () => {
    expect(tokenizeQuery("2026-09-02 user@example.com src/recall/search.ts #149 --no-cache key=value @cf/baai/bge-m3"))
      .toEqual(["2026-09-02", "user@example.com", "src/recall/search.ts", "#149", "no-cache", "key=value", "cf/baai/bge-m3"]);
  });
});
