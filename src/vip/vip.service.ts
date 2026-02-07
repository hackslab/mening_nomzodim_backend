import { Inject, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DRIZZLE } from "../database/database.module";
import * as schema from "../database/schema";
import { vipSubscriptions } from "../database/schema";
import { eq } from "drizzle-orm";
import { nowInUzbekistan } from "../common/time";
import { TelegramService } from "../telegram/telegram.service";

@Injectable()
export class VipService {
  private readonly logger = new Logger(VipService.name);

  constructor(
    private readonly telegramService: TelegramService,
    @Inject(DRIZZLE) private db: NodePgDatabase<typeof schema>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleVipCron() {
    const now = nowInUzbekistan();
    const subscriptions = await this.db
      .select()
      .from(vipSubscriptions)
      .where(eq(vipSubscriptions.status, "active"));

    for (const subscription of subscriptions) {
      if (subscription.expiresAt <= now) {
        await this.telegramService.removeUserFromVipChannel(subscription.userId);
        await this.db
          .update(vipSubscriptions)
          .set({ status: "expired", updatedAt: now })
          .where(eq(vipSubscriptions.id, subscription.id));
        await this.telegramService.sendAdminResponse(
          subscription.userId,
          "VIP obuna muddati tugadi.",
        );
        continue;
      }

      const msLeft = subscription.expiresAt.getTime() - now.getTime();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      if (!subscription.reminderSentAt && msLeft <= threeDaysMs) {
        await this.telegramService.sendAdminResponse(
          subscription.userId,
          "VIP obuna tugashiga 3 kun qoldi. Uzaytiramizmi?",
        );
        await this.db
          .update(vipSubscriptions)
          .set({ reminderSentAt: now, updatedAt: now })
          .where(eq(vipSubscriptions.id, subscription.id));
      }
    }
  }
}
