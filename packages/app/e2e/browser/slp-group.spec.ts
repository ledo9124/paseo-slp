import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

/**
 * Browser evidence for the SLP client surface (implementation plan PR 7): the
 * workspace menu starts a supervised group on the mock provider, the app lands
 * on the Supervisor as the Human's contact, and the Lead's own screen says it
 * is the Lead. The daemon behind this is the e2e worker's, with Paseo tools
 * injected, so the runtime's own preconditions hold.
 */
// Group initialization refuses a host whose agents get no Paseo tools.
test.use({ e2eInjectPaseoTools: true });

test.describe("SLP group", () => {
  test("starts a supervised group from the workspace menu and shows each member's role", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "slp-group-" });
    try {
      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      await page.getByTestId("workspace-header-menu-trigger").click();
      await page.getByTestId("workspace-header-start-slp-group").click();

      const sheet = page.getByTestId("slp-start-group-sheet");
      await expect(sheet).toBeVisible();
      await sheet.getByTestId("slp-start-mode").getByText("Supervised", { exact: true }).click();
      await sheet.getByTestId("slp-start-provider").click();
      await page.getByTestId("slp-start-provider-mock").click();
      await sheet.getByTestId("slp-start-message").fill("Investigate why login is slow.");
      await sheet.getByTestId("slp-start-submit").click();

      // Both new members get a tab and the deck keeps an off-screen copy of a
      // retained panel, so assert on the banner that is actually on screen.
      const visibleBanner = page.getByTestId("slp-group-banner").filter({ visible: true });
      await expect(visibleBanner).toHaveCount(1, { timeout: 30_000 });
      const role = () => visibleBanner.getByTestId("slp-group-banner-role");
      await expect(role()).toContainText("Supervisor");
      await expect(role()).toContainText("your contact");

      // The Lead exists as a second tab; its own screen names its role.
      const group = await workspace.client.slpGroupGet(workspace.workspaceId);
      expect(group.group?.mode).toBe("supervised");
      const lead = group.group?.slots.find((slot) => slot.role === "lead");
      if (!lead?.activeAgentId) throw new Error("the group has no active Lead");
      await page
        .getByTestId(`workspace-tab-agent_${lead.activeAgentId}`)
        .filter({ visible: true })
        .first()
        .click();
      await expect(role()).toContainText("Lead", { timeout: 30_000 });

      // The workspace menu no longer offers a second group.
      await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
      await expect(page.getByTestId("workspace-header-menu")).toBeVisible();
      await expect(page.getByTestId("workspace-header-start-slp-group")).toHaveCount(0);
      await page.keyboard.press("Escape");
    } finally {
      await workspace.cleanup();
    }
  });
});
