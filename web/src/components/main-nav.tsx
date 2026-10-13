import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { type NavGroup, type NavItem, navEntries, pageTitles } from '@/app/nav-items';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const isGroup = (entry: NavItem | NavGroup): entry is NavGroup => 'items' in entry;

// 路径属于某个路径前缀：它本身或它下面的详情页
const under = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);
// 路径属于某个菜单项：它的 to 或 also 中的前缀
const within = (pathname: string, item: NavItem) =>
  [item.to, ...(item.also ?? [])].some((prefix) => under(pathname, prefix));

// 浏览器标签页标题：当前菜单项的名称，pageTitles 中的页面用自己的标题
const APP_TITLE = 'Magi Workflow Dashboard';
function pageTitle(pathname: string): string {
  const own = pageTitles[pathname];
  if (own !== undefined) return own;
  const item = navEntries
    .flatMap((e) => (isGroup(e) ? e.items : [e]))
    .find((i) => within(pathname, i));
  return item?.label ?? APP_TITLE;
}

// 分组的展开状态存在 localStorage，默认展开；当前页面所在的分组总是展开
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
        // 按钮的 has-[>svg]:px-3 优先于普通的 pl-*，子项的缩进用同样的选择器
        nested && 'has-[>svg]:pl-8',
      )}
    >
      {/* 高亮按菜单项自己的路径与 also 中的前缀判断（NavLink 只认 to） */}
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
    <nav aria-label="主导航" className="flex flex-col gap-1 px-2">
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
              // 当前页面在这个分组中时不能收起
              title={containsCurrent ? '当前页面在这个分组中' : undefined}
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
