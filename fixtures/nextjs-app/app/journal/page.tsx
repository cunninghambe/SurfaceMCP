'use client';
import { useState } from 'react';

export default function JournalPage() {
  const [status, setStatus] = useState('');
  async function addEntry() {
    const res = await fetch('/api/journal-entries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memo: 'test', amount: 10 }),
    });
    setStatus(res.ok ? 'ok' : 'error');
  }
  return (
    <main>
      <h1>Journal</h1>
      <button type="button" onClick={addEntry}>Add Entry</button>
      <p>{status}</p>
    </main>
  );
}
