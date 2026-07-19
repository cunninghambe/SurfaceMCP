import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

// String enum — exercises `@IsEnum` + enum-typed property introspection.
export enum OrderStatus {
  Pending = 'pending',
  Shipped = 'shipped',
  Delivered = 'delivered',
}

// Nested DTO — inlined recursively into the parent schema.
export class AddressDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  street: string;

  @IsString()
  city: string;

  @IsOptional()
  @IsString()
  zip?: string;
}

// Nested DTO used as the element type of an array property.
export class OrderLineDto {
  @IsString()
  sku: string;

  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}

// Rich body DTO for POST /orders — exercises arrays (primitive + nested DTO),
// a nested DTO-typed property, an enum, and numeric/length constraints.
export class CreateOrderDto {
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  reference: string;

  @IsEnum(OrderStatus)
  status: OrderStatus;

  @IsArray()
  @IsString({ each: true })
  tags: string[];

  @ValidateNested({ each: true })
  lines: OrderLineDto[];

  @ValidateNested()
  shippingAddress: AddressDto;

  @IsNumber()
  @IsPositive()
  total: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  discountPercent?: number;
}
