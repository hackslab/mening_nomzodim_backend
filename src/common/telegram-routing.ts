import { ConfigService } from "@nestjs/config";

export type TelegramRoutingConfig = {
  managementGroupId?: string;
  storageGroupId?: string;
  confirmPaymentsTopicId?: number;
  photosTopicId?: number;
  videosTopicId?: number;
  hiddenPhotosTopicId?: number;
  archiveTopicId?: number;
  anketasTopicId?: number;
  auditTopicId?: number;
  problemsTopicId?: number;
  publicChannelId?: string;
  privateChannelId?: string;
  vipChannelId?: string;
};

function pickString(config: ConfigService, keys: string[]) {
  for (const key of keys) {
    const value = config.get<string>(key)?.trim();
    if (value) return value;
  }
  return undefined;
}

function pickNumber(config: ConfigService, keys: string[]) {
  const raw = pickString(config, keys);
  if (!raw) return undefined;
  const match = raw.match(/^-?\d+/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveTelegramRoutingConfig(
  config: ConfigService,
): TelegramRoutingConfig {
  return {
    managementGroupId: pickString(config, ["MANAGEMENT_GROUP_ID", "ADMIN_GROUP_ID"]),
    storageGroupId: pickString(config, ["STORAGE_GROUP_ID"]),
    confirmPaymentsTopicId: pickNumber(config, [
      "CONFIRM_PAYMENTS_TOPIC_ID",
      "ADMIN_TOPIC_PAYMENTS_ID",
    ]),
    photosTopicId: pickNumber(config, ["PHOTOS_TOPIC_ID", "ADMIN_TOPIC_PHOTOS_ID"]),
    videosTopicId: pickNumber(config, ["VIDEOS_TOPIC_ID", "ADMIN_TOPIC_VIDEOS_ID"]),
    hiddenPhotosTopicId: pickNumber(config, [
      "HIDDEN_PHOTOS_TOPIC_ID",
      "ADMIN_TOPIC_BLUR_ID",
    ]),
    archiveTopicId: pickNumber(config, ["ARCHIVE_TOPIC_ID", "ADMIN_TOPIC_ARCHIVE_ID"]),
    anketasTopicId: pickNumber(config, [
      "ANKETAS_TOPIC_ID",
      "ADMIN_TOPIC_ANKETAS_ID",
    ]),
    auditTopicId: pickNumber(config, ["AUDIT_TOPIC_ID", "ADMIN_TOPIC_AUDIT_ID"]),
    problemsTopicId: pickNumber(config, [
      "PROBLEMS_TOPIC_ID",
      "ADMIN_TOPIC_PROBLEMS_ID",
    ]),
    publicChannelId: pickString(config, ["PUBLIC_CHANNEL_ID"]),
    privateChannelId: pickString(config, ["PRIVATE_CHANNEL_ID"]),
    vipChannelId: pickString(config, ["VIP_CHANNEL_ID", "PRIVATE_CHANNEL_ID"]),
  };
}

export function validateTelegramRoutingConfig(
  cfg: TelegramRoutingConfig,
  log: (message: string) => void,
) {
  const required: Array<[keyof TelegramRoutingConfig, string]> = [
    ["managementGroupId", "MANAGEMENT_GROUP_ID"],
    ["confirmPaymentsTopicId", "CONFIRM_PAYMENTS_TOPIC_ID"],
    ["storageGroupId", "STORAGE_GROUP_ID"],
    ["archiveTopicId", "ARCHIVE_TOPIC_ID"],
    ["photosTopicId", "PHOTOS_TOPIC_ID"],
    ["videosTopicId", "VIDEOS_TOPIC_ID"],
    ["hiddenPhotosTopicId", "HIDDEN_PHOTOS_TOPIC_ID"],
    ["publicChannelId", "PUBLIC_CHANNEL_ID"],
    ["privateChannelId", "PRIVATE_CHANNEL_ID"],
  ];

  for (const [prop, envName] of required) {
    if (!cfg[prop]) {
      log(`Telegram routing config missing: ${envName}`);
    }
  }
}
