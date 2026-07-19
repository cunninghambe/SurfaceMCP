import { IsOptional, IsString, ValidateNested } from 'class-validator';

// Directly self-referential DTO — exercises the cycle guard for both a nested
// self-reference (`parent`) and an array self-reference (`children`). Both must
// terminate, degrading the recursive slot to an open `{ type: 'object' }`.
export class CategoryNodeDto {
  @IsString()
  name: string;

  @IsOptional()
  @ValidateNested()
  parent?: CategoryNodeDto;

  @IsOptional()
  @ValidateNested({ each: true })
  children?: CategoryNodeDto[];
}
