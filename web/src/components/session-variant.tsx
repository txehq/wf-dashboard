import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { sessionVariantsQuery } from '@/lib/drafts-api';

// Which variant the workflow-generating, variant-generating and optimizing sessions use (Contracts 33.2):
// one that built successfully in workflow-design or workflow-optimize, the baseline by default. Returns the
// chosen id (empty until the list loads) and the select placed next to the engine
export function useSessionVariant(kind: 'design' | 'optimize') {
  const query = useQuery(sessionVariantsQuery);
  const [chosen, setChosen] = useState('');
  const choice = query.data?.[kind];
  const variants = choice?.variants ?? [];
  const value =
    chosen !== '' && variants.some((v) => v.id === chosen) ? chosen : (choice?.defaultId ?? '');
  const workflowName = kind === 'design' ? 'Design workflow' : 'Optimize';
  const select = (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Session variant</span>
      <select
        className="h-9 max-w-64 rounded-md border bg-background px-2"
        data-testid="draft-session-variant"
        value={value}
        onChange={(event) => {
          setChosen(event.target.value);
        }}
      >
        {value === '' && <option value="">{query.isError ? 'Failed to load' : 'Loading…'}</option>}
        {variants.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name} ({workflowName})
          </option>
        ))}
      </select>
      {query.isError && (
        <span role="alert" className="text-destructive">
          {query.error.message}
        </span>
      )}
    </label>
  );
  return { variantId: value, select };
}
