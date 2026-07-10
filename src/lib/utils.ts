import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui標準のクラス結合ユーティリティ。
// 条件付きクラス（clsx）とTailwindの競合解決（tailwind-merge）を一括で行う。
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
