import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

/**
 * Browser evidence for the SLP client surface (implementation plan PR 7): a
 * draft composer's workspace-mode pill starts a supervised group on the mock
 * provider with the first message, the app lands on the Supervisor as the
 * Human's contact, the Lead's own screen says it is the Lead, and ending the
 * group from the workspace menu opens the mode again. The daemon behind this
 * is the e2e worker's, with Paseo tools injected, so the runtime's own
 * preconditions hold.
 */
// Group initialization refuses a host whose agents get no Paseo tools.
test.use({ e2eInjectPaseoTools: true });

test.describe("SLP group", () => {
  test("starts a supervised group from the composer's mode pill, shows each member's role and ends it", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "slp-group-" });
    // The web confirm dialog is the browser's own.
    page.on("dialog", (dialog) => void dialog.accept());
    try {
      await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
      const composer = page.getByRole("textbox", { name: "Message agent..." }).first();
      await expect(composer).toBeEditable({ timeout: 30_000 });

      // The empty workspace offers the choice; Single agent is the default.
      const modePill = page.getByTestId("slp-mode-control").filter({ visible: true }).first();
      await expect(modePill).toContainText("Single agent");
      await modePill.click();
      await page.getByTestId("slp-mode-option-supervised").click();
      await expect(modePill).toContainText("Supervised");

      await composer.fill("Investigate why login is slow.");
      await composer.press("Enter");

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

      // Ending the group archives its members and frees the workspace mode.
      await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
      await page.getByTestId("workspace-header-end-slp-group").click();
      await expect
        .poll(async () => (await workspace.client.slpGroupGet(workspace.workspaceId)).group, {
          timeout: 30_000,
        })
        .toBeNull();
      await expect(page.getByTestId("slp-group-banner").filter({ visible: true })).toHaveCount(0, {
        timeout: 30_000,
      });
    } finally {
      await workspace.cleanup();
    }
  });
});
