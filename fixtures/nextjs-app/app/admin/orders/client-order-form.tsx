'use client';

type Props = { action: (data: { productId: string; qty: number }) => Promise<void> };

export function ClientOrderForm({ action }: Props) {
  return (
    <button onClick={() => action({ productId: 'p1', qty: 1 })}>Order</button>
  );
}
