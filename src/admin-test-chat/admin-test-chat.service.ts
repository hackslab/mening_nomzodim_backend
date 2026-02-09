import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  AiConversationMessage,
  TelegramService,
} from "../telegram/telegram.service";

type SessionState = {
  messages: AiConversationMessage[];
  updatedAt: number;
};

@Injectable()
export class AdminTestChatService {
  private readonly logger = new Logger(AdminTestChatService.name);
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxMessages = 30;
  private readonly sessionTtlMs = 6 * 60 * 60 * 1000;

  constructor(private readonly telegramService: TelegramService) {}

  async sendMessage(params: {
    adminId: string;
    sessionId: string;
    message: string;
  }) {
    const sessionId = params.sessionId?.trim();
    const message = params.message?.trim();
    const adminId = params.adminId?.trim();

    if (!adminId) {
      throw new BadRequestException("adminId is required");
    }
    if (!sessionId) {
      throw new BadRequestException("sessionId is required");
    }
    if (!message) {
      throw new BadRequestException("message is required");
    }

    this.pruneStaleSessions();
    const key = this.sessionKey(adminId, sessionId);
    const current = this.sessions.get(key) ?? {
      messages: [],
      updatedAt: Date.now(),
    };

    const conversation = [
      ...current.messages,
      { role: "user" as const, content: message },
    ];

    this.logger.log(
      `[admin-test-chat] request admin=${adminId} session=${sessionId} messages=${conversation.length}`,
    );

    const assistantMessage = await this.telegramService.generateAiReplyFromConversation(
      conversation,
    );

    const nextMessages = [
      ...conversation,
      { role: "assistant" as const, content: assistantMessage },
    ].slice(-this.maxMessages);

    this.sessions.set(key, {
      messages: nextMessages,
      updatedAt: Date.now(),
    });

    return {
      sessionId,
      context: "admin-test-chat",
      messageCount: nextMessages.length,
      request: { role: "user", content: message },
      response: { role: "assistant", content: assistantMessage },
      metadata: {
        source: "admin-test-chat",
        adminId,
      },
    };
  }

  resetSession(params: { adminId: string; sessionId: string }) {
    const adminId = params.adminId?.trim();
    const sessionId = params.sessionId?.trim();

    if (!adminId) {
      throw new BadRequestException("adminId is required");
    }
    if (!sessionId) {
      throw new BadRequestException("sessionId is required");
    }

    const key = this.sessionKey(adminId, sessionId);
    this.sessions.delete(key);
    this.logger.log(
      `[admin-test-chat] reset admin=${adminId} session=${sessionId}`,
    );

    return {
      sessionId,
      context: "admin-test-chat",
      metadata: {
        source: "admin-test-chat",
        adminId,
      },
      cleared: true,
    };
  }

  private sessionKey(adminId: string, sessionId: string) {
    return `${adminId}:${sessionId}`;
  }

  private pruneStaleSessions() {
    const now = Date.now();
    for (const [key, value] of this.sessions.entries()) {
      if (now - value.updatedAt > this.sessionTtlMs) {
        this.sessions.delete(key);
      }
    }
  }
}
