import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  openNewWorkspaceComposer,
} from "../support/helpers/new-workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.use({ e2eInjectPaseoTools: false });

test("a refused New workspace SLP launch keeps the message and retries into exactly two role tabs", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const project = await seedWorkspace({ repoPrefix: "slp-startup-" });
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const originalConfig = (await client.getDaemonConfig()).config;
  const message = "Investigate the desktop SLP startup failure.";
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, project);
    const mode = () => page.getByTestId("slp-mode-control").filter({ visible: true }).first();
    await mode().click();
    await page.getByTestId("slp-mode-option-supervised").click();
    const composer = () =>
      page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }).first();
    await composer().fill(message);
    await page.getByTestId("workspace-create-submit").click();
    const workspace = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: project.workspaceId,
      projectDisplayName: project.projectDisplayName,
    });
    await expect(page.getByText(/SLP needs Paseo tools/).filter({ visible: true })).toBeVisible();
    await expect(composer()).toHaveValue(message);
    await expect(mode()).toContainText("Supervised");
    expect((await project.client.slpGroupGet(workspace.workspaceId)).group).toBeNull();

    await client.patchDaemonConfig({ mcp: { enabled: true, injectIntoAgents: true } });
    await composer().press("Enter");
    const banner = page.getByTestId("slp-group-banner").filter({ visible: true });
    await expect(banner.getByTestId("slp-group-banner-role")).toContainText("Supervisor", {
      timeout: 30_000,
    });
    const group = (await project.client.slpGroupGet(workspace.workspaceId)).group;
    expect(group?.mode).toBe("supervised");
    const deck = page.getByTestId(`workspace-deck-entry-${getServerId()}:${workspace.workspaceId}`);
    await expect(deck.locator('[data-testid^="workspace-tab-draft_"]')).toHaveCount(0);
    await expect(deck.locator('[data-testid^="workspace-tab-agent_"]')).toHaveCount(2);
    const lead = group?.slots.find((slot) => slot.role === "lead")?.activeAgentId;
    if (!lead) throw new Error("The initialized group has no Lead");
    await deck.getByTestId(`workspace-tab-agent_${lead}`).click();
    await expect(banner.getByTestId("slp-group-banner-role")).toContainText("Lead");
  } finally {
    await client.patchDaemonConfig({ mcp: originalConfig.mcp });
    await client.close();
    await project.cleanup();
  }
});
