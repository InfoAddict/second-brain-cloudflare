/**
 * The two client-side primitives Tier 1 rests on: which tags a person sees,
 * and how source text is reduced to something readable.
 *
 * Both decide what every row in the app looks like, and both are pure — so
 * they are tested directly rather than through the DOM.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function load(): any {
  const ctx: any = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/tags.js"), "utf8"), ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  return ctx;
}

describe("isSystemTag / humanTags", () => {
  const { isSystemTag, humanTags } = load();

  it("hides every reserved namespace the Worker writes", () => {
    for (const t of ["kind:episodic", "status:canonical", "volatility:volatile", "stale:as-of"]) {
      expect(isSystemTag(t), t).toBe(true);
    }
  });

  it("hides pipeline markers", () => {
    for (const t of ["auto-pattern", "synthesized", "rolled-up", "duplicate-candidate"]) {
      expect(isSystemTag(t), t).toBe(true);
    }
  });

  it("hides legacy numeric tags from synced issue references", () => {
    expect(isSystemTag("5118")).toBe(true);
    expect(isSystemTag("298")).toBe(true);
    // A number is only noise on its own — these are real topics.
    expect(isSystemTag("v2")).toBe(false);
    expect(isSystemTag("q3-2026")).toBe(false);
  });

  it("keeps the user's own vocabulary, in order", () => {
    const tags = ["work", "kind:episodic", "signpath", "5118", "status:canonical", "idea"];
    expect(humanTags(tags)).toEqual(["work", "signpath", "idea"]);
  });

  it("treats malformed input as system rather than rendering it", () => {
    expect(humanTags(["", "  ", null, 42, "real"] as any)).toEqual(["real"]);
    expect(humanTags(null as any)).toEqual([]);
  });

  it("is case-insensitive, because tags arrive from many clients", () => {
    expect(isSystemTag("Kind:Semantic")).toBe(true);
    expect(isSystemTag("STATUS:DEPRECATED")).toBe(true);
  });
});

describe("stripToPlainText / titleLine", () => {
  const { stripToPlainText, titleLine, relativeTime, sourceBadge } = load();

  it("reduces the email shapes that made rows start with punctuation", () => {
    const email = "# Your Uber Pro Card is no longer active\n*************\n[Sign in to your account](https://click.example.com/x)\n\nBalance is $0.";
    const out = stripToPlainText(email);
    expect(out).not.toMatch(/[#*]/);
    expect(out).not.toMatch(/https?:/);
    expect(out).toContain("Sign in to your account");
    expect(out.startsWith("Your Uber Pro Card")).toBe(true);
  });

  it("drops code fences and inline code without eating the prose", () => {
    expect(stripToPlainText("Run ```sh\nnpm run deploy\n``` before merging")).toBe("Run before merging");
    expect(stripToPlainText("Use `npm ci` first")).toBe("Use npm ci first");
  });

  it("takes the first sentence as the title", () => {
    expect(titleLine("Decided to close the account. The balance was zero.")).toBe("Decided to close the account.");
  });

  it("truncates on a boundary when there is no sentence to find", () => {
    const long = "x".repeat(200);
    const title = titleLine(long);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith("…")).toBe(true);
  });

  it("never renders an empty title", () => {
    expect(titleLine("")).toBe("Untitled memory");
    expect(titleLine("***")).toBe("Untitled memory");
  });

  it("describes recency the way a person would", () => {
    const now = Date.now();
    expect(relativeTime(now - 30_000)).toBe("just now");
    expect(relativeTime(now - 2 * 3600_000)).toBe("2h ago");
    expect(relativeTime(now - 3 * 86400_000)).toBe("3d ago");
    expect(relativeTime(0)).toBe("");
  });

  it("maps sources to a badge, falling back rather than blanking", () => {
    expect(sourceBadge("email-gmail").label).toBe("gmail");
    expect(sourceBadge("claude-desktop").label).toBe("claude");
    expect(sourceBadge("cli").label).toBe("cli");
    expect(sourceBadge(undefined).label).toBe("manual");
  });
});
