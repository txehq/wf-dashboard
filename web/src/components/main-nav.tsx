import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { type NavGroup, type NavItem, navEntries, pageTitles } from '@/app/nav-items';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const isGroup = (entry: NavItem | NavGroup): entry is NavGroup => 'items' in entry;

// A path is under a prefix: the prefix itself or a detail page below it
const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);
// A path belongs to a menu item: its to or a prefix in also
const within = (pathname: string, item: NavItem) =>
  [item.to, ...(item.also ?? [])].some((prefix) => under(pathname, prefix));

// Browser tab title: the current menu item's name; pages in pageTitles use their own title
const APP_TITLE = 'Magi Workflow Dashboard';
function pageTitle(pathname: string): string {
  const own = pageTitles[pathname];
  if (own !== undefined) return own;
  const item = navEntries
    .flatMap((e) => (isGroup(e) ? e.items : [e]))
    .find((i) => within(pathname, i));
  return item?.label ?? APP_TITLE;
}

// Group expansion is kept in localStorage, expanded by default; the group of the current page is always expanded
const STORAGE_KEY = 'wfd.nav.collapsed';

function readCollapsed(): string[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? [] : (JSON.parse(raw) as string[]);
}

function Item({ item, nested }: { item: NavItem; nested: boolean }) {
  const Icon = item.icon;
  const { pathname } = useLocation();
  return (
    <Button
      asChild
      variant="ghost"
      className={cn(
        'w-full justify-start aria-[current=page]:bg-background aria-[current=page]:font-semibold aria-[current=page]:shadow-xs',
        // The button's has-[>svg]:px-3 wins over a plain pl-*, so child indentation uses the same selector
        nested && 'has-[>svg]:pl-8',
      )}
    >
      {/* Highlight by the item's own path and the prefixes in also (NavLink only knows to) */}
      <Link to={item.to} aria-current={within(pathname, item) ? 'page' : undefined}>
        <Icon />
        {item.label}
      </Link>
    </Button>
  );
}

export function MainNav() {
  const { pathname } = useLocation();
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);

  useEffect(() => {
    const title = pageTitle(pathname);
    document.title = title === APP_TITLE ? APP_TITLE : `${title} · ${APP_TITLE}`;
  }, [pathname]);

  const toggle = (label: string) => {
    const next = collapsed.includes(label)
      ? collapsed.filter((l) => l !== label)
      : [...collapsed, label];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setCollapsed(next);
  };

  return (
    <nav aria-label="Main navigation" className="flex flex-col gap-1 px-2">
      {navEntries.map((entry) => {
        if (!isGroup(entry)) return <Item key={entry.to} item={entry} nested={false} />;
        const containsCurrent = entry.items.some((i) => within(pathname, i));
        const open = containsCurrent || !collapsed.includes(entry.label);
        const Icon = entry.icon;
        const listId = `nav-group-${entry.label.toLowerCase()}`;
        return (
          <div key={entry.label} className="flex flex-col gap-1" data-testid={listId}>
            <Button
              variant="ghost"
              className="w-full justify-start text-muted-foreground"
              aria-expanded={open}
              aria-controls={listId + '-items'}
              // Can't collapse while the current page is in this group
              title={containsCurrent ? 'The current page is in this group' : undefined}
              onClick={() => {
                if (!containsCurrent) toggle(entry.label);
              }}
            >
              <Icon />
              {entry.label}
              <ChevronRight
                className={cn('ml-auto transition-transform', open && 'rotate-90')}
                aria-hidden
              />
            </Button>
            <div id={listId + '-items'} hidden={!open} className="flex flex-col gap-1">
              {entry.items.map((item) => (
                <Item key={item.to} item={item} nested />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}
