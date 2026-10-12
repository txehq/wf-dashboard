import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router';
import { variantHref, variantQuery } from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';

// 原来的 /variants 与 /variants/:id（Contracts 16.7）：variant 在它所属 workflow 的页面中
export function VariantsRedirect() {
  return <Navigate to="/workflows" replace />;
}

export function VariantRedirect() {
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 variant id');
  const variant = useQuery(variantQuery(id));
  if (variant.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (variant.isError) {
    return (
      <QueryError
        error={variant.error}
        retrying={variant.isFetching}
        onRetry={() => void variant.refetch()}
      />
    );
  }
  return <Navigate to={variantHref(variant.data)} replace />;
}
