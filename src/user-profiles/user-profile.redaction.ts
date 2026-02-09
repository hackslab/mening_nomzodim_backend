import { USER_PROFILE_SENSITIVE_FIELDS } from "./user-profile.constants";

const REDACTED = "[REDACTED]";

export function redactUserProfilePayload(
  payload: Record<string, unknown> | undefined,
) {
  if (!payload) return undefined;
  const output: Record<string, unknown> = { ...payload };
  for (const field of USER_PROFILE_SENSITIVE_FIELDS) {
    if (field in output && output[field] !== undefined) {
      output[field] = REDACTED;
    }
  }
  return output;
}
