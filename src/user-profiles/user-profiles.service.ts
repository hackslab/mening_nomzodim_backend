import { Inject, Injectable, Logger } from "@nestjs/common";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../database/database.module";
import * as schema from "../database/schema";
import { adPosts, chatMessages, chatSessions } from "../database/schema";
import { UserProfilesRepository } from "./user-profiles.repository";
import {
  UserProfileUpdateInput,
  validateUserId,
  validateUserProfileUpdateInput,
} from "./user-profile.validation";
import { redactUserProfilePayload } from "./user-profile.redaction";
import { ensureUserProfilesSchema } from "./user-profiles-schema";

@Injectable()
export class UserProfilesService {
  private readonly logger = new Logger(UserProfilesService.name);
  private schemaChecked = false;

  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
    private readonly profilesRepository: UserProfilesRepository,
  ) {}

  async getProfile(userId: string) {
    await this.ensureSchema();
    const normalizedUserId = validateUserId(userId);
    const profile = await this.profilesRepository.findByUserId(normalizedUserId);

    this.logTelemetry("profile.read", {
      userId: normalizedUserId,
      outcome: profile ? "found" : "no_profile",
    });

    return profile;
  }

  async createProfile(userId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const normalizedUserId = validateUserId(userId);
    const validatedPayload = validateUserProfileUpdateInput(payload);

    const existing = await this.profilesRepository.findByUserId(normalizedUserId);
    const result = existing
      ? await this.profilesRepository.updateByUserId(
          normalizedUserId,
          validatedPayload,
        )
      : await this.profilesRepository.createByUserId(
          normalizedUserId,
          validatedPayload,
        );

    this.logTelemetry("profile.write", {
      userId: normalizedUserId,
      action: existing ? "updated" : "created",
      payload: redactUserProfilePayload(validatedPayload as Record<string, unknown>),
    });

    return result;
  }

  async updateProfile(userId: string, payload: Record<string, unknown>) {
    await this.ensureSchema();
    const normalizedUserId = validateUserId(userId);
    const validatedPayload = validateUserProfileUpdateInput(payload);
    const upserted = await this.profilesRepository.upsertByUserId(
      normalizedUserId,
      validatedPayload,
    );

    this.logTelemetry("profile.write", {
      userId: normalizedUserId,
      action: upserted.mode,
      payload: redactUserProfilePayload(validatedPayload as Record<string, unknown>),
    });

    return upserted.profile;
  }

  async getProfileForPromptContext(userId: string) {
    await this.ensureSchema();
    const normalizedUserId = validateUserId(userId);
    const result = await this.profilesRepository.getPromptContextProfile(
      normalizedUserId,
    );

    this.logTelemetry("profile.prompt_context.read", {
      userId: normalizedUserId,
      outcome: result.status,
    });

    return result;
  }

  async backfillFromAdPosts() {
    await this.ensureSchema();
    const posts = await this.db
      .select({ userId: adPosts.userId, content: adPosts.content })
      .from(adPosts);

    const stats = new Map<string, { count: number; gender?: "female" | "male" }>();

    for (const post of posts) {
      if (!post.userId) continue;
      const entry = stats.get(post.userId) ?? { count: 0 };
      entry.count += 1;
      if (!entry.gender) {
        const inferred = this.parseGenderFromText(post.content);
        if (inferred) entry.gender = inferred;
      }
      stats.set(post.userId, entry);
    }

    const sessions = await this.db
      .select({ id: chatSessions.id, userId: chatSessions.userId })
      .from(chatSessions);
    const sessionMap = new Map(sessions.map((item) => [item.id, item.userId]));

    const messages = await this.db
      .select({ sessionId: chatMessages.sessionId, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.role, "user"));

    for (const message of messages) {
      const userId = sessionMap.get(message.sessionId);
      if (!userId) continue;
      const entry = stats.get(userId) ?? { count: 0 };
      if (!entry.gender) {
        const inferred = this.parseGenderFromText(message.content);
        if (inferred) {
          entry.gender = inferred;
          stats.set(userId, entry);
        }
      }
    }

    let inserted = 0;
    let updated = 0;

    for (const [userId, entry] of stats.entries()) {
      const existing = await this.profilesRepository.findByUserId(userId);
      const payload: UserProfileUpdateInput = {
        adCount: entry.count,
        gender: entry.gender,
      };

      if (!existing) {
        await this.profilesRepository.createByUserId(userId, payload);
        inserted += 1;
        continue;
      }

      const nextGender = this.normalizeGender(existing.gender) ?? entry.gender;
      const nextCount = Math.max(existing.adCount ?? 0, entry.count);

      if (nextGender !== existing.gender || nextCount !== existing.adCount) {
        await this.profilesRepository.updateByUserId(userId, {
          gender: nextGender ?? undefined,
          adCount: nextCount,
        });
        updated += 1;
      }
    }

    this.logTelemetry("profile.backfill", {
      totalUsers: stats.size,
      inserted,
      updated,
    });

    return {
      totalUsers: stats.size,
      inserted,
      updated,
    };
  }

  private parseGenderFromText(text: string) {
    const lowered = text.toLowerCase();
    const jinsLine = lowered.split("\n").find((line) => line.startsWith("jins"));
    if (jinsLine) {
      if (jinsLine.includes("ayol") || jinsLine.includes("qiz")) return "female";
      if (jinsLine.includes("erkak") || jinsLine.includes("yigit")) return "male";
    }
    if (/(\bayol\b|\bqiz\b)/i.test(lowered)) return "female";
    if (/(\berkak\b|\byigit\b)/i.test(lowered)) return "male";
    return undefined;
  }

  private normalizeGender(value?: string | null) {
    if (!value) return undefined;
    const lowered = value.trim().toLowerCase();
    if (lowered === "female" || lowered === "male") return lowered;
    return undefined;
  }

  private logTelemetry(event: string, payload: Record<string, unknown>) {
    this.logger.log(
      JSON.stringify({
        event,
        ...payload,
      }),
    );
  }

  private async ensureSchema() {
    if (this.schemaChecked) return;
    this.schemaChecked = true;
    try {
      await ensureUserProfilesSchema(this.db, this.logger);
    } catch (error) {
      this.schemaChecked = false;
      this.logger.warn("Failed to ensure user_profiles schema", error as Error);
      throw error;
    }
  }
}
