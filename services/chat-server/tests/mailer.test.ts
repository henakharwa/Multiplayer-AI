import { describe, expect, it } from "vitest";
import { createMailer } from "../src/mailer.js";

describe("production mailer configuration", () => {
  it("refuses to report delivery when production has no email provider", async () => {
    await expect(
      createMailer({}, true).send({ to: "editor@example.test", subject: "Invitation", text: "Join the workspace." }),
    ).rejects.toThrow(/Outbound email is not configured/);
  });
});
