import type {
  SlpRoleConfig,
  SlpRoleLaunch,
  SlpRootLaunches,
  SlpRolesConfig,
} from "@getpaseo/protocol/messages";

export function resolveRoleLaunch(
  base: SlpRoleLaunch,
  defaults: SlpRoleConfig | undefined,
): SlpRoleLaunch {
  if (!defaults) return base;
  const changedProvider = Boolean(defaults.provider && defaults.provider !== base.provider);
  return {
    provider: defaults.provider ?? base.provider,
    model: defaults.model ?? (changedProvider ? null : base.model),
    modeId: defaults.modeId ?? (changedProvider ? null : base.modeId),
    thinkingOptionId: defaults.thinkingOptionId ?? (changedProvider ? null : base.thinkingOptionId),
  };
}

export function resolveRootLaunches(
  base: SlpRoleLaunch,
  defaults: SlpRolesConfig,
  overrides: SlpRootLaunches,
): SlpRootLaunches {
  return {
    supervisor: overrides.supervisor ?? resolveRoleLaunch(base, defaults.supervisor),
    lead: overrides.lead ?? resolveRoleLaunch(base, defaults.lead),
  };
}
