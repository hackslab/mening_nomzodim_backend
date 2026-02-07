import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VipService } from "./vip.service";
import { TelegramModule } from "../telegram/telegram.module";

@Module({
  imports: [ConfigModule, TelegramModule],
  providers: [VipService],
  exports: [VipService],
})
export class VipModule {}
