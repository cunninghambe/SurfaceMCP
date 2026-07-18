import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller.js';
import { HealthController } from './health.controller.js';

@Module({
  controllers: [ItemsController, HealthController],
})
export class AppModule {}
