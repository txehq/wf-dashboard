import type { ReactNode } from 'react';

// A titled block of the Team page, the same in the Linear and txe PRs views (Contracts 37.6): the title row carries
// the block's controls, a pager pushed right with ml-auto
export function Section({
  title,
  action,
  children,
  testId,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
