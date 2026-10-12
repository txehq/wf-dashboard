import { useState } from 'react';
import { Link } from 'react-router';
import { SessionBrowser } from '@/components/sessions/session-browser';
import { SourcePicker } from '@/components/sessions/source-picker';
import { Button } from '@/components/ui/button';
import { useSessionEvents } from '@/lib/sessions-api';

function SessionList() {
  // 多选的 session：一起分析（必须绑定同一个 variant，由分析表单检查）
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  return (
    <SessionBrowser
      mode="page"
      selected={selected}
      isSelectable={() => true}
      onToggle={(id) => {
        const next = new Set(selected);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        setSelected(next);
      }}
      actions={
        selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">已选 {selected.size} 个</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(new Set());
              }}
            >
              清除
            </Button>
            <Button asChild size="sm">
              <Link to={`/analyses/new?sessions=${[...selected].join(',')}`}>分析这些 session</Link>
            </Button>
          </div>
        )
      }
    />
  );
}

export function SessionsPage() {
  useSessionEvents();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Sessions</h1>
        <p className="text-sm text-muted-foreground">Claude Code session 的阶段图与请求明细。</p>
      </header>
      <SourcePicker />
      <SessionList />
    </div>
  );
}
