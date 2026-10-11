import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { formatDateTime } from '@/lib/format';
import {
  analysesQuery,
  costText,
  engineLabel,
  statusLabel,
  useAnalysisEvents,
} from '@/lib/analyses-api';

// Contracts 15.3：分析列表
export function AnalysesPage() {
  useAnalysisEvents();
  const list = useQuery(analysesQuery);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">分析</h1>
        <p className="text-sm text-muted-foreground">
          用 Claude Code 或 Codex 分析 session，按发现修改 skill，另存为新的 variant。在 Sessions
          中选择 session，或在 Runs 的 batch 上开始分析。
        </p>
      </header>
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">正在加载…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          加载分析失败：{list.error.message}
        </p>
      ) : list.data.length === 0 ? (
        <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          还没有分析。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 pl-3 font-medium">分析</th>
                <th className="py-2 pr-4 font-medium">范围</th>
                <th className="py-2 pr-4 font-medium">variant</th>
                <th className="py-2 pr-4 font-medium">引擎</th>
                <th className="py-2 pr-4 font-medium">状态</th>
                <th className="py-2 pr-3 text-right font-medium">花费</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id} className="border-b last:border-0" data-testid="analysis-row">
                  <td className="py-2 pr-4 pl-3">
                    <Link className="font-mono font-medium underline" to={`/analyses/${a.id}`}>
                      {a.id}
                    </Link>
                    <p className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</p>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {a.sessionIds.length === 1
                      ? (a.sessionIds[0] ?? '').slice(0, 8)
                      : `${String(a.sessionIds.length)} 个 session`}
                  </td>
                  <td className="py-2 pr-4">{a.variantName}</td>
                  <td className="py-2 pr-4">
                    {engineLabel[a.engine]}
                    <p className="font-mono text-xs text-muted-foreground">{a.model}</p>
                  </td>
                  <td className="py-2 pr-4">{statusLabel[a.status]}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{costText(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
