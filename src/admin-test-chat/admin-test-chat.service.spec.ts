import { BadRequestException } from "@nestjs/common";
import { AdminTestChatService } from "./admin-test-chat.service";

describe("AdminTestChatService", () => {
  it("rejects empty messages", async () => {
    const telegramService: any = {
      generateAiReplyFromConversation: jest.fn(),
    };
    const service = new AdminTestChatService(telegramService);

    await expect(
      service.sendMessage({
        adminId: "admin-1",
        sessionId: "s-1",
        message: "   ",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("handles a single-turn request", async () => {
    const telegramService: any = {
      generateAiReplyFromConversation: jest.fn().mockResolvedValue("Hello admin"),
    };
    const service = new AdminTestChatService(telegramService);

    const result = await service.sendMessage({
      adminId: "admin-1",
      sessionId: "session-a",
      message: "Salom",
    });

    expect(result.response.content).toBe("Hello admin");
    expect(result.messageCount).toBe(2);
    expect(telegramService.generateAiReplyFromConversation).toHaveBeenCalledWith([
      { role: "user", content: "Salom" },
    ]);
  });

  it("preserves session context across turns", async () => {
    const telegramService: any = {
      generateAiReplyFromConversation: jest
        .fn()
        .mockResolvedValueOnce("Birinchi javob")
        .mockResolvedValueOnce("Ikkinchi javob"),
    };
    const service = new AdminTestChatService(telegramService);

    await service.sendMessage({
      adminId: "admin-1",
      sessionId: "session-a",
      message: "Birinchi savol",
    });

    await service.sendMessage({
      adminId: "admin-1",
      sessionId: "session-a",
      message: "Ikkinchi savol",
    });

    expect(telegramService.generateAiReplyFromConversation).toHaveBeenNthCalledWith(
      2,
      [
        { role: "user", content: "Birinchi savol" },
        { role: "assistant", content: "Birinchi javob" },
        { role: "user", content: "Ikkinchi savol" },
      ],
    );
  });

  it("resets session context for a new session", async () => {
    const telegramService: any = {
      generateAiReplyFromConversation: jest
        .fn()
        .mockResolvedValueOnce("Birinchi javob")
        .mockResolvedValueOnce("Yangi sessiya javobi"),
    };
    const service = new AdminTestChatService(telegramService);

    await service.sendMessage({
      adminId: "admin-1",
      sessionId: "session-a",
      message: "Birinchi xabar",
    });

    service.resetSession({
      adminId: "admin-1",
      sessionId: "session-a",
    });

    await service.sendMessage({
      adminId: "admin-1",
      sessionId: "session-a",
      message: "Yangi sessiya xabari",
    });

    expect(telegramService.generateAiReplyFromConversation).toHaveBeenNthCalledWith(
      2,
      [{ role: "user", content: "Yangi sessiya xabari" }],
    );
  });
});
