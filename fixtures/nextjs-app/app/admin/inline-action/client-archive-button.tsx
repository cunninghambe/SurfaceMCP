'use client';

export default function ClientArchiveButton({
  onArchive,
}: {
  onArchive: (id: string) => Promise<void>;
}) {
  return <button type="button" onClick={() => onArchive('demo')}>Archive</button>;
}
