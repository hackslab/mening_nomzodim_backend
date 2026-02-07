import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramModule } from './telegram/telegram.module';
import { DatabaseModule } from './database/database.module';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsModule } from './settings/settings.module';
import { ChatProcessorModule } from './chat-processor/chat-processor.module';
import { AdminBotModule } from './admin-bot/admin-bot.module';
import { VipModule } from './vip/vip.module';
import { UserProfilesModule } from './user-profiles/user-profiles.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    TelegramModule,
    AdminBotModule,
    VipModule,
    UserProfilesModule,
    SettingsModule,
    ChatProcessorModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
