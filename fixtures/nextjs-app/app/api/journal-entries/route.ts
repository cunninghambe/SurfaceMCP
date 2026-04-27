import { NextRequest, NextResponse } from 'next/server';

// Manual validation — no Zod schema
export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.memo) throw new Error('memo is required');
  if (typeof body.amount !== 'number') return NextResponse.json({ error: 'amount must be a number' }, { status: 400 });
  return NextResponse.json({ ok: true }, { status: 201 });
}
