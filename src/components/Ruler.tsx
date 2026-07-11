// プレビューのルーラー（上端＝水平／左端＝垂直）。
//
// 目盛りの位置決めは render/ruler.ts（純粋ロジック）が担い、本コンポーネントは
// それを SVG の線とラベルへ落とすだけの presentational な層とする。
//
// ビューポートに固定表示（stage の transform を受けない）し、代わりに transform から
// 導いた「mm → スクリーン px」の 1 次式で目盛り位置を計算することで、ズーム・パンに
// 追従させる。全体を pointer-events-none にして、下のプレビューが受け取るドラッグパン・
// ホイールズームを一切妨げないようにする（SPEC「操作対象を妨げないこと」）。

import { useMemo } from 'react';

import type { ViewportTransform } from '@/hooks/useViewport';
import { buildRulerTicks, formatTickLabel } from '@/render/ruler';

/** ルーラーの帯の太さ(px)。上端・左端・角の正方形で共有する。 */
const RULER_SIZE_PX = 20;

/** 主目盛り・副目盛りの線の長さ(px)。内側の縁から手前へ伸ばす。 */
const MAJOR_TICK_LENGTH_PX = 8;
const MINOR_TICK_LENGTH_PX = 4;

/** ラベルの文字サイズ(px)。帯の太さに収まる小さめの値。 */
const LABEL_FONT_SIZE_PX = 9;

export interface RulerProps {
  /** ビューポート（プレビュー領域）の実サイズ(px)。 */
  width: number;
  height: number;
  /** 現在のズーム/パン変換。目盛りの原点・間隔はここから導く。 */
  transform: ViewportTransform;
  /** スケール換算係数(mm/px)。目盛りを実寸(mm)にするために必要。 */
  mmPerPixel: number;
}

export function Ruler({ width, height, transform, mmPerPixel }: RulerProps) {
  // 1mm あたりのスクリーン px。ズーム率とスケールの合成で決まる（render/ruler 参照）。
  const pxPerMm = transform.scale / mmPerPixel;

  // 目盛りはズーム/パン（tx, ty, scale）とビューポートサイズにのみ依存する。
  const horizontal = useMemo(
    () => buildRulerTicks(width, transform.tx, pxPerMm),
    [width, transform.tx, pxPerMm],
  );
  const vertical = useMemo(
    () => buildRulerTicks(height, transform.ty, pxPerMm),
    [height, transform.ty, pxPerMm],
  );

  // スケール未確定（画像高さ 0 等で mmPerPixel が NaN）なら実寸目盛りを描けない。
  if (!(pxPerMm > 0)) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-10 select-none">
      {/* 上端：水平ルーラー（X 方向）。 */}
      <div
        className="bg-background/85 text-muted-foreground absolute top-0 left-0 border-b backdrop-blur-sm"
        style={{ width, height: RULER_SIZE_PX }}
      >
        <svg width={width} height={RULER_SIZE_PX} className="block">
          {horizontal.map((tick) => (
            <line
              key={tick.mm}
              x1={tick.position}
              x2={tick.position}
              y1={RULER_SIZE_PX - (tick.major ? MAJOR_TICK_LENGTH_PX : MINOR_TICK_LENGTH_PX)}
              y2={RULER_SIZE_PX}
              stroke="currentColor"
              strokeWidth={1}
            />
          ))}
          {horizontal
            .filter((tick) => tick.major)
            .map((tick) => (
              <text
                key={tick.mm}
                x={tick.position + 2}
                y={LABEL_FONT_SIZE_PX}
                fontSize={LABEL_FONT_SIZE_PX}
                fill="currentColor"
              >
                {formatTickLabel(tick.mm)}
              </text>
            ))}
        </svg>
      </div>

      {/* 左端：垂直ルーラー（Y 方向）。ラベルは -90° 回転して縦帯へ収める。 */}
      <div
        className="bg-background/85 text-muted-foreground absolute top-0 left-0 border-r backdrop-blur-sm"
        style={{ width: RULER_SIZE_PX, height }}
      >
        <svg width={RULER_SIZE_PX} height={height} className="block">
          {vertical.map((tick) => (
            <line
              key={tick.mm}
              x1={RULER_SIZE_PX - (tick.major ? MAJOR_TICK_LENGTH_PX : MINOR_TICK_LENGTH_PX)}
              x2={RULER_SIZE_PX}
              y1={tick.position}
              y2={tick.position}
              stroke="currentColor"
              strokeWidth={1}
            />
          ))}
          {vertical
            .filter((tick) => tick.major)
            .map((tick) => (
              <text
                key={tick.mm}
                x={LABEL_FONT_SIZE_PX}
                y={tick.position - 3}
                fontSize={LABEL_FONT_SIZE_PX}
                fill="currentColor"
                transform={`rotate(-90 ${LABEL_FONT_SIZE_PX} ${tick.position - 3})`}
              >
                {formatTickLabel(tick.mm)}
              </text>
            ))}
        </svg>
      </div>

      {/* 角：2 本のルーラーの交差部を塞ぎ、単位を示す。 */}
      <div
        className="bg-background text-muted-foreground absolute top-0 left-0 flex items-center justify-center border-r border-b text-[9px]"
        style={{ width: RULER_SIZE_PX, height: RULER_SIZE_PX }}
      >
        mm
      </div>
    </div>
  );
}
