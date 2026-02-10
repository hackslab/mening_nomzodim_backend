import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { CallbackQuery } from "telegram/events/CallbackQuery";
import { Button } from "telegram/tl/custom/button";
import { DRIZZLE } from "../database/database.module";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../database/schema";
import { adminTasks, orders } from "../database/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import { nowInUzbekistan } from "../common/time";
import { TelegramService } from "../telegram/telegram.service";
import {
  resolveTelegramRoutingConfig,
  validateTelegramRoutingConfig,
} from "../common/telegram-routing";

@Injectable()
export class AdminBotService implements OnModuleInit {
  private readonly logger = new Logger(AdminBotService.name);
  private client?: TelegramClient;
  private adminGroupId?: string;
  private confirmPaymentsGroupId?: string;
  private paymentsTopicId?: number;
  private anketasTopicId?: number;
  private problemsTopicId?: number;
  private botStartInProgress = false;
  private botRetryTimer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly telegramService: TelegramService,
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {}

  async onModuleInit() {
    await this.ensureBotStarted();
  }

  private async ensureBotStarted() {
    if (this.client || this.botStartInProgress || this.botRetryTimer) {
      return;
    }

    this.botStartInProgress = true;
    try {
      await this.startBot();
    } catch (error) {
      this.client = undefined;
      const waitSeconds = this.resolveFloodWaitSeconds(error);
      const retryDelayMs = waitSeconds > 0 ? waitSeconds * 1000 + 2000 : 60_000;

      if (waitSeconds > 0) {
        this.logger.warn(
          `Admin bot hit FloodWait (${waitSeconds}s). Retry scheduled.`,
        );
      } else {
        this.logger.warn(
          "Admin bot failed to start. Retrying in 60 seconds.",
          error as Error,
        );
      }

      this.botRetryTimer = setTimeout(() => {
        this.botRetryTimer = undefined;
        void this.ensureBotStarted();
      }, retryDelayMs);
    } finally {
      this.botStartInProgress = false;
    }
  }

  private resolveFloodWaitSeconds(error: unknown) {
    const seconds = Number((error as any)?.seconds);
    const code = Number((error as any)?.code);
    const errorMessage = String((error as any)?.errorMessage ?? "");
    if (Number.isFinite(seconds) && seconds > 0 && (code === 420 || /FLOOD/i.test(errorMessage))) {
      return seconds;
    }
    return 0;
  }

