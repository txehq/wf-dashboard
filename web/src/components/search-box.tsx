import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

// 带放大镜图标的搜索框；label 只给读屏
export function SearchBox({
  value,
  onChange,
  label,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  className?: string;
}) {
  return (
    <label className={cn('relative', className)}>
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        className="h-9 w-full rounded-md border bg-background pr-3 pl-8 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </label>
  );
}
