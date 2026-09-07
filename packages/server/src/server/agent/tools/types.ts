import type { z } from "zod";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import type { SlpCheckpointContent } from "../../slp/store.js";

export interface PaseoToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: PaseoToolResult) => void;
}

export interface PaseoToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PaseoToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface PaseoToolDefinition extends PaseoToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>;
}

/**
 * Role policy for SLP callers. Every method answers "unchanged" for a caller
 * outside any group, so ordinary agents never see a difference.
 */
export interface SlpToolAuthority {
  /** False hides the tool from the caller's catalog. Decided once, when the session launches. */
  isToolAllowed(callerAgentId: string, tool: string): boolean;
  /**
   * Throws when the caller's generation may not run the tool right now: a
   * candidate in preparation or a retired generation. Decided per call.
   */
  assertToolExecutionAllowed(callerAgentId: string, tool: string): void;
  /** Throws when the caller's role may not act on that agent with that tool. */
  assertAgentTargetAllowed(callerAgentId: string, tool: string, targetAgentId: string): void;
  /** Queues SLP mail instead of prompting directly; null when either side is outside a group. */
  routeSend(input: {
    callerAgentId: string;
    targetAgentId: string;
    prompt: string;
  }): Promise<{ mailId: string } | null>;
  /** Rewrites the caller slot's current checkpoint. */
  recordCheckpoint(
    callerAgentId: string,
    content: SlpCheckpointContent,
  ): Promise<{ checkpointId: string; revision: number }>;
  /** Starts a same-role handoff of the caller's own slot. */
  requestHandoff(callerAgentId: string, reason: string): Promise<{ transferId: string }>;
  /** The candidate has read its handoff context and is ready to be activated. */
  acknowledgeReadiness(callerAgentId: string): Promise<{ transferId: string }>;
}

export interface PaseoToolCatalog {
  tools: ReadonlyMap<string, PaseoToolDefinition>;
  getTool(name: string): PaseoToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: PaseoToolExecutionContext,
  ): Promise<PaseoToolResult>;
}

export interface PaseoToolRuntimeContext {
  callerAgentId?: string;
  paseoToolPolicy?: ProviderPaseoToolsPolicy;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type PaseoToolCatalogFactory = (
  context: PaseoToolRuntimeContext,
) => PaseoToolCatalog | Promise<PaseoToolCatalog>;
