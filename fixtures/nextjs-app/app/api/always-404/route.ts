import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

// Zod-validated POST endpoint that always returns 404, regardless of body.
// Exists so SurfaceMCP labels it 'introspected' (driving BugHunter's plan
// to generate four palette tests against it). All four tests hit a 404,
// producing two distinct clusters that share a toolId — exercising the
// relatedClusterIds annotation in BugHunter's cluster phase.
const schema = z.object({
  payload: z.string().min(1).max(50),
  count: z.number().int().min(0).max(100),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  schema.parse(body);
  return NextResponse.json({ error: 'always 404 by design' }, { status: 404 });
}
