import { useState } from 'react';
import { Dashboard } from './pages/Dashboard';
import { Trades } from './pages/Trades';
import { Settings } from './pages/Settings';
import { Profile } from './pages/Profile';

type Tab = 'dashboard' | 'trades' | 'settings' | 'profile';

export function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div>
      <nav>
        <button onClick={() => setTab('dashboard')}>Dashboard</button>
        <button onClick={() => setTab('trades')}>Trades</button>
        <button data-testid="nav-settings" onClick={() => setTab('settings')}>Settings</button>
        <button aria-label="My profile" onClick={() => setTab('profile')}>Profile</button>
      </nav>
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'trades' && <Trades />}
      {tab === 'settings' && <Settings />}
      {tab === 'profile' && <Profile />}
    </div>
  );
}
