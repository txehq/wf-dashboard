import {
  Columns2,
  FlaskConical,
  History,
  ListChecks,
  type LucideIcon,
  Microscope,
  Play,
  SquareTerminal,
  WandSparkles,
  Workflow,
} from 'lucide-react';

// 左侧导航的全部项：顶层项与分组，按显示顺序。加一项、改顺序或分组只改这份数据
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  // 也属于这一项的其他路径前缀（这些页面打开时这一项高亮，标签页标题取这一项）
  also?: string[];
}

export interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

export const navEntries: (NavItem | NavGroup)[] = [
  { to: '/sessions', label: 'Sessions', icon: History },
  // 没有单独的 Variants 项（Contracts 16.7）：variant 页面 /variants/:id 属于 Workflows
  { to: '/workflows', label: 'Workflows', icon: Workflow, also: ['/variants'] },
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

// 浏览器标签页标题与菜单名不同的页面
export const pageTitles: Record<string, string> = { '/analyses/new': 'New analysis' };
