import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { InlineRename } from '@/components/inline-rename';
import { request, type Variant } from '@/pages/variants-api';

// A variant's name (Contracts 16.4): renamed inline, like interactions (14.3). Every place looks the name up by id:
// a rename refreshes all queries on this page; other open pages refresh through variant.updated
export function VariantName({
  variant,
  className,
  link,
}: {
  variant: Pick<Variant, 'id' | 'name'>;
  className?: string;
  // When the name is a link (Workflows list): a click opens the variant, the pencil renames
  link?: (name: string) => ReactNode;
}) {
  const client = useQueryClient();
  return (
    <InlineRename
      value={variant.name}
      label="Variant name"
      testId="variant-name"
      {...(className === undefined ? {} : { className })}
      {...(link === undefined ? {} : { link })}
      onSave={async (name) => {
        await request<Variant>('PATCH', `/api/variants/${variant.id}`, { name });
        await client.invalidateQueries();
      }}
    />
  );
}
