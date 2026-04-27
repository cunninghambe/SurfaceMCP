import { Outlet } from 'react-router-dom';

export function AdminLayout() {
  return (
    <div>
      <h1>Admin</h1>
      <Outlet />
    </div>
  );
}
