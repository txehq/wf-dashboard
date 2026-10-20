import { useQuery } from '@tanstack/react-query';
import { workflowsQuery } from '@/lib/workflows-api';
import { type Variant, variantLabel } from '@/pages/variants-api';

// 选择框中"本机配置"的值
export const LOCAL_CONFIG = 'local';

// 交互的配置（Contracts 14.5、29.2）：本机配置，或构建成功的 variant（名字 (workflow)，按 workflow 分组）。
// 新建交互与 resume 对话框共用
export function ConfigSelect({
  value,
  onChange,
  variants,
  testId,
}: {
  // LOCAL_CONFIG 或 variant id
  value: string;
  onChange: (value: string) => void;
  // 构建成功的 variant
  variants: Variant[];
  testId: string;
}) {
  const workflows = useQuery(workflowsQuery);
  const groups = (workflows.data ?? []).flatMap((w) => {
    const own = variants.filter((v) => v.workflowId === w.id);
    return own.length === 0 ? [] : [{ workflow: w, variants: own }];
  });
  return (
    <>
      <select
        className="h-9 rounded-md border bg-background px-2"
        value={value}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value={LOCAL_CONFIG}>本机配置（~/.claude）</option>
        {groups.map((g) => (
          <optgroup key={g.workflow.id} label={g.workflow.name}>
            {g.variants.map((v) => (
              <option key={v.id} value={v.id}>
                {variantLabel(v)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {workflows.isError && (
        <span role="alert" className="text-destructive">
          读取 workflow 失败：{workflows.error.message}
        </span>
      )}
    </>
  );
}
