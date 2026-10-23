import { afterAll, describe, expect, it } from "vitest";
import { captureError, flushErrorTracking, initErrorTracking } from "../src/error-tracking.js";

describe("error tracking", () => {
  const previous = process.env.SENTRY_DSN;
  afterAll(() => {
    if (previous === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = previous;
  });

  it("stays off, and capturing is harmless, when no DSN is configured", async () => {
    delete process.env.SENTRY_DSN;
    expect(await initErrorTracking()).toBe(false);
    expect(() => captureError(new Error("ignored"), { where: "test" })).not.toThrow();
  });

  it("reports an error with where it happened, and never cookies or tokens", async () => {
    process.env.SENTRY_DSN = "https://publickey@o0.ingest.sentry.io/0";
    const sent: string[] = [];
    const recordingTransport = () => ({
      send: async (envelope: unknown) => {
        sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    });
    expect(await initErrorTracking({ transport: recordingTransport as never, defaultIntegrations: false })).toBe(true);

    const secretToken = "gho_secretvalue1234567890";
    // A local holding a secret must not be captured from the stack frame.
    (function failWithSecretInScope() {
      const token = secretToken;
      try {
        throw new Error("GitHub rejected the write");
      } catch (error) {
        captureError(error, { where: "action-confirm", workspaceId: "w-1", toolName: "create_issue", tokenLength: token.length });
      }
    })();
    await flushErrorTracking();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("GitHub rejected the write");
    expect(sent[0]).toContain("action-confirm");
    expect(sent[0]).toContain("w-1");
    expect(sent[0]).not.toContain(secretToken);
  });
});
