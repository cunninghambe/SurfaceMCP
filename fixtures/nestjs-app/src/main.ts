import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// Nest bootstrap. Note `app.listen(...)` — NOT `app.get/post` — so the Express
// detector's route heuristic cannot false-positive on this entry file.
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

void bootstrap();
