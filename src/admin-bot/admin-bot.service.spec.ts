import { AdminBotService } from "./admin-bot.service";

describe("AdminBotService", () => {
  it("ignores duplicate payment decision updates", async () => {
    const task = {
      id: 123,
      status: "posted",
      userId: "111",
      payload: JSON.stringify({ orderId: 55, orderType: "ad" }),
    };

    const db: any = {
      select: jest.fn(() => ({
        from: jest.fn(() => ({
          where: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue([task]),
          })),
        })),
      })),
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({
            returning: jest.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };

    const configService: any = { get: jest.fn() };
    const telegramService: any = {
      fulfillContactOrder: jest.fn(),
      activateVipOrder: jest.fn(),
      handleAdPaymentApproved: jest.fn(),
      logAdminAction: jest.fn(),
      sendAdminResponse: jest.fn(),
    };

    const service = new AdminBotService(configService, telegramService, db);
    const event: any = { answer: jest.fn(), senderId: "42" };

    await (service as any).handlePaymentCallback(event, ["", "approve", "123"]);

    expect(event.answer).toHaveBeenCalledWith({ message: "Allaqachon ishlangan." });
    expect(telegramService.handleAdPaymentApproved).not.toHaveBeenCalled();
  });
});
