import { useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Settings } from './pages/Settings';

type Tab = 'dashboard' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div>
      <nav>
        <button onClick={() => setTab('dashboard')}>Dashboard</button>
        <button onClick={() => setTab('settings')}>Settings</button>
      </nav>
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}
