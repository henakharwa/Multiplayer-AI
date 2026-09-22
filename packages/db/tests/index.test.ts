import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import {
  getPool,
  closePool,
  createWorkspace,
  getWorkspaceById,
  getWorkspaceByJoinCode,
  insertMessage,
  listMessages,
  upsertGithubIntegration,
  upsertSlackIntegration,
  listIntegrations,
  getIntegrationCredential,
  encryptToken,
  decryptToken,
} from "../src/index.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// Real local Postgres, no mocking -- same "mock only the non-deterministic
// external call" line this project has drawn since Week 1; there's nothing
// non-deterministic about a local database.
beforeAll(async () => {
  const schema = await readFile(fileURLToPath(new URL("../sql/schema.sql", import.meta.url)), "utf8");
  await getPool().query(schema);
});

afterAll(async () => {
  await closePool();
});

describe("crypto", () => {
  it("round-trips a token", () => {
    const encrypted = encryptToken("ghp_realtoken123");
    expect(encrypted).not.toContain("ghp_realtoken123");
    expect(decryptToken(encrypted)).toBe("ghp_realtoken123");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptToken("same-token");
    const b = encryptToken("same-token");
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe("same-token");
    expect(decryptToken(b)).toBe("same-token");
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    const encrypted = encryptToken("secret");
    const [iv, authTag, ciphertext] = encrypted.split(":");
    const tampered = [iv, authTag, Buffer.from("garbage").toString("base64")].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });
});

describe("workspaces", () => {
  it("creates a workspace with a unique join code and reads it back both ways", async () => {
    const ws = await createWorkspace("Acme Eng");
    expect(ws.name).toBe("Acme Eng");
    expect(ws.joinCode).toHaveLength(6);

    const byId = await getWorkspaceById(ws.id);
    expect(byId?.id).toBe(ws.id);

    const byCode = await getWorkspaceByJoinCode(ws.joinCode);
    expect(byCode?.id).toBe(ws.id);
  });

  it("returns null for an unknown id or join code", async () => {
    expect(await getWorkspaceById("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getWorkspaceByJoinCode("zzzzzz")).toBeNull();
  });
});

describe("messages", () => {
  it("persists messages in order and lists them back", async () => {
    const ws = await createWorkspace("Message Test Co");
    await insertMessage({ workspaceId: ws.id, role: "user", authorName: "Alice", content: "hi" });
    await insertMessage({ workspaceId: ws.id, role: "agent", authorName: "Agent", content: "hello Alice" });
    await insertMessage({ workspaceId: ws.id, role: "user", authorName: "Bob", content: "hey" });

    const messages = await listMessages(ws.id);
    expect(messages.map((m) => m.content)).toEqual(["hi", "hello Alice", "hey"]);
    expect(messages[1].role).toBe("agent");
  });

  it("scopes messages to their own workspace", async () => {
    const wsA = await createWorkspace("Workspace A");
    const wsB = await createWorkspace("Workspace B");
    await insertMessage({ workspaceId: wsA.id, role: "user", authorName: "A", content: "only in A" });
    await insertMessage({ workspaceId: wsB.id, role: "user", authorName: "B", content: "only in B" });

    const messagesA = await listMessages(wsA.id);
    const messagesB = await listMessages(wsB.id);
    expect(messagesA.map((m) => m.content)).toEqual(["only in A"]);
    expect(messagesB.map((m) => m.content)).toEqual(["only in B"]);
  });
});

describe("integrations", () => {
  it("stores a github integration, never returns the raw token from the client-safe listing, but decrypts it correctly server-side", async () => {
    const ws = await createWorkspace("Github Integration Co");
    const config = await upsertGithubIntegration({
      workspaceId: ws.id,
      owner: "octocat",
      repo: "hello-world",
      token: "ghp_realSecretToken",
    });
    expect(config.owner).toBe("octocat");
    expect(config.connected).toBe(true);

    const listed = await listIntegrations(ws.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("ghp_realSecretToken");

    const credential = await getIntegrationCredential(ws.id, "github");
    expect(credential?.token).toBe("ghp_realSecretToken");
    expect(credential?.owner).toBe("octocat");
    expect(credential?.repo).toBe("hello-world");
  });

  it("stores a slack integration alongside a github one for the same workspace without clobbering it", async () => {
    const ws = await createWorkspace("Both Integrations Co");
    await upsertGithubIntegration({ workspaceId: ws.id, owner: "o", repo: "r", token: "gh-token" });
    await upsertSlackIntegration({ workspaceId: ws.id, teamName: "Acme", token: "xoxb-slack-token" });

    const listed = await listIntegrations(ws.id);
    expect(listed).toHaveLength(2);

    const githubCred = await getIntegrationCredential(ws.id, "github");
    const slackCred = await getIntegrationCredential(ws.id, "slack");
    expect(githubCred?.token).toBe("gh-token");
    expect(slackCred?.token).toBe("xoxb-slack-token");
    expect(slackCred?.teamName).toBe("Acme");
  });

  it("re-connecting github for the same workspace updates it in place (upsert), not a duplicate row", async () => {
    const ws = await createWorkspace("Reconnect Co");
    await upsertGithubIntegration({ workspaceId: ws.id, owner: "old-owner", repo: "old-repo", token: "old-token" });
    await upsertGithubIntegration({ workspaceId: ws.id, owner: "new-owner", repo: "new-repo", token: "new-token" });

    const listed = await listIntegrations(ws.id);
    expect(listed).toHaveLength(1);
    const credential = await getIntegrationCredential(ws.id, "github");
    expect(credential?.owner).toBe("new-owner");
    expect(credential?.token).toBe("new-token");
  });

  it("returns null for a workspace with no integration of that type", async () => {
    const ws = await createWorkspace("No Integrations Co");
    expect(await getIntegrationCredential(ws.id, "github")).toBeNull();
    expect(await listIntegrations(ws.id)).toEqual([]);
  });
});