  private async startBot() {
    const botToken = this.configService.get<string>("BOT_TOKEN");
    const apiId = Number(this.configService.get<number>("API_ID"));
    const apiHash = this.configService.get<string>("API_HASH");

    if (!botToken) {
      this.logger.warn("BOT_TOKEN not configured. Admin bot disabled.");
      return;
    }

    if (!apiId || !apiHash) {
      this.logger.warn("API_ID/API_HASH missing. Admin bot disabled.");
      return;
    }

    const routing = resolveTelegramRoutingConfig(this.configService);
    this.adminGroupId = routing.managementGroupId;
    this.confirmPaymentsGroupId = routing.confirmPaymentsGroupId;
    this.paymentsTopicId = routing.confirmPaymentsTopicId;
    this.anketasTopicId = routing.anketasTopicId;
    this.problemsTopicId = routing.problemsTopicId;
    validateTelegramRoutingConfig(routing, (message) => this.logger.warn(message));

    this.client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
      useWSS: true,
    });

    await this.client.start({ botAuthToken: botToken });
    this.client.addEventHandler(
      this.handleCallbackQuery.bind(this),
      new CallbackQuery({}),
    );
    this.logger.log("Admin helper bot started.");
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  async processPendingTasks() {
    if (!this.client || !this.adminGroupId) {
      await this.ensureBotStarted();
      return;
    }

    const pending = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.status, "pending"))
      .orderBy(desc(adminTasks.id))
      .limit(10);

    for (const task of pending) {
      if (task.taskType === "payment" && this.paymentsTopicId) {
        await this.postPaymentTask(task);
      }
      if (task.taskType === "publish" && this.anketasTopicId) {
        await this.postPublishTask(task);
      }
      if (task.taskType === "escalation" && this.problemsTopicId) {
        await this.postEscalationTask(task);
      }
    }
  }

  private async postEscalationTask(task: typeof adminTasks.$inferSelect) {
    if (!this.client || !this.adminGroupId || !this.problemsTopicId) return;

    const groupPeer = await this.client.getInputEntity(this.adminGroupId);
    const payload = this.safeParsePayload(task.payload);
    const text = this.buildEscalationText(task, payload);

    const openUrl =
      payload?.openUrl && typeof payload.openUrl === "string"
        ? payload.openUrl
        : task.userId
          ? `tg://user?id=${task.userId}`
          : undefined;

    const buttons = [
      [
        ...(openUrl ? [Button.url("Ochish", openUrl)] : []),
        Button.inline("AI ni qaytarish", Buffer.from(`esc:resume:${task.id}`, "utf-8")),
        Button.inline("Bloklash", Buffer.from(`esc:block:${task.id}`, "utf-8")),
      ],
    ];

    try {
      const sent = await this.client.sendMessage(groupPeer, {
        message: text,
        buttons,
        replyTo: this.problemsTopicId,
      });

      await this.db
        .update(adminTasks)
        .set({
          status: "posted",
          adminMessageId: sent?.id?.toString(),
          adminTopicId: this.problemsTopicId,
          updatedAt: nowInUzbekistan(),
        })
        .where(eq(adminTasks.id, task.id));
    } catch (error) {
      this.logger.warn("Failed to post escalation task", error as Error);
    }
  }

  private async postPaymentTask(task: typeof adminTasks.$inferSelect) {
    if (!this.client || !this.confirmPaymentsGroupId || !this.paymentsTopicId) return;

    const groupPeer = await this.client.getInputEntity(this.confirmPaymentsGroupId);
    const payload = this.safeParsePayload(task.payload);
    const messageId = payload?.messageId ? `message: ${payload.messageId}` : "";
    const orderId = payload?.orderId ? `order: #${payload.orderId}` : "";
    const orderType = payload?.orderType ? `type: ${payload.orderType}` : "";

    const text = [
      "Tolov tekshiruv",
      `task: #${task.id}`,
      task.userId ? `user: ${task.userId}` : "",
      orderId,
      orderType,
      messageId,
    ]
      .filter(Boolean)
      .join("\n");

    const buttons = [
      [
        Button.inline(
          "Tasdiqlash",
          Buffer.from(`pay:approve:${task.id}`, "utf-8"),
        ),
        Button.inline(
          "Rad etish",
          Buffer.from(`pay:reject:${task.id}`, "utf-8"),
        ),
      ],
    ];

    try {
      const sent = await this.client.sendMessage(groupPeer, {
        message: text,
        buttons,
        replyTo: this.paymentsTopicId,
      });

      await this.db
        .update(adminTasks)
        .set({
          status: "posted",
          adminMessageId: sent?.id?.toString(),
          adminTopicId: this.paymentsTopicId,
          updatedAt: nowInUzbekistan(),
        })
        .where(eq(adminTasks.id, task.id));
    } catch (error) {
      this.logger.warn("Failed to post payment task", error as Error);
    }
  }

  private async postPublishTask(task: typeof adminTasks.$inferSelect) {
    if (!this.client || !this.adminGroupId || !this.anketasTopicId) return;

    const groupPeer = await this.client.getInputEntity(this.adminGroupId);
    const payload = this.safeParsePayload(task.payload);
    const text = payload?.text ? String(payload.text) : "";
    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;
    const userId = task.userId ?? undefined;

    if (!text.trim()) {
      await this.db
        .update(adminTasks)
        .set({ status: "skipped", updatedAt: nowInUzbekistan() })
        .where(eq(adminTasks.id, task.id));
      return;
    }

    await this.telegramService.sendAnketaPreview({
      userId,
      orderId: Number.isFinite(orderId) ? orderId : undefined,
    });

    if (userId && Number.isFinite(orderId)) {
      await this.telegramService.sendAnketaPreviewFirstPhoto({
        userId,
        orderId: Number(orderId),
      });
    }

    const buttons = [
      [
        Button.inline(
          "Kanalga chiqarish",
          Buffer.from(`pub:post:${task.id}`, "utf-8"),
        ),
        Button.inline(
          "Media tasdiq",
          Buffer.from(`pub:media:${task.id}`, "utf-8"),
        ),
        Button.inline(
          "Media rad",
          Buffer.from(`pub:media_reject:${task.id}`, "utf-8"),
        ),
        Button.inline(
          "Preview",
          Buffer.from(`pub:preview:${task.id}`, "utf-8"),
        ),
        Button.inline(
          "Media reset",
          Buffer.from(`pub:media_reset:${task.id}`, "utf-8"),
        ),
      ],
    ];

    const summary = this.buildMediaSummary(payload);
    const checklist = this.buildChecklist(payload, task.status);
    const header = [summary, checklist, text].filter(Boolean).join("\n\n");

    try {
      const sent = await this.client.sendMessage(groupPeer, {
        message: header,
        buttons,
        replyTo: this.anketasTopicId,
      });

      await this.db
        .update(adminTasks)
        .set({
          status: "posted",
          adminMessageId: sent?.id?.toString(),
          adminTopicId: this.anketasTopicId,
          updatedAt: nowInUzbekistan(),
        })
        .where(eq(adminTasks.id, task.id));
    } catch (error) {
      this.logger.warn("Failed to post publish task", error as Error);
    }
  }

  private async handleCallbackQuery(event: any) {
    if (!this.client) return;
    const data = this.decodeCallbackData(event?.data);
    const paymentMatch = this.parseCallback(data, /^pay:(approve|reject):(\d+)$/);
    const publishMatch = this.parseCallback(data, /^pub:post:(\d+)$/);
    const mediaMatch = this.parseCallback(data, /^pub:media:(\d+)$/);
    const mediaRejectMatch = this.parseCallback(data, /^pub:media_reject:(\d+)$/);
    const previewMatch = this.parseCallback(data, /^pub:preview:(\d+)$/);
    const resetMatch = this.parseCallback(data, /^pub:media_reset:(\d+)$/);
    const escalationResumeMatch = this.parseCallback(data, /^esc:resume:(\d+)$/);
    const escalationBlockMatch = this.parseCallback(data, /^esc:block:(\d+)$/);
    if (
      !paymentMatch &&
      !publishMatch &&
      !mediaMatch &&
      !mediaRejectMatch &&
      !previewMatch &&
      !resetMatch &&
      !escalationResumeMatch &&
      !escalationBlockMatch
    )
      return;

    if (paymentMatch) {
      await this.handlePaymentCallback(event, paymentMatch);
      return;
    }

    if (publishMatch) {
      await this.handlePublishCallback(event, Number(publishMatch[1]));
    }

    if (mediaMatch) {
      await this.handleMediaApprove(event, Number(mediaMatch[1]));
    }

    if (mediaRejectMatch) {
      await this.handleMediaReject(event, Number(mediaRejectMatch[1]));
    }

    if (previewMatch) {
      await this.handlePreview(event, Number(previewMatch[1]));
    }

    if (resetMatch) {
      await this.handleMediaReset(event, Number(resetMatch[1]));
    }

    if (escalationResumeMatch) {
      await this.handleEscalationCallback(
        event,
        Number(escalationResumeMatch[1]),
        "resume",
      );
    }

    if (escalationBlockMatch) {
      await this.handleEscalationCallback(
        event,
        Number(escalationBlockMatch[1]),
        "block",
      );
    }
  }

  private async handleEscalationCallback(
    event: any,
    taskId: number,
    action: "resume" | "block",
  ) {
    const existing = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    if (!existing.length) {
      await event.answer({ message: "Task topilmadi." });
      return;
    }

    const task = existing[0];
    if (["resolved", "blocked"].includes(task.status)) {
      await event.answer({ message: "Allaqachon ishlangan." });
      return;
    }

    if (!task.userId) {
      await event.answer({ message: "Foydalanuvchi topilmadi." });
      return;
    }

    let details = "";
    if (action === "resume") {
      await this.telegramService.resumeAiForUser(task.userId);
      details = "AI resumed";
    } else {
      const result = await this.telegramService.blockEscalatedUser(task.userId);
      details = result.telegramBlocked ? "blocked in Telegram" : "local block only";
    }

    const nextStatus = action === "resume" ? "resolved" : "blocked";

    const updated = await this.db
      .update(adminTasks)
      .set({
        status: nextStatus,
        adminActionBy: event?.senderId?.toString?.(),
        adminActionAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .where(and(eq(adminTasks.id, task.id), inArray(adminTasks.status, ["pending", "posted"])))
      .returning({ id: adminTasks.id });

    if (updated.length === 0) {
      await event.answer({ message: "Allaqachon ishlangan." });
      return;
    }

    await this.telegramService.logAdminAction({
      action: action === "resume" ? "escalation_resume" : "escalation_block",
      taskId: task.id,
      adminId: event?.senderId?.toString?.(),
      userId: task.userId,
      details,
    });

    const statusLabel = action === "resume" ? "AI qaytarildi" : "Foydalanuvchi bloklandi";
    await event.answer({ message: statusLabel });

    const payload = this.safeParsePayload(task.payload);
    const text = [
      this.buildEscalationText(task, payload),
      `status: ${statusLabel}`,
      event?.senderId ? `by: ${event.senderId}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await this.safeEditCallbackMessage(event, text);
  }

  private async handlePaymentCallback(event: any, match: RegExpExecArray) {
    const action = match[1];
    const taskId = Number(match[2]);

    const existing = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    if (!existing.length) {
      await event.answer({ message: "Task topilmadi." });
      return;
    }

    const task = existing[0];
    if (task.status === "approved" || task.status === "rejected") {
      await event.answer({ message: "Allaqachon ishlangan." });
      return;
    }

    const payload = this.safeParsePayload(task.payload);
    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;
    const orderType = payload?.orderType
      ? String(payload.orderType)
      : undefined;

    const nextStatus = action === "approve" ? "approved" : "rejected";

    const updated = await this.db
      .update(adminTasks)
      .set({
        status: nextStatus,
        adminActionBy: event?.senderId?.toString?.(),
        adminActionAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .where(
        and(
          eq(adminTasks.id, task.id),
          inArray(adminTasks.status, ["pending", "posted", "payment_submitted"]),
        ),
      )
      .returning({ id: adminTasks.id });

    if (updated.length === 0) {
      await event.answer({ message: "Allaqachon ishlangan." });
      return;
    }

    const responseText =
      action === "approve"
        ? "To'lov tushdi. Endi ma'lumotlarni yuboring."
        : "To'lov topilmadi. Iltimos, chekingizni qayta yuboring.";

    let handledByFlow = false;
    if (action === "approve" && orderId && orderType === "contact") {
      await this.telegramService.fulfillContactOrder(orderId);
      handledByFlow = true;
    }
    if (action === "approve" && orderId && orderType === "vip") {
      await this.telegramService.activateVipOrder(orderId);
      handledByFlow = true;
    }
    if (action === "approve" && orderId && orderType === "ad") {
      await this.telegramService.handleAdPaymentApproved(orderId);
      handledByFlow = true;
    }

    if (action === "reject" && orderId) {
      await this.db
        .update(orders)
        .set({ status: "awaiting_payment", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, orderId));
      await this.telegramService.syncUserCurrentStepFromOrderId(orderId);
    }

    await this.telegramService.logAdminAction({
      action: `payment_${action}`,
      taskId: task.id,
      orderId: orderId,
      adminId: event?.senderId?.toString?.(),
      userId: task.userId ?? undefined,
    });

    if (!handledByFlow && task.userId) {
      await this.telegramService.sendAdminResponse(task.userId, responseText);
    }

    const statusLabel = action === "approve" ? "Tasdiqlandi" : "Rad etildi";
    await event.answer({ message: statusLabel });

    if (task.adminMessageId) {
      const messageId = payload?.messageId
        ? `message: ${payload.messageId}`
        : "";
      const orderId = payload?.orderId ? `order: #${payload.orderId}` : "";
      const orderType = payload?.orderType ? `type: ${payload.orderType}` : "";
      const text = [
        "Tolov tekshiruv",
        `task: #${task.id}`,
        task.userId ? `user: ${task.userId}` : "",
        orderId,
        orderType,
        messageId,
        `status: ${statusLabel}`,
        event?.senderId ? `by: ${event.senderId}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      await this.safeEditCallbackMessage(event, text);
    }
  }

  private async handlePublishCallback(event: any, taskId: number) {
    const existing = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    if (!existing.length) {
      await event.answer({ message: "Task topilmadi." });
      return;
    }

    const task = existing[0];
    if (task.status === "published") {
      await event.answer({ message: "Allaqachon chiqarilgan." });
      return;
    }

    if (task.status !== "media_approved") {
      await event.answer({ message: "Avval media tasdiqlang." });
      return;
    }

    const payload = this.safeParsePayload(task.payload);
    const text = payload?.text ? String(payload.text) : "";
    if (!text.trim()) {
      await event.answer({ message: "Matn topilmadi." });
      return;
    }

    await this.telegramService.publishAnketaTask({
      taskId: task.id,
      userId: task.userId,
      text,
    });

    await event.answer({ message: "Kanalga chiqarildi." });

    if (task.adminMessageId) {
      const statusText = [text, "\n\nstatus: chiqarildi"].join("");
      await this.safeEditCallbackMessage(event, statusText);
    }

    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;
    await this.telegramService.logAdminAction({
      action: "publish",
      taskId: task.id,
      orderId: Number.isFinite(orderId) ? orderId : undefined,
      adminId: event?.senderId?.toString?.(),
      userId: task.userId ?? undefined,
    });
  }

  private async handleMediaApprove(event: any, taskId: number) {
    const existing = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    if (!existing.length) {
      await event.answer({ message: "Task topilmadi." });
      return;
    }

    const task = existing[0];
    await this.db
      .update(adminTasks)
      .set({
        status: "media_approved",
        adminActionBy: event?.senderId?.toString?.(),
        adminActionAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .where(eq(adminTasks.id, task.id));

    await event.answer({ message: "Media tasdiqlandi." });

    const payload = this.safeParsePayload(task.payload);
    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;
    await this.telegramService.logAdminAction({
      action: "media_approved",
      taskId: task.id,
      orderId: Number.isFinite(orderId) ? orderId : undefined,
      adminId: event?.senderId?.toString?.(),
      userId: task.userId ?? undefined,
    });
  }

  private async handleMediaReject(event: any, taskId: number) {
    const existing = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    if (!existing.length) {
      await event.answer({ message: "Task topilmadi." });
      return;
    }

    const task = existing[0];
    await this.db
      .update(adminTasks)
      .set({
        status: "media_rejected",
        adminActionBy: event?.senderId?.toString?.(),
        adminActionAt: nowInUzbekistan(),
        updatedAt: nowInUzbekistan(),
      })
      .where(eq(adminTasks.id, task.id));

    const payload = this.safeParsePayload(task.payload);
    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;
    if (task.userId) {
      await this.telegramService.sendAdminResponse(
        task.userId,
        "Media mos emas. Qaytadan 2 ta rasm va 1 ta video yuboring.",
      );
      if (orderId) {
        await this.telegramService.clearOrderMedia(task.userId, orderId);
        await this.db
          .update(orders)
          .set({ status: "awaiting_content", updatedAt: nowInUzbekistan() })
          .where(eq(orders.id, orderId));
        await this.telegramService.syncUserCurrentStepFromOrderId(orderId);
      }
    }

    await event.answer({ message: "Media rad etildi." });
    await this.telegramService.logAdminAction({
      action: "media_rejected",
      taskId: task.id,
      orderId: Number.isFinite(orderId) ? orderId : undefined,
      adminId: event?.senderId?.toString?.(),
      userId: task.userId ?? undefined,
    });
  }

  private async handlePreview(event: any, taskId: number) {
    const existing = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    if (!existing.length) {
      await event.answer({ message: "Task topilmadi." });
      return;
    }

    const task = existing[0];
    const payload = this.safeParsePayload(task.payload);
    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;
    if (task.userId) {
      await this.telegramService.sendAnketaPreview({
        userId: task.userId,
        orderId: Number.isFinite(orderId) ? orderId : undefined,
      });
      await event.answer({ message: "Preview yuborildi." });
      await this.telegramService.logAdminAction({
        action: "preview",
        taskId: task.id,
        orderId: Number.isFinite(orderId) ? orderId : undefined,
        adminId: event?.senderId?.toString?.(),
        userId: task.userId ?? undefined,
      });
      return;
    }

    await event.answer({ message: "Preview topilmadi." });
  }

  private async handleMediaReset(event: any, taskId: number) {
    const existing = await this.db
      .select()
      .from(adminTasks)
      .where(eq(adminTasks.id, taskId))
      .limit(1);

    if (!existing.length) {
      await event.answer({ message: "Task topilmadi." });
      return;
    }

    const task = existing[0];
    const payload = this.safeParsePayload(task.payload);
    const orderId = payload?.orderId ? Number(payload.orderId) : undefined;

    if (task.userId && Number.isFinite(orderId)) {
      await this.telegramService.clearOrderMedia(task.userId, Number(orderId));
      await this.telegramService.sendAdminResponse(
        task.userId,
        "Media tozalandi. 2 ta rasm va 1 ta video yuboring.",
      );
      await this.db
        .update(orders)
        .set({ status: "awaiting_content", updatedAt: nowInUzbekistan() })
        .where(eq(orders.id, Number(orderId)));
      await this.telegramService.syncUserCurrentStepFromOrderId(Number(orderId));
    }

    await this.db
      .update(adminTasks)
      .set({ status: "media_reset", updatedAt: nowInUzbekistan() })
      .where(eq(adminTasks.id, task.id));

    await event.answer({ message: "Media reset qilindi." });

    await this.telegramService.logAdminAction({
      action: "media_reset",
      taskId: task.id,
      orderId: Number.isFinite(orderId) ? orderId : undefined,
      adminId: event?.senderId?.toString?.(),
      userId: task.userId ?? undefined,
    });
  }

  private decodeCallbackData(data: Uint8Array | Buffer | string | undefined) {
    if (!data) return "";
    if (typeof data === "string") return data;
    return Buffer.from(data).toString("utf-8");
  }

  private safeParsePayload(payload: string | null | undefined) {
    if (!payload) return undefined;
    try {
      return JSON.parse(payload);
    } catch {
      return undefined;
    }
  }

  private parseCallback(data: string, pattern: RegExp) {
    if (!data || data.length > 128) return null;
    return pattern.exec(data);
  }

  private async safeEditCallbackMessage(event: any, text: string) {
    try {
      await event.edit({ message: event.messageId, text, buttons: [] });
    } catch (error) {
      this.logger.warn("Failed to edit callback message", error as Error);
    }
  }

  private buildMediaSummary(payload: Record<string, unknown> | undefined) {
    if (!payload) return "";
    const photoCount = Number(payload.photoCount ?? 0);
    const videoCount = Number(payload.videoCount ?? 0);
    if (!Number.isFinite(photoCount) && !Number.isFinite(videoCount)) return "";
    const photoIds = Array.isArray(payload.photoIds)
      ? payload.photoIds.slice(0, 4).join(", ")
      : "";
    const videoIds = Array.isArray(payload.videoIds)
      ? payload.videoIds.slice(0, 2).join(", ")
      : "";
    const idLines: string[] = [];
    if (photoIds) idLines.push(`photo_ids: ${photoIds}`);
    if (videoIds) idLines.push(`video_ids: ${videoIds}`);
    const mediaLine = `media: ${photoCount} photo, ${videoCount} video`;
    return idLines.length > 0 ? [mediaLine, ...idLines].join("\n") : mediaLine;
  }

  private buildChecklist(
    payload: Record<string, unknown> | undefined,
    status: string,
  ) {
    if (!payload) return "";
    const orderId = payload.orderId ? `order: #${payload.orderId}` : "";
    const statusLine = status ? `status: ${status}` : "";
    const items = [orderId, statusLine].filter(Boolean);
    return items.length > 0 ? `checklist: ${items.join(" | ")}` : "";
  }

  private buildEscalationText(
    task: typeof adminTasks.$inferSelect,
    payload: Record<string, unknown> | undefined,
  ) {
    const name =
      payload?.name && typeof payload.name === "string"
        ? payload.name
        : "Noma'lum";
    const phone =
      payload?.phone && typeof payload.phone === "string"
        ? payload.phone
        : "Mavjud emas";
    const message =
      payload?.message && typeof payload.message === "string"
        ? payload.message
        : "[bo'sh]";

    return [
      "#muammo",
      `task: #${task.id}`,
      task.userId ? `user: ${task.userId}` : "",
      `Ism: ${name}`,
      `Telefon: ${phone}`,
      "Xabar:",
      message,
    ]
      .filter(Boolean)
      .join("\n");
  }

}
