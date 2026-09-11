import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { SlpMailbox } from "./mailbox.js";

export interface SlpLeadReportTarget {
  groupId: string;
  leadSlotId: string;
  supervisorSlotId: string;
}

export interface SlpLeadReportsOptions {
  logger: Logger;
  agentManager: Pick<AgentManager, "subscribe" | "getLastAssistantMessage">;
  mailbox: Pick<SlpMailbox, "enqueue">;
  /** The supervised group whose active Lead this agent is, else null. */
  resolveLead: (agentId: string) => SlpLeadReportTarget | null;
}

/**
 * A supervised Lead's turn ends in its own chat, which Human never reads.
 * Its last message is delivered to the Supervisor slot as a report even if
 * the Lead sent progress earlier in the turn. The Lead needs no extra tool
 * call; see docs/slp/architecture.md#message-routing-and-delivery.
 */
export class SlpLeadReports {
  private readonly logger: Logger;
  private readonly agentManager: SlpLeadReportsOptions["agentManager"];
  private readonly mailbox: SlpLeadReportsOptions["mailbox"];
  private readonly resolveLead: SlpLeadReportsOptions["resolveLead"];
  private readonly turns = new Set<string>();
  /** Relays already started; `dispose` awaits them so no mail lands after shutdown. */
  private readonly pending = new Set<Promise<void>>();
  private stop: (() => void) | null = null;

  constructor(options: SlpLeadReportsOptions) {
    this.logger = options.logger;
    this.agentManager = options.agentManager;
    this.mailbox = options.mailbox;
    this.resolveLead = options.resolveLead;
  }

  start(): void {
    if (this.stop) return;
    this.stop = this.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state") return;
        const agentId = event.agent.id;
        const lifecycle = event.agent.lifecycle;
        if (lifecycle === "running") {
          if (!this.turns.has(agentId) && event.agent.pendingPermissions.size === 0) {
            this.turns.add(agentId);
          }
          return;
        }
        if (!this.turns.delete(agentId)) return;
        if (lifecycle === "idle") this.track(this.report(agentId));
      },
      { replayState: false },
    );
  }

  /** Stop watching, then wait for the relays already in flight to finish writing. */
  async dispose(): Promise<void> {
    this.stop?.();
    this.stop = null;
    this.turns.clear();
    await Promise.all(this.pending);
  }

  private track(operation: Promise<void>): void {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }

  private async report(agentId: string): Promise<void> {
    const target = this.resolveLead(agentId);
    if (!target) return;
    try {
      const lastMessage = await this.agentManager.getLastAssistantMessage(agentId);
      if (!lastMessage?.trim()) return;
      await this.mailbox.enqueue({
        groupId: target.groupId,
        slotId: target.supervisorSlotId,
        fromSlotId: target.leadSlotId,
        kind: "report",
        prompt: formatSystemNotificationPrompt(
          [
            `SLP report from Lead (${agentId})`,
            "The Lead's turn ended; this is its last message. A turn ending does not mean the task is complete. Treat this as Lead's report, question or blocker: relay what matters to Human, or answer Lead if needed.",
            `Report:\n${lastMessage}`,
          ].join("\n"),
        ),
      });
    } catch (error) {
      this.logger.error({ agentId, err: error }, "SLP Lead report relay failed");
    }
  }
}
