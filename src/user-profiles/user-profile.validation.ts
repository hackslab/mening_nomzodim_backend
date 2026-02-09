import { BadRequestException } from "@nestjs/common";
import {
  USER_PROFILE_ALLOWED_UPDATE_FIELDS,
  USER_PROFILE_FIELD_RULES,
  UserProfileFieldName,
} from "./user-profile.constants";

export type UserProfileUpdateInput = Partial<{
  displayName: string;
  preferredLanguage: string;
  roleUseCase: string;
  timezone: string;
  gender: "male" | "female";
  adCount: number;
  phoneNumber: string;
  email: string;
  notes: string;
}>;

const ALLOWED_FIELD_SET = new Set<string>(USER_PROFILE_ALLOWED_UPDATE_FIELDS);

export function validateUserId(userId: string) {
  const normalized = typeof userId === "string" ? userId.trim() : "";
  if (!normalized) {
    throw new BadRequestException("userId is required");
  }
  if (normalized.length > 128) {
    throw new BadRequestException("userId is too long");
  }
  return normalized;
}

export function validateUserProfileUpdateInput(
  payload: Record<string, unknown>,
): UserProfileUpdateInput {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new BadRequestException("Profile payload must be an object");
  }

  const keys = Object.keys(payload);
  const disallowed = keys.filter((key) => !ALLOWED_FIELD_SET.has(key));
  if (disallowed.length > 0) {
    throw new BadRequestException(
      `Unsupported profile field(s): ${disallowed.join(", ")}`,
    );
  }

  const output: UserProfileUpdateInput = {};

  for (const key of keys) {
    const field = key as UserProfileFieldName;
    const value = payload[field];
    if (value === undefined || value === null) continue;

    if (field === "adCount") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw new BadRequestException("adCount must be a non-negative number");
      }
      output.adCount = Math.floor(numeric);
      continue;
    }

    if (typeof value !== "string") {
      throw new BadRequestException(`${field} must be a string`);
    }

    const trimmed = value.trim();
    const maxLength = USER_PROFILE_FIELD_RULES[field]?.maxLength;
    if (maxLength && trimmed.length > maxLength) {
      throw new BadRequestException(
        `${field} exceeds max length (${maxLength})`,
      );
    }

    switch (field) {
      case "displayName":
        output.displayName = trimmed;
        break;
      case "preferredLanguage":
        if (!/^[a-z]{2,8}(?:-[a-z]{2,8})?$/i.test(trimmed)) {
          throw new BadRequestException("preferredLanguage has invalid format");
        }
        output.preferredLanguage = trimmed.toLowerCase();
        break;
      case "roleUseCase":
        output.roleUseCase = trimmed;
        break;
      case "timezone":
        output.timezone = trimmed;
        break;
      case "gender": {
        const normalized = trimmed.toLowerCase();
        if (!["female", "male"].includes(normalized)) {
          throw new BadRequestException("gender must be female or male");
        }
        output.gender = normalized as "female" | "male";
        break;
      }
      case "phoneNumber":
        output.phoneNumber = trimmed;
        break;
      case "email":
        if (!trimmed.includes("@")) {
          throw new BadRequestException("email has invalid format");
        }
        output.email = trimmed.toLowerCase();
        break;
      case "notes":
        output.notes = trimmed;
        break;
      default:
        break;
    }
  }

  return output;
}
