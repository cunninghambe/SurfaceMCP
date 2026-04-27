'use client';

import { useState } from 'react';

export default function DomTestPage() {
  const [toggled, setToggled] = useState(false);
  return (
    <main>
      <h1>DOM Test</h1>
      <button
        type="button"
        data-testid="toggle"
        onClick={() => {
          setToggled(t => !t);
          if (typeof document !== 'undefined') {
            document.body.dataset.toggled = toggled ? 'off' : 'on';
          }
        }}
      >
        Toggle
      </button>
      <div data-toggled={toggled ? 'on' : 'off'}>State: {toggled ? 'on' : 'off'}</div>
    </main>
  );
}
