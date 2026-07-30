/**
 * #235 — which screen a password change lands on, and what it is allowed to say.
 *
 * The desktop app has no test setup of its own: `installer/` ships a Vite build
 * and nothing else, and `main.ts` cannot even be imported outside a webview (it
 * resolves `#app` at module scope). So the rules that decide between "nothing
 * was changed", "it may already be live" and "changed, but not saved here" live
 * in `installer/src/rotation-state.ts`, which imports nothing at all and is
 * therefore reachable from here.
 *
 * They are worth reaching. Each of these three screens exists because the other
 * two would be a lie, and the cost of picking the wrong one is a user who
 * believes their old password still works when it does not — after which the
 * brain has no key at all.
 */
import { describe, it, expect } from "vitest";
import {
  localFailureCopy,
  rotateErrorOf,
  screenForFailure,
  screenForOutcome,
  withAddress,
  type RotateOutcome,
} from "../../installer/src/rotation-state";

const ok: RotateOutcome = { keychain: true, cliConfig: true, dashboard: true };

describe("reading what rotate_password rejected with", () => {
  it("keeps a stage it recognises", () => {
    expect(rotateErrorOf({ stage: "notSent", detail: "expired" })).toEqual({
      stage: "notSent",
      detail: "expired",
    });
  });

  it("treats anything it cannot read as 'may already be live'", () => {
    // The asymmetry is deliberate and this is the test that pins it. Guessing
    // "notSent" on an unreadable rejection tells a user whose password may have
    // already changed that nothing happened; guessing "unconfirmed" only ever
    // costs them a retry that is idempotent either way.
    for (const junk of ["a string", null, undefined, 42, { stage: "elsewhere" }, {}]) {
      expect(rotateErrorOf(junk).stage).toBe("unconfirmed");
    }
  });

  it("recognises the stage a rebuild-in-flight refusal carries", () => {
    expect(rotateErrorOf({ stage: "blocked", detail: "rebuilding" }).stage).toBe("blocked");
  });
});

describe("a run that succeeded remotely", () => {
  it("lands on the done screen only when every local store took it", () => {
    expect(screenForOutcome(ok)).toBe("done");
    // A CLI that was never installed is not a failure and gets no screen.
    expect(screenForOutcome({ ...ok, cliConfig: null })).toBe("done");
  });

  it("does not claim this computer is using the new password when it isn't", () => {
    expect(screenForOutcome({ ...ok, keychain: false })).toBe("failLocal");
    expect(screenForOutcome({ ...ok, cliConfig: false })).toBe("failLocal");
    // The one that used to be dropped: the dashboard window is told its new
    // password at creation, so an open one sits on a dead value until someone
    // says otherwise. Reporting that run as a clean success left a window
    // 401ing with nothing on screen to explain it.
    expect(screenForOutcome({ ...ok, dashboard: false })).toBe("failLocal");
  });
});

describe("which failure screen", () => {
  it("maps each stage to its own screen on a first attempt", () => {
    expect(screenForFailure("notSent", false)).toBe("failNotSent");
    expect(screenForFailure("unconfirmed", false)).toBe("failUnsure");
    expect(screenForFailure("local", false)).toBe("failLocal");
    expect(screenForFailure("blocked", false)).toBe("blocked");
  });

  it("never says 'nothing was changed' after an attempt that may have changed something", () => {
    // The sequence: attempt one PUTs the secret and the health poll times out,
    // so the app correctly says the new password may already be live. The user
    // clicks Try again. Attempt two dies *before* the PUT — an expired sign-in,
    // a transient account lookup — which taken alone is honestly "notSent".
    //
    // Showing that screen would read: "your old one still works and everything
    // is exactly as it was". The old one is dead.
    expect(screenForFailure("notSent", true)).toBe("failUnsure");
    expect(screenForFailure("blocked", true)).toBe("failUnsure");
  });

  it("lets the local stage overrule the doubt, because it resolves it", () => {
    // "local" means the brain confirmed the new password. That is the ambiguity
    // ending in the direction that leaves nothing to be unsure about.
    expect(screenForFailure("local", true)).toBe("failLocal");
  });
});

describe("the 'changed, but not saved here' screen", () => {
  it("names secure storage, and offers a way back in, when that is what failed", () => {
    const copy = localFailureCopy({ keychain: false, cliConfig: null, dashboard: true });
    expect(copy.title).toBe("changePassword.failLocalTitle");
    expect(copy.notice).toBe("changePassword.failLocalBody");
    expect(copy.reconnect).toBe(true);
  });

  it("treats a stage-'local' failure, which has no outcome at all, as the same case", () => {
    const copy = localFailureCopy(null);
    expect(copy.title).toBe("changePassword.failLocalTitle");
    expect(copy.reconnect).toBe(true);
  });

  it("does not keep the unconditional heading when secure storage succeeded", () => {
    // The defect this pins: the body switched to the CLI-specific message while
    // the heading went on saying "not saved on this computer". It was saved on
    // this computer. Title and body contradicted each other and the title was
    // the false one.
    const cliOnly = localFailureCopy({ keychain: true, cliConfig: false, dashboard: true });
    expect(cliOnly.title).toBe("changePassword.failLocalTitlePartial");
    expect(cliOnly.notice).toBe("changePassword.failLocalCli");
    expect(cliOnly.extra).toEqual([]);
    // ...and the dashboard button still works, because this computer can open
    // its own brain.
    expect(cliOnly.reconnect).toBe(false);

    const dashboardOnly = localFailureCopy({ keychain: true, cliConfig: true, dashboard: false });
    expect(dashboardOnly.title).toBe("changePassword.failLocalTitlePartial");
    expect(dashboardOnly.notice).toBe("changePassword.failLocalDashboard");
    expect(dashboardOnly.reconnect).toBe(false);
  });

  it("mentions every store that missed it, not only the first", () => {
    const all = localFailureCopy({ keychain: false, cliConfig: false, dashboard: false });
    expect(all.notice).toBe("changePassword.failLocalBody");
    expect(all.extra).toEqual([
      "changePassword.failLocalCli",
      "changePassword.failLocalDashboard",
    ]);

    const bothLesser = localFailureCopy({ keychain: true, cliConfig: false, dashboard: false });
    expect(bothLesser.notice).toBe("changePassword.failLocalCli");
    expect(bothLesser.extra).toEqual(["changePassword.failLocalDashboard"]);
  });
});

describe("Door B's address travelling with the call", () => {
  it("is sent when there is one", () => {
    // Both `rotate_password` and `recheck_password` take `address:
    // Option<String>`, and a missing key deserialises to None — which resolves
    // the setup stored on *this* computer. Door B is by definition a computer
    // with no stored setup, so omitting it does not fall back to the right
    // brain; it probes a different one or none at all.
    expect(withAddress({ password: "pw" }, "https://brain.example.workers.dev")).toEqual({
      password: "pw",
      address: "https://brain.example.workers.dev",
    });
  });

  it("is omitted on Door A, where the command resolves the stored address", () => {
    expect(withAddress({ newPassword: "pw" }, null)).toEqual({ newPassword: "pw" });
    expect(withAddress({ newPassword: "pw" }, "")).toEqual({ newPassword: "pw" });
  });
});
