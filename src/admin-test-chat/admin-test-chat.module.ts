import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { TelegramModule } from "../telegram/telegram.module";
import { AdminTestChatController } from "./admin-test-chat.controller";
import { AdminTestChatService } from "./admin-test-chat.service";

@Module({
  imports: [ConfigModule, TelegramModule],
  controllers: [AdminTestChatController],
  providers: [AdminTestChatService],
})
export class AdminTestChatModule {}
