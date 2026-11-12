import { useEffect, useState } from 'react';
import { useDarkMode } from '@/lib/dark-mode';

type Rendered = { svg: string; dark: boolean } | { error: string } | null;

// mermaid.render(id) first removes any element with the same id: each render uses a new id so diagrams already shown are not removed
let renders = 0;

// Renders a mermaid code block as a diagram. mermaid is large and loads on first use; with securityLevel strict, diagram text is not
// treated as HTML and click events are off. On a syntax error, shows mermaid's message and the code
export function MermaidDiagram({ code }: { code: string }) {
  const dark = useDarkMode();
  const [rendered, setRendered] = useState<Rendered>(null);
  useEffect(() => {
    let current = true;
    renders += 1;
    const id = `mermaid-${String(renders)}`;
    const render = async () => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: dark ? 'dark' : 'default',
      });
      return mermaid.render(id, code);
    };
    void render().then(
      ({ svg }) => {
        if (current) setRendered({ svg, dark });
      },
      (error: unknown) => {
        if (current) setRendered({ error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [code, dark]);

  if (rendered !== null && 'error' in rendered) {
    return (
      <div data-testid="mermaid-error">
        <p className="md-mermaid-error">{rendered.error}</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  // data-theme: the theme the shown diagram was rendered in (it keeps the old theme until the re-render after a theme change finishes)
  return (
    <div
      className="md-mermaid"
      data-testid="mermaid"
      data-rendered={rendered !== null}
      data-theme={rendered === null ? undefined : rendered.dark ? 'dark' : 'light'}
      dangerouslySetInnerHTML={{ __html: rendered?.svg ?? '' }}
    />
  );
}
