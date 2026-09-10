import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Crown, Eye, Hammer } from "lucide-react-native";
import type { SlpRoleConfig, SlpRolesConfig } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { SlpRoleEditModal } from "./role-edit-modal";
import { resolveSlpRoleDefaults, SLP_ROLES, type SlpRole } from "./roles";

const ROLE_ICONS = {
  supervisor: withUnistyles(Eye),
  lead: withUnistyles(Crown),
  peer: withUnistyles(Hammer),
} as const;
const roleIconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const EXTRA_PREVIEW_LENGTH = 90;

function describeLaunch(config: SlpRoleConfig): string {
  return [config.provider, config.model, config.thinkingOptionId, config.modeId]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Per-role launch settings for SLP groups, stored in the daemon's config so
 * every client starts groups the same way. A role without settings launches
 * with what the composer showed when the group was started.
 */
export function HostSlpPage({ serverId }: { serverId: string }): ReactElement {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "slpGroups");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const configuredRoles = config?.slp?.roles;
  const roles = useMemo<SlpRolesConfig>(() => configuredRoles ?? {}, [configuredRoles]);
  const { preferences } = useFormPreferences();
  const composerDefault = useMemo(() => resolveSlpRoleDefaults(preferences), [preferences]);
  const [editing, setEditing] = useState<SlpRole | null>(null);

  const saveRoles = useCallback(
    async (next: SlpRolesConfig) => {
      await patchConfig({ slp: { roles: next } });
    },
    [patchConfig],
  );
  const handleSave = useCallback(
    async (value: SlpRoleConfig) => {
      if (!editing) return;
      await saveRoles({ ...roles, [editing]: value });
    },
    [editing, roles, saveRoles],
  );
  const handleReset = useCallback(
    (target: SlpRole) => {
      const { [target]: _removed, ...rest } = roles;
      void saveRoles(rest);
    },
    [roles, saveRoles],
  );
  const handleClose = useCallback(() => setEditing(null), []);

  if (!isConnected || !supported) {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("slp.settings.unavailable")}</Text>
      </View>
    );
  }

  return (
    <View>
      <SettingsSection title={t("slp.settings.title")}>
        <Text style={styles.intro}>{t("slp.settings.intro")}</Text>
        {SLP_ROLES.map((role) => (
          <SlpRoleCard
            key={role}
            role={role}
            config={roles[role]}
            composerDefault={composerDefault}
            onEdit={setEditing}
            onReset={handleReset}
          />
        ))}
      </SettingsSection>
      {editing ? (
        <SlpRoleEditModal
          key={editing}
          serverId={serverId}
          role={editing}
          current={roles[editing]}
          onClose={handleClose}
          onSave={handleSave}
        />
      ) : null}
    </View>
  );
}

function SlpRoleCard({
  role,
  config,
  composerDefault,
  onEdit,
  onReset,
}: {
  role: SlpRole;
  config: SlpRoleConfig | undefined;
  composerDefault: SlpRoleConfig | undefined;
  onEdit: (role: SlpRole) => void;
  onReset: (role: SlpRole) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => onEdit(role), [onEdit, role]);
  const handleReset = useCallback(() => onReset(role), [onReset, role]);
  const configured = Boolean(config?.provider);
  const Icon = ROLE_ICONS[role];
  return (
    <View style={[settingsStyles.card, styles.card]} testID={`slp-role-card-${role}`}>
      <View style={styles.cardHeader}>
        <View style={styles.roleBadge}>
          <Icon size={ICON_SIZE.md} uniProps={roleIconColorMapping} />
        </View>
        <View style={styles.cardTitleBlock}>
          <Text style={styles.roleTitle}>{t(`slp.roles.${role}`)}</Text>
          <Text style={styles.roleDescription}>{t(`slp.settings.descriptions.${role}`)}</Text>
        </View>
        <View style={styles.actions}>
          {configured ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={handleReset}
              testID={`slp-role-reset-${role}`}
            >
              {t("slp.settings.reset")}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onPress={handleEdit} testID={`slp-role-edit-${role}`}>
            {t("slp.settings.edit")}
          </Button>
        </View>
      </View>
      <View style={styles.facts}>
        <Fact label={t("slp.settings.launchSection")} testID={`slp-role-summary-${role}`}>
          {resolveLaunchSummary({ config, composerDefault, t })}
        </Fact>
        <Fact label={t("slp.settings.instructionsSection")}>
          {resolveInstructionsSummary({ config, t })}
        </Fact>
      </View>
    </View>
  );
}

function Fact({
  label,
  children,
  testID,
}: {
  label: string;
  children: string;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} testID={testID}>
        {children}
      </Text>
    </View>
  );
}

function resolveLaunchSummary(input: {
  config: SlpRoleConfig | undefined;
  composerDefault: SlpRoleConfig | undefined;
  t: TFunction;
}): string {
  const { config, composerDefault, t } = input;
  if (config?.provider) return describeLaunch(config);
  if (composerDefault) {
    return t("slp.settings.defaultWith", { value: describeLaunch(composerDefault) });
  }
  return t("slp.settings.defaultSummary");
}

function resolveInstructionsSummary(input: {
  config: SlpRoleConfig | undefined;
  t: TFunction;
}): string {
  const extra = input.config?.instructions?.trim().replace(/\s+/g, " ");
  if (!extra) return input.t("slp.settings.bundledOnly");
  const text =
    extra.length > EXTRA_PREVIEW_LENGTH ? `${extra.slice(0, EXTRA_PREVIEW_LENGTH)}…` : extra;
  return input.t("slp.settings.extraPreview", { text });
}

const styles = StyleSheet.create((theme) => ({
  intro: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
    marginBottom: theme.spacing[2],
  },
  card: {
    gap: theme.spacing[3],
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  roleBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardTitleBlock: {
    flex: 1,
    gap: 2,
  },
  roleTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  roleDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.45,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  facts: {
    gap: theme.spacing[1],
    paddingLeft: 36 + theme.spacing[3],
  },
  fact: {
    flexDirection: "row",
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  factLabel: {
    width: 120,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    lineHeight: theme.fontSize.sm * 1.45,
  },
  factValue: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.45,
  },
  emptyCard: {
    padding: theme.spacing[4],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
