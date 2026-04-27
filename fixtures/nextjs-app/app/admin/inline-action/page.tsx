import ClientArchiveButton from './client-archive-button';

export default function InlineActionPage() {
  async function archiveOrder(id: string) {
    'use server';
    console.log('archive', id);
  }
  return <ClientArchiveButton onArchive={archiveOrder} />;
}
