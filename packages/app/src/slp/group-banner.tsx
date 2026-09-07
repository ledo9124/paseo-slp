import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { describeSlpMembership, useSlpGroup, type SlpMembership } from "./store";
import type { SlpGroupSummary } from "@getpaseo/protocol/messages";

const MAX_CONTENT_WIDTH = 768;

/**
 * What the reader needs to know before typing to an SLP member: which role
 * this agent is, whether it is the Human's contact, and any state in which a
 * message would go nowhere useful (a handoff in flight, a retired
 * generation, a frozen or still-initializing group, uncertain deliveries).
 */
export function SlpGroupBanner({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const router = useRouter();
  const group = useSlpGroup(serverId, workspaceId);
  const membership = useMemo(
    () => (group ? describeSlpMembership(group, agentId) : null),
    [group, agentId],
  );
  const openCurrent = useCallback(() => {
    if (!membership?.activeAgentId) return;
    router.push(buildHostAgentDetailRoute(serverId, membership.activeAgentId, workspaceId) as Href);
  }, [membership?.activeAgentId, router, serverId, workspaceId]);

  if (!group || !membership) return null;
  const notices = describeNotices(group, membership, t);
  const showOpenCurrent = membership.activeAgentId !== null && membership.activeAgentId !== agentId;
  const roleLabel = t(`slp.roles.${membership.role}`, { defaultValue: membership.role });

  return (
    <View style={styles.rail}>
      <View style={styles.content}>
        <View style={styles.callout} testID="slp-group-banner">
          <View style={styles.textColumn}>
            <Text style={styles.title} testID="slp-group-banner-role">
              {t("slp.banner.title", {
                role: roleLabel,
                mode: t(`slp.modes.${group.mode}`, { defaultValue: group.mode }),
                number: membership.generationNumber,
              })}
              {membership.isContact ? ` · ${t("slp.banner.contact")}` : ""}
            </Text>
            {notices.map((notice) => (
              <Text key={notice} style={styles.notice}>
                {notice}
              </Text>
            ))}
          </View>
          {showOpenCurrent ? (
            <Button
              size="sm"
              variant="secondary"
              onPress={openCurrent}
              testID="slp-group-banner-open-current"
            >
              {t("slp.banner.openCurrent", { role: roleLabel })}
            </Button>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function describeNotices(
  group: SlpGroupSummary,
  membership: SlpMembership,
  t: (key: string, options?: Record<string, unknown>) => string,
): string[] {
  const notices: string[] = [];
  if (group.status === "frozen") {
    notices.push(t("slp.banner.frozen", { reason: group.freezeReason ?? "" }));
  } else if (group.status === "initializing") {
    notices.push(t("slp.banner.initializing"));
  }
  if (group.initialMessageReceipt === "uncertain" && membership.isContact) {
    notices.push(t("slp.banner.receiptUncertain"));
  }
  if (membership.generationState === "retired") {
    notices.push(t("slp.banner.retired"));
  } else if (membership.transfer?.phase === "blocked") {
    notices.push(t("slp.banner.transferBlocked", { reason: membership.transfer.reason ?? "" }));
  } else if (membership.transfer?.isCandidate) {
    notices.push(t("slp.banner.transferCandidate"));
  } else if (membership.transfer?.isSource) {
    notices.push(t("slp.banner.transferSource"));
  }
  if (group.mail.uncertain > 0) {
    notices.push(t("slp.banner.mailUncertain", { count: group.mail.uncertain }));
  }
  if (group.mail.queued > 0) {
    notices.push(t("slp.banner.mailQueued", { count: group.mail.queued }));
  }
  return notices;
}

const styles = StyleSheet.create((theme: Theme) => ({
  rail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
  },
  content: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
  },
  callout: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
  },
  textColumn: {
    flex: 1,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
