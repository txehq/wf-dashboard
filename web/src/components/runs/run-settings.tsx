import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { saveSettings, type Settings, settingsQuery } from '@/lib/runs-api';

const numberFields = [
  { key: 'runConcurrency', label: '同时运行数', min: 1, max: 32 },
  { key: 'maxUserTurns', label: '模拟用户最多回答次数', min: 1, max: 1000 },
  { key: 'defaultRepeats', label: '默认重复次数', min: 1, max: 50 },
] as const;

const modelFields = [
  { key: 'simulatedUser', label: '模拟用户' },
  { key: 'judge', label: '评分（judge）' },
] as const;

// 每行一个标签，空行忽略
const parseLabels = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

function SettingsForm({ initial }: { initial: Settings }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Settings>(initial);
  const [labelsText, setLabelsText] = useState(initial.copyRunnerLabels.join('\n'));
  const save = useMutation({
    mutationFn: saveSettings,
    onSuccess: (saved) => {
      client.setQueryData(settingsQuery.queryKey, saved);
      setDraft(saved);
      setLabelsText(saved.copyRunnerLabels.join('\n'));
    },
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  return (
    <form
      className="flex flex-col gap-4"
      data-testid="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(draft);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {numberFields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            {f.label}
            <Input
              type="number"
              min={f.min}
              max={f.max}
              required
              value={draft[f.key]}
              onChange={(event) => {
                setDraft({ ...draft, [f.key]: Number(event.target.value) });
              }}
            />
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {modelFields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            {f.label}的模型
            <Input
              required
              className="font-mono"
              value={draft.models[f.key]}
              onChange={(event) => {
                setDraft({ ...draft, models: { ...draft.models, [f.key]: event.target.value } });
              }}
            />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        副本仓库可用的自托管 runner 标签（每行一个）
        <Textarea
          aria-label="副本仓库可用的自托管 runner 标签"
          className="min-h-16 font-mono field-sizing-fixed"
          rows={3}
          value={labelsText}
          onChange={(event) => {
            setLabelsText(event.target.value);
            setDraft({ ...draft, copyRunnerLabels: parseLabels(event.target.value) });
          }}
        />
        <span className="text-xs text-muted-foreground">
          runs-on 中的标签都是 GitHub 托管 runner、self-hosted 或这里列出的标签时，job 计入导入 task
          的必需检查默认值。
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
          {save.isPending ? '保存中…' : '保存设置'}
        </Button>
        <span className="text-xs text-muted-foreground">
          保存后立即生效；同时运行数调小时，正在进行的 run 不会中断。
        </span>
      </div>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          保存失败：{save.error.message}
        </p>
      )}
    </form>
  );
}

export function RunSettings() {
  const settings = useQuery(settingsQuery);
  return (
    <details className="rounded-lg border px-4 py-3" data-testid="run-settings">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Settings2 className="size-4" aria-hidden />
        设置
        {settings.data !== undefined && (
          <span className="font-normal text-muted-foreground">
            同时 {settings.data.runConcurrency} 个 · 模拟用户 {settings.data.models.simulatedUser} ·
            评分 {settings.data.models.judge}
          </span>
        )}
      </summary>
      <div className="pt-4">
        {settings.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
        {settings.isError && <p className="text-sm text-destructive">{settings.error.message}</p>}
        {settings.data !== undefined && (
          <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} />
        )}
      </div>
    </details>
  );
}
