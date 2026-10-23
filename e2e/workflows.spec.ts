import { expect, test } from "@playwright/test";
import { API_URL, closeBrowserPages, createWorkspace, signUp } from "./helpers";

test.afterEach(closeBrowserPages);

test.describe("workflows", () => {
  test("an Admin creates a workflow and runs it now", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    const { page } = alice;
    await page.goto(`/w/${workspace.id}/workflows`);

    await page.getByPlaceholder("Weekly release readiness").fill("Daily standup summary");
    await page.getByPlaceholder("A short description for your team").fill("Summarize yesterday for the team");
    for (let step = 0; step < 6 && !(await page.getByRole("button", { name: "Create workflow" }).isVisible()); step++) {
      const instructions = page.getByPlaceholder("Review open pull requests, checks, and release blockers. Share a concise update.");
      if (await instructions.isVisible()) await instructions.fill("Write a two-line standup summary.");
      await page.getByRole("button", { name: "Continue" }).click();
    }
    await page.getByRole("button", { name: "Create workflow" }).click();
    await expect(page.locator(".workflow-card").filter({ hasText: "Daily standup summary" })).toBeVisible();

    await page.getByRole("button", { name: "Run now" }).click();
    // The run finishes and its record says it succeeded with the agent's answer.
    const workflows = await (await page.request.get(`${API_URL}/workspaces/${workspace.id}/workflows`)).json();
    const workflow = workflows.find((item: { name: string }) => item.name === "Daily standup summary");
    await expect
      .poll(async () => {
        const runs = await (await page.request.get(`${API_URL}/workspaces/${workspace.id}/workflows/${workflow.id}/runs`)).json();
        return runs[0]?.status;
      }, { timeout: 30_000 })
      .toBe("succeeded");
    const runs = await (await page.request.get(`${API_URL}/workspaces/${workspace.id}/workflows/${workflow.id}/runs`)).json();
    expect(JSON.stringify(runs[0])).toContain("Mock agent reply to:");
  });
});
