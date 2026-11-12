import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import { router } from '@/app/router';
import './index.css';

// No automatic retries: a failure shows its error text at once, and actions on the page request again
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
