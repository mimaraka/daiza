// ペイン間のリサイズハンドル（縦の仕切り）。
//
// 隣接する固定幅ペインの幅を、ドラッグ（およびキーボード）で変更するための操作子。
// 幅の値そのものは持たず、上位（App）が持つ幅 state を更新するだけの制御コンポーネント。
// 3 ペイン構成のうち幅を持つのは左右のパネルで、中央のプレビューは残りを埋めるため、
// どちらのハンドルも「隣の固定幅ペイン」を操作対象とする（中央は結果的に追従する）。

import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { cn } from '@/lib/utils';

/** キーボード操作 1 回あたりの変化量(px)。細かすぎず粗すぎない刻みにする。 */
const KEY_STEP_PX = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface PaneResizerProps {
  /** 操作対象ペインの現在幅(px)。 */
  width: number;
  /** 幅の下限・上限(px)。ペインが潰れる／プレビューを圧迫するのを防ぐ。 */
  min: number;
  max: number;
  /**
   * ポインタの右移動が幅の増加になるなら 1、減少になるなら -1。
   * ハンドルの左にあるペイン（左パネル）は 1、右にあるペイン（結果パネル）は -1。
   */
  sign: 1 | -1;
  /** 新しい幅を通知する（clamp 済み）。 */
  onWidthChange: (width: number) => void;
  /** スクリーンリーダー向けの説明（例「左パネルの幅」）。 */
  label: string;
}

export function PaneResizer({ width, min, max, sign, onWidthChange, label }: PaneResizerProps) {
  // ドラッグ中の見た目（強調）に使うため state で持つ。
  const [isDragging, setIsDragging] = useState(false);
  // ドラッグ開始時点の基準（ポインタ X と幅）。移動ごとの差分を積み上げると clamp で
  // 頭打ちになった分の誤差が溜まるため、常に「開始点からの総移動量」で幅を決める。
  const originRef = useRef<{ x: number; width: number } | null>(null);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // ドラッグ中に周囲のテキストが選択されるのを防ぐ。
    event.preventDefault();
    originRef.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const origin = originRef.current;
    if (!origin) {
      return;
    }
    onWidthChange(clamp(origin.width + sign * (event.clientX - origin.x), min, max));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!originRef.current) {
      return;
    }
    originRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDragging(false);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={(event) => {
        // 矢印キーでも幅を調整できるようにする（ポインタを使えない環境向け）。
        // 画面上の見た目に合わせ、左キーは常に左方向へ境界を動かす。
        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if (direction === 0) {
          return;
        }
        event.preventDefault();
        onWidthChange(clamp(width + sign * direction * KEY_STEP_PX, min, max));
      }}
      className={cn(
        // 狭幅ではペインが縦積みになり左右の境界が存在しないため、ハンドル自体を出さない。
        // 負のマージンで main の gap（16px）を打ち消し、ハンドルとペインの間隔を詰める。
        'bg-border/60 hover:bg-primary/60 focus-visible:ring-ring hidden w-1.5 shrink-0 cursor-col-resize touch-none rounded-full transition-colors focus-visible:ring-2 focus-visible:outline-none lg:-mx-2.5 lg:block',
        isDragging && 'bg-primary',
      )}
    />
  );
}
