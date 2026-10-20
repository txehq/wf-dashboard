export function PageShell({ title, description }: { title: string; description: string }) {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </section>
  );
}
