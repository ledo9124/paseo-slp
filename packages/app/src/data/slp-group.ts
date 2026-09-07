export const SLP_GROUP_QUERY_ROOT = "slpGroup";

export function slpGroupQueryRoot(serverId: string) {
  return [SLP_GROUP_QUERY_ROOT, serverId] as const;
}

export function slpGroupQueryKey(serverId: string, workspaceId: string) {
  return [SLP_GROUP_QUERY_ROOT, serverId, workspaceId] as const;
}
