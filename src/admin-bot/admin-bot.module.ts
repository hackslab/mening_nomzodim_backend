import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AdminBotService } from "./admin-bot.service";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [ConfigModule, TelegramModule],
  providers: [AdminBotService],
  exports: [AdminBotService],
})
export class AdminBotModule {}
