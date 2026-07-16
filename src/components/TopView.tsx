// 上面図インセット：台座を真上から見た小さな図をプレビューの隅へ重ねる。
//
// 前面図には台座の奥行・形状が現れないため、footprint（緑）／スリット（青）／重心の鉛直投影
// （赤点）／最小転倒角の方位矢印を 1 枚で確認できるようにする（SPEC「上面図インセット」）。
// **表示のみ**であり、解析結果・パラメータ・エクスポートには一切影響しない。
//
// 幾何は render/topView（純粋ロジック）が台座ローカル座標(mm)で決める。SVG の y は下向きなので、
// その座標をそのまま viewBox に載せるだけで「前（+Z）が下」（エクスポートの上面図と同じ規約）になる。

import { useTranslation } from '@/locales';
import type { TopViewShapes } from '@/render/topView';

/** インセットの一辺(px)。プレビューを覆い隠さず、形状と重心の関係が読める大きさ。 */
const SIZE_PX = 132;

/** 線幅・マーカー半径は「画面上の px」で決め、viewBox のスケールで割って一定の見た目に保つ。 */
const STROKE_PX = 1.5;
const CENTROID_RADIUS_PX = 2.5;
const ARROW_HEAD_PX = 5;

export interface TopViewProps {
  shapes: TopViewShapes;
}

export function TopView({ shapes }: TopViewProps) {
  const { t } = useTranslation();
  const { viewBox, slot, centroid, worst } = shapes;

  // mm → 画面 px のスケール。線幅・マーカーはこれで割って画面上サイズを一定にする。
  const scale = SIZE_PX / Math.max(viewBox.width, viewBox.height);
  const stroke = STROKE_PX / scale;

  // 矢印の先端（三角形）。方位ベクトルに沿って底辺を左右へ振る。
  const dx = worst.to.x - worst.from.x;
  const dy = worst.to.y - worst.from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const head = ARROW_HEAD_PX / scale;
  const headPoints = [
    `${worst.to.x},${worst.to.y}`,
    `${worst.to.x - ux * head + -uy * head * 0.5},${worst.to.y - uy * head + ux * head * 0.5}`,
    `${worst.to.x - ux * head - -uy * head * 0.5},${worst.to.y - uy * head - ux * head * 0.5}`,
  ].join(' ');

  return (
    <div
      // 表示操作コントロール（右下）の上へ置き、ルーラー・エラー表示とは重ならない位置に留める。
      // pointer-events は持たせず、下のプレビューのドラッグパン・ホイールズームを妨げない。
      className="bg-background/80 pointer-events-none absolute right-2 bottom-14 rounded-md border p-1.5 shadow-sm backdrop-blur"
      aria-hidden
    >
      <svg
        width={SIZE_PX}
        height={SIZE_PX}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      >
        {/* 台座 footprint（前が下）。前面図の台座と同じ緑。 */}
        <path
          d={shapes.footprintPath}
          fill="rgba(34, 197, 94, 0.18)"
          stroke="rgb(22, 163, 74)"
          strokeWidth={stroke}
        />
        {/* 台座に切るスリット。幅 = 差込口幅、奥行方向の開口 = 板厚。 */}
        <rect
          x={slot.x}
          y={slot.y}
          width={slot.width}
          height={slot.height}
          fill="rgba(37, 99, 235, 0.25)"
          stroke="rgb(37, 99, 235)"
          strokeWidth={stroke}
        />
        {/* 最小転倒角の方位（最悪方向）。重心投影から外向きへ。 */}
        <line
          x1={worst.from.x}
          y1={worst.from.y}
          x2={worst.to.x}
          y2={worst.to.y}
          stroke="rgb(249, 115, 22)"
          strokeWidth={stroke}
        />
        <polygon points={headPoints} fill="rgb(249, 115, 22)" />
        {/* 重心の鉛直投影。これが footprint の凸包から外れると自立しない（＝台座計算不可）。 */}
        <circle
          cx={centroid.x}
          cy={centroid.y}
          r={CENTROID_RADIUS_PX / scale}
          fill="rgb(239, 68, 68)"
          stroke="white"
          strokeWidth={stroke / 2}
        />
      </svg>
      <p className="text-muted-foreground mt-0.5 text-center text-[10px] tabular-nums">
        {t('topView.caption', { angle: shapes.worstAngleDeg.toFixed(1) })}
      </p>
    </div>
  );
}
