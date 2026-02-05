import {
  Controller,
  Post,
  Body,
  Get,
  UseInterceptors,
  ClassSerializerInterceptor,
} from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller('telegram')
@UseInterceptors(ClassSerializerInterceptor)
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Post('connect')
  async connect(@Body('phoneNumber') phoneNumber: string) {
    return this.telegramService.sendCode(phoneNumber);
  }

  @Post('verify')
  async verify(
    @Body('phoneNumber') phoneNumber: string,
    @Body('phoneCodeHash') phoneCodeHash: string,
    @Body('phoneCode') phoneCode: string,
  ) {
    const session = await this.telegramService.signIn(
      phoneNumber,
      phoneCodeHash,
      phoneCode,
    );
    return { session };
  }

  @Post('verify-password')
  async verifyPassword(@Body('password') password: string) {
    const session = await this.telegramService.signInWithPassword(password);
    return { session };
  }

  @Get('status')
  async status() {
    return this.telegramService.getStatus();
  }
}
