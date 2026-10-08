import { describe, expect, it } from "vitest";
import { missingRequiredFields } from "../lib/builder-validation";

describe("builder required-field validation", () => {
  it("flags missing and whitespace-only required values", () => {
    expect(
      missingRequiredFields({
        name: "  ",
        instructions: "",
        title: undefined,
        content: "Ready",
      }),
    ).toEqual(["name", "instructions", "title"]);
  });

  it("accepts populated required values", () => {
    expect(missingRequiredFields({ name: "Release readiness", instructions: "Review blockers." })).toEqual([]);
  });
});
