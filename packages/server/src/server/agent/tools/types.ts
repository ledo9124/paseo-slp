import type { z } from "zod";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

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
  /** False hides the tool from the caller's catalog. */
  isToolAllowed(callerAgentId: string, tool: string): boolean;
  /** Throws when the caller's role may not act on that agent with that tool. */
  assertAgentTargetAllowed(callerAgentId: string, tool: string, targetAgentId: string): void;
  /** Queues SLP mail instead of prompting directly; null when either side is outside a group. */
  routeSend(input: {
    callerAgentId: string;
    targetAgentId: string;
    prompt: string;
  }): Promise<{ mailId: string } | null>;
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
