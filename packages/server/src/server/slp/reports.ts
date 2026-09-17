import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import type { SlpControlTurns } from "./control-turns.js";
import type { SlpMailbox } from "./mailbox.js";

export interface SlpLeadReportTarget {
  groupId: string;
  leadSlotId: string;
  supervisorSlotId: string;
}

export interface SlpLeadReportsOptions {
  logger: Logger;
  agentManager: Pick<AgentManager, "subscribe" | "getLastAssistantMessage">;
  mailbox: Pick<SlpMailbox, "enqueue" | "appendToQueuedReport">;
  /** The supervised group whose active Lead this agent is, else null. */
  resolveLead: (agentId: string) => SlpLeadReportTarget | null;
  /** Turns the runtime started for its own mail; their answers are not reports. */
  controlTurns: SlpControlTurns;
}

const REPORT_INTRO =
  "The Lead's turn ended; this is its last message. A turn ending does not mean the task is complete. Treat each entry below as Lead's report, question or blocker: relay what matters to Human, or answer Lead if needed. More than one entry means several Lead turns ended before this reached you — every one is included, in order.";
const ENVELOPE_OPEN = "<paseo-system>\n";
const ENVELOPE_CLOSE = "\n</paseo-system>";
const ENTRY_SEPARATOR = "\n\n---\n\n";

function reportEntry(agentId: string, message: string): string {
  return `Report from Lead (${agentId}):\n${message}`;
}

/** Strips the envelope `formatSystemNotificationPrompt` added, so a new entry can be inserted before it closes again. */
function unwrapReportEnvelope(prompt: AgentPromptInput): string {
  const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
  const withoutOpen = text.startsWith(ENVELOPE_OPEN) ? text.slice(ENVELOPE_OPEN.length) : text;
  return withoutOpen.endsWith(ENVELOPE_CLOSE)
    ? withoutOpen.slice(0, -ENVELOPE_CLOSE.length)
    : withoutOpen;
}

/**
 * A supervised Lead's turn ends in its own chat, which Human never reads.
 * Its last message is delivered to the Supervisor slot as a report even if
 * the Lead sent progress earlier in the turn. The Lead needs no extra tool
 * call; see docs/slp/architecture.md#message-routing-and-delivery.
 *
 * A turn the runtime itself started is the exception, and the runtime knows
 * which those are because it claimed them at admission. Do not infer it from
 * the message: an earlier rule read "the Lead already sent mail this turn" as
 * "already reported" and swallowed real final messages.
 */
export class SlpLeadReports {
  private readonly logger: Logger;
  private readonly agentManager: SlpLeadReportsOptions["agentManager"];
  private readonly mailbox: SlpLeadReportsOptions["mailbox"];
  private readonly resolveLead: SlpLeadReportsOptions["resolveLead"];
  private readonly controlTurns: SlpControlTurns;
  private readonly turns = new Set<string>();
  /** Relays already started; `dispose` awaits them so no mail lands after shutdown. */
  private readonly pending = new Set<Promise<void>>();
  /**
   * One chain per Supervisor slot, so two turn ends seconds apart from the
   * same Lead cannot both see nothing queued and both enqueue: the second
   * one's decision waits for the first one's write to land first.
   */
  private readonly relayChains = new Map<string, Promise<void>>();
  private stop: (() => void) | null = null;

  constructor(options: SlpLeadReportsOptions) {
    this.logger = options.logger;
    this.agentManager = options.agentManager;
    this.mailbox = options.mailbox;
    this.resolveLead = options.resolveLead;
    this.controlTurns = options.controlTurns;
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
        // Settled however the turn ended, so a failed control turn does not
        // leave its claim to silence the next ordinary one.
        const runtimeControl = this.controlTurns.settle(agentId);
        if (lifecycle === "idle" && !runtimeControl) this.track(this.report(agentId));
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
    this.relayChains.clear();
  }

  private track(operation: Promise<void>): void {
    this.pending.add(operation);
    void operation.finally(() => this.pending.delete(operation));
  }

  private async report(agentId: string): Promise<void> {
    const target = this.resolveLead(agentId);
    if (!target) return;
    const key = `${target.groupId}/${target.supervisorSlotId}`;
    const chained = (this.relayChains.get(key) ?? Promise.resolve()).then(() =>
      this.relay(agentId, target),
    );
    this.relayChains.set(key, chained);
    return chained;
  }

  private async relay(agentId: string, target: SlpLeadReportTarget): Promise<void> {
    try {
      const lastMessage = await this.agentManager.getLastAssistantMessage(agentId);
      if (!lastMessage?.trim()) {
        this.logger.info(
          { agentId },
          "SLP Lead turn ended with no message; nothing to relay to the Supervisor",
        );
        return;
      }
      const entry = reportEntry(agentId, lastMessage);
      const appended = await this.mailbox.appendToQueuedReport(
        target.groupId,
        target.supervisorSlotId,
        (existingPrompt) =>
          formatSystemNotificationPrompt(
            `${unwrapReportEnvelope(existingPrompt)}${ENTRY_SEPARATOR}${entry}`,
          ),
      );
      if (appended) return;
      await this.mailbox.enqueue({
        groupId: target.groupId,
        slotId: target.supervisorSlotId,
        fromSlotId: target.leadSlotId,
        kind: "report",
        prompt: formatSystemNotificationPrompt([REPORT_INTRO, entry].join("\n\n")),
      });
    } catch (error) {
      this.logger.error({ agentId, err: error }, "SLP Lead report relay failed");
    }
  }
}
