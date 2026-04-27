import { createOrder } from '../../actions/orders';
import { ClientOrderForm } from './client-order-form';

export default function AdminOrdersPage() {
  return <ClientOrderForm action={createOrder} />;
}
