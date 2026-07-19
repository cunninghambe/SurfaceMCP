import { IsOptional, IsString, ValidateNested } from 'class-validator';

// Transitively cyclic DTOs (NodeA -> NodeB -> NodeA) — proves the cycle guard
// tracks the whole resolution path, not just direct self-reference.
export class NodeBDto {
  @IsString()
  label: string;

  @IsOptional()
  @ValidateNested()
  a?: NodeADto;
}

export class NodeADto {
  @IsString()
  id: string;

  @IsOptional()
  @ValidateNested()
  b?: NodeBDto;
}
