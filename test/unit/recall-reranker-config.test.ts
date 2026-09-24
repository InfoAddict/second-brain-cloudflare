import { describe, expect, it, vi } from "vitest";
import { CONFIG_KEY, DEFAULTS, readOverrides, resolveConfig, writeOverrides } from "../../src/config";
import { getVariant } from "../eval/variants";
import { makeMemoryKV, makeTestEnv } from "../helpers/make-env";

const envWith = () => makeTestEnv(undefined, { OAUTH_KV: makeMemoryKV() });

describe("RERANK_MODE", () => {
  it("ships as auto", async () => {
    expect(DEFAULTS.RERANK_MODE).toBe("auto");
    expect((await resolveConfig(envWith())).RERANK_MODE).toBe("auto");
  });

  it("accepts off, on and auto on write, and drops a value equal to the default", async () => {
    const env = envWith();
    expect(await writeOverrides(env, { RERANK_MODE: "off" })).toEqual({ ok: true });
    expect((await resolveConfig(env)).RERANK_MODE).toBe("off");
    expect(await writeOverrides(env, { RERANK_MODE: "on" })).toEqual({ ok: true });
    expect((await resolveConfig(env)).RERANK_MODE).toBe("on");
    expect(await writeOverrides(env, { RERANK_MODE: "auto" })).toEqual({ ok: true });
    expect(await readOverrides(env)).toEqual({});
  });

  it.each(["", "ON", "yes", "true", 1, null])("rejects %j on write", async value => {
    const res = await writeOverrides(envWith(), { RERANK_MODE: value as never });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/RERANK_MODE must be one of off, on, auto/);
  });

  it("reads an invalid stored value as off, never as the model", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = envWith();
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify({ RERANK_MODE: "sometimes" }));
    expect((await resolveConfig(env)).RERANK_MODE).toBe("off");
  });
});

describe("the eval variants", () => {
  it("rerank forces the model on through the typed internal flag and targets paraphrase and multi-hop", () => {
    const v = getVariant("rerank");
    expect(v.internal?.variant?.rerank).toBe(true);
    expect(v.internal?.variant?.arms).toBeUndefined();
    expect(v.targetCategories).toEqual(["paraphrase", "multi-hop"]);
    expect(v.config).toBeUndefined();
  });
  it("rerank-auto is the shipped mode with pre-registered targets, so the ship gate needs no --target flag", () => {
    const v = getVariant("rerank-auto");
    expect(v.config).toBeUndefined();
    expect(v.internal).toBeUndefined();
    expect(v.targetCategories).toEqual(["paraphrase", "multi-hop"]);
  });
  it("baseline is the shipped default; no-rerank and the ablations pin the mode off", () => {
    expect(getVariant("baseline").config).toBeUndefined();
    for (const name of ["no-rerank", "like", "fts-orderless", "dense-only", "keyword-only"]) expect(getVariant(name).config?.RERANK_MODE).toBe("off");
  });
});
