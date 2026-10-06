import { describe, expect, it, vi } from "vitest";
import {
  LIVE_VERIFY_ATTEMPTS,
  LIVE_VERIFY_RETRY_DELAY_MS,
  LIVE_VERIFY_TIMEOUT_SECONDS,
  LiveHealthError,
  requestHealthWithCurl,
  verifyLiveWorker,
} from "../../scripts/verify-live-worker.mjs";

const options = {
  baseUrl: "https://brain.example.test/",
  token: "test-token",
  expectedVersion: "4.0.0",
  log: vi.fn(),
};

describe("verifyLiveWorker", () => {
  it("keeps the production retry, timeout, and delay budget", () => {
    expect(LIVE_VERIFY_ATTEMPTS).toBe(5);
    expect(LIVE_VERIFY_TIMEOUT_SECONDS).toBe(10);
    expect(LIVE_VERIFY_RETRY_DELAY_MS).toBe(3_000);
  });

  it.each([
    ["wrong version", { ok: true, version: "3.9.9" }, /expected Worker v4.0.0; received v3.9.9/],
    ["unhealthy response", { ok: false, version: "4.0.0" }, /health response is not ok:true/],
  ])("rejects a %s response", async (_name, health, error) => {
    await expect(verifyLiveWorker({
      ...options,
      attempts: 1,
      requestHealth: () => health,
    })).rejects.toThrow(error);
  });

  it("rejects HTTP and transport failures without exposing a response body", async () => {
    await expect(verifyLiveWorker({
      ...options,
      attempts: 1,
      requestHealth: () => { throw new LiveHealthError("HTTP 503"); },
    })).rejects.toThrow("HTTP 503");
    await expect(verifyLiveWorker({
      ...options,
      attempts: 1,
      requestHealth: () => { throw new LiveHealthError("transport exit-28"); },
    })).rejects.toThrow("transport exit-28");
  });

  it("retries failed checks and eventually accepts the exact version", async () => {
    const requestHealth = vi.fn()
      .mockImplementationOnce(() => { throw new LiveHealthError("transport exit-28"); })
      .mockImplementationOnce(() => { throw new LiveHealthError("HTTP 503"); })
      .mockReturnValue({ ok: true, version: "4.0.0" });
    const wait = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(verifyLiveWorker({ ...options, requestHealth, wait, log })).resolves.toEqual({ ok: true, version: "4.0.0" });
    expect(requestHealth).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, LIVE_VERIFY_RETRY_DELAY_MS);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("succeeded"));
  });

  it("passes credentials to curl via stdin configuration and never logs the body", () => {
    const runCurl = vi.fn().mockReturnValue({
      status: 0,
      stdout: '{"ok":true,"version":"4.0.0"}\n__SECOND_BRAIN_HTTP_STATUS__200',
    });

    expect(requestHealthWithCurl({ ...options, runCurl })).toEqual({ ok: true, version: "4.0.0" });
    expect(runCurl).toHaveBeenCalledWith("curl", expect.arrayContaining([
      "--config", "-", "--max-time", "10",
    ]), expect.objectContaining({
      input: expect.stringContaining("Authorization: Bearer test-token"),
    }));
    expect(runCurl.mock.calls[0][1].join(" ")).not.toContain("test-token");
  });
});
