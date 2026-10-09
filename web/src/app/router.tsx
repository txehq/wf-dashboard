import { createBrowserRouter, Navigate } from 'react-router';
import { Layout } from '@/app/layout';
import { ComparePage } from '@/pages/compare';
import { RunsPage } from '@/pages/runs';
import { SessionsPage } from '@/pages/sessions';
import { TasksPage } from '@/pages/tasks';
import { VariantsPage } from '@/pages/variants';
import { VariantDetailPage } from '@/pages/variants-detail';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/sessions" replace /> },
      { path: 'sessions', element: <SessionsPage /> },
      { path: 'runs', element: <RunsPage /> },
      { path: 'variants', element: <VariantsPage /> },
      { path: 'variants/:id', element: <VariantDetailPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'compare', element: <ComparePage /> },
    ],
  },
]);
