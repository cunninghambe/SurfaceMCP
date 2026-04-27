import React, { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { AdminLayout } from './pages/AdminLayout';
import { AdminUsers } from './pages/AdminUsers';
import { AdminSettings } from './pages/AdminSettings';
import { UserDetail } from './pages/UserDetail';

// Pattern P4 — React.lazy with named-export .then shape
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })));

export function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <Routes>
        {/* Pattern P1 — simple route */}
        <Route path="/" element={<Home />} />
        {/* Pattern P4 — lazy route */}
        <Route path="/about" element={<About />} />
        {/* Pattern P2 — nested routes */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route path="users" element={<AdminUsers />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>
        {/* Dynamic param route */}
        <Route path="/users/:id" element={<UserDetail />} />
      </Routes>
    </Suspense>
  );
}
