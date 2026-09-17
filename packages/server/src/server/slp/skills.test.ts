import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { installSlpSkills, resolveBundledSlpSkillsDir, type SlpSkillTargets } from "./skills.js";

describe("SLP skill installation", () => {
  let root: string;
  let targets: SlpSkillTargets;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "slp-skills-"));
    targets = {
      agentsDir: path.join(root, "agents"),
      claudeDir: path.join(root, "claude"),
      codexDir: path.join(root, "codex"),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function bundle(files: Record<string, string>): Promise<string> {
    const sourceDir = path.join(root, "bundle");
    for (const [relative, body] of Object.entries(files)) {
      const file = path.join(sourceDir, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body, "utf8");
    }
    return sourceDir;
  }

  test("every bundled skill lands in all three provider directories", async () => {
    const sourceDir = await bundle({
      "slp-cross-review/SKILL.md": "review",
      "slp-other/SKILL.md": "other",
    });

    const installed = await installSlpSkills({ sourceDir, targets, logger: createTestLogger() });

    expect(installed.sort()).toEqual(["slp-cross-review", "slp-other"]);
    for (const dir of [targets.agentsDir, targets.claudeDir, targets.codexDir]) {
      expect(await readFile(path.join(dir, "slp-cross-review", "SKILL.md"), "utf8")).toBe("review");
    }
  });

  test("a later boot replaces what an earlier one installed", async () => {
    const sourceDir = await bundle({ "slp-cross-review/SKILL.md": "first" });
    await installSlpSkills({ sourceDir, targets, logger: createTestLogger() });

    await writeFile(path.join(sourceDir, "slp-cross-review", "SKILL.md"), "second", "utf8");
    await installSlpSkills({ sourceDir, targets, logger: createTestLogger() });

    expect(
      await readFile(path.join(targets.claudeDir, "slp-cross-review", "SKILL.md"), "utf8"),
    ).toBe("second");
  });

  test("installation never removes a skill that is no longer bundled", async () => {
    const sourceDir = await bundle({ "slp-cross-review/SKILL.md": "review" });
    await installSlpSkills({ sourceDir, targets, logger: createTestLogger() });
    await rm(path.join(sourceDir, "slp-cross-review"), { recursive: true, force: true });
    await writeFile(path.join(sourceDir, "keep.txt"), "not a skill", "utf8");

    // A host that installed a name we later drop keeps it rather than having it
    // deleted underneath a session that may be using it.
    await installSlpSkills({ sourceDir, targets, logger: createTestLogger() });

    expect(
      await readFile(path.join(targets.codexDir, "slp-cross-review", "SKILL.md"), "utf8"),
    ).toBe("review");
  });

  test("a missing bundle is reported and installs nothing", async () => {
    const installed = await installSlpSkills({
      sourceDir: path.join(root, "absent"),
      targets,
      logger: createTestLogger(),
    });

    expect(installed).toEqual([]);
  });

  test("the bundle ships the cross-review skill and resolves without a build", async () => {
    // Guards the dev path: the daemon reads the repository copy directly, so a
    // rename of `skills-slp/` would otherwise only surface in a packaged build.
    const sourceDir = resolveBundledSlpSkillsDir();
    const skill = await readFile(path.join(sourceDir, "slp-cross-review", "SKILL.md"), "utf8");

    expect(skill).toContain("name: slp-cross-review");
    expect(skill).toContain("The reviewer is never the author.");
  });
});
