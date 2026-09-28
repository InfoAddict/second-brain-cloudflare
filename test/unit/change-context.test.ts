import { describe, it, expectTypeOf } from "vitest";
import type { AuditChannel, ChangeContext } from "../../src/lib/audit";

describe("ChangeContext", () => {
  it("names the channels a change can come from", () => {
    expectTypeOf<"rest">().toExtend<AuditChannel>();
    expectTypeOf<"mcp">().toExtend<AuditChannel>();
    expectTypeOf<"system:digest">().toExtend<AuditChannel>();
    expectTypeOf<"unspecified">().toExtend<AuditChannel>();
    expectTypeOf<"web">().not.toExtend<AuditChannel>();
  });

  it("requires both an actor and a channel, and allows an optional client label", () => {
    expectTypeOf<ChangeContext>().toEqualTypeOf<{ actorId: string; channel: AuditChannel; client?: string }>();
    expectTypeOf<{ actorId: string }>().not.toExtend<ChangeContext>();
    expectTypeOf<{ actorId: string; channel: AuditChannel }>().toExtend<ChangeContext>();
  });
});
