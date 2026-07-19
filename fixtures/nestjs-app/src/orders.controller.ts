import { Controller, Post, Patch, Body, Param } from '@nestjs/common';
import { CreateOrderDto, OrderStatus } from './dto/create-order.dto.js';
import { CategoryNodeDto } from './dto/category.dto.js';
import { NodeADto } from './dto/graph.dto.js';

@Controller('orders')
export class OrdersController {
  // POST /orders — rich @Body() DTO: primitive + nested-DTO arrays, a nested
  // DTO-typed property, an enum, and numeric/length constraints.
  @Post()
  create(@Body() dto: CreateOrderDto) {
    return { created: dto };
  }

  // PATCH /orders/:id/status — @Body('status') single-field pick (enum-typed).
  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body('status') status: OrderStatus) {
    return { id, status };
  }

  // POST /orders/categories — self-referential DTO (direct + array cycle).
  @Post('categories')
  addCategory(@Body() node: CategoryNodeDto) {
    return { node };
  }

  // POST /orders/graph — transitively cyclic DTOs (A -> B -> A).
  @Post('graph')
  addGraph(@Body() node: NodeADto) {
    return { node };
  }
}
