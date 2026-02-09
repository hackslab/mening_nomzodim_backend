import { buildUserPromptContext } from "./prompt-context.builder";

describe("prompt-context.builder", () => {
  it("includes only prompt-safe fields", () => {
    const result = buildUserPromptContext({
      profile: {
        displayName: "Aziza",
        preferredLanguage: "uz",
        roleUseCase: "candidate",
        timezone: "Asia/Tashkent",
        gender: "female",
        phoneNumber: "+998901112233",
        notes: "sensitive",
      },
    });

    expect(result.status).toBe("included");
    expect(result.section).toContain("display_name=Aziza");
    expect(result.section).not.toContain("+998901112233");
    expect(result.excludedFields).toContain("phoneNumber");
    expect(result.excludedFields).toContain("notes");
  });

  it("falls back to skipped when no profile is present", () => {
    const result = buildUserPromptContext({ profile: undefined });
    expect(result.status).toBe("skipped");
    expect(result.section).toBeUndefined();
  });

  it("caps values by configured field length", () => {
    const result = buildUserPromptContext({
      profile: {
        displayName: "VeryLongName",
      },
      maxFieldLength: 4,
    });

    expect(result.section).toContain("display_name=Very");
  });
});
