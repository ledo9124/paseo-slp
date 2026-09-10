import type { Logger } from "pino";

import type { AgentStreamEvent } from "./agent-sdk-types.js";

/**
 * Iterate a foreground run to completion without observing its events.
 *
 * A `streamAgent` generator that is never iterated strands the run slot until
 * process exit: only the generator's own settle path releases the pending
 * claim, and that path runs only once the generator is pulled. Every route
 * that starts a turn it does not consume must drain it through here.
 */
export function drainAgentStream(
  iterator: AsyncGenerator<AgentStreamEvent>,
  params: { logger: Logger; agentId: string; context?: Record<string, unknown> },
): void {
  const fields = { agentId: params.agentId, ...params.context };
  void (async () => {
    try {
      for await (const _ of iterator) {
        // Events reach subscribers through the manager's dispatch.
      }
      params.logger.trace(fields, "agent.session.iterator.drained");
    } catch (error) {
      params.logger.trace({ ...fields, err: error }, "agent.session.iterator.error");
      params.logger.error({ ...fields, err: error }, "Agent stream failed");
    }
  })();
}
