import { useState } from 'react';

type Tab = 'overview' | 'orders' | 'inventory' | 'reports';

const TABS: Array<{ id: Tab; label: string; testId: string }> = [
  { id: 'overview', label: 'Overview', testId: 'tab-overview' },
  { id: 'orders', label: 'Orders', testId: 'tab-orders' },
  { id: 'inventory', label: 'Inventory', testId: 'tab-inventory' },
  { id: 'reports', label: 'Reports', testId: 'tab-reports' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div>
      <nav>
        {TABS.map(({ id, label, testId }) => (
          <button key={id} data-testid={testId} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      <div>active: {tab}</div>
    </div>
  );
}
