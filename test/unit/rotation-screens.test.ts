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
  blockedCopy,
  localFailureCopy,
  recheckArgs,
  rotateArgs,
  rotateErrorOf,
  screenForFailure,
  screenForOutcome,
  withAddress,
  ROTATION_STEP_IDS,
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
  });

  it("still shows the blocked screen after an attempt that may have landed", () => {
    // This assertion used to read `.toBe("failUnsure")`, and that was the bug.
    //
    // "blocked" is the one stage that is not a report on what happened — it is
    // an instruction, and this is the only screen that carries it. The escape
    // paragraph and the Advanced Settings button are the sole route out of an
    // abandoned rebuild ledger, which is exactly why the stage was split out of
    // "notSent" in the first place.
    //
    // The sticky flag was undoing the split for one sequence: once any attempt
    // reached "unconfirmed", every later attempt — all of them blocked, none of
    // them capable of succeeding — rendered "may already be live" with a "Try
    // again" button and no mention of the rebuild. The user retries forever
    // against a gate whose key is in another window they have no reason to
    // open.
    //
    // Both facts are true and neither is optional, so the screen carries both:
    // it is blocked, *and* the password may already be live.
    expect(screenForFailure("blocked", true)).toBe("blocked");
  });

  it("lets the local stage overrule the doubt, because it resolves it", () => {
    // "local" means the brain confirmed the new password. That is the ambiguity
    // ending in the direction that leaves nothing to be unsure about.
    expect(screenForFailure("local", true)).toBe("failLocal");
  });
});

describe("the blocked screen, when an earlier attempt may already have landed", () => {
  it("says nothing about a live password on a run where nothing was sent", () => {
    const copy = blockedCopy(false);
    expect(copy.liveNotice).toBe(null);
    // Nothing reached the brain, so the old password still works and this one
    // demonstrably does not. Calling it "your new password" here would tell
    // someone who saved it that they now hold the working key.
    expect(copy.passwordLabel).toBe("changePassword.failNotSentLabel");
    expect(copy.guardLeaving).toBe(false);
  });

  it("carries the warning the failUnsure screen would have carried", () => {
    const copy = blockedCopy(true);
    // Without this, rendering the blocked screen after an unconfirmed attempt
    // would drop the may-already-be-live warning entirely — which is what made
    // routing to failUnsure look like the lesser evil.
    expect(copy.liveNotice).toBe("changePassword.blockedMayBeLive");
  });

  it("does not call a password that may be live 'not in use'", () => {
    // The label failNotSentLabel spells out "not in use". After an attempt that
    // reached the brain and never confirmed, that may be the only key the brain
    // still answers to — and this screen offers no Try again to settle it, so
    // the user's next move is deciding whether to keep what is on screen.
    expect(blockedCopy(true).passwordLabel).toBe("changePassword.passwordLabel");
  });

  it("asks before letting the only copy of it be closed", () => {
    // The same acknowledgement failUnsure guards its exit with, for the same
    // reason: this window may hold the only password that opens the brain.
    expect(blockedCopy(true).guardLeaving).toBe(true);
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

describe("what crosses the IPC boundary", () => {
  it("keys the checklist on the step ids the Rust side emits", () => {
    // These must match the `Step` variants in
    // `installer/src-tauri/src/cf/provision.rs` — Step::Secret, Step::Confirm,
    // Step::Local — as that enum's `rename_all` serialises them. The Rust half
    // is pinned by `the_step_ids_on_the_wire_are_the_ones_the_screens_key_on`
    // in the same file; this is the other half, and both are needed.
    //
    // Nothing else catches a drift. Every one of the seven ids in `StepId` is a
    // legal value for a rotation row, so writing `finish` where `secret`
    // belongs type-checks, builds, and passes the whole suite — while the
    // checklist sits at three static bullets for the entire run under copy
    // reading "Leave this window open". That is the exact defect this branch
    // was opened to fix, and until this assertion existed it could be
    // reintroduced by a one-word edit.
    expect([...ROTATION_STEP_IDS]).toEqual(["secret", "confirm", "local"]);
  });

  it("names the rotate arguments the way the command declares them", () => {
    // `commands::rotate_password(new_password: String, address: Option<String>)`
    // and `commands::recheck_password(password: String, address: Option<String>)`.
    // Tauri matches an argument bag to those parameters by name, camelCase to
    // snake_case, and a key that matches nothing is not a type error at either
    // end — the call compiles, ships, and fails only when a user runs it.
    expect(rotateArgs("pw", null)).toEqual({ newPassword: "pw" });
    expect(recheckArgs("pw", null)).toEqual({ password: "pw" });
    // …and the address, when Door B supplies one, keeps the name the commands
    // declare too.
    expect(rotateArgs("pw", "https://brain.example.workers.dev")).toEqual({
      newPassword: "pw",
      address: "https://brain.example.workers.dev",
    });
    expect(recheckArgs("pw", "https://brain.example.workers.dev")).toEqual({
      password: "pw",
      address: "https://brain.example.workers.dev",
    });
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
