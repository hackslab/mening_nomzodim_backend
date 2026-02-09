export const USER_PROFILE_FIELD_RULES = {
  displayName: {
    type: "string",
    maxLength: 80,
    promptSafe: true,
    sensitive: false,
  },
  preferredLanguage: {
    type: "string",
    maxLength: 16,
    promptSafe: true,
    sensitive: false,
  },
  roleUseCase: {
    type: "string",
    maxLength: 120,
    promptSafe: true,
    sensitive: false,
  },
  timezone: {
    type: "string",
    maxLength: 64,
    promptSafe: true,
    sensitive: false,
  },
  gender: {
    type: "string",
    maxLength: 16,
    promptSafe: true,
    sensitive: false,
  },
  adCount: {
    type: "number",
    promptSafe: false,
    sensitive: false,
  },
  currentStep: {
    type: "string",
    maxLength: 64,
    promptSafe: false,
    sensitive: false,
  },
  phoneNumber: {
    type: "string",
    maxLength: 32,
    promptSafe: false,
    sensitive: true,
  },
  email: {
    type: "string",
    maxLength: 120,
    promptSafe: false,
    sensitive: true,
  },
  notes: {
    type: "string",
    maxLength: 500,
    promptSafe: false,
    sensitive: true,
  },
} as const;

export type UserProfileFieldName = keyof typeof USER_PROFILE_FIELD_RULES;

export const USER_PROFILE_ALLOWED_UPDATE_FIELDS: UserProfileFieldName[] = [
  "displayName",
  "preferredLanguage",
  "roleUseCase",
  "timezone",
  "gender",
  "adCount",
  "phoneNumber",
  "email",
  "notes",
];

export const USER_PROFILE_PROMPT_SAFE_FIELDS: UserProfileFieldName[] = [
  "displayName",
  "preferredLanguage",
  "roleUseCase",
  "timezone",
  "gender",
];

export const USER_PROFILE_SENSITIVE_FIELDS = Object.entries(
  USER_PROFILE_FIELD_RULES,
)
  .filter(([, rule]) => rule.sensitive)
  .map(([field]) => field as UserProfileFieldName);

export const DEFAULT_PROMPT_CONTEXT_FIELD_MAX_LENGTH = 120;
