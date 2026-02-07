import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DRIZZLE } from "../database/database.module";
import * as schema from "../database/schema";
import { chatMessages, chatSessions, chatSummaries } from "../database/schema";
import { and, desc, eq, gt } from "drizzle-orm";
import { SettingsService } from "../settings/settings.service";
import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { ConfigService } from "@nestjs/config";
import { nowInUzbekistan } from "../common/time";

type FailureState = { count: number; lastFailedAt: Date };

@Injectable()
export class ChatProcessorService {
  private readonly logger = new Logger(ChatProcessorService.name);
  private genAI: GoogleGenerativeAI | undefined;
  private model: GenerativeModel | undefined;
  private lastRunAt: Date | undefined;
  private isProcessing = false;
  private failureState = new Map<number, FailureState>();

  constructor(
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {
    const apiKey = this.configService.get<string>("GEMINI_API_KEY");
    const modelName = this.configService.get<string>("AI_MODEL_NAME");

    if (apiKey && modelName) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.model = this.genAI.getGenerativeModel({ model: modelName });
    } else {
      this.logger.warn(
        "GEMINI_API_KEY or AI_MODEL_NAME not found. Summary cron disabled.",
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleSummaryCron() {
    if (!this.model) return;
    if (this.isProcessing) return;

    const settings = await this.settingsService.getSettings();
    const now = nowInUzbekistan();
    const intervalMs = settings.summaryCronMinutes * 60 * 1000;

    if (
      this.lastRunAt &&
      now.getTime() - this.lastRunAt.getTime() < intervalMs
    ) {
      return;
    }

    this.isProcessing = true;
    try {
      await this.processSummaries(
        settings.summaryBatchSize,
        settings.summaryPrompt,
      );
      this.lastRunAt = now;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processSummaries(batchSize: number, summaryPrompt: string) {
    if (batchSize <= 0) return;

    const sessions = await this.db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.status, "active"));

    for (const session of sessions) {
      if (this.shouldSkipSession(session.id)) continue;

      try {
        const latestSummary = await this.getLatestSummary(session.id);
        const lastProcessedId = latestSummary?.lastProcessedMessageId ?? 0;

        const messages = await this.db
          .select()
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.sessionId, session.id),
              gt(chatMessages.id, lastProcessedId),
            ),
          )
          .orderBy(chatMessages.id)
          .limit(batchSize);

        if (messages.length < batchSize) continue;

        const summaryText = await this.generateSummary(
          latestSummary?.summaryContent,
          messages,
          summaryPrompt,
        );

        if (!summaryText) {
          this.recordFailure(session.id);
          continue;
        }

        const lastMessageId = messages[messages.length - 1].id;
        await this.db.insert(chatSummaries).values({
          sessionId: session.id,
          summaryContent: summaryText,
          lastProcessedMessageId: lastMessageId,
          createdAt: nowInUzbekistan(),
        });

        this.failureState.delete(session.id);
        this.logger.log(
          `Summary updated for session ${session.id} (lastMessageId=${lastMessageId}).`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to summarize session ${session.id}.`,
          error as Error,
        );
        this.recordFailure(session.id);
      }
    }
  }

  private async getLatestSummary(sessionId: number) {
    const summaries = await this.db
      .select()
      .from(chatSummaries)
      .where(eq(chatSummaries.sessionId, sessionId))
      .orderBy(desc(chatSummaries.id))
      .limit(1);
    return summaries[0];
  }

  private async generateSummary(
    previousSummary: string | undefined,
    messages: typeof chatMessages.$inferSelect[],
    summaryPrompt: string,
  ) {
    if (!this.model) return undefined;

    const formattedMessages = messages
      .map((message) => {
        const roleLabel = message.role === "assistant" ? "assistant" : "user";
        return `${roleLabel}: ${message.content}`;
      })
      .join("\n");

    const prompt = [
      summaryPrompt,
      "",
      "Oldingi xulosa:",
      previousSummary?.trim().length
        ? previousSummary
        : "Mavjud emas.",
      "",
      "Yangi xabarlar:",
      formattedMessages,
      "",
      "Yangilangan xulosa:",
    ].join("\n");

    const result = await this.model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    if (!text?.trim()) return undefined;
    return text.trim();
  }

  private shouldSkipSession(sessionId: number) {
    const state = this.failureState.get(sessionId);
    if (!state) return false;
    const backoffMinutes = Math.min(30, state.count * 5);
    const now = nowInUzbekistan();
    return (
      now.getTime() - state.lastFailedAt.getTime() <
      backoffMinutes * 60 * 1000
    );
  }

  private recordFailure(sessionId: number) {
    const now = nowInUzbekistan();
    const existing = this.failureState.get(sessionId);
    this.failureState.set(sessionId, {
      count: existing ? existing.count + 1 : 1,
      lastFailedAt: now,
    });
  }
}
