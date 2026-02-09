import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { ConfigModule } from '@nestjs/config';
import { TelegramController } from './telegram.controller';
import { SettingsModule } from '../settings/settings.module';
import { UserProfilesModule } from '../user-profiles/user-profiles.module';

@Module({
  imports: [ConfigModule, SettingsModule, UserProfilesModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
