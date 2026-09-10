import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { AgentProfile, SlpRoleConfig } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import type { AgentProfileFormOption } from "@/agent-profiles/internal/profile-form-model";
import { useAgentProfileFormCatalog } from "@/agent-profiles/internal/use-profile-form-inputs";
import {
  useAgentProfileFormModel,
  useAgentProfileFormState,
} from "@/agent-profiles/internal/use-profile-form-model";
import { resolveSlpRoleDefaults, type SlpRole } from "./roles";
import { useSlpBundledInstructions } from "./use-instructions";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const chevronColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface SlpRoleEditModalProps {
  serverId: string;
  role: SlpRole;
  current: SlpRoleConfig | undefined;
  onClose: () => void;
  onSave: (value: SlpRoleConfig) => Promise<void>;
}

function toSelectOptions(options: AgentProfileFormOption[]): SelectFieldOption<string>[] {
  return options.map((option) => ({
    id: option.id,
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    testID: option.testID.replace("agent-profile-", "slp-role-"),
  }));
}

/**
 * One role's launch settings, edited through the agent-profile form model: a
 * role is a profile whose name is fixed, so the model's provider, model, mode
 * and thinking handling (catalog resolution, owned displays) carries over
 * unchanged. A role without settings opens on the composer's remembered
 * defaults, the launch it would get today, so editing adjusts rather than
 * starts blank; the bundled instructions the daemon applies are shown beside
 * the host's extra ones for the same reason. Mounted fresh per open; the page
 * keys it on the role.
 */
