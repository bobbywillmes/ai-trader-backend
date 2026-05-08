export function PlaceholderPage({ title }: { title: string }) {
  return (
    <section>
      <div className="page-header">
        <h1>{title}</h1>
        <p className="muted">This page is coming soon.</p>
      </div>
    </section>
  );
}
