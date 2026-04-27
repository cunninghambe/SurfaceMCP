import { NextRequest, NextResponse } from 'next/server';

// This route deliberately returns 404 when called without an `?ok=1` query param.
// It exists in the route table (so SurfaceMCP discovers it as a tool) but its
// happy-palette body produces a 404 response — exercising surface_call_failed
// AND its sibling 404_for_linked_route from the page that links to it.
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  if (url.searchParams.get('ok') !== '1') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
