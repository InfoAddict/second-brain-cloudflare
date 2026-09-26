import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Removes everything the current test file made under os.tmpdir(). vitest.setup.ts points TMPDIR at a root private
 * to the file and fails the file if anything is left in it, so call this from afterEach (dirs made per test) or
 * afterAll (dirs a suite shares) in any file that calls mkdtemp.
 */
export function cleanTemp(): void {
  if (!process.env.SB_TEST_TMP_ROOT || tmpdir() === process.env.SB_TEST_TMP_ROOT) throw new Error("cleanTemp only runs inside a test file's private temp root");
  for (const entry of readdirSync(tmpdir())) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
}
