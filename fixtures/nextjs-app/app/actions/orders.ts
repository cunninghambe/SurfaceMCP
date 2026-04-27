'use server';

export async function createOrder(data: { productId: string; qty: number }) {
  console.log('createOrder', data);
}