export function SlpRoleEditModal({
  serverId,
  role,
  current,
  onClose,
  onSave,
}: SlpRoleEditModalProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const roleLabel = t(`slp.roles.${role}`);
  const { preferences } = useFormPreferences();
  const [initial] = useState<SlpRoleConfig | undefined>(
    () => current ?? resolveSlpRoleDefaults(preferences),
  );
  const profile = useMemo<AgentProfile>(
    () => ({
      id: role,
      name: roleLabel,
      provider: initial?.provider ?? "",
      ...(initial?.model ? { model: initial.model } : {}),
      ...(initial?.modeId ? { modeId: initial.modeId } : {}),
      ...(initial?.thinkingOptionId ? { thinkingOptionId: initial.thinkingOptionId } : {}),
      ...(initial?.instructions ? { notes: initial.instructions } : {}),
    }),
    [initial, role, roleLabel],
  );
  const model = useAgentProfileFormModel({ mode: "edit", profile });
  const state = useAgentProfileFormState(model);
  useAgentProfileFormCatalog({ serverId, model });
  const bundled = useSlpBundledInstructions(serverId);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("slp.settings.editTitle", { role: roleLabel }) }),
    [roleLabel, t],
  );
  const providerOptions = useMemo(
    () => toSelectOptions(state.providerOptions),
    [state.providerOptions],
  );
  const modelOptions = useMemo(() => toSelectOptions(state.modelOptions), [state.modelOptions]);
  const modeOptions = useMemo(() => toSelectOptions(state.modeOptions), [state.modeOptions]);
  const thinkingOptions = useMemo(
    () => toSelectOptions(state.thinkingOptions),
    [state.thinkingOptions],
  );

  const handleProviderChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setProvider(value, display),
    [model],
  );
  const handleModelChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setModel(value, value ? display : null),
    [model],
  );
  const handleModeChange = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setMode(value, value ? display : null),
    [model],
  );
  const handleThinkingChange = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setThinking(value, value ? display : null),
    [model],
  );

  const handleSave = useCallback(async () => {
    const value = model.getState().submitValue;
    if (!value) return;
    model.setSubmitError(null);
    model.setSubmitting(true);
    try {
      await onSave({
        provider: value.provider,
        ...(value.model ? { model: value.model } : {}),
        ...(value.modeId ? { modeId: value.modeId } : {}),
        ...(value.thinkingOptionId ? { thinkingOptionId: value.thinkingOptionId } : {}),
        ...(value.notes ? { instructions: value.notes } : {}),
      });
      onClose();
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    } finally {
      model.setSubmitting(false);
    }
  }, [model, onClose, onSave]);
  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);
  const handleCancel = useCallback(() => {
    if (!state.isSubmitting) onClose();
  }, [onClose, state.isSubmitting]);

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={handleCancel}
      desktopMaxWidth={640}
      testID="slp-role-edit-modal"
    >
      <View style={styles.body}>
        <Text style={styles.roleDescription}>{t(`slp.settings.descriptions.${role}`)}</Text>

        <Text style={styles.sectionTitle}>{t("slp.settings.launchSection")}</Text>
        <View style={styles.fieldGrid}>
          <SelectField
            label={t("settings.host.agentProfiles.providerLabel")}
            value={state.provider || null}
            selectedDisplay={state.providerDisplay}
            options={providerOptions}
            onChange={handleProviderChange}
            placeholder={t("settings.host.agentProfiles.providerPlaceholder")}
            emptyText={t("settings.host.agentProfiles.noProviders")}
            loading={state.catalogResolution !== "complete"}
            disabled={state.isSubmitting}
            searchable={providerOptions.length > 6}
            title={t("settings.host.agentProfiles.providerLabel")}
            size={controlSize}
            testID="slp-role-provider-field"
            triggerTestID="slp-role-provider-trigger"
          />
          {state.disclosure.showModelField ? (
            <SelectField
              label={t("settings.host.agentProfiles.modelLabel")}
              value={state.modelId || ""}
              selectedDisplay={state.modelDisplay}
              options={modelOptions}
              onChange={handleModelChange}
              placeholder={t("settings.host.agentProfiles.modelLabel")}
              emptyText={t("settings.host.agentProfiles.noModels")}
              disabled={state.isSubmitting}
              searchable={modelOptions.length > 6}
              title={t("settings.host.agentProfiles.modelLabel")}
              size={controlSize}
              testID="slp-role-model-field"
              triggerTestID="slp-role-model-trigger"
            />
          ) : null}
          {state.disclosure.showThinkingField ? (
            <SelectField
              label={t("slp.settings.thinkingLabel")}
              value={state.thinkingOptionId || ""}
              selectedDisplay={state.thinkingDisplay}
              options={thinkingOptions}
              onChange={handleThinkingChange}
              placeholder={t("slp.settings.thinkingLabel")}
              emptyText={t("slp.settings.noThinkingOptions")}
              disabled={state.isSubmitting}
              searchable={thinkingOptions.length > 6}
              title={t("slp.settings.thinkingLabel")}
              size={controlSize}
              testID="slp-role-thinking-field"
              triggerTestID="slp-role-thinking-trigger"
            />
          ) : null}
          {state.disclosure.showModeField ? (
            <SelectField
              label={t("settings.host.agentProfiles.modeLabel")}
              value={state.modeId || ""}
              selectedDisplay={state.modeDisplay}
              options={modeOptions}
              onChange={handleModeChange}
              placeholder={t("settings.host.agentProfiles.modeLabel")}
              emptyText={t("settings.host.agentProfiles.noModes")}
              disabled={state.isSubmitting}
              searchable={modeOptions.length > 6}
              title={t("settings.host.agentProfiles.modeLabel")}
              size={controlSize}
              testID="slp-role-mode-field"
              triggerTestID="slp-role-mode-trigger"
            />
          ) : null}
        </View>

        <Text style={styles.sectionTitle}>{t("slp.settings.instructionsSection")}</Text>
        <BundledInstructions
          title={t("slp.settings.bundledRoleLabel", { role: roleLabel })}
          text={bundled.data?.roles[role]}
          status={bundled.status}
          testID="slp-role-bundled-role"
        />
        <BundledInstructions
          title={t("slp.settings.bundledSharedLabel")}
          text={bundled.data?.common}
          status={bundled.status}
          testID="slp-role-bundled-shared"
        />
        <Field
          label={t("slp.settings.instructionsLabel")}
          hint={t("slp.settings.instructionsHint")}
          testID="slp-role-instructions-field"
        >
          <FormTextInput
            initialValue={initial?.instructions ?? ""}
            onChangeText={model.setNotes}
            placeholder={t("slp.settings.instructionsPlaceholder")}
            multiline
            numberOfLines={5}
            style={styles.instructionsInput}
            editable={!state.isSubmitting}
            size={controlSize}
            accessibilityLabel={t("slp.settings.instructionsLabel")}
            testID="slp-role-instructions-input"
          />
        </Field>
        {state.submitError ? (
          <Text style={styles.submitError} testID="slp-role-submit-error">
            {state.submitError}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={state.isSubmitting}
            testID="slp-role-cancel-button"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={handleSavePress}
            disabled={!state.canSubmit}
            testID="slp-role-save-button"
          >
            {state.isSubmitting
              ? t("settings.host.agentProfiles.saving")
              : t("settings.host.agentProfiles.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

/** A bundled instruction file, collapsed by default: read-only, the daemon owns it. */
function BundledInstructions({
  title,
  text,
  status,
  testID,
}: {
  title: string;
  text: string | undefined;
  status: "pending" | "error" | "success";
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const body = useMemo(() => {
    if (status === "pending") return t("slp.settings.bundledLoading");
    if (status === "error" || text === undefined) return t("slp.settings.bundledUnavailable");
    return text;
  }, [status, t, text]);
  return (
    <View style={styles.bundled} testID={testID}>
      <Pressable
        onPress={toggle}
        style={styles.bundledHeader}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        testID={`${testID}-toggle`}
      >
        <Chevron size={ICON_SIZE.sm} uniProps={chevronColorMapping} />
        <Text style={styles.bundledTitle}>{title}</Text>
        <Text style={styles.bundledMeta}>{t("slp.settings.bundledAlwaysApplied")}</Text>
      </Pressable>
      {open ? (
        <ScrollView style={styles.bundledBody} nestedScrollEnabled>
          <Text style={styles.bundledText} selectable>
            {body}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
  },
  roleDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: theme.spacing[2],
  },
  fieldGrid: {
    gap: theme.spacing[3],
  },
  bundled: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  bundledHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  bundledTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  bundledMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bundledBody: {
    maxHeight: 240,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  bundledText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.6,
  },
  instructionsInput: {
    minHeight: 120,
    textAlignVertical: "top",
  },
  submitError: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  actionButton: {
    minWidth: 96,
  },
}));
