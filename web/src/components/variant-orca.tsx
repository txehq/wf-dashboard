import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request, type Variant } from '@/pages/variants-api';

// "Include Orca skills" (Contracts 35.5): when on, the build puts Orca's bundled orchestration and
// orca-cli skills into the variant's install and records the Orca version; after Orca updates, a
// rebuild is prompted. Changing the switch requires a rebuild; frozen and imported variants cannot change it

const orcaVersionQuery = queryOptions({
  queryKey: ['variants', 'orca-version'],
  queryFn: () => request<{ version: string | null }>('GET', '/api/variants/orca-version'),
  staleTime: 60_000,
});

export function OrcaSkillsSwitch({ variant, locked }: { variant: Variant; locked: boolean }) {
  const client = useQueryClient();
  const current = useQuery(orcaVersionQuery);
  const toggle = useMutation({
    mutationFn: (on: boolean) =>
      request<Variant>('PATCH', `/api/variants/${variant.id}`, { orcaSkills: on }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['variants'] }),
  });
  const now = current.data?.version ?? null;
  // The Orca included at build time differs from the current one
  const stale = variant.orcaVersion !== null && now !== null && now !== variant.orcaVersion;
  return (
    <span className="inline-flex items-center gap-1.5" data-testid="variant-orca-skills">
      <label
        className="inline-flex items-center gap-1"
        title={
          locked
            ? "Frozen and imported variants can't be changed"
            : 'Requires a rebuild after changing'
        }
      >
        <input
          type="checkbox"
          checked={variant.orcaSkills}
          disabled={locked || toggle.isPending}
          data-testid="variant-orca-skills-toggle"
          onChange={(event) => {
            toggle.mutate(event.target.checked);
          }}
        />
        Include Orca skills
      </label>
      {variant.orcaVersion !== null && (
        <span className="font-mono text-xs" data-testid="variant-orca-version">
          Orca {variant.orcaVersion}
        </span>
      )}
      {stale && (
        <span className="text-xs text-warning-foreground" data-testid="variant-orca-stale">
          Orca updated to {now}; rebuild before starting
        </span>
      )}
      {toggle.error !== null && (
        <span role="alert" className="text-xs text-destructive">
          {toggle.error.message}
        </span>
      )}
    </span>
  );
}
