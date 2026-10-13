/** One topic of the privacy policy, folded: the picture summary above it is what most people need. */
export function Part({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <details className="legal-part" id={id}>
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}
