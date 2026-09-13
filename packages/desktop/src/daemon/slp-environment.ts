import path from "node:path";
import { DEFAULT_DAEMON_PORT, DEFAULT_HOME_DIRECTORY } from "@getpaseo/protocol/product-identity";

// A packaged fork can be opened from a terminal owned by upstream Paseo.
// Its inherited PASEO_HOME/HOST must not select or stop upstream's daemon.
export function applyPackagedSlpEnvironment(env: NodeJS.ProcessEnv, home: string): void {
  env.PASEO_HOME = env.PASEO_SLP_HOME?.trim() || path.join(home, DEFAULT_HOME_DIRECTORY);
  env.PASEO_LISTEN = env.PASEO_SLP_LISTEN?.trim() || `127.0.0.1:${DEFAULT_DAEMON_PORT}`;
  env.PASEO_HOST = env.PASEO_LISTEN;
  env.PASEO_DESKTOP_MANAGED = "1";
}
