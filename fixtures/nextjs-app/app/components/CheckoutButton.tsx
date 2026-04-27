'use client';
import Stripe from 'stripe';

// This import is unusual (client-side stripe is typically loaded differently),
// but serves as a test fixture for the 'use client' skip rule.
export default function CheckoutButton() {
  return <button type="button">Checkout</button>;
}
