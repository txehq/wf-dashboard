import { useQuery } from '@tanstack/react-query';
import { workflowsQuery } from '@/lib/workflows-api';
import { type Variant, variantLabel } from '@/pages/variants-api';

// Value of "Local config" in the select
export const LOCAL_CONFIG = 'local';

// Config of an interaction (Contracts 14.5, 29.2): local config, or a successfully built variant
// (name (workflow), grouped by workflow). Shared by the new interaction form and the resume dialog
export function ConfigSelect({
  value,
  onChange,
  variants,
  testId,
  localLabel = 'Local config (~/.claude)',
}: {
  // LOCAL_CONFIG or a variant id
  value: string;
  onChange: (value: string) => void;
  // Successfully built variants
  variants: Variant[];
  testId: string;
  // Text of LOCAL_CONFIG: "<label> config" on an SSH host (Contracts 31.3)
  localLabel?: string;
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
        <option value={LOCAL_CONFIG}>{localLabel}</option>
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
          Couldn't load workflows: {workflows.error.message}
        </span>
      )}
    </>
  );
}
