import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AdminTestChatService } from "./admin-test-chat.service";

@Controller("admin/test-chat")
export class AdminTestChatController {
  constructor(
    private readonly adminTestChatService: AdminTestChatService,
    private readonly configService: ConfigService,
  ) {}

  @Post("message")
  async sendMessage(
    @Body("sessionId") sessionId: string,
    @Body("message") message: string,
    @Headers("x-admin-key") adminKey?: string,
    @Headers("x-admin-id") adminId?: string,
  ) {
    this.requireAdmin(adminKey);
    return this.adminTestChatService.sendMessage({
      sessionId,
      message,
      adminId: this.resolveAdminId(adminId),
    });
  }

  @Post("reset")
  resetSession(
    @Body("sessionId") sessionId: string,
    @Headers("x-admin-key") adminKey?: string,
    @Headers("x-admin-id") adminId?: string,
  ) {
    this.requireAdmin(adminKey);
    return this.adminTestChatService.resetSession({
      sessionId,
      adminId: this.resolveAdminId(adminId),
    });
  }

  private requireAdmin(adminKey?: string) {
    const expected = this.configService.get<string>("ADMIN_API_KEY");
    if (expected && adminKey !== expected) {
      throw new UnauthorizedException("Invalid admin key");
    }
  }

  private resolveAdminId(adminId?: string) {
    const normalized = adminId?.trim();
    return normalized || "admin";
  }
}
