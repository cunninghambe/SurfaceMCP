import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ posts: [] });
}

export async function POST() {
  return NextResponse.json({ post: {} }, { status: 201 });
}
