import { useState } from 'react';

type Range = 'a' | 'b' | 'c';

export function App() {
  const [r, setR] = useState<Range>('a');
  return (
    <div>
      <button onClick={() => setR('a')}>Save</button>
      <button onClick={() => setR('b')}>Save</button>
      <button data-testid="save-c" onClick={() => setR('c')}>Save</button>
    </div>
  );
}
