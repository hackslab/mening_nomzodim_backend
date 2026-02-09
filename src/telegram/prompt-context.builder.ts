import {
  DEFAULT_PROMPT_CONTEXT_FIELD_MAX_LENGTH,
  USER_PROFILE_FIELD_RULES,
  USER_PROFILE_PROMPT_SAFE_FIELDS,
} from "../user-profiles/user-profile.constants";

export type PromptContextAssemblyStatus = "included" | "partial" | "skipped";

export type PromptContextAssemblyResult = {
  status: PromptContextAssemblyStatus;
  section?: string;
  includedFields: string[];
  excludedFields: string[];
};

const PROMPT_FIELD_LABELS: Record<string, string> = {
  displayName: "display_name",
  preferredLanguage: "preferred_language",
  roleUseCase: "role_use_case",
  timezone: "timezone",
  gender: "gender",
};

export function buildUserPromptContext(params: {
  profile?: Record<string, unknown>;
  maxFieldLength?: number;
}): PromptContextAssemblyResult {
  if (!params.profile) {
    return {
      status: "skipped",
      includedFields: [],
      excludedFields: [],
    };
  }

  const profile = params.profile;
  const maxFieldLength =
    params.maxFieldLength && params.maxFieldLength > 0
      ? Math.floor(params.maxFieldLength)
      : DEFAULT_PROMPT_CONTEXT_FIELD_MAX_LENGTH;

  const includedFields: string[] = [];
  const lines: string[] = [];

  for (const field of USER_PROFILE_PROMPT_SAFE_FIELDS) {
    const value = profile[field];
    if (value === undefined || value === null) continue;

    const asText = String(value).replace(/\s+/g, " ").trim();
    if (!asText) continue;

    const fieldRule = USER_PROFILE_FIELD_RULES[field];
    const perFieldLimit =
      fieldRule && "maxLength" in fieldRule ? fieldRule.maxLength : undefined;
    const hardLimit = perFieldLimit
      ? Math.min(perFieldLimit, maxFieldLength)
      : maxFieldLength;
    const bounded = asText.slice(0, hardLimit);

    lines.push(`${PROMPT_FIELD_LABELS[field]}=${bounded}`);
    includedFields.push(field);
  }

  const excludedFields = Object.keys(profile)
    .filter((field) => !USER_PROFILE_PROMPT_SAFE_FIELDS.includes(field as any))
    .sort();

  if (lines.length === 0) {
    return {
      status: "skipped",
      includedFields,
      excludedFields,
    };
  }

  return {
    status:
      includedFields.length === USER_PROFILE_PROMPT_SAFE_FIELDS.length
        ? "included"
        : "partial",
    section: ["[USER_PROFILE_CONTEXT]", ...lines].join("\n"),
    includedFields,
    excludedFields,
  };
}
