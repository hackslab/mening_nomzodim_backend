import { Inject, Injectable, Logger } from "@nestjs/common";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DRIZZLE } from "../database/database.module";
import * as schema from "../database/schema";
import { appSettings } from "../database/schema";
import { eq, sql } from "drizzle-orm";
import { nowInUzbekistan } from "../common/time";

export type SummarySettings = {
  summaryBatchSize: number;
  summaryCronMinutes: number;
  systemPrompt: string;
  summaryPrompt: string;
};

const DEFAULT_SUMMARY_BATCH_SIZE = 100;
const DEFAULT_SUMMARY_CRON_MINUTES = 1;
const DEFAULT_SYSTEM_PROMPT_TEMPLATE = [
  "Siz sovchilik agentligi adminisiz. Ismingiz: {adminName}.",
  "Mijozlar bilan ozbek (lotin) tilida gaplashing.",
  "Javoblar 1-2 gap, qisqa va aniq bo'lsin. Ortikcha reklama yoki takror yozmang.",
  "Savolga javob bering, kerak bo'lsa bitta aniqlashtiruvchi savol bering.",
  "O'zingizni bot deb tanitmang.",
  "Narx yoki qoida haqida ishonchsiz bo'lsangiz taxmin qilmang, aniqlashtiring.",
  "Kontakt/raqam/rasm so'ralganda anketa ID so'rang (masalan #371). To'lovdan keyin kontakt va 1 ta rasm beriladi.",
  "E'lon (anketa joylash) so'ralganda jinsini so'rang, 2 ta rasm va 1 ta video kerakligini ayting.",
  "VIP so'ralganda: VIP kanal oyiga {vipPrice} so'm. Xohlasa obunani boshlang.",
  "Narxlar (faqat so'ralganda): kontakt {contactPrice} so'm, e'lon {adPrice} so'm. Qizlar uchun birinchi e'lon bepul.",
  "Kafolat: nomzod bog'lanmasa 100% pul qaytariladi.",
  "Agar mijoz shikoyat qilsa, haqorat qilsa yoki muammo haqida yozsa, faqat quyidagi matnni yozing: escalate_to_human",
].join("\n");
const DEFAULT_SUMMARY_PROMPT_TEMPLATE = [
  "Siz yordamchi assistentsiz.",
  "Quyidagi xulosa va yangi xabarlar asosida yangilangan xulosa tuzing.",
  "Iltimos, barcha muhim faktlar, ism-shariflar, raqamlar, qarorlar, muammolar, reja va keyingi qadamlarni saqlang.",
  "Qisqa yozmang, batafsil va tushunarli bo'lsin.",
  "Xulosa faqat ozbek (lotin) tilida bo'lsin.",
].join("\n");

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private schemaChecked = false;
  constructor(
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {}

  async getSettings(): Promise<SummarySettings> {
    await this.ensureSettingsSchema();
    const existing = await this.db.select().from(appSettings).limit(1);
    if (existing.length === 0) {
      return {
        summaryBatchSize: DEFAULT_SUMMARY_BATCH_SIZE,
        summaryCronMinutes: DEFAULT_SUMMARY_CRON_MINUTES,
        systemPrompt: DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        summaryPrompt: DEFAULT_SUMMARY_PROMPT_TEMPLATE,
      };
    }

    return this.normalizeSettings({
      summaryBatchSize: existing[0].summaryBatchSize,
      summaryCronMinutes: existing[0].summaryCronMinutes,
      systemPrompt: existing[0].systemPrompt ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE,
      summaryPrompt: existing[0].summaryPrompt ?? DEFAULT_SUMMARY_PROMPT_TEMPLATE,
    });
  }

  async updateSettings(input: Partial<SummarySettings>) {
    await this.ensureSettingsSchema();
    const current = await this.getSettings();
    const next = this.normalizeSettings({
      summaryBatchSize: input.summaryBatchSize ?? current.summaryBatchSize,
      summaryCronMinutes: input.summaryCronMinutes ?? current.summaryCronMinutes,
      systemPrompt: input.systemPrompt ?? current.systemPrompt,
      summaryPrompt: input.summaryPrompt ?? current.summaryPrompt,
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
          systemPrompt: next.systemPrompt,
          summaryPrompt: next.summaryPrompt,
          createdAt: nowInUzbekistan(),
          updatedAt: nowInUzbekistan(),
        })
        .returning();
      return {
        summaryBatchSize: inserted[0].summaryBatchSize,
        summaryCronMinutes: inserted[0].summaryCronMinutes,
        systemPrompt: inserted[0].systemPrompt ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE,
        summaryPrompt:
          inserted[0].summaryPrompt ?? DEFAULT_SUMMARY_PROMPT_TEMPLATE,
      };
    }

    const updated = await this.db
      .update(appSettings)
      .set({
        summaryBatchSize: next.summaryBatchSize,
        summaryCronMinutes: next.summaryCronMinutes,
        systemPrompt: next.systemPrompt,
        summaryPrompt: next.summaryPrompt,
        updatedAt: nowInUzbekistan(),
      })
      .where(eq(appSettings.id, existing[0].id))
      .returning();

    return {
      summaryBatchSize: updated[0].summaryBatchSize,
      summaryCronMinutes: updated[0].summaryCronMinutes,
      systemPrompt: updated[0].systemPrompt ?? DEFAULT_SYSTEM_PROMPT_TEMPLATE,
      summaryPrompt:
        updated[0].summaryPrompt ?? DEFAULT_SUMMARY_PROMPT_TEMPLATE,
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
      systemPrompt: this.normalizePrompt(
        input.systemPrompt,
        DEFAULT_SYSTEM_PROMPT_TEMPLATE,
      ),
      summaryPrompt: this.normalizePrompt(
        input.summaryPrompt,
        DEFAULT_SUMMARY_PROMPT_TEMPLATE,
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

  private normalizePrompt(value: unknown, fallback: string) {
    if (typeof value !== "string") return fallback;
    const normalized = value.replace(/\r\n/g, "\n").trim();
    if (!normalized) return fallback;
    return normalized;
  }

  private async ensureSettingsSchema() {
    if (this.schemaChecked) return;
    this.schemaChecked = true;
    try {
      await this.db.execute(
        sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS system_prompt text`,
      );
      await this.db.execute(
        sql`ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS summary_prompt text`,
      );
    } catch (error) {
      this.logger.warn("Failed to ensure app_settings columns", error as Error);
    }
  }
}
