import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from '@/app/router';
import './index.css';

// 不自动重试：失败立即显示错误原文，由页面上的操作重新请求
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const root = document.getElementById('root');
if (root === null) throw new Error('index.html 缺少 #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
