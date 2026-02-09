import { BadRequestException } from "@nestjs/common";
import {
  validateUserId,
  validateUserProfileUpdateInput,
} from "./user-profile.validation";

describe("user-profile.validation", () => {
  it("rejects unsupported profile fields", () => {
    expect(() =>
      validateUserProfileUpdateInput({
        unknownField: "value",
      }),
    ).toThrow(BadRequestException);
  });

  it("validates and normalizes accepted profile fields", () => {
    const payload = validateUserProfileUpdateInput({
      displayName: "  Aziza  ",
      preferredLanguage: "UZ",
      roleUseCase: "  candidate  ",
      timezone: "Asia/Tashkent",
      gender: "female",
      adCount: 4,
      email: "  TEST@EXAMPLE.COM  ",
    });

    expect(payload).toEqual({
      displayName: "Aziza",
      preferredLanguage: "uz",
      roleUseCase: "candidate",
      timezone: "Asia/Tashkent",
      gender: "female",
      adCount: 4,
      email: "test@example.com",
    });
  });

  it("rejects invalid gender value", () => {
    expect(() =>
      validateUserProfileUpdateInput({
        gender: "unknown",
      }),
    ).toThrow(BadRequestException);
  });

  it("validates user id format", () => {
    expect(validateUserId("  user-1  ")).toBe("user-1");
    expect(() => validateUserId("  ")).toThrow(BadRequestException);
  });
});
