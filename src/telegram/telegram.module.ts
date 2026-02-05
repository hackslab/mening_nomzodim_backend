import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { ConfigModule } from '@nestjs/config';
import { TelegramController } from './telegram.controller';

@Module({
  imports: [ConfigModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
