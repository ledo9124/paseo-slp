import type { UseQueryResult } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { SlpInstructionsGetResponse } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export type SlpBundledInstructions = Omit<SlpInstructionsGetResponse["payload"], "requestId">;

/**
 * The bundled role text the daemon composes into every generation. Server
 * state: the settings page shows it beside the host's extra instructions so
 * an edit adjusts what actually applies instead of guessing at it.
 */
export function useSlpBundledInstructions(
  serverId: string,
): UseQueryResult<SlpBundledInstructions> {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: ["slp-instructions", serverId],
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client) throw new Error("host disconnected");
      const { requestId: _requestId, ...instructions } = await client.slpInstructionsGet();
      return instructions;
    },
  });
}
