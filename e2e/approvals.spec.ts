import { expect, test } from "@playwright/test";
import { closeBrowserPages, createWorkspace, joinWorkspace, proposeAction, signUp, userIdFor, waitForChat } from "./helpers";

test.afterEach(closeBrowserPages);

test.describe("approving agent actions", () => {
  test("an Admin cancels a proposed action and the whole room is told", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    const bob = await signUp(browser, "Bob");
    // Bob is an Editor: his page should never ask for the Admin-only
    // permission requests (it used to, every 15 seconds, and be refused).
    const editorAsked: string[] = [];
    bob.page.on("request", (request) => {
      if (request.url().includes("/permission-requests")) editorAsked.push(request.url());
    });
    const adminAsked: string[] = [];
    alice.page.on("request", (request) => {
      if (request.url().includes("/permission-requests")) adminAsked.push(request.url());
    });
    await joinWorkspace(bob, workspace.joinCode, workspace.name);
    await proposeAction(workspace.id, { id: await userIdFor(alice.page), name: alice.name }, "Open an issue: flaky login test");

    for (const { page } of [alice, bob]) {
      await page.reload();
      await waitForChat(page);
      await expect(page.getByTestId("pending-action-card")).toContainText("Open an issue: flaky login test");
    }

    // Bob is an Editor, who can't approve by default.
    await expect(bob.page.getByTestId("confirm-action-btn")).toBeDisabled();
    await expect(bob.page.getByTestId("pending-action-card")).toContainText("must confirm this action");

    await alice.page.getByTestId("cancel-action-btn").click();
    for (const { page } of [alice, bob]) {
      await expect(page.getByTestId("pending-action-card")).toHaveCount(0);
      await expect(page.getByTestId("chat-message").filter({ hasText: `${alice.name} cancelled: Open an issue: flaky login test` })).toBeVisible();
    }
    expect(editorAsked).toHaveLength(0);
    expect(adminAsked.length).toBeGreaterThan(0);
  });

  test("confirming when the tool is no longer connected fails visibly instead of silently", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    await proposeAction(workspace.id, { id: await userIdFor(alice.page), name: alice.name }, "Post the release note to #general");
    await alice.page.reload();
    await waitForChat(alice.page);
    // The action runs as Alice herself, so "Run as me" would mean nothing.
    await expect(alice.page.getByTestId("run-as-me-btn")).toHaveCount(0);
    await expect(alice.page.getByTestId("pending-action-card")).toContainText("Your connection for this tool is no longer available");
    await alice.page.getByTestId("confirm-action-btn").click();
    await expect(alice.page.getByTestId("chat-message").filter({ hasText: "no longer connected" })).toBeVisible();
    await expect(alice.page.getByTestId("pending-action-card")).toHaveCount(0);
  });
});
