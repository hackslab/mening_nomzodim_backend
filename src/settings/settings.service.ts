import { Inject, Injectable } from "@nestjs/common";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DRIZZLE } from "../database/database.module";
import * as schema from "../database/schema";
import { appSettings } from "../database/schema";
import { eq } from "drizzle-orm";
import { nowInUzbekistan } from "../common/time";

export type SummarySettings = {
  summaryBatchSize: number;
  summaryCronMinutes: number;
};

const DEFAULT_SUMMARY_BATCH_SIZE = 100;
const DEFAULT_SUMMARY_CRON_MINUTES = 1;

@Injectable()
export class SettingsService {
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {}

  async getSettings(): Promise<SummarySettings> {
    const existing = await this.db.select().from(appSettings).limit(1);
    if (existing.length === 0) {
      return {
        summaryBatchSize: DEFAULT_SUMMARY_BATCH_SIZE,
        summaryCronMinutes: DEFAULT_SUMMARY_CRON_MINUTES,
      };
    }

    return this.normalizeSettings({
      summaryBatchSize: existing[0].summaryBatchSize,
      summaryCronMinutes: existing[0].summaryCronMinutes,
    });
  }

  async updateSettings(input: Partial<SummarySettings>) {
    const current = await this.getSettings();
    const next = this.normalizeSettings({
      summaryBatchSize: input.summaryBatchSize ?? current.summaryBatchSize,
      summaryCronMinutes: input.summaryCronMinutes ?? current.summaryCronMinutes,
    });

    const existing = await this.db
      .select({ id: appSettings.id })
      .from(appSettings)
      .limit(1);

    if (existing.length === 0) {
      const inserted = await this.db
        .insert(appSettings)
        .values({
          summaryBatchSize: next.summaryBatchSize,
          summaryCronMinutes: next.summaryCronMinutes,
          createdAt: nowInUzbekistan(),
          updatedAt: nowInUzbekistan(),
        })
        .returning();
      return {
        summaryBatchSize: inserted[0].summaryBatchSize,
        summaryCronMinutes: inserted[0].summaryCronMinutes,
      };
    }

    const updated = await this.db
      .update(appSettings)
      .set({
        summaryBatchSize: next.summaryBatchSize,
        summaryCronMinutes: next.summaryCronMinutes,
        updatedAt: nowInUzbekistan(),
      })
      .where(eq(appSettings.id, existing[0].id))
      .returning();

    return {
      summaryBatchSize: updated[0].summaryBatchSize,
      summaryCronMinutes: updated[0].summaryCronMinutes,
    };
  }

  private normalizeSettings(input: SummarySettings): SummarySettings {
    return {
      summaryBatchSize: this.normalizePositiveInt(
        input.summaryBatchSize,
        DEFAULT_SUMMARY_BATCH_SIZE,
      ),
      summaryCronMinutes: this.normalizePositiveInt(
        input.summaryCronMinutes,
        DEFAULT_SUMMARY_CRON_MINUTES,
      ),
    };
  }

  private normalizePositiveInt(value: unknown, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const normalized = Math.floor(parsed);
    if (normalized <= 0) return fallback;
    return normalized;
  }
}
