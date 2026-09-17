import { existsSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Logger } from "pino";

/**
 * `skills-slp/` is the source; `build:lib` copies it next to the compiled
 * server as `slp-skills`, the same way `slp-roles` travels.
 *
 * It is deliberately not part of `skills/`: the orchestration-skills
 * controller enumerates that directory and removes by name, so anything in it
 * becomes selectable and removable through the host's skills settings. A role
 * method a Lead is told to reach for cannot be one a host may have switched
 * off, so these install unconditionally and out of that controller's sight.
 */
export function resolveBundledSlpSkillsDir(moduleUrl: string | URL = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "slp-skills"),
    path.resolve(moduleDir, "..", "..", "..", "..", "..", "skills-slp"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export interface SlpSkillTargets {
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
}

export interface InstallSlpSkillsOptions {
  sourceDir?: string;
  targets: SlpSkillTargets;
  logger: Logger;
}

/**
 * Copy every bundled SLP skill into each provider's skill directory, replacing
 * what is there. Runs on every boot so an edited bundle reaches the next
 * session, and never removes anything: a name that leaves the bundle stops
 * being refreshed rather than being deleted out from under a host.
 *
 * Installation is best effort. A provider directory that cannot be written is
 * logged and skipped — a Lead without the method still delegates, and failing
 * the daemon's start over an optional technique would be the worse trade.
 */
export async function installSlpSkills(options: InstallSlpSkillsOptions): Promise<string[]> {
  const sourceDir = options.sourceDir ?? resolveBundledSlpSkillsDir();
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const skills = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (skills.length === 0) {
    options.logger.warn({ sourceDir }, "SLP skills bundle is empty or missing");
    return [];
  }

  const targets = [options.targets.agentsDir, options.targets.claudeDir, options.targets.codexDir];
  const installed: string[] = [];
  for (const name of skills) {
    let anywhere = false;
    for (const target of targets) {
      try {
        await mkdir(target, { recursive: true });
        await cp(path.join(sourceDir, name), path.join(target, name), {
          recursive: true,
          force: true,
        });
        anywhere = true;
      } catch (error) {
        options.logger.warn(
          { err: error, skill: name, target },
          "SLP skill could not be installed",
        );
      }
    }
    if (anywhere) installed.push(name);
  }
  options.logger.info({ installed }, "SLP skills installed");
  return installed;
}
