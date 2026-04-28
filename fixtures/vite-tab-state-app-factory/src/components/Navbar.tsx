type Props = { tab: string; setTab: (t: string) => void };

export function Navbar({ tab, setTab }: Props) {
  const item = (id: string, label: string) => (
    <button onClick={() => setTab(id)} aria-pressed={tab === id}>{label}</button>
  );
  return (
    <nav>
      {item('dashboard', 'Dashboard')}
      {item('trades', 'Trades')}
      {item('settings', 'Settings')}
      {item('profile', 'Profile')}
    </nav>
  );
}
