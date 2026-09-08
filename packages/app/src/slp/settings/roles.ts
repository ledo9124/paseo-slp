import type { SlpRoleConfig } from "@getpaseo/protocol/messages";
import type { FormPreferences } from "@/create-agent-preferences/preferences";

export type SlpRole = "supervisor" | "lead" | "peer";

/** Display order on the settings page: the Human's contact first. */
export const SLP_ROLES: readonly SlpRole[] = ["supervisor", "lead", "peer"];

/**
 * What a role without settings launches with: the composer's remembered
 * provider, model and permission mode, which is what the daemon receives as
 * the group's launch when a draft starts it. Undefined until a provider was
 * ever chosen.
 */
export function resolveSlpRoleDefaults(preferences: FormPreferences): SlpRoleConfig | undefined {
  const provider = preferences.provider;
  if (!provider) return undefined;
  const perProvider = preferences.providerPreferences?.[provider];
  return {
    provider,
    ...(perProvider?.model ? { model: perProvider.model } : {}),
    ...(perProvider?.mode ? { modeId: perProvider.mode } : {}),
  };
}
