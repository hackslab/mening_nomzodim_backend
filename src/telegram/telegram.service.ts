import {
  Injectable,
  OnModuleInit,
  Logger,
  Inject,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import { DRIZZLE } from "../database/database.module";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../database/schema";
import { chatMessages, chatSessions, chatSummaries, sessions } from "../database/schema";
import { and, desc, eq, gt } from "drizzle-orm";
import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { NewMessage } from "telegram/events";
import { nowInUzbekistan } from "../common/time";

@Injectable()
export class TelegramService implements OnModuleInit {
  private client: TelegramClient;
  private readonly logger = new Logger(TelegramService.name);
  private stringSession: StringSession;
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor(
    private configService: ConfigService,
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {
    const apiKey = this.configService.get<string>("GEMINI_API_KEY");
    const modelName = this.configService.get<string>("AI_MODEL_NAME");

    if (apiKey && modelName) {
      this.genAI = new GoogleGenerativeAI(apiKey);
      this.model = this.genAI.getGenerativeModel({ model: modelName });
      this.logger.log(
        `Gemini (Vertex AI) initialized with model: ${modelName}`,
      );
    } else {
      this.logger.warn(
        "GEMINI_API_KEY or AI_MODEL_NAME not found. AI features disabled.",
      );
    }
  }

  async onModuleInit() {
    await this.loadSession();
    await this.startUserbot();
  }

  async loadSession() {
    const result = await this.db.select().from(sessions).limit(1);
    if (result.length > 0) {
      this.stringSession = new StringSession(result[0].sessionString);
      this.logger.log(`Loaded session for ${result[0].phoneNumber}`);
    } else {
      this.stringSession = new StringSession("");
    }
  }

  async startUserbot() {
    const apiId = this.configService.get<number>("API_ID");
    const apiHash = this.configService.get<string>("API_HASH");

    const numericApiId = Number(apiId);

    if (!numericApiId || !apiHash) {
      this.logger.error("API_ID or API_HASH not found in env");
      return;
    }

    this.client = new TelegramClient(
      this.stringSession,
      numericApiId,
      apiHash,
      {
        connectionRetries: 5,
        useWSS: true, // Try using WSS for better stability
      },
    );

    try {
      await this.client.connect();
      this.logger.log("Client connected to Telegram servers.");

      this.client.addEventHandler(
        this.handleIncomingMessage.bind(this),
        new NewMessage({ incoming: true }),
      );
      this.logger.log("AI Userbot handler attached.");
    } catch (e: any) {
      if (e.code === 401 || e.errorMessage === "AUTH_KEY_UNREGISTERED") {
        this.logger.warn("Session is invalid or expired. Resetting session.");
        this.stringSession = new StringSession("");
        // Re-create client with empty session
        this.client = new TelegramClient(
          this.stringSession,
          numericApiId,
          apiHash,
          { connectionRetries: 5, useWSS: true },
        );
        await this.client.connect();
        this.logger.log(
          "Client connected with empty session (ready to login).",
        );
      } else {
        this.logger.error("Initial connection failed", e);
      }
    }
  }

  async handleIncomingMessage(event: any) {
    if (!this.model) {
      this.logger.debug("Gemini model not initialized, ignoring message.");
      return;
    }

    const message = event.message;
    const senderId = message?.senderId?.toString();
    const isPrivate = event.isPrivate;
    const isOut = message?.out;
    const incomingText = message?.message ?? "";

    this.logger.debug(
      `Event received: Sender=${senderId}, Private=${isPrivate}, Out=${isOut}, Text=${message?.message?.substring(0, 20)}...`,
    );

    if (isPrivate && message && !isOut) {
      if (!senderId) return;

      this.logger.debug(
        `Processing message from ${senderId}: ${incomingText}`,
      );

      try {
        const session = await this.getOrCreateChatSession(senderId);
        const telegramMessageId = message.id?.toString();
        const userCreatedAt = this.resolveMessageDate(message);
        const insertedUser = await this.insertChatMessage({
          sessionId: session.id,
          role: "user",
          content: incomingText,
          telegramMessageId,
          createdAt: userCreatedAt,
        });

        const excludeMessageId = insertedUser.id;

        const history = await this.getChatHistory(session.id, excludeMessageId);
        const chat = this.model.startChat({ history });
        const result = await chat.sendMessage(incomingText);
        const response = await result.response;
        const responseText = response.text();

        if (responseText) {
          const sentMessage = await message.respond({ message: responseText });
          await this.insertChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: responseText,
            telegramMessageId: sentMessage?.id?.toString(),
            createdAt: sentMessage ? this.resolveMessageDate(sentMessage) : undefined,
          });
          await this.touchChatSession(session.id);
          this.logger.log(`Gemini replied to ${senderId}: ${responseText}`);
        } else {
          this.logger.warn(`Empty response from Gemini for ${senderId}`);
        }
      } catch (error) {
        this.logger.error(`Error in Gemini handler for ${senderId}`, error);
      }
    }
  }

  private async getOrCreateChatSession(userId: string) {
    const existing = await this.db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.platform, "telegram"),
          eq(chatSessions.userId, userId),
          eq(chatSessions.status, "active"),
        ),
      )
      .orderBy(desc(chatSessions.updatedAt))
      .limit(1);

    if (existing.length > 0) {
      const session = existing[0];
      await this.touchChatSession(session.id);
      return session;
    }

    const created = await this.db
      .insert(chatSessions)
      .values({
        platform: "telegram",
        userId,
        status: "active",
        createdAt: nowInUzbekistan(),
        lastMessageAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .returning();

    return created[0];
  }

  private async touchChatSession(sessionId: number, lastMessageAt?: Date) {
    const timestamp = lastMessageAt ?? nowInUzbekistan();
    await this.db
      .update(chatSessions)
      .set({ updatedAt: timestamp, lastMessageAt: timestamp })
      .where(eq(chatSessions.id, sessionId));
  }

  private async getChatHistory(sessionId: number, excludeMessageId?: number) {
    const summaries = await this.db
      .select()
      .from(chatSummaries)
      .where(eq(chatSummaries.sessionId, sessionId))
      .orderBy(desc(chatSummaries.id))
      .limit(1);

    const latestSummary = summaries[0];
    const lastProcessedId = latestSummary?.lastProcessedMessageId ?? 0;

    const messages = await this.db
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, sessionId),
          lastProcessedId > 0
            ? gt(chatMessages.id, lastProcessedId)
            : gt(chatMessages.id, 0),
        ),
      )
      .orderBy(chatMessages.id);

    const filtered = excludeMessageId
      ? messages.filter((item) => item.id !== excludeMessageId)
      : messages;

    const history = [] as Array<{ role: "model" | "user"; parts: { text: string }[] }>;

    if (latestSummary?.summaryContent) {
      history.push({
        role: "user",
        parts: [
          {
            text: [
              "[SYSTEM CONTEXT]",
              "Oldingi xulosa (ozbek tilida):",
              latestSummary.summaryContent,
              "[CHATNI DAVOM ETTIRING]",
            ].join("\n"),
          },
        ],
      });
    }

    history.push(
      ...filtered.map((item) => ({
        role: item.role === "assistant" ? "model" : "user",
        parts: [{ text: item.content }],
      })),
    );

    return history;
  }

  async syncTelegramChats() {
    if (!this.client) {
      await this.startUserbot();
    }

    if (!this.client) {
      throw new BadRequestException("Telegram client not initialized");
    }

    if (!this.client.connected) {
      await this.client.connect();
    }

    const isAuthorized = await this.client.checkAuthorization();
    if (!isAuthorized) {
      throw new BadRequestException("Telegram client not authorized");
    }

    let dialogsProcessed = 0;
    let messagesStored = 0;

    for await (const dialog of this.client.iterDialogs({})) {
      const dialogId = this.resolveDialogId(dialog);
      if (!dialogId) continue;

      dialogsProcessed += 1;
      const session = await this.getOrCreateChatSession(dialogId);
      const { insertedCount, lastMessageAt } =
        await this.syncDialogMessages(dialog, session.id);

      messagesStored += insertedCount;
      if (lastMessageAt) {
        await this.touchChatSession(session.id, lastMessageAt);
      }
    }

    return { dialogsProcessed, messagesStored };
  }

  private async syncDialogMessages(dialog: any, sessionId: number) {
    let insertedCount = 0;
    let lastMessageAt: Date | undefined;

    for await (const message of this.client.iterMessages(dialog, {
      reverse: true,
    })) {
      const content = this.resolveMessageContent(message);
      const createdAt = this.resolveMessageDate(message);
      const telegramMessageId = message?.id?.toString();
      const role = message?.out ? "assistant" : "user";

      const inserted = await this.insertChatMessage({
        sessionId,
        role,
        content,
        telegramMessageId,
        createdAt,
      });

      if (inserted.inserted) {
        insertedCount += 1;
      }

      if (!lastMessageAt || createdAt > lastMessageAt) {
        lastMessageAt = createdAt;
      }
    }

    return { insertedCount, lastMessageAt };
  }

  private async insertChatMessage(params: {
    sessionId: number;
    role: string;
    content: string;
    telegramMessageId?: string;
    createdAt?: Date;
  }) {
    const values: typeof chatMessages.$inferInsert = {
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      telegramMessageId: params.telegramMessageId,
    };

    if (params.createdAt) {
      values.createdAt = params.createdAt;
    }

    try {
      const query = params.telegramMessageId
        ? this.db
            .insert(chatMessages)
            .values(values)
            .onConflictDoNothing({
              target: [chatMessages.sessionId, chatMessages.telegramMessageId],
            })
        : this.db.insert(chatMessages).values(values);

      const inserted = await query.returning({ id: chatMessages.id });
      if (inserted.length > 0) {
        return { id: inserted[0].id, inserted: true };
      }

      if (params.telegramMessageId) {
        const existing = await this.db
          .select({ id: chatMessages.id })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.sessionId, params.sessionId),
              eq(chatMessages.telegramMessageId, params.telegramMessageId),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          return { id: existing[0].id, inserted: false };
        }
      }

      return { id: undefined, inserted: false };
    } catch (error: any) {
      if (error?.code === "42P10") {
        if (params.telegramMessageId) {
          const existing = await this.db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(
              and(
                eq(chatMessages.sessionId, params.sessionId),
                eq(chatMessages.telegramMessageId, params.telegramMessageId),
              ),
            )
            .limit(1);
          if (existing.length > 0) {
            return { id: existing[0].id, inserted: false };
          }
        }

        const inserted = await this.db
          .insert(chatMessages)
          .values(values)
          .returning({ id: chatMessages.id });
        return {
          id: inserted[0]?.id,
          inserted: inserted.length > 0,
        };
      }

      throw error;
    }
  }

  private resolveMessageDate(message: any) {
    const rawDate = message?.date;
    if (rawDate instanceof Date) return rawDate;
    if (typeof rawDate === "number") return new Date(rawDate * 1000);
    if (typeof rawDate === "string") {
      const parsed = new Date(rawDate);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return nowInUzbekistan();
  }

  private resolveMessageContent(message: any) {
    const text = typeof message?.message === "string" ? message.message : "";
    if (text.trim().length > 0) return text;
    if (message?.media) return "[media]";
    if (message?.action) return "[action]";
    return "[empty]";
  }

  private resolveDialogId(dialog: any) {
    const dialogId = dialog?.id ?? dialog?.entity?.id;
    if (dialogId === undefined || dialogId === null) return undefined;
    return dialogId.toString();
  }

  async sendCode(phoneNumber: string) {
    if (!this.client) await this.startUserbot();
    try {
      const result = await this.client.sendCode(
        {
          apiId: Number(this.configService.get("API_ID")),
          apiHash: this.configService.get("API_HASH")!,
        },
        phoneNumber,
      );
      this.logger.log(`Code sent to ${phoneNumber}`);
      return result;
    } catch (error) {
      this.logger.error("Error sending code", error);
      throw error;
    }
  }

  async signIn(phoneNumber: string, phoneCodeHash: string, phoneCode: string) {
    try {
      const result = await this.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phoneNumber,
          phoneCodeHash: phoneCodeHash,
          phoneCode: phoneCode,
        }),
      );

      const sessionString = this.stringSession.save();
      await this.saveSessionToDb(phoneNumber, sessionString);

      this.logger.log("Signed in successfully");
      return sessionString;
    } catch (error) {
      this.logger.error("Error signing in", error);
      if (error.errorMessage) {
        throw new BadRequestException(error.errorMessage);
      }
      throw error;
    }
  }

  async signInWithPassword(password: string) {
    try {
      const passwordSrpResult = await this.client.invoke(
        new Api.account.GetPassword(),
      );
      const passwordSrpCheck = await computeCheck(passwordSrpResult, password);

      await this.client.invoke(
        new Api.auth.CheckPassword({
          password: passwordSrpCheck,
        }),
      );

      const sessionString = this.stringSession.save();
      const me = await this.client.getMe();
      if (me && !(me instanceof Promise) && (me as any).phone) {
        await this.saveSessionToDb((me as any).phone, sessionString);
      } else {
        this.logger.warn(
          "Could not retrieve phone number after password login to save session DB",
        );
      }

      this.logger.log("Signed in with password successfully");
      return sessionString;
    } catch (error) {
      this.logger.error("Error signing in with password", error);
      if (error.errorMessage) {
        throw new BadRequestException(error.errorMessage);
      }
      throw error;
    }
  }

  async saveSessionToDb(phoneNumber: string, sessionString: string) {
    const existing = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.phoneNumber, phoneNumber));
    if (existing.length > 0) {
      await this.db
        .update(sessions)
        .set({ sessionString, updatedAt: nowInUzbekistan() })
        .where(eq(sessions.phoneNumber, phoneNumber));
    } else {
      await this.db.insert(sessions).values({
        phoneNumber,
        sessionString,
        createdAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      });
    }
  }

  async getStatus() {
    if (!this.client) return { connected: false };
    if (!this.client.connected) return { connected: false };

    try {
      if (!(await this.client.checkAuthorization())) {
        return { connected: false };
      }

      const me = await this.client.getMe();
      if (me && !(me instanceof Promise)) {
        return {
          connected: true,
          user: {
            id: me.id.toString(),
            username: me.username,
            firstName: me.firstName,
          },
        };
      }
    } catch (e) {}

    return { connected: false };
  }

  getClient() {
    return this.client;
  }
}
