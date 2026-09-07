import path from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { AgentRequests } from "../agent/requests/index.js";
import { createAgentCommand, type CreateAgentFromMcpInput } from "../agent/create-agent/create.js";
import { SlpService, type SlpServiceOptions } from "../slp/service.js";
import type { SlpGroupRecord } from "../slp/store.js";
import { createHeldTurnClient, type HeldTurnClient } from "./held-turn-agent-client.js";
import { createProviderSnapshotManagerStub } from "./session-stubs.js";

export interface SlpTestDaemon {
  service: SlpService;
  manager: AgentManager;
  client: HeldTurnClient;
  storage: AgentStorage;
  /** The production create funnel bound to this daemon, with the SLP hook attached. */
  createAgent: (input: CreateAgentFromMcpInput) => ReturnType<typeof createAgentCommand>;
  stop: () => Promise<void>;
}

export interface SlpTestDaemonOptions {
  paseoHome: string;
  releaseText?: string;
  isDelegationToolingEnabled?: () => boolean;
  instructionsDir?: string;
}

/**
 * One AgentManager + storage + journal + SLP service over a preserved home,
 * wired the way bootstrap wires them. Two in sequence stand in for a restart.
 */
export async function startSlpTestDaemon(options: SlpTestDaemonOptions): Promise<SlpTestDaemon> {
  const logger = createTestLogger();
  const client = createHeldTurnClient({ provider: "codex", releaseText: options.releaseText });
  const storage = new AgentStorage(path.join(options.paseoHome, "agents"), logger);
  await storage.initialize();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentRequests = new AgentRequests(path.join(options.paseoHome, "agent-requests"));
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: manager,
    agentStorage: storage,
    logger,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
  };
  const createAgent = (input: CreateAgentFromMcpInput) => createAgentCommand(dependencies, input);
  const serviceOptions: SlpServiceOptions = {
    paseoHome: options.paseoHome,
    logger,
    agentManager: manager,
    agentStorage: storage,
    agentRequests,
    createLeadAgent: async (creation) => {
      await manager.createAgent(
        {
          provider: creation.lead.provider,
          cwd: creation.lead.cwd,
          systemPrompt: creation.systemPrompt,
        },
        creation.agentId,
        { workspaceId: creation.workspaceId },
      );
    },
    isDelegationToolingEnabled: options.isDelegationToolingEnabled ?? (() => true),
    ...(options.instructionsDir ? { instructionsDir: options.instructionsDir } : {}),
  };
  const service = new SlpService(serviceOptions);
  dependencies.slp = service;
  await service.recover();
  return {
    service,
    manager,
    client,
    storage,
    createAgent,
    stop: async () => {
      service.dispose();
      manager.prepareForShutdown();
      for (const agent of manager.listAgents()) {
        await manager.closeAgent(agent.id).catch(() => undefined);
      }
      await manager.flushForShutdown();
      await storage.flush();
    },
  };
}

export function slpLeadAgentId(group: SlpGroupRecord): string {
  const slot = group.slots[group.leadSlotId]!;
  return slot.generations.find((generation) => generation.id === slot.activeGenerationId)!.agentId;
}

/** Yields until `condition` holds; bounded so a wrong expectation fails instead of hanging. */
export async function untilSettled(
  condition: () => boolean | Promise<boolean>,
  label: string,
): Promise<void> {
  for (let i = 0; i < 10_000; i += 1) {
    if (await condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition never held: ${label}`);
}
