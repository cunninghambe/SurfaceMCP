import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

const createUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(64),
  age: z.number().int().min(0).max(120).optional(),
});

export async function GET() {
  return NextResponse.json({ users: [] });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createUserSchema.parse(body);
  return NextResponse.json({ user: parsed }, { status: 201 });
}
