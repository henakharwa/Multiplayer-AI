import { expect, test } from "@playwright/test";
import { closeBrowserPages, createWorkspace, signUp } from "./helpers";

test.afterEach(closeBrowserPages);

test.describe("integrations", () => {
  test("GitHub works with one repository per member: no workspace repository list or GitHub App", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    const { page } = alice;
    await page.goto(`/w/${workspace.id}/integrations`);

    const events = page.getByTestId("github-events");
    await expect(events).toBeVisible();
    await expect(events).toContainText("Everyone works in the one repository they chose");
    await expect(page.getByTestId("no-member-repositories")).toBeVisible();
    // Admins get the webhook values to set events up.
    await events.getByText("Set up events manually").click();
    await expect(events).toContainText(`/webhooks/github/workspaces/${workspace.id}`);

    await expect(page.getByText("Workspace repositories")).toHaveCount(0);
    await expect(page.getByText(/GitHub App/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add repository" })).toHaveCount(0);
  });
});
