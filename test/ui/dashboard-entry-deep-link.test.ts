import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const { entryIdFromSearch } = require("../../public/js/dashboard-entry-deep-link.js");
const dashboardAuth = readFileSync("public/js/auth.js", "utf8");
const dashboardEntryDeepLink = readFileSync("public/js/dashboard-entry-deep-link.js", "utf8");
const dashboardHtml = readFileSync("public/index.html", "utf8");

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

  it("is wired between upstream auth and dashboard initialization", () => {
    const authPosition = dashboardHtml.indexOf('<script src="js/auth.js"></script>');
    const deepLinkPosition = dashboardHtml.indexOf('<script src="js/dashboard-entry-deep-link.js"></script>');
    const appPosition = dashboardHtml.indexOf('<script src="js/app.js"></script>');

    expect(authPosition).toBeGreaterThan(-1);
    expect(deepLinkPosition).toBeGreaterThan(authPosition);
    expect(appPosition).toBeGreaterThan(deepLinkPosition);
    expect(dashboardEntryDeepLink).toContain("entryIdFromSearch(window.location.search)");
    expect(dashboardEntryDeepLink).toContain("withDashboardEntryDeepLink(showApp)");
    expect(dashboardEntryDeepLink).toContain("/entry?id=${encodeURIComponent(entryId)}");
  });

  it("keeps the fork feature out of the upstream auth module", () => {
    expect(dashboardAuth).toContain("installAuthWatch");
    expect(dashboardAuth).toContain("loadTeam");
    expect(dashboardAuth).not.toContain("entryIdFromSearch");
  });
});
