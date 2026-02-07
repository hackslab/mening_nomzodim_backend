import {
  Injectable,
  OnModuleInit,
  Logger,
  Inject,
  BadRequestException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SettingsService } from "../settings/settings.service";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { computeCheck } from "telegram/Password";
import { DRIZZLE } from "../database/database.module";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../database/schema";
import {
  adminTasks,
  adPosts,
  orders,
  userMedia,
  userProfiles,
  vipSubscriptions,
  chatMessages,
  chatSessions,
  chatSummaries,
  sessions,
} from "../database/schema";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { NewMessage } from "telegram/events";
import { nowInUzbekistan } from "../common/time";
import { promises as fs } from "fs";
import {
  resolveTelegramRoutingConfig,
  validateTelegramRoutingConfig,
} from "../common/telegram-routing";

type PendingReply = {
  sessionId: number;
  messageIds: number[];
  messages: string[];
  lastMessage: any;
  timer?: NodeJS.Timeout;
  token: number;
};

@Injectable()
export class TelegramService implements OnModuleInit {
  private client: TelegramClient;
  private readonly logger = new Logger(TelegramService.name);
  private stringSession: StringSession;
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private readonly replyBufferMs = 40_000;
  private readonly minFragmentChars = 12;
  private readonly maxFragmentChars = 200;
  private readonly typingMinMs = 1500;
  private readonly typingMaxMs = 3000;
  private readonly typingBaseMs = 1200;
  private readonly typingPerCharMs = 20;
  private readonly contactPrice = 99_000;
  private readonly vipPrice = 490_000;
  private readonly adPrice = 90_000;
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly replyTokens = new Map<string, number>();
  private adminGroupId?: string;
  private storageGroupId?: string;
  private problemsTopicId?: number;
  private paymentsTopicId?: number;
  private photosTopicId?: number;
  private videosTopicId?: number;
  private blurTopicId?: number;
  private anketasTopicId?: number;
  private archiveTopicId?: number;
  private auditTopicId?: number;
  private publicChannelId?: string;
  private vipChannelId?: string;
  private paymentCardNumber?: string;
  private paymentCardOwner?: string;
  private adminName = "Admin";
  private templateLink?: string;

