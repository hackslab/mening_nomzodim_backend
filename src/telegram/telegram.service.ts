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
import { UserProfilesService } from "../user-profiles/user-profiles.service";
import { buildUserPromptContext } from "./prompt-context.builder";
import { DEFAULT_PROMPT_CONTEXT_FIELD_MAX_LENGTH } from "../user-profiles/user-profile.constants";
import { ensureUserProfilesSchema } from "../user-profiles/user-profiles-schema";
import {
  assertMediaArchiveSchemaReadiness,
  extractArchiveColumnsFromDbError,
  MediaArchiveConnectivityError,
  MediaArchiveReadinessError,
  logMediaArchiveSchemaMismatch,
} from "../database/media-archive-readiness";

type PendingReply = {
  sessionId: number;
  messageIds: number[];
  messages: string[];
  lastMessage: any;
  timer?: NodeJS.Timeout;
  token: number;
};

type TelegramParseMode = "markdown" | "markdownv2";

export type AiConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

type UserCurrentStep =
  | "idle"
  | "awaiting_gender"
  | "awaiting_payment_confirmation"
  | "awaiting_payment_receipt"
  | "payment_receipt_submitted"
  | "awaiting_candidate_media"
  | "candidate_media_ready"
  | "awaiting_publish_review"
  | "escalated_to_admin";

type ClassifiedMediaType = "photo" | "video" | "sticker" | "unsupported";

type ActiveImageChatContext =
  | "payment_receipt"
  | "candidate_media"
  | "unknown";

type ImageMessageIntent = "payment_receipt" | "candidate_media" | "unknown";

type ImageRoutingTarget = "payment_receipt" | "candidate_media" | "blocked";

type ImageRoutingConfidence = "high" | "medium" | "low";

@Injectable()
export class TelegramService implements OnModuleInit {
  private client: TelegramClient;
  private readonly logger = new Logger(TelegramService.name);
  private stringSession: StringSession;
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;
  private readonly replyBufferMs: number;
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
  private readonly aiPausedUsers = new Set<string>();
  private readonly blockedUsers = new Set<string>();
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
  private readonly sendTemplateLinkCommand = "send_template_link";
  private readonly promptContextFieldMaxLength: number;
  private profileSchemaChecked = false;
  private mediaArchiveSchemaChecked = false;
  private blurDependencyWarningEmitted = false;
  private templateLink?: string;
  private templateLinkMale?: string;
  private templateLinkFemale?: string;
  private readonly candidateStepSet = new Set<UserCurrentStep>([
    "awaiting_candidate_media",
    "candidate_media_ready",
    "awaiting_publish_review",
  ]);
  private readonly payableOrderStatuses = new Set([
    "awaiting_payment",
    "awaiting_check",
    "payment_submitted",
  ]);
  private readonly candidateCollectionStatuses = new Set([
    "payment_submitted",
    "awaiting_content",
    "ready_to_publish",
  ]);
  private readonly imageRoutingMatrix: Record<
    ActiveImageChatContext,
    Partial<Record<ClassifiedMediaType, ImageRoutingTarget>>
  > = {
    payment_receipt: {
      photo: "payment_receipt",
    },
    candidate_media: {
      photo: "candidate_media",
      video: "candidate_media",
    },
    unknown: {},
  };

  constructor(
    private configService: ConfigService,
    private readonly settingsService: SettingsService,
    private readonly userProfilesService: UserProfilesService,
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
    this.templateLinkMale = this.configService.get<string>("TEMPLATE_LINK_MALE");
    this.templateLinkFemale = this.configService.get<string>(
      "TEMPLATE_LINK_FEMALE",
    );

    const cooldownSeconds =
      this.configService.get<number>("COOLDOWN_TIME") || 40;
    this.replyBufferMs = cooldownSeconds * 1000;

    this.promptContextFieldMaxLength = this.resolvePromptContextFieldMaxLength();
  }

