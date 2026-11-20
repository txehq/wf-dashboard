import {
  ChartColumn,
  Columns2,
  FlaskConical,
  History,
  ListChecks,
  type LucideIcon,
  Microscope,
  Network,
  Play,
  SquareTerminal,
  Users,
  WandSparkles,
  Workflow,
} from 'lucide-react';

// All entries of the left navigation, top-level items and groups, in display order. Adding, reordering or regrouping changes only this data
export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  // Other path prefixes that belong to this item (it is highlighted on those pages and gives the tab title)
  also?: string[];
}

export interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

export const navEntries: (NavItem | NavGroup)[] = [
  { to: '/sessions', label: 'Sessions', icon: History },
  // No separate Variants item (Contracts 16.7): the variant page /variants/:id belongs to Workflows
  { to: '/workflows', label: 'Workflows', icon: Workflow, also: ['/variants'] },
  { to: '/live', label: 'Live', icon: SquareTerminal },
  // The Orca topology page (Contracts 40.2)
  { to: '/orca', label: 'Orca', icon: Network },
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
  {
    label: 'Team',
    icon: Users,
    items: [{ to: '/team', label: 'Engineering stats', icon: ChartColumn }],
  },
];

// Pages whose browser tab title differs from the menu name
export const pageTitles: Record<string, string> = {
  '/analyses/new': 'New analysis',
  // Settings is not in the left menu; the gear at the top right opens it
  '/settings': 'Settings',
};
