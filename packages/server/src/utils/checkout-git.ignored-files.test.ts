import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { getCheckoutDiff, getCheckoutShortstat } from "./checkout-git.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "paseo-ignore-"));
  roots.push(root);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  for (const name of ["visible.txt", "skip.txt", "assume.txt"])
    writeFileSync(join(root, name), "base\n");
  git(root, ["add", "."]);
  git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

test("diff and shortstat honor ignore rules and index flags for local edits", async () => {
  const root = repository();
  git(root, ["update-index", "--skip-worktree", "skip.txt"]);
  git(root, ["update-index", "--assume-unchanged", "assume.txt"]);
  writeFileSync(join(root, ".git/info/exclude"), "excluded.txt\n");
  for (const name of ["skip.txt", "assume.txt", "ignored.txt", "excluded.txt"])
    writeFileSync(join(root, name), "hidden\nextra\n");
  writeFileSync(join(root, "visible.txt"), "base\nvisible\n");
  const diff = await getCheckoutDiff(root, { mode: "uncommitted", includeStructured: true });
  expect(diff.diff).toContain("+visible");
  for (const name of ["skip.txt", "assume.txt", "ignored.txt", "excluded.txt"])
    expect(diff.diff).not.toContain(name);
  expect(await getCheckoutShortstat(root, undefined, { force: true })).toEqual({
    additions: 1,
    deletions: 0,
  });
});
