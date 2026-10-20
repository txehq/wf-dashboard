import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EngineChoice } from '@/components/engine-choice';
import { ImportColumns } from '@/components/sessions/import-columns';
import { SessionActionButtons } from '@/components/sessions/session-actions';
import { SessionManager } from '@/components/sessions/session-manager';
import { Button } from '@/components/ui/button';
import { rememberPicked } from '@/lib/analyses-api';
import { applyLabel, type ImportChanges, splitChanges, withoutApplied } from '@/lib/import-changes';
import { useSessionEngine } from '@/lib/session-view';
import {
  importSessions,
  runSessionAction,
  type SessionEngine,
  useSessionEvents,
} from '@/lib/sessions-api';

const SESSION_ORDER = ['claude', 'codex'] as const;

// 上面：导入与清除（Contracts 25.1）。三列中勾选的在下面的管理表格中；改动先暂存，"应用"时先导入再清除，不需要确认（清除不动磁盘）。
// 任一步失败时以原文显示，已完成的部分保留，暂存中只留下没完成的
function ImportPanel({ engine }: { engine: SessionEngine }) {
  const client = useQueryClient();
  const [changes, setChanges] = useState<ImportChanges>(new Map());
  const [changesFor, setChangesFor] = useState(engine);
  if (changesFor !== engine) {
    setChangesFor(engine);
    setChanges(new Map());
  }
  const { imports, clears } = splitChanges(changes);
  const applying = useMutation({
    mutationFn: async () => {
      if (imports.length > 0) {
        await importSessions(
          engine,
          imports.map((s) => s.file),
        );
        setChanges((prev) => withoutApplied(prev, imports));
      }
      if (clears.length > 0) {
        await runSessionAction(
          'clear',
          clears.map((s) => s.id),
        );
        setChanges((prev) => withoutApplied(prev, clears));
      }
      return { imported: imports.length, cleared: clears.length };
    },
    onSettled: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['session-import', engine] }),
        client.invalidateQueries({ queryKey: ['sessions'] }),
      ]);
    },
  });
  return (
    <section aria-label="导入" className="flex flex-col gap-2" data-testid="import-panel">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold">导入</h2>
        <p className="text-xs text-muted-foreground">
          勾选的 session 在下面的表格中：勾选导入，取消勾选清除，改好后点应用。
        </p>
        <div className="ml-auto flex items-center gap-3">
          {applying.isError && (
            <p role="alert" className="text-xs whitespace-pre-wrap text-destructive">
              应用失败：{applying.error.message}
            </p>
          )}
          {applying.isSuccess && changes.size === 0 && (
            <p className="text-xs text-muted-foreground" data-testid="import-result">
              {[
                ...(applying.data.imported > 0
                  ? [`已导入 ${String(applying.data.imported)} 个`]
                  : []),
                ...(applying.data.cleared > 0
                  ? [`已清除 ${String(applying.data.cleared)} 个`]
                  : []),
              ].join('，')}
            </p>
          )}
          {changes.size > 0 && (
            <Button
              variant="ghost"
              size="sm"
              data-testid="import-undo"
              disabled={applying.isPending}
              onClick={() => {
                setChanges(new Map());
              }}
            >
              <Undo2 />
              撤销改动
            </Button>
          )}
          <Button
            size="sm"
            data-testid="import-apply"
            disabled={changes.size === 0 || applying.isPending}
            onClick={() => {
              applying.mutate();
            }}
          >
            <Check />
            {applying.isPending ? '正在应用…' : applyLabel(imports.length, clears.length)}
          </Button>
        </div>
      </div>
      <ImportColumns engine={engine} mode="manage" changes={changes} onChanges={setChanges} />
    </section>
  );
}

// 下面：管理表格。选中的 session：清除、删除、归档与恢复，一起分析（本机配置的或绑定同一个 variant 的，由分析表单检查）。
// 分析的 id 放进本标签页的 sessionStorage，地址只带一个键（Contracts 25.5）
function SessionList({ engine }: { engine: SessionEngine }) {
  const navigate = useNavigate();
  return (
    <SessionManager
      engine={engine}
      actions={(targets, done) => (
        <>
          <SessionActionButtons targets={[...targets]} onDone={done} />
          <Button
            size="sm"
            onClick={() => {
              void navigate(`/analyses/new?picked=${rememberPicked(targets.map((t) => t.id))}`);
            }}
          >
            分析这些 session
          </Button>
        </>
      )}
    />
  );
}

export function SessionsPage() {
  useSessionEvents();
  const [engine, setEngine] = useSessionEngine();
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <p className="text-sm text-muted-foreground">
            上面从磁盘导入 session，下面查看、分析与管理导入的 session。
          </p>
        </div>
        <EngineChoice value={engine} onChange={setEngine} order={SESSION_ORDER} label="视图" />
      </header>
      <ImportPanel engine={engine} />
      <SessionList engine={engine} />
    </div>
  );
}
