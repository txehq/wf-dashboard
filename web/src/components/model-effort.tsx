import { useQuery } from '@tanstack/react-query';
import type { ModelEffort } from '@/lib/model-effort';
import { variantOptionsQuery } from '@/pages/variants-api';

export function ModelEffortChoice({
  value,
  onModel,
  onEffort,
  testIdPrefix,
}: {
  value: ModelEffort | null;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  testIdPrefix: string;
}) {
  const options = useQuery(variantOptionsQuery);
  return (
    <div className="flex flex-wrap gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">model</span>
        <select
          className="h-9 rounded-md border bg-background px-2"
          data-testid={`${testIdPrefix}-model`}
          value={value?.model ?? ''}
          disabled={value === null || options.data === undefined}
          onChange={(event) => {
            onModel(event.target.value);
          }}
        >
          {options.data?.models.map((m) => (
            <option key={m.alias} value={m.alias}>
              {m.alias}（{m.model}）
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">effort</span>
        <select
          className="h-9 rounded-md border bg-background px-2"
          data-testid={`${testIdPrefix}-effort`}
          value={value?.effort ?? ''}
          disabled={value === null || options.data === undefined}
          onChange={(event) => {
            onEffort(event.target.value);
          }}
        >
          {options.data?.efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </label>
      {options.isError && (
        <span role="alert" className="text-sm text-destructive">
          读取模型列表失败：{options.error.message}
        </span>
      )}
    </div>
  );
}
