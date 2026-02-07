import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { UserProfilesService } from "./user-profiles.service";
import { UserProfilesController } from "./user-profiles.controller";

@Module({
  imports: [ConfigModule],
  providers: [UserProfilesService],
  controllers: [UserProfilesController],
  exports: [UserProfilesService],
})
export class UserProfilesModule {}
