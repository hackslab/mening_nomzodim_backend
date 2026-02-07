import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { UZBEKISTAN_TIMEZONE } from "./common/time";

async function bootstrap() {
  process.env.TZ = UZBEKISTAN_TIMEZONE;
  const PORT = process.env.PORT ?? 3000;
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: "*",
  });
  await app.listen(PORT, () => {
    console.log(`Application is running on: http://localhost:${PORT}`);
    // Server started
  });
}
bootstrap();
