import { IsString, IsInt, IsBoolean, IsOptional } from 'class-validator';

// Body DTO for POST /items. Mix of required + optional fields with
// class-validator decorators so schema introspection is deterministic.
export class CreateItemDto {
  @IsString()
  name: string;

  @IsInt()
  price: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsBoolean()
  inStock?: boolean;
}

// Body DTO for PUT /items/:id. All fields optional (partial update).
export class UpdateItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsInt()
  price?: number;
}

// Query DTO for GET /items/search — exercises @Query() introspection.
export class SearchItemsQuery {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsInt()
  limit?: number;
}
