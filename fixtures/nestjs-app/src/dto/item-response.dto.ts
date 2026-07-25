// Response DTOs. Unlike the request DTOs these carry no class-validator
// decorators — response typing has only the TS types to work from, which is
// exactly the point of the fixture.

export class ItemResponseDto {
  id: string;

  name: string;

  price: number;

  category?: string;
}

// Nested response DTO: exercises recursion through the shared type walk on the
// output side (the wrapper's `item` property expands to ItemResponseDto).
export class ItemEnvelopeDto {
  item: ItemResponseDto;

  revision: number;
}
