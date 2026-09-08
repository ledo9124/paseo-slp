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
  mailbox: Pick<SlpMailbox, "enqueue" | "list">;
  /** The supervised group whose active Lead this agent is, else null. */
  resolveLead: (agentId: string) => SlpLeadReportTarget | null;
  now: () => Date;
}

interface TurnWatch {
  startedAt: string;
}

/**
 * A supervised Lead's turn ends in its own chat, which Human never reads.
 * If the Lead sent the Supervisor nothing during the turn, its last message
 * is delivered to the Supervisor slot as a report, the same way a Peer's last
 * message is its handback. A turn the Lead did report on is left alone, so
 * the rule adds no duplicate mail; see docs/slp/architecture.md#message-routing-and-delivery.
 */
export class SlpLeadReports {
  private readonly logger: Logger;
  private readonly agentManager: SlpLeadReportsOptions["agentManager"];
  private readonly mailbox: SlpLeadReportsOptions["mailbox"];
  private readonly resolveLead: SlpLeadReportsOptions["resolveLead"];
  private readonly now: () => Date;
  private readonly turns = new Map<string, TurnWatch>();
  private stop: (() => void) | null = null;

  constructor(options: SlpLeadReportsOptions) {
    this.logger = options.logger;
    this.agentManager = options.agentManager;
    this.mailbox = options.mailbox;
    this.resolveLead = options.resolveLead;
    this.now = options.now;
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
            this.turns.set(agentId, { startedAt: this.now().toISOString() });
          }
          return;
        }
        const turn = this.turns.get(agentId);
        if (!turn) return;
        this.turns.delete(agentId);
        if (lifecycle === "idle") void this.report(agentId, turn);
      },
      { replayState: false },
    );
  }

  dispose(): void {
    this.stop?.();
    this.stop = null;
    this.turns.clear();
  }

  private async report(agentId: string, turn: TurnWatch): Promise<void> {
    const target = this.resolveLead(agentId);
    if (!target) return;
    const reported = this.mailbox
      .list()
      .some(
        (mail) =>
          mail.groupId === target.groupId &&
          mail.fromSlotId === target.leadSlotId &&
          mail.slotId === target.supervisorSlotId &&
          mail.createdAt >= turn.startedAt,
      );
    if (reported) return;
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
            "The Lead's turn ended without a message to you; this is its last message. Treat it as Lead's report: relay what matters to Human, or answer Lead if it asks something.",
            `Report:\n${lastMessage}`,
          ].join("\n"),
        ),
      });
    } catch (error) {
      this.logger.error({ agentId, err: error }, "SLP Lead report relay failed");
    }
  }
}
