import { UnauthorizedException } from "@nestjs/common";
import { AdminTestChatController } from "./admin-test-chat.controller";

describe("AdminTestChatController", () => {
  it("rejects invalid admin key", async () => {
    const service: any = {
      sendMessage: jest.fn(),
      resetSession: jest.fn(),
    };
    const configService: any = {
      get: jest.fn().mockReturnValue("secret-key"),
    };

    const controller = new AdminTestChatController(service, configService);

    await expect(
      controller.sendMessage("session-1", "hello", "wrong-key", "admin-1"),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("accepts valid admin key and forwards payload", async () => {
    const service: any = {
      sendMessage: jest.fn().mockResolvedValue({ ok: true }),
      resetSession: jest.fn(),
    };
    const configService: any = {
      get: jest.fn().mockReturnValue("secret-key"),
    };

    const controller = new AdminTestChatController(service, configService);

    await controller.sendMessage("session-1", "hello", "secret-key", "admin-1");

    expect(service.sendMessage).toHaveBeenCalledWith({
      sessionId: "session-1",
      message: "hello",
      adminId: "admin-1",
    });
  });
});
