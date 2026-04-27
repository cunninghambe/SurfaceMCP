import Stripe from 'stripe';
import { NextRequest, NextResponse } from 'next/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body.amount) throw new Error('amount required');
  const intent = await stripe.paymentIntents.create({ amount: body.amount, currency: 'usd' });
  return NextResponse.json({ clientSecret: intent.client_secret }, { status: 201 });
}
