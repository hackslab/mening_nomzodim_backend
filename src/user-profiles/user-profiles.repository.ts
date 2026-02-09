import { Inject, Injectable } from "@nestjs/common";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../database/database.module";
import * as schema from "../database/schema";
import { userProfiles } from "../database/schema";
import { nowInUzbekistan } from "../common/time";
import { UserProfileUpdateInput } from "./user-profile.validation";

type UserProfileRow = typeof userProfiles.$inferSelect;

export type PromptContextProfileResult =
  | {
      status: "found";
      profile: UserProfileRow;
    }
  | {
      status: "no_profile";
    };

@Injectable()
export class UserProfilesRepository {
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {}

  async findByUserId(userId: string) {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    return rows[0];
  }

  async createByUserId(userId: string, payload: UserProfileUpdateInput) {
    const inserted = await this.db
      .insert(userProfiles)
      .values({
        userId,
        ...payload,
        createdAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .returning();
    return inserted[0];
  }

  async updateByUserId(userId: string, payload: UserProfileUpdateInput) {
    const updated = await this.db
      .update(userProfiles)
      .set({
        ...payload,
        updatedAt: nowInUzbekistan(),
      })
      .where(eq(userProfiles.userId, userId))
      .returning();
    return updated[0];
  }

  async upsertByUserId(userId: string, payload: UserProfileUpdateInput) {
    const existing = await this.findByUserId(userId);
    if (existing) {
      const updated = await this.updateByUserId(userId, payload);
      return {
        mode: "updated" as const,
        profile: updated,
      };
    }

    try {
      const created = await this.createByUserId(userId, payload);
      return {
        mode: "created" as const,
        profile: created,
      };
    } catch (error: any) {
      if (error?.code === "23505") {
        const updated = await this.updateByUserId(userId, payload);
        return {
          mode: "updated" as const,
          profile: updated,
        };
      }
      throw error;
    }
  }

  async getPromptContextProfile(userId: string): Promise<PromptContextProfileResult> {
    const profile = await this.findByUserId(userId);
    if (!profile) {
      return { status: "no_profile" };
    }
    return {
      status: "found",
      profile,
    };
  }
}
