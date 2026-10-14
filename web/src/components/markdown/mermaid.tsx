import { useEffect, useState } from 'react';
import { useDarkMode } from '@/lib/dark-mode';

type Rendered = { svg: string } | { error: string } | null;

// mermaid.render(id) 先删去页面中 id 相同的元素：每次渲染用新的 id，已经显示的图不会被删去
let renders = 0;

// mermaid 代码块渲染成图。mermaid 很大，用到时才加载；securityLevel strict 时图中的文字不作为 HTML 解释、点击事件不可用。
// 语法有错时显示 mermaid 的原文与代码
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
        if (current) setRendered({ svg });
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
  return (
    <div
      className="md-mermaid"
      data-testid="mermaid"
      data-rendered={rendered !== null}
      dangerouslySetInnerHTML={{ __html: rendered?.svg ?? '' }}
    />
  );
}
