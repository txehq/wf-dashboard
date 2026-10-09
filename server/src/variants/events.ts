// 事件总线（server/src/events.ts）合并前，variants 只依赖这个发布函数接口
export type VariantEvent =
  | { type: 'variant.updated'; variantId: string }
  | {
      type: 'variant.build';
      variantId: string;
      status: 'building' | 'built' | 'failed';
      step: string | null;
    };

export type PublishVariantEvent = (event: VariantEvent) => void;
