import { createBrowserRouter, Navigate } from 'react-router';
import { Layout } from '@/app/layout';
import { ComparePage } from '@/pages/compare';
import { RunsPage } from '@/pages/runs';
import { RunDetailPage } from '@/pages/runs-detail';
import { SessionsPage } from '@/pages/sessions';
import { SessionDetailPage } from '@/pages/sessions-detail';
import { TasksPage } from '@/pages/tasks';
import { TaskDetailPage } from '@/pages/tasks-detail';
import { TaskNewPage } from '@/pages/tasks-new';
import { VariantsPage } from '@/pages/variants';
import { VariantDetailPage } from '@/pages/variants-detail';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/sessions" replace /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'sessions/:id', element: <SessionDetailPage /> },
      { path: 'runs', element: <RunsPage /> },
      { path: 'runs/:id', element: <RunDetailPage /> },
      { path: 'variants', element: <VariantsPage /> },
      { path: 'variants/:id', element: <VariantDetailPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'tasks/new', element: <TaskNewPage /> },
      { path: 'tasks/:id', element: <TaskDetailPage /> },
      { path: 'compare', element: <ComparePage /> },
    ],
  },
]);
