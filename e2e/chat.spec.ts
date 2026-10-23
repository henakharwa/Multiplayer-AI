import { expect, test } from "@playwright/test";
import { closeBrowserPages, createWorkspace, joinWorkspace, sendChat, signUp, waitForChat } from "./helpers";

test.afterEach(closeBrowserPages);

test.describe("shared chat", () => {
  test("two teammates see each other, the same messages and the agent's reply live", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    const bob = await signUp(browser, "Bob");
    await joinWorkspace(bob, workspace.joinCode, workspace.name);
    await waitForChat(alice.page);
    await waitForChat(bob.page);

    // Presence: each sees the other in the member list.
    await expect(alice.page.getByTestId("participant").filter({ hasText: bob.name })).toBeVisible();
    await expect(bob.page.getByTestId("participant").filter({ hasText: alice.name })).toBeVisible();

    await sendChat(alice.page, "@agent what should we ship this week?");
    for (const { page } of [alice, bob]) {
      await expect(page.getByTestId("chat-message").filter({ hasText: "what should we ship this week?" }).first()).toBeVisible();
      await expect(page.getByTestId("chat-message").filter({ hasText: "Mock agent reply to: @agent what should we ship this week?" })).toBeVisible();
    }
  });

  test("a message to a teammate is handed off and does not start the agent", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    const workspace = await createWorkspace(alice);
    const bob = await signUp(browser, "Bob");
    await joinWorkspace(bob, workspace.joinCode, workspace.name);
    await waitForChat(alice.page);
    await sendChat(alice.page, "@agent start the thread");
    await expect(alice.page.getByTestId("chat-message").filter({ hasText: "Mock agent reply to:" })).toHaveCount(1);

    await sendChat(bob.page, `@${alice.name} can you review this?`);
    const handoff = alice.page.getByTestId("chat-message").filter({ hasText: "can you review this?" });
    await expect(handoff).toBeVisible();
    await expect(handoff.getByTestId("handoff-badge")).toBeVisible();
    // Still exactly one agent reply: the hand-off did not reach the agent.
    await alice.page.waitForTimeout(1500);
    await expect(alice.page.getByTestId("chat-message").filter({ hasText: "Mock agent reply to:" })).toHaveCount(1);
  });

  test("an over-long message cannot be typed past the limit", async ({ browser }) => {
    const alice = await signUp(browser, "Alice");
    await createWorkspace(alice);
    await waitForChat(alice.page);
    await alice.page.getByTestId("chat-input").fill("x".repeat(20_050));
    await expect(alice.page.getByTestId("chat-input")).toHaveValue("x".repeat(20_000));
  });
});
