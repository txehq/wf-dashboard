import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { InlineRename } from '@/components/inline-rename';
import { request, type Variant } from '@/pages/variants-api';

// variant 的名字（Contracts 16.4）：直接改名，与交互项相同（14.3）。各处都按 id 取名字：
// 改名后刷新这个页面的全部查询；其他已打开的页面经 variant.updated 刷新
export function VariantName({
  variant,
  className,
  link,
}: {
  variant: Pick<Variant, 'id' | 'name'>;
  className?: string;
  // 名字是链接时（Workflows 列表）：单击打开 variant，铅笔图标改名
  link?: (name: string) => ReactNode;
}) {
  const client = useQueryClient();
  return (
    <InlineRename
      value={variant.name}
      label="variant 的名字"
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
