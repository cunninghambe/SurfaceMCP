export default function InlineActionPage() {
  async function archiveOrder(id: string) {
    'use server';
    console.log('archive', id);
  }
  return <button onClick={() => archiveOrder('demo')}>Archive</button>;
}
