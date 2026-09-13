import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "@getpaseo/server";
import { resolveDefaultDaemonHosts } from "./client.js";

it("does not fall back to upstream Paseo when the SLP daemon has not started", () => {
  const home = mkdtempSync(path.join(tmpdir(), "slp-isolation-"));
  try {
    const env = { PASEO_HOME: home };
    expect(loadConfig(home, { env }).listen).toBe("127.0.0.1:6777");
    expect(resolveDefaultDaemonHosts(env)).toEqual(["localhost:6777"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
