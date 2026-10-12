import {
  ChevronRight,
  Columns2,
  FlaskConical,
  GitBranch,
  History,
  ListChecks,
  type LucideIcon,
  Microscope,
  Play,
  SquareTerminal,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

const navEntries: (NavItem | NavGroup)[] = [
  { to: '/sessions', label: 'Sessions', icon: History },
  { to: '/variants', label: 'Variants', icon: GitBranch },
  { to: '/live', label: 'Live', icon: SquareTerminal },
  {
    label: 'Evaluate',
    icon: FlaskConical,
    items: [
      { to: '/tasks', label: 'Tasks', icon: ListChecks },
      { to: '/runs', label: 'Runs', icon: Play },
      { to: '/compare', label: 'Compare', icon: Columns2 },
    ],
  },
  {
    label: 'Optimize',
    icon: WandSparkles,
    items: [{ to: '/analyses', label: 'Analyses', icon: Microscope }],
  },
];

const isGroup = (entry: NavItem | NavGroup): entry is NavGroup => 'items' in entry;

// 路径属于某个菜单项：它本身或它下面的详情页
const within = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

// 浏览器标签页标题：当前菜单项的名称；新建分析页另有自己的标题
const APP_TITLE = 'Magi Workflow Dashboard';
function pageTitle(pathname: string): string {
  if (pathname === '/analyses/new') return 'New analysis';
  const item = navEntries
    .flatMap((e) => (isGroup(e) ? e.items : [e]))
    .find((i) => within(pathname, i.to));
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
      <NavLink to={item.to}>
        <Icon />
        {item.label}
      </NavLink>
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
        const containsCurrent = entry.items.some((i) => within(pathname, i.to));
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
