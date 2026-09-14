import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { SlpRoleConfig, SlpRoleLaunch, SlpRootLaunches } from "@getpaseo/protocol/messages";
import { Button } from "@/components/ui/button";
import { SlpRoleEditModal } from "./settings/role-edit-modal";

export interface SlpLaunchControlsProps {
  serverId: string;
  roles: SlpRootLaunches;
  mode: "direct" | "supervised";
  ready: boolean;
  disabled?: boolean;
  onChange: (role: "supervisor" | "lead", launch: SlpRoleLaunch) => void;
}

export function SlpLaunchControls({
  serverId,
  roles,
  mode,
  ready,
  disabled,
  onChange,
}: SlpLaunchControlsProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<"supervisor" | "lead" | null>(null);
  const visibleRoles: ("supervisor" | "lead")[] =
    mode === "supervised" ? ["supervisor", "lead"] : ["lead"];
  const selected = editing ? roles[editing] : undefined;
  const current = useMemo<SlpRoleConfig | undefined>(
    () =>
      selected
        ? {
            provider: selected.provider,
            model: selected.model ?? undefined,
            modeId: selected.modeId ?? undefined,
            thinkingOptionId: selected.thinkingOptionId ?? undefined,
          }
        : undefined,
    [selected],
  );
  const close = useCallback(() => setEditing(null), []);
  const openRole = useMemo(
    () => ({ supervisor: () => setEditing("supervisor"), lead: () => setEditing("lead") }),
    [],
  );
  const save = useCallback(
    async (value: SlpRoleConfig) => {
      if (!editing || !value.provider) return;
      onChange(editing, {
        provider: value.provider,
        model: value.model ?? null,
        modeId: value.modeId ?? null,
        thinkingOptionId: value.thinkingOptionId ?? null,
      });
    },
    [editing, onChange],
  );
  return (
    <View style={styles.row}>
      {visibleRoles.map((role) => (
        <Button
          key={role}
          size="sm"
          variant="ghost"
          disabled={disabled || !ready}
          onPress={openRole[role]}
          testID={`slp-launch-${role}`}
        >
          {t(`slp.roles.${role}`)} · {roles[role]?.model ?? roles[role]?.provider ?? "…"}
        </Button>
      ))}
      {editing ? (
        <SlpRoleEditModal
          key={editing}
          serverId={serverId}
          role={editing}
          current={current}
          launchOnly
          onClose={close}
          onSave={save}
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
}));
