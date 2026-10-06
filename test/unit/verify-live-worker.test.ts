import { describe, expect, it, vi } from "vitest";
import {
  LIVE_VERIFY_ATTEMPTS,
  LIVE_VERIFY_RETRY_DELAY_MS,
  LIVE_VERIFY_TIMEOUT_SECONDS,
  CONFIG_WARMUP_TIMEOUT_SECONDS,
  LiveHealthError,
  parseCurlMetrics,
  requestHealthWithCurl,
  verifyLiveWorker,
  warmLiveWorkerConfig,
} from "../../scripts/verify-live-worker.mjs";

const options = {
  baseUrl: "https://brain.example.test/",
  token: "test-token",
  expectedVersion: "4.0.0",
  log: vi.fn(),
  warmConfig: () => {},
};

describe("verifyLiveWorker", () => {
  it("allows cold-isolate startup while retaining bounded retries", () => {
    expect(LIVE_VERIFY_ATTEMPTS).toBe(5);
    expect(LIVE_VERIFY_TIMEOUT_SECONDS).toBe(30);
    expect(LIVE_VERIFY_RETRY_DELAY_MS).toBe(3_000);
    expect(CONFIG_WARMUP_TIMEOUT_SECONDS).toBe(60);
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

  it("warms authenticated config with a 60-second curl request before health checks", () => {
    const runCurl = vi.fn().mockReturnValue({
      status: 0,
      stdout: '{}\n__SECOND_BRAIN_CURL_METRICS__200,0.001,0.002,0.003,0.004,0.005,2',
    });
    const log = vi.fn();

    warmLiveWorkerConfig({ ...options, runCurl, log });
    expect(runCurl).toHaveBeenCalledWith("curl", expect.arrayContaining(["--max-time", "60"]), expect.objectContaining({
      input: expect.stringContaining("/config\""),
    }));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^Live config warmup succeeded in \d+ms: HTTP 200$/));
  });

  it("halts before health checks when config warmup fails", async () => {
    const warmConfig = vi.fn(() => { throw new LiveHealthError("config warmup returned a non-200 status", { status: 503 }); });
    const requestHealth = vi.fn();

    await expect(verifyLiveWorker({ ...options, warmConfig, requestHealth })).rejects.toThrow("config warmup returned a non-200 status");
    expect(requestHealth).not.toHaveBeenCalled();
  });

  it("passes credentials to curl via stdin configuration and never logs the body", () => {
    const runCurl = vi.fn().mockReturnValue({
      status: 0,
      stdout: '{"ok":true,"version":"4.0.0"}\n__SECOND_BRAIN_CURL_METRICS__200,0.001,0.002,0.003,0.004,0.005,42',
    });

    expect(requestHealthWithCurl({ ...options, runCurl })).toEqual({ ok: true, version: "4.0.0" });
    expect(runCurl).toHaveBeenCalledWith("curl", expect.arrayContaining([
      "--config", "-", "--max-time", "30",
    ]), expect.objectContaining({
      input: expect.stringContaining("Authorization: Bearer test-token"),
    }));
    expect(runCurl.mock.calls[0][1].join(" ")).not.toContain("test-token");
  });

  it("reports only valid numeric curl timing diagnostics for transport failures", () => {
    const output = 'private response body\n__SECOND_BRAIN_CURL_METRICS__000,0.001,0.002,0.003,0.004,10.000,0';
    expect(parseCurlMetrics(output)).toEqual(expect.objectContaining({
      status: 0,
      diagnostics: "HTTP 000; dns=0.001s connect=0.002s tls=0.003s starttransfer=0.004s total=10s downloaded=0B",
    }));

    const runCurl = vi.fn().mockReturnValue({ status: 28, stdout: output });
    expect(() => requestHealthWithCurl({ ...options, runCurl })).toThrow(
      "transport exit-28; HTTP 000; dns=0.001s connect=0.002s tls=0.003s starttransfer=0.004s total=10s downloaded=0B",
    );
  });

  it("still rejects a non-200 health response before parsing its body", () => {
    const runCurl = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'private response body\n__SECOND_BRAIN_CURL_METRICS__503,0.001,0.002,0.003,0.004,0.005,42',
    });

    expect(() => requestHealthWithCurl({ ...options, runCurl })).toThrow(
      "HTTP 503; dns=0.001s connect=0.002s tls=0.003s starttransfer=0.004s total=0.005s downloaded=42B",
    );
  });

  it("drops malformed timing diagnostics rather than reporting response content", () => {
    const output = 'private response body\n__SECOND_BRAIN_CURL_METRICS__000,,0.002,0.003,0.004,10.000,0';
    expect(parseCurlMetrics(output)).toBeUndefined();

    const runCurl = vi.fn().mockReturnValue({ status: 28, stdout: output });
    expect(() => requestHealthWithCurl({ ...options, runCurl })).toThrow("transport exit-28");
    expect(() => requestHealthWithCurl({ ...options, runCurl })).not.toThrow("private response body");
  });
});
