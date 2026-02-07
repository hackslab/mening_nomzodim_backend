import { Inject, Injectable } from "@nestjs/common";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DRIZZLE } from "../database/database.module";
import * as schema from "../database/schema";
import { adPosts, chatMessages, chatSessions, userProfiles } from "../database/schema";
import { eq } from "drizzle-orm";
import { nowInUzbekistan } from "../common/time";

@Injectable()
export class UserProfilesService {
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {}

  async getProfile(userId: string) {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    return rows[0];
  }

  async updateProfile(userId: string, input: { gender?: string; adCount?: number }) {
    const gender = this.normalizeGender(input.gender);
    const adCount = this.normalizeAdCount(input.adCount);
    const existing = await this.getProfile(userId);

    if (!existing) {
      const inserted = await this.db
        .insert(userProfiles)
        .values({
          userId,
          gender,
          adCount: adCount ?? 0,
          createdAt: nowInUzbekistan(),
          updatedAt: nowInUzbekistan(),
        })
        .returning();
      return inserted[0];
    }

    const updatePayload: Partial<typeof userProfiles.$inferInsert> = {
      updatedAt: nowInUzbekistan(),
    };
    if (gender) updatePayload.gender = gender;
    if (adCount !== undefined) updatePayload.adCount = adCount;

    const updated = await this.db
      .update(userProfiles)
      .set(updatePayload)
      .where(eq(userProfiles.userId, userId))
      .returning();
    return updated[0];
  }

  async backfillFromAdPosts() {
    const posts = await this.db
      .select({ userId: adPosts.userId, content: adPosts.content })
      .from(adPosts);

    const stats = new Map<string, { count: number; gender?: string }>();

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

    const profiles = await this.db.select().from(userProfiles);
    const profileMap = new Map(profiles.map((item) => [item.userId, item]));

    let inserted = 0;
    let updated = 0;

    for (const [userId, entry] of stats.entries()) {
      const existing = profileMap.get(userId);
      if (!existing) {
        await this.db.insert(userProfiles).values({
          userId,
          gender: entry.gender,
          adCount: entry.count,
          createdAt: nowInUzbekistan(),
          updatedAt: nowInUzbekistan(),
        });
        inserted += 1;
        continue;
      }

      const nextGender = existing.gender ?? entry.gender;
      const nextCount = Math.max(existing.adCount ?? 0, entry.count);

      if (nextGender !== existing.gender || nextCount !== existing.adCount) {
        await this.db
          .update(userProfiles)
          .set({
            gender: nextGender,
            adCount: nextCount,
            updatedAt: nowInUzbekistan(),
          })
          .where(eq(userProfiles.userId, userId));
        updated += 1;
      }
    }

    return {
      totalProfiles: profiles.length,
      totalUsers: stats.size,
      inserted,
      updated,
    };
  }

  private normalizeGender(input?: string) {
    if (!input) return undefined;
    const lowered = input.toLowerCase();
    if (["female", "ayol", "qiz"].includes(lowered)) return "female";
    if (["male", "erkak", "yigit"].includes(lowered)) return "male";
    return undefined;
  }

  private normalizeAdCount(input?: number) {
    if (input === undefined || input === null) return undefined;
    const parsed = Number(input);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.max(0, Math.floor(parsed));
    return normalized;
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
}
