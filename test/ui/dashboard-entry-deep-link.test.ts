import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const { entryIdFromSearch } = require("../../public/js/auth.js");
const dashboardAuth = readFileSync("public/js/auth.js", "utf8");

describe("dashboard entry deep links", () => {
  it("reads and decodes the requested entry", () => {
    expect(entryIdFromSearch("?entry=memory%2Fone")).toBe("memory/one");
  });

  it("trims the entry id and ignores unrelated or empty queries", () => {
    expect(entryIdFromSearch("?entry=%20memory-1%20")).toBe("memory-1");
    expect(entryIdFromSearch("?tag=throughline")).toBeNull();
    expect(entryIdFromSearch("?entry=%20%20")).toBeNull();
  });

  it("rejects unreasonably large entry ids", () => {
    expect(entryIdFromSearch(`?entry=${"a".repeat(257)}`)).toBeNull();
  });

  it("is wired into the authenticated dashboard entry flow", () => {
    expect(dashboardAuth).toContain("entryIdFromSearch(window.location.search)");
    expect(dashboardAuth).toContain("void openRequestedEntry()");
    expect(dashboardAuth).toContain("/entry?id=${encodeURIComponent(entryId)}");
  });
});
