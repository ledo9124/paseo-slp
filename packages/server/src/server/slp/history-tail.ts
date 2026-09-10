import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentTimelineRow } from "../agent/agent-timeline-store-types.js";
import type { SlpHistoryTail, SlpTimelineCursor } from "./store.js";

/** Entries kept per tail; a source that did more after its checkpoint loses the oldest. */
const HISTORY_TAIL_MAX_ENTRIES = 100;
const ENTRY_TEXT_LIMIT = 400;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ENTRY_TEXT_LIMIT ? `${flat.slice(0, ENTRY_TEXT_LIMIT)}…` : flat;
}

/** One line per timeline item; reasoning carries nothing a successor can act on. */
function describeTimelineItem(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "user_message":
      return `user: ${clip(item.text)}`;
    case "assistant_message":
      return `assistant: ${clip(item.text)}`;
    case "tool_call":
      return `tool ${item.name} ${item.status}${item.status === "failed" ? `: ${clip(String(item.error))}` : ""}`;
    case "error":
      return `error: ${clip(item.message)}`;
    case "notification":
      return `${item.level}: ${clip(item.message)}`;
    case "compaction":
      return `compaction ${item.status}`;
    case "todo":
      return `todo list updated (${item.items.length} items)`;
    case "plugin":
      return `plugin ${item.pluginId} ${item.kind}`;
    case "reasoning":
      return null;
  }
}

export function buildHistoryTail(
  from: SlpTimelineCursor,
  epoch: string,
  rows: readonly AgentTimelineRow[],
): SlpHistoryTail {
  const entries = rows.flatMap((row) => {
    const text = describeTimelineItem(row.item);
    return text === null ? [] : [{ seq: row.seq, text }];
  });
  const kept = entries.slice(-HISTORY_TAIL_MAX_ENTRIES);
  const last = rows[rows.length - 1];
  return {
    from,
    to: { epoch, seq: last ? last.seq : from.seq },
    entries: kept,
    omitted: entries.length - kept.length,
  };
}
