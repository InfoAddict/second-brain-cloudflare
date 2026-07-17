import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { makeTestEnv } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/index";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const release = {
  releaseTag: "v2.1.0",
  releaseName: "Second Brain v2.1.0",
  releaseUrl: "https://github.com/rahilp/second-brain-cloudflare/releases/tag/v2.1.0",
};

describe("Release notification", () => {
  let env: Env;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn().mockResolvedValue({ messageId: "message-123" });
    env = makeTestEnv(undefined, {
      RELEASE_EMAIL: { send } as unknown as SendEmail,
    });
  });

  it("requires authentication", async () => {
    const response = await worker.fetch(
      req("POST", "/internal/release-notification", { body: release, token: null }),
      env,
      ctx,
    );

    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects non-GitHub release links", async () => {
    const response = await worker.fetch(
      req("POST", "/internal/release-notification", {
        body: { ...release, releaseUrl: "https://example.com/release/v2.1.0" },
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the applied release and release-notes link to Dan", async () => {
    const response = await worker.fetch(
      req("POST", "/internal/release-notification", { body: release }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, messageId: "message-123", test: false });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: "releases@updates.infoaddict.net",
      to: "dan@infoaddict.net",
      subject: "Second Brain updated: v2.1.0",
      text: expect.stringContaining(release.releaseUrl),
      html: expect.stringContaining(release.releaseUrl),
    }));
  });

  it("labels setup emails as tests", async () => {
    const response = await worker.fetch(
      req("POST", "/internal/release-notification", { body: { ...release, test: true } }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      subject: "Second Brain release email test",
    }));
  });

  it("returns an error when Cloudflare cannot send", async () => {
    send.mockRejectedValue(new Error("send failed"));

    const response = await worker.fetch(
      req("POST", "/internal/release-notification", { body: release }),
      env,
      ctx,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "Release notification email failed" });
  });
});
