import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Users } from "lucide-react-native";
import type { SheetHeader } from "@/components/adaptive-modal-sheet";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import {
  SLP_COMPOSER_MODES,
  type SlpComposerMode,
  type SlpModeControlValue,
} from "./composer-mode";

/**
 * The workspace-mode pill in a draft composer. It sits beside the provider
 * and permission-mode pills because it is decided with them, before the first
 * message; once the workspace has agents or a group it only shows the choice.
 */
export function SlpModeControl({
  value,
  lock,
  onSelect,
  disabled = false,
  surface = "toolbar",
  onClose,
}: SlpModeControlValue & {
  disabled?: boolean;
  surface?: "toolbar" | "sheet";
  onClose?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { presentation } = useComposerControlLayout();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const locked = lock !== null;

  const options = useMemo<ComboboxOption[]>(
    () =>
      SLP_COMPOSER_MODES.map((mode) => ({
        id: mode,
        label: t(`slp.composer.options.${mode}.label`),
        description: t(`slp.composer.options.${mode}.hint`),
      })),
    [t],
  );
  const selectedLabel = t(`slp.composer.options.${value}.label`);
  const hint = lock ? t(`slp.composer.locked.${lock}`) : t("slp.composer.hint");

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) onClose?.();
    },
    [onClose],
  );
  const handlePress = useCallback(() => handleOpenChange(!open), [handleOpenChange, open]);
  const handleSelect = useCallback(
    (id: string) => {
      if (isSlpComposerMode(id)) onSelect(id);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelect],
  );
  const renderOption = useCallback(
    (args: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }): ReactElement => (
      <ComboboxItem
        label={args.option.label}
        description={args.option.description}
        selected={args.selected}
        active={args.active}
        onPress={args.onPress}
        testID={`slp-mode-option-${args.option.id}`}
      />
    ),
    [],
  );
  const sheetHeader = useMemo<SheetHeader>(() => ({ title: t("slp.composer.title") }), [t]);

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={Users}
            surface={surface}
            label={t("slp.composer.title")}
            value={selectedLabel}
            showToolbarLabel={presentation.showModeLabel}
            showCaret={surface === "toolbar" && presentation.showCarets && !locked}
            open={open}
            disabled={disabled || locked}
            onPress={handlePress}
            accessibilityLabel={t("slp.composer.selectWithValue", { value: selectedLabel })}
            testID="slp-mode-control"
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{hint}</Text>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={options}
        value={value}
        onSelect={handleSelect}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={300}
        header={sheetHeader}
        renderOption={renderOption}
      />
    </>
  );
}

function isSlpComposerMode(value: string): value is SlpComposerMode {
  return (SLP_COMPOSER_MODES as readonly string[]).includes(value);
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
    maxWidth: 320,
  },
}));
