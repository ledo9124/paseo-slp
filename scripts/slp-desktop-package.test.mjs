import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { load } from "js-yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = path.join(root, "packages/desktop");

test("desktop packages have a separate installation, shortcut, CLI and update identity", () => {
  const config = load(readFileSync(path.join(desktop, "electron-builder.yml"), "utf8"));
  assert.equal(config.appId, "io.github.ledo9124.paseo-slp");
  assert.equal(config.productName, "Paseo SLP");
  assert.equal(config.executableName, "Paseo SLP");
  assert.equal(config.extraMetadata.name, "paseo-slp-desktop");
  assert.equal(config.deb.packageName, "paseo-slp");
  assert.equal(config.rpm.packageName, "paseo-slp");
  assert.deepEqual(
    config.protocols.flatMap((protocol) => protocol.schemes),
    ["paseo-slp"],
  );
  assert.equal(config.publish.owner, "ledo9124");
  assert.equal(config.publish.repo, "paseo-slp");
  for (const platform of ["mac", "linux", "win"]) {
    assert.match(config[platform].artifactName, /^Paseo-SLP-/);
    const shims = config[platform].extraResources.filter((resource) =>
      resource.to.startsWith("bin/"),
    );
    assert.equal(shims.length, 1);
    assert.match(shims[0].to, /^bin\/paseo-slp(?:\.cmd)?$/);
    assert.ok(readFileSync(path.join(desktop, shims[0].from)).length);
  }
});

test(
  "bundled POSIX CLI preserves spaces and selects SLP despite inherited upstream state",
  {
    skip: process.platform === "win32",
  },
  () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slp bundle with spaces "));
    try {
      const resources = path.join(dir, "resources");
      mkdirSync(path.join(resources, "bin"), { recursive: true });
      const shim = path.join(resources, "bin/paseo-slp");
      cpSync(path.join(desktop, "bin/paseo-slp"), shim);
      chmodSync(shim, 0o755);
      const executable = path.join(dir, "Paseo SLP");
      // Capture the real shell shim's process boundary without needing Electron.
      writeFileSync(
        executable,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), home: process.env.PASEO_HOME, host: process.env.PASEO_HOST, listen: process.env.PASEO_LISTEN, cli: process.env.PASEO_CLI, app: process.env.PASEO_SLP_DESKTOP_APP }));\n`,
      );
      chmodSync(executable, 0o755);
      const slpHome = path.join(dir, "slp home");
      const result = JSON.parse(
        execFileSync(shim, ["daemon", "status", "--json"], {
          encoding: "utf8",
          env: {
            ...process.env,
            APPIMAGE: "",
            PASEO_HOME: path.join(dir, "upstream"),
            PASEO_HOST: "127.0.0.1:6767",
            PASEO_LISTEN: "127.0.0.1:6767",
            PASEO_SLP_HOME: slpHome,
            PASEO_SLP_LISTEN: "127.0.0.1:17777",
          },
        }),
      );
      assert.equal(result.home, slpHome);
      assert.equal(result.host, "127.0.0.1:17777");
      assert.equal(result.listen, result.host);
      assert.equal(result.cli, shim);
      assert.equal(path.resolve(result.app), executable);
      assert.deepEqual(result.args.slice(-3), ["daemon", "status", "--json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
