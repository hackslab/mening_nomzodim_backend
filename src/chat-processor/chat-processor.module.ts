import { Module } from "@nestjs/common";
import { ChatProcessorService } from "./chat-processor.service";
import { SettingsModule } from "../settings/settings.module";
import { ConfigModule } from "@nestjs/config";

@Module({
  imports: [SettingsModule, ConfigModule],
  providers: [ChatProcessorService],
})
export class ChatProcessorModule {}
