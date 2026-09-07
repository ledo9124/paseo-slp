import type { AgentManager } from "../agent/agent-manager.js";

const TURN_TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_canceled",
]);

/**
 * A wake-up, not a check: admission alone decides. The agent's terminal
 * stream event is dispatched after its run is settled, so waking on it
 * guarantees the next attempt sees the slot free; the earlier idle state
 * event may precede the settle and cost one more busy answer. Subscribe
 * before the action whose boundary you wait for, or the boundary can be
 * crossed unseen. Do not replace this with `waitForAgentEvent`: it treats a
 * pending run as busy and nothing follows the settle, so it can wait forever.
 */
export function nextTurnBoundary(
  agentManager: Pick<AgentManager, "subscribe">,
  agentId: string,
): { reached: Promise<void>; stop: () => void } {
  let resolve: () => void = () => {};
  const reached = new Promise<void>((done) => {
    resolve = done;
  });
  const stop = agentManager.subscribe(
    (event) => {
      const crossed =
        (event.type === "agent_state" && event.agent.lifecycle !== "running") ||
        (event.type === "agent_stream" && TURN_TERMINAL_EVENTS.has(event.event.type));
      if (crossed) resolve();
    },
    { agentId, replayState: false },
  );
  return { reached, stop };
}