  constructor(
    private configService: ConfigService,
    private readonly settingsService: SettingsService,
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

    const routing = resolveTelegramRoutingConfig(this.configService);
    this.adminGroupId = routing.managementGroupId;
    this.storageGroupId = routing.storageGroupId;
    this.problemsTopicId = routing.problemsTopicId;
    this.paymentsTopicId = routing.confirmPaymentsTopicId;
    this.photosTopicId = routing.photosTopicId;
    this.videosTopicId = routing.videosTopicId;
    this.blurTopicId = routing.hiddenPhotosTopicId;
    this.anketasTopicId = routing.anketasTopicId;
    this.archiveTopicId = routing.archiveTopicId;
    this.auditTopicId = routing.auditTopicId;
    this.publicChannelId = routing.publicChannelId;
    this.vipChannelId = routing.vipChannelId;
    validateTelegramRoutingConfig(routing, (message) =>
      this.logger.warn(message),
    );
    this.paymentCardNumber = this.configService.get<string>(
      "PAYMENT_CARD_NUMBER",
    );
    this.paymentCardOwner =
      this.configService.get<string>("PAYMENT_CARD_OWNER");
    this.adminName =
      this.configService.get<string>("ADMIN_NAME")?.trim() || "Admin";
    this.templateLink = this.configService.get<string>("TEMPLATE_LINK");
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
    const incomingText = this.resolveMessageContent(message);

    this.logger.debug(
      `Event received: Sender=${senderId}, Private=${isPrivate}, Out=${isOut}, Text=${message?.message?.substring(0, 20)}...`,
    );

    if (isPrivate && message && !isOut) {
      if (!this.isHumanPrivateMessage(event)) {
        this.logger.debug(
          `Ignoring non-human or non-private message from ${senderId}.`,
        );
        return;
      }
      if (!senderId) return;

      this.logger.debug(`Processing message from ${senderId}: ${incomingText}`);

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

        const messageId = insertedUser.id;

        await this.forwardIncomingMedia({
          senderId,
          sessionId: session.id,
          message,
          incomingText,
        });

        await this.maybeCreateAnketaTask({
          senderId,
          sessionId: session.id,
          incomingText,
        });

        const handled = await this.handleOrderFlow({
          senderId,
          sessionId: session.id,
          incomingText,
        });

        if (handled) {
          return;
        }

        this.queueBufferedReply({
          senderId,
          sessionId: session.id,
          messageId,
          content: incomingText,
          message,
        });
      } catch (error) {
        this.logger.error(`Error in Gemini handler for ${senderId}`, error);
      }
    }
  }

  private isHumanPrivateMessage(event: any) {
    const message = event?.message;
    if (!event?.isPrivate) return false;
    if (!message || message?.out) return false;

    const sender = message?.sender ?? event?.sender;
    if (sender && typeof sender === "object" && (sender as any).bot) {
      return false;
    }

    const senderId = message?.senderId?.toString();
    if (!senderId) return false;

    return true;
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

  private async getChatHistory(
    sessionId: number,
    excludeMessageIds?: number[],
  ) {
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

    const excludeSet = excludeMessageIds?.length
      ? new Set(excludeMessageIds)
      : undefined;
    const filtered = excludeSet
      ? messages.filter((item) => !excludeSet.has(item.id))
      : messages;

    const history = [] as Array<{
      role: "model" | "user";
      parts: { text: string }[];
    }>;

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
      ...filtered.map((item) => {
        const role: "user" | "model" =
          item.role === "assistant" ? "model" : "user";
        return {
          role,
          parts: [{ text: item.content }],
        };
      }),
    );

    return history;
  }

  private queueBufferedReply(params: {
    senderId: string;
    sessionId: number;
    messageId?: number;
    content: string;
    message: any;
  }) {
    const token = this.nextReplyToken(params.senderId);
    const existing = this.pendingReplies.get(params.senderId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const pending: PendingReply = existing ?? {
      sessionId: params.sessionId,
      messageIds: [],
      messages: [],
      lastMessage: params.message,
      token,
    };

    pending.sessionId = params.sessionId;
    pending.lastMessage = params.message;
    pending.token = token;

    if (params.messageId) {
      pending.messageIds.push(params.messageId);
    }
    const trimmed = params.content?.trim();
    if (trimmed) {
      pending.messages.push(trimmed);
    }

    pending.timer = setTimeout(() => {
      void this.processBufferedReply(params.senderId, token);
    }, this.replyBufferMs);

    this.pendingReplies.set(params.senderId, pending);
  }

  private nextReplyToken(senderId: string) {
    const next = (this.replyTokens.get(senderId) ?? 0) + 1;
    this.replyTokens.set(senderId, next);
    return next;
  }

  private async processBufferedReply(senderId: string, token: number) {
    const pending = this.pendingReplies.get(senderId);
    if (!pending || pending.token !== token) return;

    this.pendingReplies.delete(senderId);

    if (!this.model) {
      this.logger.debug(
        "Gemini model not initialized, skipping buffered reply.",
      );
      return;
    }

    const combinedMessage = pending.messages.join("\n").trim();
    if (!combinedMessage) {
      this.logger.warn(`Buffered reply empty for ${senderId}, skipping.`);
      return;
    }

    try {
      await this.markMessageRead(pending.lastMessage);
      const history = await this.getChatHistory(
        pending.sessionId,
        pending.messageIds,
      );
      if (this.shouldEscalateLocally(combinedMessage)) {
        await this.escalateToHuman({
          senderId,
          message: pending.lastMessage,
          combinedMessage,
        });
        return;
      }

      const chat = this.model.startChat({
        history: await this.prependSystemPrompt(history),
      });
      const result = await chat.sendMessage(combinedMessage);
      const response = await result.response;
      const responseText = response.text();

      if (!responseText?.trim()) {
        this.logger.warn(`Empty response from Gemini for ${senderId}`);
        return;
      }

      if (this.isEscalationResponse(responseText)) {
        await this.escalateToHuman({
          senderId,
          message: pending.lastMessage,
          combinedMessage,
        });
        return;
      }

      await this.sendHumanizedResponse({
        senderId,
        sessionId: pending.sessionId,
        responseText,
        token,
      });
    } catch (error) {
      this.logger.error(
        `Error processing buffered reply for ${senderId}`,
        error,
      );
    }
  }

  private async sendHumanizedResponse(params: {
    senderId: string;
    sessionId: number;
    responseText: string;
    token: number;
  }) {
    if (!this.client) return;

    const fragments = this.splitResponse(params.responseText);
    if (fragments.length === 0) return;

    const inputPeer = await this.client.getInputEntity(params.senderId);

    for (const fragment of fragments) {
      if (!this.isReplyTokenActive(params.senderId, params.token)) return;

      const delayMs = this.calculateTypingDelayMs(fragment);
      await this.showTyping(inputPeer, delayMs);

      if (!this.isReplyTokenActive(params.senderId, params.token)) return;

      const sentMessage = await this.client.sendMessage(inputPeer, {
        message: fragment,
      });

      await this.insertChatMessage({
        sessionId: params.sessionId,
        role: "assistant",
        content: fragment,
        telegramMessageId: sentMessage?.id?.toString(),
        createdAt: sentMessage
          ? this.resolveMessageDate(sentMessage)
          : undefined,
      });
    }

    await this.touchChatSession(params.sessionId);
    this.logger.log(
      `Gemini replied to ${params.senderId} (${fragments.length} fragments).`,
    );
  }

  private isReplyTokenActive(senderId: string, token: number) {
    return this.replyTokens.get(senderId) === token;
  }

  private splitResponse(text: string) {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [] as string[];

    const lines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const segments: string[] = [];

    for (const line of lines) {
      if (this.isNumericOnlyLine(line)) {
        segments.push(line);
        continue;
      }

      const sentences = line.split(/(?<=[.!?])\s+/);
      let buffer = "";

      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;

        const candidate = buffer ? `${buffer} ${trimmed}` : trimmed;
        if (candidate.length > this.maxFragmentChars && buffer) {
          segments.push(buffer);
          buffer = trimmed;
        } else {
          buffer = candidate;
        }
      }

      if (buffer) {
        segments.push(buffer);
      }
    }

    return this.mergeShortFragments(segments);
  }

  private mergeShortFragments(segments: string[]) {
    const merged: string[] = [];
    for (const segment of segments) {
      if (!segment) continue;
      const numeric = this.isNumericOnlyLine(segment);
      const previous = merged[merged.length - 1];
      if (
        !numeric &&
        previous &&
        !this.isNumericOnlyLine(previous) &&
        segment.length < this.minFragmentChars &&
        previous.length + 1 + segment.length <= this.maxFragmentChars
      ) {
        merged[merged.length - 1] = `${previous} ${segment}`;
      } else {
        merged.push(segment);
      }
    }
    return merged;
  }

  private isNumericOnlyLine(value: string) {
    const compact = value.replace(/\s+/g, "");
    return /^[0-9]+$/.test(compact) && compact.length >= 8;
  }

  private calculateTypingDelayMs(text: string) {
    const length = text.replace(/\s+/g, "").length;
    const raw = this.typingBaseMs + length * this.typingPerCharMs;
    const jitter = 0.85 + Math.random() * 0.3;
    const withJitter = Math.round(raw * jitter);
    return Math.min(this.typingMaxMs, Math.max(this.typingMinMs, withJitter));
  }

  private async showTyping(inputPeer: any, durationMs: number) {
    if (!this.client || durationMs <= 0) return;
    const start = Date.now();
    const intervalMs = 4000;

    while (Date.now() - start < durationMs) {
      await this.client.invoke(
        new Api.messages.SetTyping({
          peer: inputPeer,
          action: new Api.SendMessageTypingAction(),
        }),
      );
      const remaining = durationMs - (Date.now() - start);
      if (remaining <= 0) break;
      await this.sleep(Math.min(intervalMs, remaining));
    }

    await this.client.invoke(
      new Api.messages.SetTyping({
        peer: inputPeer,
        action: new Api.SendMessageCancelAction(),
      }),
    );
  }

  private async markMessageRead(message: any) {
    if (!message) return;
    try {
      if (typeof message.markAsRead === "function") {
        await message.markAsRead();
        return;
      }
      if (this.client && message.peerId && message.id) {
        await this.client.markAsRead(message.peerId, message.id);
      }
    } catch (error) {
      this.logger.warn("Failed to mark message as read", error as Error);
    }
  }

  private async prependSystemPrompt(
    history: Array<{ role: "model" | "user"; parts: { text: string }[] }>,
  ) {
    const systemPrompt = await this.buildSystemPrompt();
    return [
      {
        role: "user" as const,
        parts: [{ text: systemPrompt }],
      },
      ...history,
    ];
  }

  private async buildSystemPrompt() {
    const settings = await this.settingsService.getSettings();
    return this.applyPromptVariables(settings.systemPrompt);
  }

  private applyPromptVariables(prompt: string) {
    const replacements: Record<string, string> = {
      adminName: this.adminName,
      contactPrice: this.formatAmount(this.contactPrice),
      vipPrice: this.formatAmount(this.vipPrice),
      adPrice: this.formatAmount(this.adPrice),
    };

    let output = prompt;
    for (const [key, value] of Object.entries(replacements)) {
      const pattern = new RegExp(
        `\\{\\{${key}\\}\\}|\\{${key}\\}|\\$\\{${key}\\}`,
        "g",
      );
      output = output.replace(pattern, value);
    }
    return output;
  }

  private isEscalationResponse(responseText: string) {
    return responseText.trim().toLowerCase() === "escalate_to_human";
  }

  private shouldEscalateLocally(text: string) {
    const normalized = text.toLowerCase();
    const keywords = [
      "shikoyat",
      "muammo",
      "haqorat",
      "aldadingiz",
      "pulim",
      "qaytar",
      "tulov qilmadim",
      "tulov qilganman",
      "janjal",
      "nohaq",
      "firib",
      "politsiya",
      "sud",
      "prokur",
      "uraman",
      "so'kish",
      "axmoq",
      "ahmoq",
      "xayvon",
      "tentak",
      "sharmanda",
      "yolg'on",
      "dolboyob",
      "pidar",
      "suka",
      "blya",
      "fuck",
      "shit",
    ];
    return keywords.some((word) => normalized.includes(word));
  }

  private async escalateToHuman(params: {
    senderId: string;
    message: any;
    combinedMessage: string;
  }) {
    if (!this.client || !this.adminGroupId || !this.problemsTopicId) {
      this.logger.warn("Admin group/topic not configured for escalation.");
      return;
    }

    const groupPeer = await this.client.getInputEntity(this.adminGroupId);

    try {
      if (params.message?.id && params.message?.peerId) {
        await this.client.invoke(
          new Api.messages.ForwardMessages({
            fromPeer: params.message.peerId,
            id: [params.message.id],
            toPeer: groupPeer,
            topMsgId: this.problemsTopicId,
          }),
        );
      }
    } catch (error) {
      this.logger.warn(
        "Failed to forward message for escalation",
        error as Error,
      );
    }

    const payload = [
      "#muammo",
      `user: ${params.senderId}`,
      params.combinedMessage,
    ].join("\n");

    await this.client.sendMessage(groupPeer, {
      message: payload,
      topMsgId: this.problemsTopicId,
    });
  }

  async sendAdminResponse(senderId: string, text: string) {
    if (!this.client) {
      await this.startUserbot();
    }
    if (!this.client) return;
    const session = await this.getOrCreateChatSession(senderId);
    const token = this.nextReplyToken(senderId);
    await this.sendHumanizedResponse({
      senderId,
      sessionId: session.id,
      responseText: text,
      token,
    });
  }

  private async handleOrderFlow(params: {
    senderId: string;
    sessionId: number;
    incomingText: string;
  }) {
    const text = params.incomingText?.trim();
    if (!text) return false;

    if (this.isMediaResetCommand(text)) {
      const openOrder = await this.getOpenAdOrder(params.senderId);
      if (!openOrder) return false;
      await this.clearOrderMedia(params.senderId, openOrder.id);
      await this.sendAdminResponse(
        params.senderId,
        "Media tozalandi. 2 ta rasm va 1 ta video yuboring.",
      );
      return true;
    }

    const affirmative = this.isAffirmative(text);
    const negative = this.isNegative(text);
    const contactIntent = this.parseContactIntent(text);
    const vipIntent = this.isVipIntent(text);
    const adIntent = this.isAdIntent(text);

    const openOrder = await this.getLatestOpenOrder(params.senderId);

    if (openOrder && openOrder.orderType === "ad") {
      if (openOrder.status === "awaiting_gender") {
        const gender = this.parseGender(text);
        if (negative) {
          await this.db
            .update(orders)
            .set({ status: "cancelled", updatedAt: nowInUzbekistan() })
            .where(eq(orders.id, openOrder.id));
          await this.sendAdminResponse(params.senderId, "Mayli, bekor qildim.");
          return true;
        }
        if (!gender) {
          await this.sendAdminResponse(
            params.senderId,
            "Ayolmisiz yoki erkak?",
          );
          return true;
        }

        const profile = await this.getOrCreateUserProfile(params.senderId);
        await this.updateUserGender(profile.userId, gender);
        const amount = this.computeAdPrice(gender, profile.adCount ?? 0);
        const nextStatus =
          amount === 0 ? "awaiting_content" : "awaiting_payment";
        await this.db
          .update(orders)
          .set({ amount, status: nextStatus, updatedAt: nowInUzbekistan() })
          .where(eq(orders.id, openOrder.id));

        if (amount === 0) {
          await this.sendAdminResponse(
            params.senderId,
            "Birinchi e'lon bepul.",
          );
          await this.handleAdPaymentApproved(openOrder.id);
        } else {
          await this.sendAdminResponse(
            params.senderId,
            this.buildAdPriceMessage(gender, profile.adCount ?? 0, amount),
          );
        }
        return true;
      }
      if (
        ["awaiting_payment", "awaiting_check"].includes(openOrder.status) &&
        adIntent
      ) {
        await this.sendAdminResponse(
          params.senderId,
          "To'lovni yakunlaymiz, keyin davom etamiz.",
        );
        return true;
      }
      if (
        ["awaiting_content", "ready_to_publish", "payment_submitted"].includes(
          openOrder.status,
        ) &&
        adIntent
      ) {
        await this.sendAdminResponse(
          params.senderId,
          "Joriy e'lon jarayoni davom etyapti.",
        );
        return true;
      }
    }

    if (openOrder && openOrder.status === "awaiting_payment" && affirmative) {
      await this.db
        .update(orders)
        .set({ status: "awaiting_check", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, openOrder.id));
      const paymentMessage = this.buildPaymentMessage(openOrder.amount);
      await this.sendAdminResponse(params.senderId, paymentMessage);
      if (
        openOrder.orderType === "ad" &&
        openOrder.amount > 0 &&
        openOrder.userId
      ) {
        const profile = await this.getOrCreateUserProfile(openOrder.userId);
        if (profile.gender === "female" && (profile.adCount ?? 0) > 0) {
          await this.sendAdminResponse(
            params.senderId,
            "Bu keyingi e'lon, narxi 90 ming.",
          );
        }
      }
      return true;
    }

    if (openOrder && openOrder.status === "awaiting_payment" && negative) {
      await this.db
        .update(orders)
        .set({ status: "cancelled", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, openOrder.id));
      await this.sendAdminResponse(params.senderId, "Mayli, bekor qildim.");
      return true;
    }

    if (contactIntent?.adId) {
      await this.createOrder({
        orderType: "contact",
        sessionId: params.sessionId,
        userId: params.senderId,
        amount: this.contactPrice,
        adId: contactIntent.adId,
      });
      await this.sendAdminResponse(
        params.senderId,
        `Narxi ${this.formatAmount(
          this.contactPrice,
        )}. To'lovdan keyin kontakt va 1 ta rasm beriladi. Olasizmi?`,
      );
      return true;
    }

    if (vipIntent) {
      await this.createOrder({
        orderType: "vip",
        sessionId: params.sessionId,
        userId: params.senderId,
        amount: this.vipPrice,
      });
      await this.sendAdminResponse(
        params.senderId,
        `Oyiga ${this.formatAmount(this.vipPrice)}. Olasizmi?`,
      );
      return true;
    }

    if (adIntent) {
      const profile = await this.getOrCreateUserProfile(params.senderId);
      if (!profile.gender) {
        await this.createOrder({
          orderType: "ad",
          sessionId: params.sessionId,
          userId: params.senderId,
          amount: 0,
          status: "awaiting_gender",
        });
        await this.sendAdminResponse(params.senderId, "Ayolmisiz yoki erkak?");
        return true;
      }

      const amount = this.computeAdPrice(profile.gender, profile.adCount ?? 0);
      const status = amount === 0 ? "awaiting_content" : "awaiting_payment";
      const orderId = await this.createOrder({
        orderType: "ad",
        sessionId: params.sessionId,
        userId: params.senderId,
        amount,
        status,
      });

      if (amount === 0) {
        await this.sendAdminResponse(params.senderId, "Birinchi e'lon bepul.");
        if (orderId) {
          await this.handleAdPaymentApproved(orderId);
        }
      } else {
        await this.sendAdminResponse(
          params.senderId,
          this.buildAdPriceMessage(
            profile.gender ?? "",
            profile.adCount ?? 0,
            amount,
          ),
        );
      }
      return true;
    }

    return false;
  }

  private async createOrder(params: {
    orderType: string;
    sessionId: number;
    userId: string;
    amount: number;
    adId?: number;
    status?: string;
  }) {
    const inserted = await this.db
      .insert(orders)
      .values({
        orderType: params.orderType,
        status: params.status ?? "awaiting_payment",
        sessionId: params.sessionId,
        userId: params.userId,
        amount: params.amount,
        adId: params.adId,
        createdAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .returning({ id: orders.id });
    return inserted[0]?.id;
  }

  private async getLatestOpenOrder(userId: string) {
    const rows = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          inArray(orders.status, [
            "awaiting_payment",
            "awaiting_check",
            "payment_submitted",
            "awaiting_gender",
            "awaiting_content",
            "ready_to_publish",
          ]),
        ),
      )
      .orderBy(desc(orders.id))
      .limit(1);

    return rows[0];
  }

  private async getOpenAdOrder(userId: string) {
    const rows = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          eq(orders.orderType, "ad"),
          inArray(orders.status, [
            "awaiting_payment",
            "awaiting_check",
            "payment_submitted",
            "awaiting_gender",
            "awaiting_content",
            "ready_to_publish",
          ]),
        ),
      )
      .orderBy(desc(orders.id))
      .limit(1);
    return rows[0];
  }

  private parseContactIntent(text: string) {
    if (!text) return undefined;
    if (this.isLikelyAnketa(text)) return undefined;

    const normalized = text.toLowerCase();
    const adId = this.extractAnketaId(text);
    if (!adId) return undefined;

    const hasKeyword = this.hasContactKeyword(normalized);
    const hasLabel = this.hasAnketaLabel(normalized);
    const isBareId = this.isBareAnketaId(text);
    const hasHash = text.includes("#");

    if (hasKeyword || hasLabel || isBareId || hasHash) {
      return { adId };
    }
    return undefined;
  }

  private extractAnketaId(text: string) {
    const patterns = [
      /#\s*(\d{1,6})(?!\s*(?:ming|so'm|som))/i,
      /\b(?:anketa|nomzod|id|raqam)\s*[:#]?\s*(\d{1,6})(?!\s*(?:ming|so'm|som))/i,
      /\b(\d{1,6})\s*(?:anketa|nomzod)\b/i,
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      const adId = Number(match[1]);
      if (Number.isFinite(adId)) return adId;
    }

    if (this.isBareAnketaId(text)) {
      return Number(text.trim());
    }

    return undefined;
  }

  private isBareAnketaId(text: string) {
    return /^\d{3,6}$/.test(text.trim());
  }

  private hasContactKeyword(normalized: string) {
    const contactWords = [
      "kontakt",
      "nomer",
      "raqam",
      "telefon",
      "tel",
      "aloqa",
      "lich",
      "lichka",
      "dm",
    ];
    if (contactWords.some((word) => normalized.includes(word))) {
      return true;
    }

    const photoWords = ["rasm", "surat", "foto"];
    const subjectWords = ["anketa", "nomzod", "egasi", "id"];
    const hasPhoto = photoWords.some((word) => normalized.includes(word));
    const hasSubject = subjectWords.some((word) => normalized.includes(word));
    return hasPhoto && hasSubject;
  }

  private hasAnketaLabel(normalized: string) {
    const labels = ["anketa", "nomzod", "id", "raqam"];
    return labels.some((word) => normalized.includes(word));
  }

  private isVipIntent(text: string) {
    const lowered = text.toLowerCase();
    return (
      lowered.includes("vip") &&
      (lowered.includes("kanal") || lowered.includes("obuna"))
    );
  }

  private isAdIntent(text: string) {
    const lowered = text.toLowerCase();
    if (/(e'lon|elon|reklama)/.test(lowered)) return true;
    if (!lowered.includes("anketa")) return false;

    const strongContact = [
      "raqam",
      "kontakt",
      "nomer",
      "telefon",
      "tel",
      "aloqa",
      "lich",
    ];
    if (strongContact.some((word) => lowered.includes(word))) {
      return false;
    }

    const adKeywords = ["joyla", "chiqar", "tashla", "post", "kanal"];
    return adKeywords.some((word) => lowered.includes(word));
  }

  private isAffirmative(text: string) {
    return /(\bha\b|\bxa\b|\bxo'p\b|\bmayli\b|\bolaman\b|\bok\b)/i.test(text);
  }

  private isNegative(text: string) {
    return /(\byoq\b|\byo'q\b|\bkerak emas\b|\bbekor\b|\bistamayman\b)/i.test(
      text,
    );
  }

  private isMediaResetCommand(text: string) {
    return /(reset media|media reset|media tozalash|media tozalansin)/i.test(
      text,
    );
  }

  private formatAmount(amount: number) {
    if (amount % 1000 === 0) {
      return `${Math.round(amount / 1000)} ming`;
    }
    return amount.toString();
  }

  private buildAdPriceMessage(gender: string, adCount: number, amount: number) {
    const base = `Narxi ${this.formatAmount(amount)}. Karta tashlaymi?`;
    if (gender === "female" && adCount > 0) {
      return `Birinchi e'lon bepul edi. ${base}`;
    }
    return base;
  }

  private buildPaymentMessage(amount: number) {
    const lines = [`Narxi ${this.formatAmount(amount)}.`];
    if (this.paymentCardNumber) {
      lines.push("Karta raqami:");
      lines.push(this.paymentCardNumber);
    }
    if (this.paymentCardOwner) {
      lines.push(`Karta egasi: ${this.paymentCardOwner}`);
    }
    lines.push("Chekni yuborasiz.");
    return lines.join("\n");
  }

  private parseGender(text: string) {
    const lowered = text.toLowerCase();
    if (/(\bayol\b|\bqiz\b)/i.test(lowered)) return "female" as const;
    if (/(\berkak\b|\byigit\b)/i.test(lowered)) return "male" as const;
    return undefined;
  }

  private computeAdPrice(gender: string, adCount: number) {
    if (gender === "female" && adCount === 0) return 0;
    return this.adPrice;
  }

  private async getOrCreateUserProfile(userId: string) {
    const rows = await this.db
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    if (rows.length > 0) return rows[0];

    const inserted = await this.db
      .insert(userProfiles)
      .values({
        userId,
        adCount: 0,
        createdAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .returning();
    return inserted[0];
  }

  private async updateUserGender(userId: string, gender: string) {
    await this.db
      .update(userProfiles)
      .set({ gender, updatedAt: nowInUzbekistan() })
      .where(eq(userProfiles.userId, userId));
  }

  private async incrementAdCount(userId: string) {
    const profile = await this.getOrCreateUserProfile(userId);
    const nextCount = (profile.adCount ?? 0) + 1;
    await this.db
      .update(userProfiles)
      .set({ adCount: nextCount, updatedAt: nowInUzbekistan() })
      .where(eq(userProfiles.userId, userId));
  }

  private async createAdminTask(params: {
    taskType: string;
    sessionId?: number;
    userId?: string;
    payload?: Record<string, unknown>;
  }) {
    try {
      const inserted = await this.db
        .insert(adminTasks)
        .values({
          taskType: params.taskType,
          status: "pending",
          sessionId: params.sessionId,
          userId: params.userId,
          payload: params.payload ? JSON.stringify(params.payload) : undefined,
          createdAt: nowInUzbekistan(),
          updatedAt: nowInUzbekistan(),
        })
        .returning({ id: adminTasks.id });
      return inserted[0]?.id;
    } catch (error) {
      this.logger.warn("Failed to create admin task", error as Error);
    }
    return undefined;
  }

  async publishAnketaTask(params: {
    taskId: number;
    userId?: string | null;
    text: string;
  }) {
    if (!this.client) {
      await this.startUserbot();
    }
    if (!this.client) return;

    if (!this.publicChannelId && !this.vipChannelId) {
      this.logger.warn("Channel IDs not configured for publishing.");
      return;
    }

    const orderId = await this.findOrderIdForPublishTask(params.taskId);
    const orderRow = orderId
      ? await this.db
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1)
      : [];
    const order = orderRow[0];

    const created = await this.db
      .insert(adPosts)
      .values({
        taskId: params.taskId,
        sessionId: order?.sessionId ?? undefined,
        userId: order?.userId ?? params.userId ?? undefined,
        content: params.text,
        status: "publishing",
        createdAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .returning();

    const adId = created[0]?.id;
    const sourceMessageText = adId
      ? `${params.text}\n\nID: #${adId}`
      : params.text;

    const mediaUserId = order?.userId ?? params.userId ?? undefined;
    let mediaCounts: { photos: number; videos: number } | undefined;
    if (mediaUserId) {
      const counts = await this.getAdMediaCounts(mediaUserId, orderId);
      if (!counts.ready) {
        this.logger.warn("Not enough media to publish anketa.");
        return;
      }
      if (counts.photos > 2 || counts.videos > 1) {
        this.logger.warn("Too many media assets for publish.");
        return;
      }
      mediaCounts = { photos: counts.photos, videos: counts.videos };
    }
    const photoRows = mediaUserId
      ? await this.getRecentUserMedia(mediaUserId, "photo", 2, orderId)
      : [];
    const videoRows = mediaUserId
      ? await this.getRecentUserMedia(mediaUserId, "video", 1, orderId)
      : [];

    const photoBuffers = await this.downloadMediaBuffers(
      mediaUserId,
      photoRows,
    );
    const videoBuffers = await this.downloadMediaBuffers(
      mediaUserId,
      videoRows,
    );

    const bestPhoto = this.pickBestPhoto(photoBuffers);
    const blurredBestPhoto = bestPhoto
      ? await this.blurFaces(bestPhoto)
      : undefined;
    const openPhotos = blurredBestPhoto ? [blurredBestPhoto] : [];
    const closedPhotos = bestPhoto ? [bestPhoto] : [];

    const publicText = this.buildOpenChannelMessage(sourceMessageText);
    const vipText = this.buildClosedChannelMessage(sourceMessageText);

    let publicMessageId: string | undefined;
    let vipMessageId: string | undefined;
    let publicStatus = "pending";
    let vipStatus = "pending";

    let archiveMessageId: string | undefined;
    if (this.storageGroupId && this.archiveTopicId) {
      const groupPeer = await this.client.getInputEntity(this.storageGroupId);
      const archiveBanner = this.buildArchiveBanner({
        orderId,
        mediaCounts,
      });
      const archiveText = archiveBanner
        ? `${archiveBanner}\n\n${sourceMessageText}`
        : sourceMessageText;
      await this.sendMediaToTarget({
        target: groupPeer,
        photos: photoBuffers,
        videos: videoBuffers,
        blurPhotos: false,
        topMsgId: this.archiveTopicId,
      });
      const sent = await this.client.sendMessage(groupPeer, {
        message: archiveText,
        topMsgId: this.archiveTopicId,
      });
      archiveMessageId = sent?.id?.toString();
    }

    if (this.publicChannelId) {
      try {
        await this.sendMediaToTarget({
          target: this.publicChannelId,
          photos: openPhotos,
          videos: videoBuffers,
          blurPhotos: false,
        });
        const sent = await this.client.sendMessage(this.publicChannelId, {
          message: publicText,
        });
        publicMessageId = sent?.id?.toString();
        publicStatus = "published";
      } catch (error) {
        publicStatus = "failed";
        this.logger.warn("Failed to publish open channel post", error as Error);
      }
    }

    if (this.vipChannelId) {
      try {
        await this.sendMediaToTarget({
          target: this.vipChannelId,
          photos: closedPhotos,
          videos: videoBuffers,
          blurPhotos: false,
        });
        const sent = await this.client.sendMessage(this.vipChannelId, {
          message: vipText,
        });
        vipMessageId = sent?.id?.toString();
        vipStatus = "published";
      } catch (error) {
        vipStatus = "failed";
        this.logger.warn(
          "Failed to publish closed channel post",
          error as Error,
        );
      }
    }

    if (adId) {
      const finalStatus =
        publicStatus === "published" && vipStatus === "published"
          ? "published"
          : publicStatus === "failed" || vipStatus === "failed"
            ? "partial_failed"
            : "published";
      await this.db
        .update(adPosts)
        .set({
          status: finalStatus,
          publicMessageId,
          publicStatus,
          vipMessageId,
          vipStatus,
          archiveMessageId,
          updatedAt: nowInUzbekistan(),
        })
        .where(eq(adPosts.id, adId));
    }

    const isFullyPublished =
      publicStatus === "published" && vipStatus === "published";

    await this.db
      .update(adminTasks)
      .set({
        status: isFullyPublished ? "published" : "publish_partial_failed",
        updatedAt: nowInUzbekistan(),
      })
      .where(eq(adminTasks.id, params.taskId));

    if (orderId && isFullyPublished) {
      await this.db
        .update(orders)
        .set({ status: "completed", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, orderId));
    }

    if (isFullyPublished && order?.orderType === "ad" && order?.userId) {
      await this.incrementAdCount(order.userId);
    }

    if (params.userId && adId && isFullyPublished) {
      await this.sendAdminResponse(
        params.userId,
        `Anketangiz chiqdi. ID: #${adId}`,
      );
    }
  }

  private async maybeCreateAnketaTask(params: {
    senderId: string;
    sessionId: number;
    incomingText: string;
  }) {
    if (!params.incomingText) return;
    if (!this.anketasTopicId || !this.adminGroupId) return;
    if (!this.isLikelyAnketa(params.incomingText)) return;

    const validation = this.validateAnketa(params.incomingText);
    if (!validation.valid) {
      await this.sendAdminResponse(
        params.senderId,
        `Shablonni to'liq toldiring. Yetishmayapti: ${validation.missing.join(", ")}.`,
      );
      const template = [
        "Jins: ",
        "Ism: ",
        "Yosh: ",
        "Manzil: ",
        "Boy: ",
        "Talab: ",
        "Tel: ",
      ].join("\n");
      await this.sendAdminResponse(params.senderId, template);
      return;
    }

    const parsedGender = this.parseGender(params.incomingText);
    if (parsedGender) {
      const profile = await this.getOrCreateUserProfile(params.senderId);
      if (!profile.gender) {
        await this.updateUserGender(profile.userId, parsedGender);
      }
    }

    const openAdOrder = await this.getOpenAdOrder(params.senderId);
    if (
      openAdOrder &&
      !["awaiting_content", "ready_to_publish"].includes(openAdOrder.status)
    ) {
      await this.sendAdminResponse(
        params.senderId,
        "Avval to'lovni yakunlaymiz.",
      );
      return;
    }

    const mediaCounts = await this.getAdMediaCounts(
      params.senderId,
      openAdOrder?.id,
    );
    if (!mediaCounts.ready) {
      await this.sendAdminResponse(
        params.senderId,
        `2 ta rasm va 1 ta yumaloq video yuboring. Hozir: ${mediaCounts.photos} rasm, ${mediaCounts.videos} video.`,
      );
      return;
    }
    if (mediaCounts.photos > 2 || mediaCounts.videos > 1) {
      await this.sendAdminResponse(
        params.senderId,
        "Ortiqcha fayllarni yubormang. 2 ta rasm va 1 ta video kerak.",
      );
      return;
    }

    const photoRows = await this.getRecentUserMedia(
      params.senderId,
      "photo",
      10,
      openAdOrder?.id,
    );
    const videoRows = await this.getRecentUserMedia(
      params.senderId,
      "video",
      5,
      openAdOrder?.id,
    );

    const taskId = await this.createAdminTask({
      taskType: "publish",
      sessionId: params.sessionId,
      userId: params.senderId,
      payload: {
        text: params.incomingText.trim(),
        orderId: openAdOrder?.id,
        photoCount: mediaCounts.photos,
        videoCount: mediaCounts.videos,
        photoIds: photoRows.map((row) => row.messageId),
        videoIds: videoRows.map((row) => row.messageId),
      },
    });

    if (taskId) {
      await this.db
        .update(adminTasks)
        .set({ status: "media_ready", updatedAt: nowInUzbekistan() })
        .where(eq(adminTasks.id, taskId));
    }

    if (openAdOrder) {
      await this.db
        .update(orders)
        .set({ status: "ready_to_publish", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, openAdOrder.id));
    }
  }

  private validateAnketa(text: string) {
    const required = ["jins", "ism", "yosh", "manzil", "boy", "talab", "tel"];
    const lowered = text.toLowerCase();
    const missing: string[] = [];
    for (const field of required) {
      const regex = new RegExp(`${field}\\s*:\\s*.+`, "i");
      if (!regex.test(lowered)) {
        missing.push(field);
      }
    }
    if (missing.length > 0) {
      return { valid: false, missing } as const;
    }
    return { valid: true, missing: [] } as const;
  }

  private async getAdMediaCounts(userId: string, orderId?: number) {
    const filters = [eq(userMedia.userId, userId)];
    if (orderId) {
      filters.push(eq(userMedia.orderId, orderId));
    }

    const rows = await this.db
      .select({ mediaType: userMedia.mediaType })
      .from(userMedia)
      .where(and(...filters));

    const photos = rows.filter((row) => row.mediaType === "photo").length;
    const videos = rows.filter((row) => row.mediaType === "video").length;
    return {
      photos,
      videos,
      ready: photos >= 2 && videos >= 1,
    } as const;
  }

  private isLikelyAnketa(text: string) {
    const normalized = text.toLowerCase();
    const keywords = [
      "jins",
      "ism",
      "yosh",
      "manzil",
      "raqam",
      "telefon",
      "boy",
    ];
    const lines = text.split(/\r?\n/).filter((line) => line.includes(":"));
    const keywordHits = keywords.filter((word) =>
      normalized.includes(word),
    ).length;
    return lines.length >= 3 && keywordHits >= 2;
  }

  private async forwardIncomingMedia(params: {
    senderId: string;
    sessionId: number;
    message: any;
    incomingText: string;
  }) {
    if (!this.client || !params.message?.media) return;
    if (!this.adminGroupId && !this.storageGroupId) return;

    const mediaType = this.resolveMediaType(params.message);
    const isPayment = this.isPaymentEvidence(params.incomingText);

    if (isPayment && this.paymentsTopicId) {
      await this.forwardMessageToTopic({
        message: params.message,
        topicId: this.paymentsTopicId,
        targetGroupId: this.adminGroupId,
      });
      const openOrder = await this.getLatestOpenOrder(params.senderId);
      if (openOrder) {
        await this.db
          .update(orders)
          .set({ status: "payment_submitted", updatedAt: nowInUzbekistan() })
          .where(eq(orders.id, openOrder.id));
      }
      await this.createAdminTask({
        taskType: "payment",
        sessionId: params.sessionId,
        userId: params.senderId,
        payload: {
          messageId: params.message?.id,
          peerId: params.message?.peerId,
          text: params.incomingText,
          orderId: openOrder?.id,
          orderType: openOrder?.orderType,
          orderAmount: openOrder?.amount,
          adId: openOrder?.adId,
        },
      });
      if (openOrder?.orderType === "ad") {
        await this.sendAdminResponse(
          params.senderId,
          "To'lov tushgach, anketangizni yuborasiz.",
        );
      }
      return;
    }

    const openAdOrder = await this.getOpenAdOrder(params.senderId);
    if (
      openAdOrder &&
      !["payment_submitted", "awaiting_content", "ready_to_publish"].includes(
        openAdOrder.status,
      )
    ) {
      if (openAdOrder.status === "awaiting_gender") {
        await this.sendAdminResponse(params.senderId, "Ayolmisiz yoki erkak?");
      } else {
        await this.sendAdminResponse(
          params.senderId,
          "Avval to'lovni yakunlaymiz.",
        );
      }
      return;
    }

    if (openAdOrder) {
      const counts = await this.getAdMediaCounts(
        params.senderId,
        openAdOrder.id,
      );
      if (mediaType === "photo" && counts.photos >= 2) {
        await this.sendAdminResponse(
          params.senderId,
          "2 ta rasm yetarli. Ortiqcha yubormang.",
        );
        return;
      }
      if (mediaType === "video" && counts.videos >= 1) {
        await this.sendAdminResponse(
          params.senderId,
          "1 ta video yetarli. Ortiqcha yubormang.",
        );
        return;
      }
    }

    if (mediaType === "photo") {
      let storedRef:
        | {
            archiveGroupId?: string;
            archiveTopicId?: number;
            archiveMessageId?: number;
          }
        | undefined;
      if (this.photosTopicId) {
        const forwarded = await this.forwardMessageToTopic({
          message: params.message,
          topicId: this.photosTopicId,
          targetGroupId: this.storageGroupId,
        });
        storedRef = {
          archiveGroupId: this.storageGroupId,
          archiveTopicId: this.photosTopicId,
          archiveMessageId: forwarded?.id,
        };
      }
      await this.storeUserMedia({
        sessionId: params.sessionId,
        userId: params.senderId,
        messageId: params.message?.id,
        mediaType: "photo",
        archiveGroupId: storedRef?.archiveGroupId,
        archiveTopicId: storedRef?.archiveTopicId,
        archiveMessageId: storedRef?.archiveMessageId,
      });
      await this.forwardBlurredPhoto({
        senderId: params.senderId,
        message: params.message,
      });
      return;
    }

    if (mediaType === "video") {
      let storedRef:
        | {
            archiveGroupId?: string;
            archiveTopicId?: number;
            archiveMessageId?: number;
          }
        | undefined;
      if (this.videosTopicId) {
        const forwarded = await this.forwardMessageToTopic({
          message: params.message,
          topicId: this.videosTopicId,
          targetGroupId: this.storageGroupId,
        });
        storedRef = {
          archiveGroupId: this.storageGroupId,
          archiveTopicId: this.videosTopicId,
          archiveMessageId: forwarded?.id,
        };
      }
      await this.storeUserMedia({
        sessionId: params.sessionId,
        userId: params.senderId,
        messageId: params.message?.id,
        mediaType: "video",
        archiveGroupId: storedRef?.archiveGroupId,
        archiveTopicId: storedRef?.archiveTopicId,
        archiveMessageId: storedRef?.archiveMessageId,
      });
    }
  }

  private resolveMediaType(message: any) {
    const media = message?.media;
    if (!media) return "unknown" as const;
    if (media instanceof Api.MessageMediaPhoto) return "photo" as const;
    if (media instanceof Api.MessageMediaDocument) {
      const document = media.document as any;
      const mimeType =
        typeof document?.mimeType === "string" ? document.mimeType : "";
      if (mimeType.startsWith("video/")) return "video" as const;
      if (mimeType.startsWith("image/")) return "photo" as const;
      const attributes = Array.isArray(document?.attributes)
        ? document.attributes
        : [];
      if (
        attributes.some(
          (attr: any) => attr instanceof Api.DocumentAttributeVideo,
        )
      ) {
        return "video" as const;
      }
    }
    return "unknown" as const;
  }

  private isPaymentEvidence(text: string) {
    const normalized = text.toLowerCase();
    const keywords = [
      "chek",
      "check",
      "oplata",
      "payment",
      "tolov",
      "tulov",
      "kvitansiya",
      "skrin",
      "kvitan",
    ];
    return keywords.some((word) => normalized.includes(word));
  }

  private async forwardMessageToTopic(params: {
    message: any;
    topicId: number;
    targetGroupId?: string;
  }) {
    if (!this.client || !params.targetGroupId) return;
    try {
      const groupPeer = await this.client.getInputEntity(params.targetGroupId);
      if (params.message?.id && params.message?.peerId) {
        const forwarded = await this.client.invoke(
          new Api.messages.ForwardMessages({
            fromPeer: params.message.peerId,
            id: [params.message.id],
            toPeer: groupPeer,
            topMsgId: params.topicId,
          }),
        );
        const updates = (forwarded as any)?.updates;
        if (Array.isArray(updates)) {
          const update = updates.find((item: any) => item?.id);
          if (update?.id) {
            return { id: Number(update.id) };
          }
        }
      }
    } catch (error) {
      this.logger.warn("Failed to forward media to topic", error as Error);
    }
    return undefined;
  }

  private async storeUserMedia(params: {
    sessionId: number;
    userId: string;
    messageId?: number;
    mediaType: string;
    archiveGroupId?: string;
    archiveTopicId?: number;
    archiveMessageId?: number;
  }) {
    if (!params.messageId) return;
    const openAdOrder = await this.getOpenAdOrder(params.userId);
    try {
      await this.db.insert(userMedia).values({
        sessionId: params.sessionId,
        userId: params.userId,
        messageId: params.messageId,
        archiveGroupId: params.archiveGroupId,
        archiveTopicId: params.archiveTopicId,
        archiveMessageId: params.archiveMessageId,
        mediaType: params.mediaType,
        orderId: openAdOrder?.id,
        createdAt: nowInUzbekistan(),
      });
    } catch (error) {
      this.logger.warn("Failed to store user media", error as Error);
    }
  }

  async fulfillContactOrder(orderId: number) {
    if (!this.client) {
      await this.startUserbot();
    }
    if (!this.client) return;

    const orderRows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const order = orderRows[0];
    if (!order || order.orderType !== "contact") return;

    const adRows = order.adId
      ? await this.db
          .select()
          .from(adPosts)
          .where(eq(adPosts.id, order.adId))
          .limit(1)
      : [];

    const adPost = adRows[0];
    if (!adPost?.content || !adPost.userId) {
      await this.sendAdminResponse(
        order.userId,
        "Kontakt topilmadi. Admin tekshiradi.",
      );
      await this.db
        .update(orders)
        .set({ status: "failed", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, order.id));
      return;
    }

    const contact = this.extractContactInfo(adPost.content);
    if (!contact) {
      await this.sendAdminResponse(
        order.userId,
        "Kontakt topilmadi. Admin tekshiradi.",
      );
      await this.db
        .update(orders)
        .set({ status: "failed", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, order.id));
      return;
    }

    await this.sendAdminResponse(order.userId, `Kontakt: ${contact}`);

    const media = await this.getRecentUserMedia(adPost.userId, "photo", 1);
    if (media.length > 0) {
      const buffer = await this.downloadUserMedia(media[0], adPost.userId);
      if (buffer) {
        await this.sendSelfDestructPhoto(order.userId, buffer, 10_000);
      }
    }

    await this.db
      .update(orders)
      .set({ status: "completed", updatedAt: nowInUzbekistan() })
      .where(eq(orders.id, order.id));
  }

  async activateVipOrder(orderId: number) {
    if (!this.client) {
      await this.startUserbot();
    }
    if (!this.client) return;

    const orderRows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const order = orderRows[0];
    if (!order || order.orderType !== "vip") return;

    const expiresAt = await this.upsertVipSubscription(order.userId);
    const addResult = await this.addUserToVipChannel(order.userId);

    if (addResult.inviteLink) {
      await this.sendAdminResponse(
        order.userId,
        `VIP kanal link: ${addResult.inviteLink}`,
      );
    } else if (addResult.added) {
      await this.sendAdminResponse(order.userId, "VIP kanalga qo'shildingiz.");
    }

    if (expiresAt) {
      await this.sendAdminResponse(
        order.userId,
        "VIP obuna 30 kun faol bo'ladi.",
      );
    }

    await this.db
      .update(orders)
      .set({ status: "completed", updatedAt: nowInUzbekistan() })
      .where(eq(orders.id, order.id));
  }

  async handleAdPaymentApproved(orderId: number) {
    const rows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const order = rows[0];
    if (!order || order.orderType !== "ad") return;

    await this.db
      .update(orders)
      .set({ status: "awaiting_content", updatedAt: nowInUzbekistan() })
      .where(eq(orders.id, order.id));

    if (this.templateLink) {
      await this.sendAdminResponse(
        order.userId,
        `Anketani to'ldirish uchun quyidagi havolani bosing:\n${this.templateLink}`,
      );
    } else {
      const template = [
        "Anketa shabloni:",
        "Jins: ",
        "Ism: ",
        "Yosh: ",
        "Manzil: ",
        "Boy: ",
        "Talab: ",
        "Tel: ",
      ].join("\n");

      await this.sendAdminResponse(order.userId, template);
    }
    await this.sendAdminResponse(
      order.userId,
      "Keyin 2 ta rasm va 1 ta yumaloq video yuboring.",
    );
  }

  private extractContactInfo(text: string) {
    const phoneMatch = text.match(/\+?\d[\d\s-]{8,}/);
    if (phoneMatch) {
      return phoneMatch[0].replace(/\s+/g, "");
    }
    const usernameMatch = text.match(/@[a-zA-Z0-9_]{4,}/);
    if (usernameMatch) return usernameMatch[0];
    return undefined;
  }

  private async getRecentUserMedia(
    userId: string,
    mediaType: string,
    limit: number,
    orderId?: number,
  ) {
    const filters = [
      eq(userMedia.userId, userId),
      eq(userMedia.mediaType, mediaType),
    ];
    if (orderId) {
      filters.push(eq(userMedia.orderId, orderId));
    }

    const rows = await this.db
      .select()
      .from(userMedia)
      .where(and(...filters))
      .orderBy(desc(userMedia.id))
      .limit(limit);
    return rows;
  }

  private buildArchiveBanner(params: {
    orderId?: number;
    mediaCounts?: { photos: number; videos: number };
  }) {
    const parts: string[] = [];
    if (Number.isFinite(params.orderId)) {
      parts.push(`order: #${params.orderId}`);
    }
    if (params.mediaCounts) {
      parts.push(
        `media: ${params.mediaCounts.photos} photo, ${params.mediaCounts.videos} video`,
      );
    }
    return parts.length > 0 ? parts.join(" | ") : "";
  }

  private buildOpenChannelMessage(text: string) {
    return text
      .split(/\r?\n/)
      .filter((line) => !/^\s*(tel|telefon|phone|aloqa)\s*:/i.test(line))
      .join("\n")
      .trim();
  }

  private buildClosedChannelMessage(text: string) {
    return text;
  }

  private pickBestPhoto(photos: Buffer[]) {
    if (!photos.length) return undefined;
    return photos[0];
  }

  private async findOrderIdForPublishTask(taskId: number) {
    const tasks = await this.db
      .select({ payload: adminTasks.payload })
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    const payload = tasks[0]?.payload
      ? JSON.parse(tasks[0].payload)
      : undefined;
    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;
    return Number.isFinite(orderId) ? orderId : undefined;
  }

  private async downloadUserMediaByPeer(peerId: string, messageId: number) {
    if (!this.client) return undefined;
    try {
      const peer = await this.client.getInputEntity(peerId);
      const messages = await this.client.getMessages(peer, {
        ids: [messageId],
      });
      const message = messages[0];
      if (!message) return undefined;
      const data = await message.downloadMedia({});
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === "string") {
        return await fs.readFile(data);
      }
      return undefined;
    } catch (error) {
      this.logger.warn("Failed to download user media", error as Error);
      return undefined;
    }
  }

  private async downloadUserMedia(
    row: typeof userMedia.$inferSelect,
    userId?: string,
  ) {
    if (row.archiveGroupId && row.archiveMessageId) {
      const archived = await this.downloadUserMediaByPeer(
        row.archiveGroupId,
        row.archiveMessageId,
      );
      if (archived) return archived;
    }

    if (userId) {
      return this.downloadUserMediaByPeer(userId, row.messageId);
    }

    return undefined;
  }

  private async downloadMediaBuffers(
    userId: string | undefined,
    rows: Array<typeof userMedia.$inferSelect>,
  ) {
    const buffers: Buffer[] = [];
    for (const row of rows) {
      const buffer = await this.downloadUserMedia(row, userId);
      if (buffer) buffers.push(buffer);
    }
    return buffers;
  }

  async clearOrderMedia(userId: string, orderId: number) {
    try {
      await this.db
        .delete(userMedia)
        .where(
          and(eq(userMedia.userId, userId), eq(userMedia.orderId, orderId)),
        );
    } catch (error) {
      this.logger.warn("Failed to clear media for order", error as Error);
    }
  }

  async logAdminAction(params: {
    action: string;
    taskId: number;
    orderId?: number;
    adminId?: string;
    userId?: string;
    details?: string;
  }) {
    if (!this.client || !this.adminGroupId || !this.auditTopicId) return;
    const parts = [
      `action: ${params.action}`,
      `task: #${params.taskId}`,
      params.orderId ? `order: #${params.orderId}` : "",
      params.adminId ? `admin: ${params.adminId}` : "",
      params.userId ? `user: ${params.userId}` : "",
      params.details ? `details: ${params.details}` : "",
    ].filter(Boolean);

    const groupPeer = await this.client.getInputEntity(this.adminGroupId);
    await this.client.sendMessage(groupPeer, {
      message: parts.join("\n"),
      topMsgId: this.auditTopicId,
    });
  }

  async sendAnketaPreview(params: {
    userId: string | undefined;
    orderId?: number;
  }) {
    if (!this.client || !this.adminGroupId || !this.anketasTopicId) return;
    if (!params.userId) return;

    const photoRows = await this.getRecentUserMedia(
      params.userId,
      "photo",
      2,
      params.orderId,
    );
    const videoRows = await this.getRecentUserMedia(
      params.userId,
      "video",
      1,
      params.orderId,
    );

    const photoBuffers = await this.downloadMediaBuffers(
      params.userId,
      photoRows,
    );
    const videoBuffers = await this.downloadMediaBuffers(
      params.userId,
      videoRows,
    );

    if (photoBuffers.length === 0 && videoBuffers.length === 0) return;

    const groupPeer = await this.client.getInputEntity(this.adminGroupId);
    await this.sendMediaToTarget({
      target: groupPeer,
      photos: photoBuffers,
      videos: videoBuffers,
      blurPhotos: false,
      topMsgId: this.anketasTopicId,
    });
  }

  async sendAnketaPreviewFirstPhoto(params: {
    userId: string;
    orderId: number;
  }) {
    if (!this.client || !this.adminGroupId || !this.anketasTopicId) return;

    const photoRows = await this.getRecentUserMedia(
      params.userId,
      "photo",
      1,
      params.orderId,
    );
    if (photoRows.length === 0) return;

    const buffers = await this.downloadMediaBuffers(params.userId, photoRows);
    if (buffers.length === 0) return;

    const groupPeer = await this.client.getInputEntity(this.adminGroupId);
    await this.client.sendFile(groupPeer, {
      file: buffers[0],
      caption: "preview",
      topMsgId: this.anketasTopicId,
    });
  }

  private async sendMediaToTarget(params: {
    target: any;
    photos: Buffer[];
    videos: Buffer[];
    blurPhotos: boolean;
    topMsgId?: number;
  }) {
    if (!this.client) return;

    for (const photo of params.photos) {
      const file = params.blurPhotos ? await this.blurFaces(photo) : photo;
      if (!file) continue;
      await this.client.sendFile(params.target, {
        file,
        forceDocument: false,
        topMsgId: params.topMsgId,
      });
    }

    for (const video of params.videos) {
      await this.client.sendFile(params.target, {
        file: video,
        forceDocument: false,
        topMsgId: params.topMsgId,
      });
    }
  }

  private async sendSelfDestructPhoto(
    userId: string,
    buffer: Buffer,
    ttlMs: number,
  ) {
    if (!this.client) return;
    const peer = await this.client.getInputEntity(userId);
    const sent = await this.client.sendFile(peer, {
      file: buffer,
      caption: "Rasm 10 soniyada o'chadi.",
    });

    if (sent?.id) {
      setTimeout(() => {
        this.client
          ?.deleteMessages(peer, [sent.id], { revoke: true })
          .catch(() => undefined);
      }, ttlMs);
    }
  }

  private async upsertVipSubscription(userId: string) {
    const now = nowInUzbekistan();
    const existing = await this.db
      .select()
      .from(vipSubscriptions)
      .where(eq(vipSubscriptions.userId, userId))
      .orderBy(desc(vipSubscriptions.id))
      .limit(1);

    const current = existing[0];
    const baseDate =
      current && current.status === "active" && current.expiresAt > now
        ? current.expiresAt
        : now;
    const nextExpires = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);

    await this.db.insert(vipSubscriptions).values({
      userId,
      status: "active",
      startsAt: now,
      expiresAt: nextExpires,
      createdAt: now,
      updatedAt: now,
    });

    return nextExpires;
  }

  private async addUserToVipChannel(userId: string) {
    if (!this.client || !this.vipChannelId) return { added: false };
    try {
      const channel = await this.client.getInputEntity(this.vipChannelId);
      const user = await this.client.getInputEntity(userId);
      await this.client.invoke(
        new Api.channels.InviteToChannel({
          channel,
          users: [user],
        }),
      );
      return { added: true } as const;
    } catch (error) {
      this.logger.warn("Failed to invite user to VIP channel", error as Error);
    }

    try {
      const channel = await this.client.getInputEntity(this.vipChannelId);
      const invite = await this.client.invoke(
        new Api.messages.ExportChatInvite({ peer: channel }),
      );
      const link = (invite as any)?.link as string | undefined;
      if (link) return { added: false, inviteLink: link } as const;
    } catch (error) {
      this.logger.warn("Failed to export VIP invite", error as Error);
    }

    return { added: false } as const;
  }

  async removeUserFromVipChannel(userId: string) {
    if (!this.client || !this.vipChannelId) return;
    try {
      const channel = await this.client.getInputEntity(this.vipChannelId);
      const user = await this.client.getInputEntity(userId);
      await this.client.invoke(
        new Api.channels.EditBanned({
          channel,
          participant: user,
          bannedRights: new Api.ChatBannedRights({
            viewMessages: true,
            sendMessages: true,
            untilDate: 0,
          }),
        }),
      );
    } catch (error) {
      this.logger.warn("Failed to remove VIP member", error as Error);
    }
  }

  private async forwardBlurredPhoto(params: {
    senderId: string;
    message: any;
  }) {
    if (!this.client || !this.storageGroupId || !this.blurTopicId) return;
    if (!params.message?.media) return;

    try {
      const buffer = await params.message.downloadMedia({});
      if (!buffer || !(buffer instanceof Buffer)) return;

      const blurred = await this.blurFaces(buffer);
      const fileToSend = blurred ?? buffer;
      const groupPeer = await this.client.getInputEntity(this.storageGroupId);

      await this.client.sendFile(groupPeer, {
        file: fileToSend,
        caption: `user: ${params.senderId}`,
        forceDocument: false,
        topMsgId: this.blurTopicId,
      });
    } catch (error) {
      this.logger.warn("Failed to forward blurred photo", error as Error);
    }
  }

  private async blurFaces(buffer: Buffer) {
    let cv: any;
    try {
      const imported = await import("opencv4nodejs");
      cv = imported.default ?? imported;
    } catch (error) {
      this.logger.warn("opencv4nodejs not available for blur", error as Error);
      return undefined;
    }

    try {
      const mat = cv.imdecode(buffer);
      const gray = mat.bgrToGray();
      const classifier = new cv.CascadeClassifier(cv.HAAR_FRONTALFACE_ALT2);
      const detection = classifier.detectMultiScale(gray);
      const faces = Array.isArray(detection.objects) ? detection.objects : [];

      if (faces.length === 0) {
        const blurred = mat.gaussianBlur(new cv.Size(31, 31), 0);
        return Buffer.from(cv.imencode(".jpg", blurred));
      }

      for (const face of faces) {
        const rect = new cv.Rect(face.x, face.y, face.width, face.height);
        const roi = mat.getRegion(rect);
        const kernelSize = Math.max(
          15,
          Math.floor(Math.min(face.width, face.height) / 2) | 1,
        );
        const blurred = roi.gaussianBlur(
          new cv.Size(kernelSize, kernelSize),
          0,
        );
        blurred.copyTo(mat.getRegion(rect));
      }

      return Buffer.from(cv.imencode(".jpg", mat));
    } catch (error) {
      this.logger.warn("Failed to blur faces", error as Error);
      return undefined;
    }
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      const { insertedCount, lastMessageAt } = await this.syncDialogMessages(
        dialog,
        session.id,
      );

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
