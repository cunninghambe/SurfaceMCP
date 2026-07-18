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
import { CreateItemDto, UpdateItemDto, SearchItemsQuery } from './dto/create-item.dto.js';

@Controller('items')
export class ItemsController {
  // GET /items
  @Get()
  findAll() {
    return [];
  }

  // GET /items/search — @Query() DTO introspection.
  @Get('search')
  search(@Query() query: SearchItemsQuery) {
    return { query };
  }

  // GET /items/:id — Express-style path param.
  @Get(':id')
  findOne(@Param('id') id: string) {
    return { id };
  }

  // POST /items — @Body() DTO introspection.
  @Post()
  create(@Body() dto: CreateItemDto) {
    return { created: dto };
  }

  // PUT /items/:id — @Body() DTO (all-optional) introspection.
  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateItemDto) {
    return { updated: id, dto };
  }

  // DELETE /items/:id — no body/query DTO, so schema is unknown.
  @Delete(':id')
  remove(@Param('id') id: string) {
    return { deleted: id };
  }
}
