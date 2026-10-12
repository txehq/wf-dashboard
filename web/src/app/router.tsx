import { createBrowserRouter, Navigate } from 'react-router';
import { Layout } from '@/app/layout';
import { AnalysesPage } from '@/pages/analyses';
import { AnalysisDetailPage } from '@/pages/analyses-detail';
import { AnalysisNewPage } from '@/pages/analyses-new';
import { ComparePage } from '@/pages/compare';
import { LivePage } from '@/pages/live';
import { RunsPage } from '@/pages/runs';
import { RunDetailPage } from '@/pages/runs-detail';
import { SessionsPage } from '@/pages/sessions';
import { SessionDetailPage } from '@/pages/sessions-detail';
import { TasksPage } from '@/pages/tasks';
import { TaskDetailPage } from '@/pages/tasks-detail';
import { TaskNewPage } from '@/pages/tasks-new';
import { VariantRedirect, VariantsRedirect } from '@/pages/variants';
import { WorkflowPage } from '@/pages/workflow-detail';
import { WorkflowsPage } from '@/pages/workflows';

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
      { path: 'live', element: <LivePage /> },
      { path: 'workflows', element: <WorkflowsPage /> },
      { path: 'workflows/:id', element: <WorkflowPage /> },
      { path: 'variants', element: <VariantsRedirect /> },
      { path: 'variants/:id', element: <VariantRedirect /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'tasks/new', element: <TaskNewPage /> },
      { path: 'tasks/:id', element: <TaskDetailPage /> },
      { path: 'compare', element: <ComparePage /> },
      { path: 'analyses', element: <AnalysesPage /> },
      { path: 'analyses/new', element: <AnalysisNewPage /> },
      { path: 'analyses/:id', element: <AnalysisDetailPage /> },
    ],
  },
]);
