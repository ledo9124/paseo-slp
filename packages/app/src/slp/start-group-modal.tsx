import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { generateMessageId } from "@/types/stream";
import { toErrorMessage } from "@/utils/error-messages";

type SlpMode = "direct" | "supervised";

/**
 * The one decision an SLP workspace makes before its first message: the
 * mode. It is fixed once the daemon accepts the message, so the sheet asks
 * for mode, provider and that message together and sends them as one
 * request. The message id is minted when the sheet opens, so a retry after
 * a dropped connection converges on the same group instead of a conflict.
 */
export function SlpStartGroupModal({
  serverId,
  workspaceId,
  cwd,
  visible,
  onClose,
  onStarted,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  visible: boolean;
  onClose: () => void;
  onStarted: (group: SlpGroupSummary) => void;
}): ReactElement {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const providers = useProvidersSnapshot(serverId, { cwd, enabled: visible });
  const [mode, setMode] = useState<SlpMode>("direct");
  const [provider, setProvider] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [messageId, setMessageId] = useState(() => generateMessageId());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) return;
    setMode("direct");
    setProvider(null);
    setText("");
    setMessageId(generateMessageId());
    setPending(false);
    setError(null);
  }, [visible]);

  const providerOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      (providers.entries ?? [])
        .filter((entry) => entry.enabled !== false && entry.status !== "unavailable")
        .map((entry) => ({
          id: entry.provider,
          value: entry.provider,
          label: entry.label ?? entry.provider,
          testID: `slp-start-provider-${entry.provider}`,
        })),
    [providers.entries],
  );
  const selectedProvider = providerOptions.find((option) => option.value === provider) ?? null;
  const modeOptions = useMemo(
    () => [
      { value: "direct" as const, label: t("slp.modes.direct") },
      { value: "supervised" as const, label: t("slp.modes.supervised") },
    ],
    [t],
  );

  const canSubmit =
    Boolean(client && isConnected && cwd && selectedProvider) && text.trim().length > 0 && !pending;
  const header = useMemo(() => ({ title: t("slp.start.title") }), [t]);
  const selectedDisplay = useMemo(
    () => (selectedProvider ? { label: selectedProvider.label } : null),
    [selectedProvider],
  );
  const handleProviderChange = useCallback((value: string) => setProvider(value), []);

  const submit = useCallback(async () => {
    if (!client || !cwd || !selectedProvider) return;
    setPending(true);
    setError(null);
    try {
      const result = await client.slpGroupInitialize({
        workspaceId,
        mode,
        cwd,
        provider: selectedProvider.value,
        messageId,
        text: text.trim(),
      });
      if (!result.success || !result.group) {
        setError(result.error?.message ?? t("slp.start.failed"));
        return;
      }
      onStarted(result.group);
    } catch (caught) {
      setError(toErrorMessage(caught));
    } finally {
      setPending(false);
    }
  }, [client, cwd, selectedProvider, workspaceId, mode, messageId, text, onStarted, t]);

  const footer = useMemo(
    () => (
      <Button
        onPress={submit}
        disabled={!canSubmit}
        testID="slp-start-submit"
        accessibilityLabel={t("slp.start.submit")}
      >
        {pending ? t("slp.start.starting") : t("slp.start.submit")}
      </Button>
    ),
    [submit, canSubmit, pending, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="slp-start-group-sheet"
      footer={footer}
    >
      <View style={styles.body}>
        <Field label={t("slp.start.modeLabel")} hint={t(`slp.start.modeHint.${mode}`)}>
          <SegmentedControl
            options={modeOptions}
            value={mode}
            onValueChange={setMode}
            testID="slp-start-mode"
          />
        </Field>
        <SelectField
          label={t("slp.start.providerLabel")}
          value={provider}
          selectedDisplay={selectedDisplay}
          options={providerOptions}
          onChange={handleProviderChange}
          placeholder={t("slp.start.providerPlaceholder")}
          emptyText={t("slp.start.providerEmpty")}
          loading={providers.isLoading}
          testID="slp-start-provider"
        />
        <Field label={t("slp.start.messageLabel")}>
          <FormTextInput
            initialValue=""
            resetKey={messageId}
            onChangeText={setText}
            placeholder={t("slp.start.messagePlaceholder")}
            multiline
            numberOfLines={4}
            testID="slp-start-message"
            style={styles.message}
          />
        </Field>
        {error ? (
          <Text style={styles.error} testID="slp-start-error">
            {error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  message: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
