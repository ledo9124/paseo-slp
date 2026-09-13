import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPackagedSlpEnvironment } from "./slp-environment.js";

describe("packaged Paseo SLP environment", () => {
  it("isolates repeated GUI launches from an upstream terminal's daemon", () => {
    const home = path.resolve("test-user");
    const env = {
      PASEO_HOME: path.join(home, ".paseo"),
      PASEO_LISTEN: "127.0.0.1:6767",
      PASEO_HOST: "localhost:6767",
    };
    applyPackagedSlpEnvironment(env, home);
    expect(env.PASEO_HOME).toBe(path.join(home, ".paseo-slp"));
    expect(env.PASEO_LISTEN).toBe("127.0.0.1:6777");
    expect(env.PASEO_HOST).toBe("127.0.0.1:6777");
    const firstLaunch = { ...env };
    applyPackagedSlpEnvironment(env, home);
    expect(env).toEqual(firstLaunch);
  });

  it("uses explicit SLP overrides for both GUI and bundled CLI targets", () => {
    const home = path.resolve("test-user");
    const env: NodeJS.ProcessEnv = {
      PASEO_SLP_HOME: path.join(home, "custom-slp"),
      PASEO_SLP_LISTEN: "127.0.0.1:17777",
      PASEO_HOME: path.join(home, ".paseo"),
      PASEO_HOST: "localhost:6767",
    };
    applyPackagedSlpEnvironment(env, home);
    expect(env.PASEO_HOME).toBe(env.PASEO_SLP_HOME);
    expect(env.PASEO_LISTEN).toBe(env.PASEO_SLP_LISTEN);
    expect(env.PASEO_HOST).toBe(env.PASEO_SLP_LISTEN);
  });
});
