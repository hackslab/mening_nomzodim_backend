import { Body, Controller, Get, Patch } from "@nestjs/common";
import { SettingsService } from "./settings.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  async getSettings() {
    return this.settingsService.getSettings();
  }

  @Patch()
  async updateSettings(
    @Body("summaryBatchSize") summaryBatchSize?: number,
    @Body("summaryCronMinutes") summaryCronMinutes?: number,
  ) {
    return this.settingsService.updateSettings({
      summaryBatchSize,
      summaryCronMinutes,
    });
  }
}
