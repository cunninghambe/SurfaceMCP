import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller.js';
import { HealthController } from './health.controller.js';
import { OrdersController } from './orders.controller.js';

@Module({
  controllers: [ItemsController, HealthController, OrdersController],
})
export class AppModule {}
