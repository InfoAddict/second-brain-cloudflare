import { describe, it, expect } from "vitest";
import { classifyVolatility, shouldFlagStale } from "../../src/staleness/heuristic";

describe("classifyVolatility", () => {
  it("marks birthdays as durable", () => {
    expect(classifyVolatility("Alice's birthday is March 12")).toBe("durable");
  });

  it("marks employment as state", () => {
    expect(classifyVolatility("Bob works at Acme Corp as a PM")).toBe("state");
  });

  it("marks task tag as volatile", () => {
    expect(classifyVolatility("Finish the report", ["task"])).toBe("volatile");
  });

  it("returns null when uncertain", () => {
    expect(classifyVolatility("Some random note without clear signals")).toBeNull();
  });

  it("does not false-positive on email addresses", () => {
    expect(classifyVolatility("Send the report to alice@example.com by Friday")).toBeNull();
  });

  it("does not false-positive on scheduled handler mentions", () => {
    expect(classifyVolatility("The scheduled handler runs compression nightly")).toBeNull();
  });

  it("does not false-positive on API paths", () => {
    expect(classifyVolatility("GET /api/v1/recall?query=test")).toBeNull();
  });
});

describe("shouldFlagStale", () => {
  it("flags state and volatile only", () => {
    expect(shouldFlagStale("state")).toBe(true);
    expect(shouldFlagStale("volatile")).toBe(true);
    expect(shouldFlagStale("durable")).toBe(false);
    expect(shouldFlagStale(null)).toBe(false);
  });
});
