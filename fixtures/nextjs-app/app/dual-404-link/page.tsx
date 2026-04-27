export default function Dual404LinkPage() {
  return (
    <main>
      <h1>Dual 404 Source</h1>
      {/* BugHunter UI walker may follow this; the GET-as-link returns 404 (POST-only route). */}
      <a href="/api/conditional-404">Conditional 404</a>
    </main>
  );
}
