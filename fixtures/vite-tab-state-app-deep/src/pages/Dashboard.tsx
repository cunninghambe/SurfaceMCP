import { useState } from 'react';

type Range = 'monthly' | 'hour';

export function Dashboard() {
  const [range, setRange] = useState<Range>('monthly');
  return (
    <div>
      <button onClick={() => setRange('monthly')}>monthly</button>
      <button onClick={() => setRange('hour')}>hour</button>
      {range === 'monthly' && <div>Monthly View</div>}
      {range === 'hour' && <div>Hourly View</div>}
    </div>
  );
}
