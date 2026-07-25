import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { CreateItemDto, UpdateItemDto, SearchItemsQuery } from './dto/create-item.dto.js';
import { ItemResponseDto, ItemEnvelopeDto } from './dto/item-response.dto.js';

@Controller('items')
export class ItemsController {
  // GET /items — array return type -> array outputSchema (inferred).
  @Get()
  findAll(): ItemResponseDto[] {
    return [];
  }

  // GET /items/search — @Query() DTO introspection; no return type, so no
  // outputSchema.
  @Get('search')
  search(@Query() query: SearchItemsQuery) {
    return { query };
  }

  // GET /items/:id — Express-style path param; Promise-wrapped return type
  // exercises the async unwrap + nested response DTO.
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<ItemEnvelopeDto> {
    return { item: { id, name: '', price: 0 }, revision: 1 };
  }

  // POST /items — @Body() DTO introspection. The Swagger decorator declares the
  // response, which outranks the (absent) return type -> introspected.
  @Post()
  @ApiResponse({ status: 201, type: ItemResponseDto })
  create(@Body() dto: CreateItemDto) {
    return { created: dto };
  }

  // PUT /items/:id — @Body() DTO (all-optional) introspection.
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateItemDto) {
    return { updated: id, dto };
  }

  // DELETE /items/:id — no body/query DTO and no return type, so the input
  // schema is unknown and no output schema is emitted.
  @Delete(':id')
  remove(@Param('id') id: string) {
    return { deleted: id };
  }
}
