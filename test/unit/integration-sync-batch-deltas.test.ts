import { describe, it, expect, vi, afterEach } from "vitest";
import { makeMemoryKV } from "../helpers/make-env";
import { notionProvider, makeCalendarProvider, loadIntegration } from "../../src/integrations";
import type { IntegrationRecord } from "../../src/integrations";

// #348 follow-up. A sync now records its writes as deltas over its read
// snapshot and applies them to a fresh record at save time. Within one batch a
// later iteration must still see earlier successful puts/deletes, exactly as
// the old in-place writes made it: otherwise a repeated key creates a second,
// untracked mirror (only the last mapping survives) or repeats a deletion.

const DAY_MS = 86_400_000;

function seed(provider: string, itemMap: IntegrationRecord["itemMap"] = {}): IntegrationRecord {
  return {
    provider,
    authKind: "token",
    credentials: { token: provider === "notion" ? "secret" : "https://cal.example/x.ics" },
    config: { mirrorWorkspace: "personal" },
    status: "connected",
    workspaceName: "ws",
    lastSyncedAt: null,
    lastSyncError: null,
    itemMap,
    createdAt: 1,
    updatedAt: 1,
  };
}

// Distinct generated ids, so a duplicate create is visible as e-2.
function store() {
  let n = 0;
  return {
    createEntry: vi.fn(async () => `e-${++n}`),
    updateEntry: vi.fn(async () => true),
    deleteEntry: vi.fn(async (_id: string) => {}),
  };
}

function page(id: string, lastEdited: string, archived = false) {
  return {
    object: "page", id, last_edited_time: lastEdited, archived,
    url: `https://notion.so/${id}`,
    properties: { title: { type: "title", title: [{ plain_text: id }] } },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Notion sync: in-batch reads see earlier deltas", () => {
  it("a page listed twice is created once, then updated in place", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:notion", JSON.stringify(seed("notion")));
    let search = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith("/search")
        ? { results: [page("p", ++search === 1 ? "v1" : "v2")], has_more: search === 1, next_cursor: "next" }
        : { results: [], has_more: false },
    })));
    const s = store();

    const out = await notionProvider.sync({ OAUTH_KV: kv }, s);

    expect(out).toMatchObject({ ok: true, created: 1, updated: 1, failed: 0 });
    expect(s.createEntry).toHaveBeenCalledTimes(1);
    expect(s.updateEntry).toHaveBeenCalledWith("e-1", expect.any(String));
    expect((await loadIntegration({ OAUTH_KV: kv }, "notion"))!.itemMap.p).toEqual({ entryId: "e-1", version: "v2" });
  });

  it("a page archived twice is deleted and counted once", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:notion", JSON.stringify(seed("notion", { p: { entryId: "old", version: "v0" } })));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith("/search")
        ? { results: [page("p", "v1", true), page("p", "v1", true)], has_more: false }
        : { results: [], has_more: false },
    })));
    const s = store();

    const out = await notionProvider.sync({ OAUTH_KV: kv }, s);

    expect(out).toMatchObject({ ok: true, deleted: 1 });
    expect(s.deleteEntry).toHaveBeenCalledTimes(1);
    expect((await loadIntegration({ OAUTH_KV: kv }, "notion"))!.itemMap).toEqual({});
  });

  it("a page re-created earlier in the run is deleted by its NEW entry id, not the obsolete one", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:notion", JSON.stringify(seed("notion", { p: { entryId: "old", version: "v0" } })));
    // Listed live (changed) and archived (delete signal) in one listing.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith("/search")
        ? { results: [page("p", "v1"), page("p", "v1", true)], has_more: false }
        : { results: [], has_more: false },
    })));
    const s = store();
    s.updateEntry.mockResolvedValue(false as never); // mirror gone out-of-band: re-create

    const out = await notionProvider.sync({ OAUTH_KV: kv }, s);

    expect(out).toMatchObject({ ok: true, created: 1, deleted: 1 });
    expect(s.deleteEntry).toHaveBeenCalledTimes(1);
    expect(s.deleteEntry).toHaveBeenCalledWith("e-1");
    expect((await loadIntegration({ OAUTH_KV: kv }, "notion"))!.itemMap).toEqual({});
  });
});

describe("calendar sync: in-batch reads see earlier deltas", () => {
  it("two orphan recurrence overrides sharing one map key create one mirror, then update it", async () => {
    const kv = makeMemoryKV();
    await kv.put("integrations:calendar-google", JSON.stringify(seed("calendar-google")));
    const now = Date.now();
    const fmt = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    // No master VEVENT: the parser emits each override standalone, keyed by the shared UID.
    const events = [1, 2].flatMap((i) => [
      "BEGIN:VEVENT", "UID:series@test", `RECURRENCE-ID:${fmt(now + i * DAY_MS)}`,
      `DTSTART:${fmt(now + i * DAY_MS)}`, `DTEND:${fmt(now + i * DAY_MS + 3600_000)}`,
      `DTSTAMP:${fmt(now + i * 1000)}`, `SUMMARY:Meeting ${i}`, "END:VEVENT",
    ]);
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...events, "END:VCALENDAR"].join("\r\n");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => ics })));
    const s = store();
    const provider = makeCalendarProvider({ id: "calendar-google", name: "Google Calendar", connectLabel: "", connectPlaceholder: "", connectHint: "" });

    const out = await provider.sync({ OAUTH_KV: kv }, s);

    expect(out).toMatchObject({ ok: true, total: 2, created: 1, updated: 1, failed: 0 });
    expect(s.createEntry).toHaveBeenCalledTimes(1);
    expect(s.updateEntry).toHaveBeenCalledWith("e-1", expect.any(String));
    const rec = (await loadIntegration({ OAUTH_KV: kv }, "calendar-google"))!;
    expect(Object.keys(rec.itemMap)).toEqual(["series@test"]);
    expect(rec.itemMap["series@test"].entryId).toBe("e-1"); // the one mirror stays tracked
  });
});
