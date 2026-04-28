import { useState } from 'react';
import { Navbar } from './components/Navbar';
import { Dashboard } from './pages/Dashboard';
import { Trades } from './pages/Trades';
import { Settings } from './pages/Settings';
import { Profile } from './pages/Profile';

type Tab = 'dashboard' | 'trades' | 'settings' | 'profile';

export function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  return (
    <div>
      <Navbar tab={tab} setTab={setTab} />
      {tab === 'dashboard' && <Dashboard />}
      {tab === 'trades' && <Trades />}
      {tab === 'settings' && <Settings />}
      {tab === 'profile' && <Profile />}
    </div>
  );
}