  async onModuleInit() {
    await this.ensureUserProfileSchema();
    try {
      await this.ensureMediaArchiveSchemaReadiness("startup");
    } catch (error) {
      if (error instanceof MediaArchiveReadinessError) {
        throw new Error(
          `Media archive startup blocked: missing migration columns on user_media (${error.missingColumns.join(", ")}). ${error.remediation}`,
          { cause: error },
        );
      }
      if (error instanceof MediaArchiveConnectivityError) {
        throw new Error(
          "Media archive startup blocked: database connectivity check failed. Verify DB_URL/network access and retry startup.",
          { cause: error },
        );
      }
      throw error;
    }
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

        if (this.isUserBlocked(senderId)) {
          await this.markMessageRead(message);
          this.logger.debug(`Blocked user ignored: ${senderId}`);
          return;
        }

        if (this.isAiPausedForUser(senderId)) {
          await this.markMessageRead(message);
          this.logger.debug(`AI paused for user ${senderId}, skipping reply.`);
          return;
        }

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
        if (
          error instanceof MediaArchiveReadinessError ||
          error instanceof MediaArchiveConnectivityError
        ) {
          await this.notifyMediaArchiveFailure(senderId, error);
          return;
        }
        this.logger.error(`Error in Gemini handler for ${senderId}`, error);
      }
    }
  }

  private async notifyMediaArchiveFailure(
    senderId: string,
    error: MediaArchiveReadinessError | MediaArchiveConnectivityError,
  ) {
    const message =
      error instanceof MediaArchiveReadinessError
        ? "Media saqlash vaqtincha to'xtatildi: bazada kerakli migratsiya ustunlari topilmadi. Iltimos, keyinroq qayta yuboring."
        : "Media saqlash vaqtincha to'xtatildi: ma'lumotlar bazasiga ulanishda muammo bor. Iltimos, keyinroq qayta yuboring.";

    this.logger.error(`Media archive flow blocked for ${senderId}: ${error.message}`);
    try {
      await this.sendAdminResponse(senderId, message);
    } catch (notifyError) {
      this.logger.warn(
        `Failed to notify user ${senderId} about media archive issue`,
        notifyError as Error,
      );
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

  private normalizeCurrentStep(value?: string | null): UserCurrentStep {
    const normalized = value?.trim().toLowerCase();
    const known: UserCurrentStep[] = [
      "idle",
      "awaiting_gender",
      "awaiting_payment_confirmation",
      "awaiting_payment_receipt",
      "payment_receipt_submitted",
      "awaiting_candidate_media",
      "candidate_media_ready",
      "awaiting_publish_review",
      "escalated_to_admin",
    ];
    if (normalized && known.includes(normalized as UserCurrentStep)) {
      return normalized as UserCurrentStep;
    }
    return "idle";
  }

  private resolveStepFromOrderState(
    orderType?: string,
    orderStatus?: string,
  ): UserCurrentStep {
    if (!orderStatus) return "idle";

    if (orderStatus === "awaiting_gender") return "awaiting_gender";
    if (orderStatus === "awaiting_payment") {
      return "awaiting_payment_confirmation";
    }
    if (orderStatus === "awaiting_check") return "awaiting_payment_receipt";
    if (orderStatus === "payment_submitted") return "payment_receipt_submitted";
    if (orderType === "ad" && orderStatus === "awaiting_content") {
      return "awaiting_candidate_media";
    }
    if (orderType === "ad" && orderStatus === "ready_to_publish") {
      return "awaiting_publish_review";
    }
    if (["completed", "cancelled", "failed"].includes(orderStatus)) {
      return "idle";
    }
    return "idle";
  }

  private async setUserCurrentStep(
    userId: string,
    nextStep: UserCurrentStep,
    options?: { expectedCurrentStep?: UserCurrentStep },
  ) {
    const profile = await this.getOrCreateUserProfile(userId);
    const currentStep = this.normalizeCurrentStep(profile.currentStep);

    if (options?.expectedCurrentStep && currentStep !== options.expectedCurrentStep) {
      return currentStep;
    }
    if (currentStep === nextStep) return currentStep;

    await this.db
      .update(userProfiles)
      .set({ currentStep: nextStep, updatedAt: nowInUzbekistan() })
      .where(eq(userProfiles.userId, userId));

    return nextStep;
  }

  private async syncUserCurrentStepFromOrderState(params: {
    userId?: string;
    orderType?: string;
    orderStatus?: string;
  }) {
    if (!params.userId) return "idle" as const;
    const nextStep = this.resolveStepFromOrderState(
      params.orderType,
      params.orderStatus,
    );
    await this.setUserCurrentStep(params.userId, nextStep);
    return nextStep;
  }

  async syncUserCurrentStepFromOrderId(orderId: number) {
    const rows = await this.db
      .select({
        userId: orders.userId,
        orderType: orders.orderType,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const order = rows[0];
    if (!order?.userId) return "idle" as const;

    return this.syncUserCurrentStepFromOrderState({
      userId: order.userId,
      orderType: order.orderType,
      orderStatus: order.status,
    });
  }

  private async resolveCurrentStep(params: {
    userId: string;
    openOrder?: typeof orders.$inferSelect;
  }) {
    const profile = await this.getOrCreateUserProfile(params.userId);
    const persisted = this.normalizeCurrentStep(profile.currentStep);
    if (persisted === "escalated_to_admin") return persisted;

    const openOrder = params.openOrder ?? (await this.getLatestOpenOrder(params.userId));
    const inferred = this.resolveStepFromOrderState(
      openOrder?.orderType,
      openOrder?.status,
    );

    if (inferred !== "idle" && inferred !== persisted) {
      await this.setUserCurrentStep(params.userId, inferred);
      return inferred;
    }

    return persisted !== "idle" ? persisted : inferred;
  }

  private resolveAllowedActions(step: UserCurrentStep) {
    switch (step) {
      case "awaiting_gender":
        return ["ask_gender", "set_gender"];
      case "awaiting_payment_confirmation":
        return ["confirm_payment_intent", "cancel_order"];
      case "awaiting_payment_receipt":
        return ["request_receipt_photo", "wait_for_image"];
      case "payment_receipt_submitted":
        return ["wait_for_admin_moderation", "do_not_request_new_payment"];
      case "awaiting_candidate_media":
        return ["request_candidate_photos", "accept_media", "wait_for_anketa_text"];
      case "candidate_media_ready":
        return ["collect_or_validate_anketa", "prepare_publish_task"];
      case "awaiting_publish_review":
        return ["wait_for_admin_review", "provide_status_update"];
      case "escalated_to_admin":
        return ["handoff_to_human", "do_not_auto_reply"];
      default:
        return ["normal_assistant_flow"];
    }
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
          sessionId: pending.sessionId,
          message: pending.lastMessage,
          combinedMessage,
        });
        return;
      }

      const chat = this.model.startChat({
        history: await this.prependSystemPrompt(history, senderId),
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
          sessionId: pending.sessionId,
          message: pending.lastMessage,
          combinedMessage,
        });
        return;
      }

      const handledTemplateOutput = await this.handleTemplateLinkAssistantOutput(
        {
          senderId,
          responseText,
        },
      );
      if (handledTemplateOutput) {
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
    parseMode?: TelegramParseMode;
  }) {
    if (!this.client) return;

    const normalizedText = params.responseText?.trim();
    if (!normalizedText) return;

    const fragments = params.parseMode
      ? [normalizedText]
      : this.splitResponse(normalizedText);
    if (fragments.length === 0) return;

    const inputPeer = await this.client.getInputEntity(params.senderId);

    for (const fragment of fragments) {
      if (!this.isReplyTokenActive(params.senderId, params.token)) return;

      const delayMs = this.calculateTypingDelayMs(fragment);
      await this.showTyping(inputPeer, delayMs);

      if (!this.isReplyTokenActive(params.senderId, params.token)) return;

      const sentMessage = await this.client.sendMessage(inputPeer, {
        message: fragment,
        parseMode: params.parseMode,
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
    userId?: string,
  ) {
    const systemPrompt = await this.buildSystemPrompt(userId);
    return [
      {
        role: "user" as const,
        parts: [{ text: systemPrompt }],
      },
      ...history,
    ];
  }

  private async buildSystemPrompt(userId?: string) {
    const settings = await this.settingsService.getSettings();
    const basePrompt = this.applyPromptVariables(settings.systemPrompt);
    if (!userId) return basePrompt;

    const openOrder = await this.getLatestOpenOrder(userId);
    const step = await this.resolveCurrentStep({ userId, openOrder });
    const allowedActions = this.resolveAllowedActions(step).join(", ");
    const orderStatus = openOrder?.status ?? "none";

    let promptContextSection: string | undefined;
    let promptContextStatus: "included" | "partial" | "skipped" = "skipped";
    let includedFields: string[] = [];
    let excludedFields: string[] = [];

    try {
      const profileResult =
        await this.userProfilesService.getProfileForPromptContext(userId);
      const contextResult = buildUserPromptContext({
        profile:
          profileResult.status === "found"
            ? (profileResult.profile as unknown as Record<string, unknown>)
            : undefined,
        maxFieldLength: this.promptContextFieldMaxLength,
      });

      promptContextSection = contextResult.section;
      promptContextStatus = contextResult.status;
      includedFields = contextResult.includedFields;
      excludedFields = contextResult.excludedFields;

      this.logger.log(
        JSON.stringify({
          event: "prompt_context.assembly",
          userId,
          profileReadOutcome: profileResult.status,
          assemblyStatus: contextResult.status,
          includedFields: contextResult.includedFields,
          excludedFields: contextResult.excludedFields,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Prompt context fallback for user ${userId}; baseline system prompt is used.`,
        error as Error,
      );
    }

    return [
      basePrompt,
      promptContextSection,
      "[FLOW_CONTEXT]",
      `current_step=${step}`,
      `order_status=${orderStatus}`,
      `allowed_next_actions=${allowedActions}`,
      `prompt_context_status=${promptContextStatus}`,
      `prompt_context_included=${includedFields.join(",") || "none"}`,
      `prompt_context_excluded=${excludedFields.join(",") || "none"}`,
    ]
      .filter(Boolean)
      .join("\n");
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

  private resolvePromptContextFieldMaxLength() {
    const raw = this.configService.get<number>("PROMPT_CONTEXT_FIELD_MAX_LENGTH");
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return DEFAULT_PROMPT_CONTEXT_FIELD_MAX_LENGTH;
    }
    return Math.floor(numeric);
  }

  private async ensureUserProfileSchema() {
    if (this.profileSchemaChecked) return;
    this.profileSchemaChecked = true;
    try {
      await ensureUserProfilesSchema(this.db, this.logger);
    } catch (error) {
      this.profileSchemaChecked = false;
      throw error;
    }
  }

  private async ensureMediaArchiveSchemaReadiness(
    source: "startup" | "runtime",
  ) {
    if (this.mediaArchiveSchemaChecked) return;
    this.mediaArchiveSchemaChecked = true;
    try {
      await assertMediaArchiveSchemaReadiness({
        db: this.db,
        logger: this.logger,
        source,
      });
    } catch (error) {
      this.mediaArchiveSchemaChecked = false;
      throw error;
    }
  }

  async generateAiReplyFromConversation(conversation: AiConversationMessage[]) {
    if (!this.model) {
      throw new BadRequestException("AI model is not configured");
    }

    const normalized = conversation
      .map((item) => ({
        role: item.role,
        content: item.content?.trim(),
      }))
      .filter((item) => item.content);

    if (normalized.length === 0) {
      throw new BadRequestException("Conversation is empty");
    }

    const lastMessage = normalized[normalized.length - 1];
    if (lastMessage.role !== "user") {
      throw new BadRequestException("Last message must be from user");
    }

    const history = normalized.slice(0, -1).map((item) => ({
      role: item.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: item.content }],
    }));

    const chat = this.model.startChat({
      history: await this.prependSystemPrompt(history),
    });
    const result = await chat.sendMessage(lastMessage.content);
    const response = await result.response;
    const responseText = response.text()?.trim();

    if (!responseText) {
      throw new BadRequestException("AI returned an empty response");
    }

    return responseText;
  }

  private isEscalationResponse(responseText: string) {
    return responseText.trim().toLowerCase() === "escalate_to_human";
  }

  private async handleTemplateLinkAssistantOutput(params: {
    senderId: string;
    responseText: string;
  }) {
    const normalized = params.responseText?.trim();
    if (!normalized) return false;

    const openAdOrder = await this.getOpenAdOrder(params.senderId);
    if (!openAdOrder) return false;
    if (!this.isPostingAdTemplateStep(openAdOrder.status)) return false;

    if (this.isTemplateLinkCommand(normalized)) {
      await this.executeTemplateLinkCommand({
        senderId: params.senderId,
        order: openAdOrder,
      });
      return true;
    }

    if (!this.hasRawTemplateUrl(normalized)) return false;

    this.logger.warn(
      `[template-link-guard] blocked raw template URL output for user ${params.senderId} on order ${openAdOrder.id}`,
    );
    await this.executeTemplateLinkCommand({
      senderId: params.senderId,
      order: openAdOrder,
    });
    return true;
  }

  private async executeTemplateLinkCommand(params: {
    senderId: string;
    order: typeof orders.$inferSelect;
  }) {
    const profile = await this.getOrCreateUserProfile(params.senderId);
    const gender = this.resolveProfileGender(profile.gender);

    if (!gender) {
      await this.ensureAdOrderAwaitingGender(params.order.id);
      await this.sendAdminResponse(params.senderId, "Ayolmisiz yoki erkak?");
      return;
    }

    if (profile.gender !== gender) {
      await this.updateUserGender(profile.userId, gender);
    }

    if (params.order.status === "awaiting_gender") {
      const amount = this.computeAdPrice(gender, profile.adCount ?? 0);
      const nextStatus = amount === 0 ? "awaiting_content" : "awaiting_payment";
      await this.updateAdOrderAmountAndStatus(params.order.id, amount, nextStatus);

      if (amount > 0) {
        await this.sendAdminResponse(
          params.senderId,
          this.buildAdPriceMessage(gender, profile.adCount ?? 0, amount),
        );
        return;
      }

      await this.sendAdminResponse(params.senderId, "Birinchi e'lon bepul.");
    }

    if (
      !["awaiting_gender", "awaiting_content", "ready_to_publish"].includes(
        params.order.status,
      )
    ) {
      await this.sendAdminResponse(
        params.senderId,
        "Avval to'lovni yakunlaymiz.",
      );
      return;
    }

    await this.sendPostingTemplateForGender(params.senderId, gender);
    await this.sendAdminResponse(
      params.senderId,
      "Keyin 2 ta rasm va 1 ta yumaloq video yuboring.",
    );
  }

  private async ensureAdOrderAwaitingGender(orderId: number) {
    await this.db
      .update(orders)
      .set({ status: "awaiting_gender", updatedAt: nowInUzbekistan() })
      .where(eq(orders.id, orderId));
    await this.syncUserCurrentStepFromOrderId(orderId);
  }

  private async updateAdOrderAmountAndStatus(
    orderId: number,
    amount: number,
    status: string,
  ) {
    await this.db
      .update(orders)
      .set({ amount, status, updatedAt: nowInUzbekistan() })
      .where(eq(orders.id, orderId));
    await this.syncUserCurrentStepFromOrderId(orderId);
  }

  private resolveProfileGender(value?: string | null) {
    if (!value) return undefined;
    const lowered = value.trim().toLowerCase();
    if (["female", "ayol", "qiz"].includes(lowered)) return "female" as const;
    if (["male", "erkak", "yigit"].includes(lowered)) return "male" as const;
    return undefined;
  }

  private isPostingAdTemplateStep(status: string) {
    return ["awaiting_gender", "awaiting_content", "ready_to_publish"].includes(
      status,
    );
  }

  private isTemplateLinkCommand(text: string) {
    return text.trim().toLowerCase() === this.sendTemplateLinkCommand;
  }

  private hasRawTemplateUrl(text: string) {
    const urls = text.match(/https?:\/\/[^\s)]+/gi) ?? [];
    if (urls.length === 0) return false;

    const knownLinks = [
      this.templateLink,
      this.templateLinkMale,
      this.templateLinkFemale,
    ]
      .map((item) => this.normalizeUrlForCompare(item))
      .filter((item): item is string => Boolean(item));
    const knownSet = new Set(knownLinks);

    return urls.some((url) => {
      const normalized = this.normalizeUrlForCompare(url);
      if (!normalized) return false;
      if (knownSet.has(normalized)) return true;
      return /(template|anketa)/i.test(normalized);
    });
  }

  private normalizeUrlForCompare(value?: string) {
    if (!value) return undefined;
    return value.trim().replace(/[)\].,!?]+$/g, "").toLowerCase();
  }

  private resolveTemplateLinkForGender(gender: "male" | "female") {
    if (gender === "male" && this.templateLinkMale) {
      return this.templateLinkMale;
    }
    if (gender === "female" && this.templateLinkFemale) {
      return this.templateLinkFemale;
    }
    return this.templateLink;
  }

  private async sendPostingTemplateForGender(
    userId: string,
    gender: "male" | "female",
  ) {
    const link = this.resolveTemplateLinkForGender(gender);
    if (link) {
      await this.sendAdminResponse(
        userId,
        `Anketani to'ldirish uchun [shu yerga bosing](${link})`,
        { parseMode: "markdown" },
      );
      return;
    }

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

    await this.sendAdminResponse(userId, template);
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
    sessionId: number;
    message: any;
    combinedMessage: string;
  }) {
    if (!this.problemsTopicId) {
      this.logger.warn("Admin group/topic not configured for escalation.");
      return;
    }

    this.pauseAiForUser(params.senderId);
    await this.setUserCurrentStep(params.senderId, "escalated_to_admin");

    const identity = await this.resolveEscalationIdentity({
      senderId: params.senderId,
      sessionId: params.sessionId,
      sender: params.message?.sender,
    });

    await this.createAdminTask({
      taskType: "escalation",
      sessionId: params.sessionId,
      userId: params.senderId,
      payload: {
        topicId: this.problemsTopicId,
        name: identity.name,
        phone: identity.phone,
        message: params.combinedMessage,
        openUrl: identity.openUrl,
      },
    });
  }

  async resumeAiForUser(userId: string) {
    this.aiPausedUsers.delete(userId);
    this.blockedUsers.delete(userId);
    this.clearPendingReply(userId);
    const openOrder = await this.getLatestOpenOrder(userId);
    await this.syncUserCurrentStepFromOrderState({
      userId,
      orderType: openOrder?.orderType,
      orderStatus: openOrder?.status,
    });
  }

  async blockEscalatedUser(userId: string) {
    this.blockedUsers.add(userId);
    this.aiPausedUsers.add(userId);
    this.clearPendingReply(userId);
    await this.setUserCurrentStep(userId, "escalated_to_admin");

    if (!this.client) {
      return { telegramBlocked: false };
    }

    try {
      const target = await this.client.getEntity(userId);
      await this.client.invoke(
        new Api.contacts.Block({
          id: target as any,
        }),
      );
      return { telegramBlocked: true };
    } catch (error) {
      this.logger.warn(
        "Failed to block user in Telegram; local block remains active.",
        error as Error,
      );
      return { telegramBlocked: false };
    }
  }

  private pauseAiForUser(userId: string) {
    this.aiPausedUsers.add(userId);
    this.clearPendingReply(userId);
  }

  private isAiPausedForUser(userId: string) {
    return this.aiPausedUsers.has(userId);
  }

  private isUserBlocked(userId: string) {
    return this.blockedUsers.has(userId);
  }

  private clearPendingReply(userId: string) {
    const pending = this.pendingReplies.get(userId);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingReplies.delete(userId);
    this.nextReplyToken(userId);
  }

  private async resolveEscalationIdentity(params: {
    senderId: string;
    sessionId: number;
    sender?: any;
  }) {
    const dbName = await this.findNameFromDb(params.sessionId, params.senderId);
    const dbPhone = await this.findPhoneFromDb(params.sessionId, params.senderId);

    const telegramIdentity = await this.resolveTelegramIdentity(
      params.senderId,
      params.sender,
    );

    const name =
      dbName ||
      telegramIdentity.displayName ||
      telegramIdentity.username ||
      params.senderId;
    const phone = dbPhone || telegramIdentity.phone;
    const openUrl = telegramIdentity.username
      ? `https://t.me/${telegramIdentity.username}`
      : `tg://user?id=${params.senderId}`;

    return {
      name,
      phone,
      openUrl,
    };
  }

  private async resolveTelegramIdentity(senderId: string, sender?: any) {
    const entity = await this.getTelegramEntity(senderId, sender);
    const username = this.normalizeUsername(entity?.username);
    const displayName = this.buildDisplayName(entity, username);
    const phone = this.normalizePhone(entity?.phone);
    return {
      username,
      displayName,
      phone,
    };
  }

  private async getTelegramEntity(senderId: string, sender?: any) {
    if (sender && typeof sender === "object") {
      return sender as any;
    }
    if (!this.client) return undefined;
    try {
      return await this.client.getEntity(senderId);
    } catch {
      return undefined;
    }
  }

  private buildDisplayName(entity: any, username?: string) {
    const firstName = typeof entity?.firstName === "string" ? entity.firstName : "";
    const lastName = typeof entity?.lastName === "string" ? entity.lastName : "";
    const fromNames = [firstName, lastName].filter(Boolean).join(" ").trim();
    if (fromNames) return fromNames;
    return username ? `@${username}` : undefined;
  }

  private normalizeUsername(value: unknown) {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().replace(/^@+/, "");
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private normalizePhone(value: unknown) {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim().replace(/\s+/g, "");
    if (!trimmed) return undefined;
    if (trimmed.startsWith("+")) return trimmed;
    return /^\d+$/.test(trimmed) ? `+${trimmed}` : trimmed;
  }

  private async findNameFromDb(sessionId: number, userId: string) {
    const sources = await this.getIdentitySourceTexts(sessionId, userId);
    for (const text of sources) {
      const name = this.extractNameFromText(text);
      if (name) return name;
    }
    return undefined;
  }

  private async findPhoneFromDb(sessionId: number, userId: string) {
    const sources = await this.getIdentitySourceTexts(sessionId, userId);
    for (const text of sources) {
      const phone = this.extractPhoneNumber(text);
      if (phone) return phone;
    }
    return undefined;
  }

  private async getIdentitySourceTexts(sessionId: number, userId: string) {
    const messages = await this.db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(
        and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.role, "user")),
      )
      .orderBy(desc(chatMessages.id))
      .limit(30);

    const posts = await this.db
      .select({ content: adPosts.content })
      .from(adPosts)
      .where(eq(adPosts.userId, userId))
      .orderBy(desc(adPosts.id))
      .limit(10);

    return [...messages.map((row) => row.content), ...posts.map((row) => row.content)];
  }

  private extractNameFromText(text: string) {
    if (!text) return undefined;
    const patterns = [
      /^\s*ism\s*:\s*(.+)$/im,
      /^\s*ismi\s*:\s*(.+)$/im,
      /^\s*name\s*:\s*(.+)$/im,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const value = match?.[1]?.trim();
      if (value) return value;
    }
    return undefined;
  }

  private extractPhoneNumber(text: string) {
    if (!text) return undefined;
    const match = text.match(/\+?\d[\d\s()\-]{7,}\d/);
    if (!match) return undefined;
    const normalized = match[0].replace(/[\s()\-]/g, "");
    return normalized.startsWith("+") ? normalized : `+${normalized}`;
  }

  async sendAdminResponse(
    senderId: string,
    text: string,
    options?: { parseMode?: TelegramParseMode },
  ) {
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
      parseMode: options?.parseMode,
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
    await this.resolveCurrentStep({
      userId: params.senderId,
      openOrder,
    });

    if (openOrder && openOrder.orderType === "ad") {
      if (openOrder.status === "awaiting_gender") {
        const gender = this.parseGender(text);
        if (negative) {
          await this.db
            .update(orders)
            .set({ status: "cancelled", updatedAt: nowInUzbekistan() })
            .where(eq(orders.id, openOrder.id));
          await this.setUserCurrentStep(params.senderId, "idle");
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
        await this.syncUserCurrentStepFromOrderState({
          userId: params.senderId,
          orderType: openOrder.orderType,
          orderStatus: nextStatus,
        });

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
      await this.setUserCurrentStep(params.senderId, "awaiting_payment_receipt");
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
      await this.setUserCurrentStep(params.senderId, "idle");
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
    const nextStatus = params.status ?? "awaiting_payment";
    const inserted = await this.db
      .insert(orders)
      .values({
        orderType: params.orderType,
        status: nextStatus,
        sessionId: params.sessionId,
        userId: params.userId,
        amount: params.amount,
        adId: params.adId,
        createdAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .returning({ id: orders.id });
    await this.syncUserCurrentStepFromOrderState({
      userId: params.userId,
      orderType: params.orderType,
      orderStatus: nextStatus,
    });
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
    await this.ensureUserProfileSchema();
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
        currentStep: "idle",
        adCount: 0,
        createdAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .returning();
    return inserted[0];
  }

  private async updateUserGender(userId: string, gender: string) {
    await this.ensureUserProfileSchema();
    await this.db
      .update(userProfiles)
      .set({ gender, updatedAt: nowInUzbekistan() })
      .where(eq(userProfiles.userId, userId));
  }

  private async incrementAdCount(userId: string) {
    await this.ensureUserProfileSchema();
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
      if (order?.userId) {
        await this.setUserCurrentStep(order.userId, "idle");
      }
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
      await this.setUserCurrentStep(params.senderId, "awaiting_candidate_media");
      await this.sendAdminResponse(
        params.senderId,
        `2 ta rasm va 1 ta yumaloq video yuboring. Hozir: ${mediaCounts.photos} rasm, ${mediaCounts.videos} video.`,
      );
      return;
    }
    if (mediaCounts.photos > 2 || mediaCounts.videos > 1) {
      await this.setUserCurrentStep(params.senderId, "awaiting_candidate_media");
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
      await this.setUserCurrentStep(params.senderId, "awaiting_publish_review");
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
    const openOrder = await this.getLatestOpenOrder(params.senderId);
    const currentStep = await this.resolveCurrentStep({
      userId: params.senderId,
      openOrder,
    });
    const expectsPaymentReceipt =
      currentStep === "awaiting_payment_receipt" ||
      this.isPaymentEvidence(params.incomingText);

    if (openOrder && expectsPaymentReceipt) {
      const handledPayment = await this.handlePaymentReceiptMedia({
        senderId: params.senderId,
        sessionId: params.sessionId,
        incomingText: params.incomingText,
        message: params.message,
        mediaType,
        openOrder,
      });
      if (handledPayment) {
        return;
      }
    }

    if (mediaType === "sticker" || mediaType === "unsupported") {
      if (this.candidateStepSet.has(currentStep)) {
        await this.setUserCurrentStep(params.senderId, "awaiting_candidate_media");
        await this.sendAdminResponse(
          params.senderId,
          "Rasm yuboring. Sticker yoki boshqa turdagi fayl tahlil qilinmaydi.",
        );
      }
      return;
    }

    await this.ensureMediaArchiveSchemaReadiness("runtime");

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

      if (openAdOrder) {
        await this.syncCandidateMediaCurrentStep(params.senderId, openAdOrder.id);
      }

      if (this.candidateStepSet.has(currentStep)) {
        await this.analyzeCandidatePhotoStep({
          senderId: params.senderId,
          message: params.message,
        });
      }
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

      if (openAdOrder) {
        await this.syncCandidateMediaCurrentStep(params.senderId, openAdOrder.id);
      }

      if (this.candidateStepSet.has(currentStep)) {
        await this.sendAdminResponse(
          params.senderId,
          "Video qabul qilindi. AI tahlil uchun qo'shimcha rasm ham yuboring.",
        );
      }
    }
  }

  private resolveMediaType(message: any): ClassifiedMediaType {
    const media = message?.media;
    if (!media) return "unsupported";
    if (media instanceof Api.MessageMediaPhoto) return "photo" as const;

    if (media instanceof Api.MessageMediaDocument) {
      const document = media.document as any;
      const mimeType =
        typeof document?.mimeType === "string"
          ? document.mimeType.toLowerCase()
          : "";
      const attributes = Array.isArray(document?.attributes)
        ? document.attributes
        : [];

      const hasStickerAttribute = attributes.some(
        (attr: any) => attr instanceof Api.DocumentAttributeSticker,
      );
      if (hasStickerAttribute) {
        return "sticker";
      }

      if (
        mimeType.includes("sticker") ||
        mimeType.includes("tgsticker") ||
        mimeType.includes("x-tgs") ||
        mimeType === "application/x-tgsticker"
      ) {
        return "sticker";
      }

      if (
        attributes.some(
          (attr: any) => attr instanceof Api.DocumentAttributeVideo,
        )
      ) {
        return "video" as const;
      }

      if (mimeType.startsWith("video/")) return "video" as const;
      if (mimeType.startsWith("image/")) return "photo" as const;
    }

    return "unsupported";
  }

  private isPaymentEvidence(text: string) {
    const normalized = text?.toLowerCase?.() ?? "";
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

  private async syncCandidateMediaCurrentStep(userId: string, orderId: number) {
    const counts = await this.getAdMediaCounts(userId, orderId);
    if (counts.ready) {
      await this.setUserCurrentStep(userId, "candidate_media_ready");
      return;
    }
    await this.setUserCurrentStep(userId, "awaiting_candidate_media");
  }

  private async handlePaymentReceiptMedia(params: {
    senderId: string;
    sessionId: number;
    incomingText: string;
    message: any;
    mediaType: ClassifiedMediaType;
    openOrder: typeof orders.$inferSelect;
  }) {
    if (!this.paymentsTopicId) return false;

    if (!["awaiting_payment", "awaiting_check", "payment_submitted"].includes(params.openOrder.status)) {
      return false;
    }

    if (params.mediaType !== "photo") {
      await this.setUserCurrentStep(params.senderId, "awaiting_payment_receipt");
      await this.sendAdminResponse(
        params.senderId,
        "To'lov cheki rasm bo'lishi kerak. Iltimos, chekni rasm ko'rinishida yuboring.",
      );
      return true;
    }

    await this.forwardMessageToTopic({
      message: params.message,
      topicId: this.paymentsTopicId,
      targetGroupId: this.adminGroupId,
    });

    await this.db
      .update(orders)
      .set({ status: "payment_submitted", updatedAt: nowInUzbekistan() })
      .where(eq(orders.id, params.openOrder.id));

    await this.setUserCurrentStep(params.senderId, "payment_receipt_submitted");

    await this.createAdminTask({
      taskType: "payment",
      sessionId: params.sessionId,
      userId: params.senderId,
      payload: {
        messageId: params.message?.id,
        peerId: params.message?.peerId,
        text: params.incomingText,
        orderId: params.openOrder?.id,
        orderType: params.openOrder?.orderType,
        orderAmount: params.openOrder?.amount,
        adId: params.openOrder?.adId,
        mediaType: params.mediaType,
      },
    });

    await this.analyzePaymentReceiptStep({
      senderId: params.senderId,
      message: params.message,
    });

    if (params.openOrder?.orderType === "ad") {
      await this.sendAdminResponse(
        params.senderId,
        "To'lov tushgach, anketangizni yuborasiz.",
      );
    }

    return true;
  }

  private async analyzeCandidatePhotoStep(params: {
    senderId: string;
    message: any;
  }) {
    const prompt =
      "Siz nomzod suratlarini baholovchi yordamchisiz. Rasm mosligini qisqa tekshiring va faqat o'zbek tilida 1-2 jumla amaliy tavsiya yozing.";
    await this.analyzeImageWithPrompt({
      senderId: params.senderId,
      message: params.message,
      prompt,
      fallbackText:
        "Rasm qabul qilindi. Yana kerakli materiallarni yuborishda davom eting.",
    });
  }

  private async analyzePaymentReceiptStep(params: {
    senderId: string;
    message: any;
  }) {
    const prompt =
      "Siz to'lov cheki tekshiruvchisiz. Rasm to'lov cheki ekanini qisqa baholang va faqat o'zbek tilida 1-2 jumla natija yozing.";
    await this.analyzeImageWithPrompt({
      senderId: params.senderId,
      message: params.message,
      prompt,
      fallbackText: "Chek rasmi qabul qilindi va tekshiruvga yuborildi.",
    });
  }

  private async analyzeImageWithPrompt(params: {
    senderId: string;
    message: any;
    prompt: string;
    fallbackText: string;
  }) {
    if (!this.model) return;

    const imageBuffer = await this.downloadIncomingImageBuffer(params.message);
    if (!imageBuffer) {
      await this.sendAdminResponse(params.senderId, params.fallbackText);
      return;
    }

    try {
      const result = await this.model.generateContent([
        {
          text: params.prompt,
        },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: imageBuffer.toString("base64"),
          },
        } as any,
      ] as any);
      const response = await result.response;
      const text = response.text()?.trim();
      if (text) {
        await this.sendAdminResponse(params.senderId, text);
        return;
      }
    } catch (error) {
      this.logger.warn("Image analysis failed", error as Error);
    }

    await this.sendAdminResponse(params.senderId, params.fallbackText);
  }

  private async downloadIncomingImageBuffer(message: any) {
    try {
      const data = await message?.downloadMedia?.({});
      if (Buffer.isBuffer(data)) return data;
      if (typeof data === "string") {
        return await fs.readFile(data);
      }
    } catch (error) {
      this.logger.warn("Failed to download incoming image", error as Error);
    }
    return undefined;
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
      const missingColumns = extractArchiveColumnsFromDbError(error);
      if (missingColumns.length > 0) {
        this.mediaArchiveSchemaChecked = false;
        logMediaArchiveSchemaMismatch(this.logger, {
          source: "runtime",
          missingColumns,
        });
        throw new MediaArchiveReadinessError(missingColumns);
      }
      throw error;
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
      await this.setUserCurrentStep(order.userId, "idle");
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
      await this.setUserCurrentStep(order.userId, "idle");
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
    await this.setUserCurrentStep(order.userId, "idle");
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
    await this.setUserCurrentStep(order.userId, "idle");
  }

  async handleAdPaymentApproved(orderId: number) {
    const rows = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const order = rows[0];
    if (!order || order.orderType !== "ad") return;

    const profile = await this.getOrCreateUserProfile(order.userId);
    const gender = this.resolveProfileGender(profile.gender);
    if (!gender) {
      await this.ensureAdOrderAwaitingGender(order.id);
      await this.sendAdminResponse(order.userId, "Ayolmisiz yoki erkak?");
      return;
    }

    if (profile.gender !== gender) {
      await this.updateUserGender(profile.userId, gender);
    }

    await this.db
      .update(orders)
      .set({ status: "awaiting_content", updatedAt: nowInUzbekistan() })
      .where(eq(orders.id, order.id));
    await this.setUserCurrentStep(order.userId, "awaiting_candidate_media");

    await this.sendPostingTemplateForGender(order.userId, gender);
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
      if (!this.blurDependencyWarningEmitted) {
        this.blurDependencyWarningEmitted = true;
        this.logger.warn(
          JSON.stringify({
            event: "media_blur.degraded_mode",
            tag: "opencv4nodejs_missing",
            behavior: "blur_disabled_passthrough",
            remediation:
              "Install optional opencv4nodejs dependency to re-enable face blur.",
            errorMessage:
              error instanceof Error ? error.message : "Unknown import error",
          }),
        );
      }
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
