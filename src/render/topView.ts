// 上面図インセットの描画モデル構築（純粋ロジック、React / SVG 非依存）。
//
// 前面図（プレビュー本体）には台座の奥行・形状が現れない。そこで台座を真上から見た小さな図を
// 別に組み立て、footprint・スリット・重心の鉛直投影・最悪方位を 1 枚で確認できるようにする
// （SPEC「上面図インセット（台座形状の確認）」）。**表示のみ**であり、解析結果・パラメータ・
// エクスポートには一切影響しない。
//
// 座標系は台座ローカル座標（mm）そのまま：原点 = footprint の bbox 中心、x = 右が正、
// y = **前（手前）が正**。SVG は y が下向きなので、この座標をそのまま viewBox に載せるだけで
// 「前が下」（エクスポートの上面図と同じ規約）になる。

import type { AnalysisResult, Point } from '@/model/types';
import { curvePathData } from '@/utils/curve';
import { degToRad } from '@/utils/geometry';

/** 図の外周に取る余白（footprint の長辺に対する比率）。矢印や線幅が縁で切れないようにする。 */
const MARGIN_RATIO = 0.12;

/** 最悪方位の矢印の長さ（footprint の長辺に対する比率）。 */
const ARROW_RATIO = 0.3;

/** 上面図に描く矩形（スリット）。左上原点・幅・高さ（ローカル mm）。 */
export interface TopViewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 上面図の viewBox（ローカル mm）。 */
export interface TopViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 上面図に重ねる図形一式（すべて台座ローカル座標 mm）。 */
export interface TopViewShapes {
  /** 台座 footprint の曲線パス（`d` 属性）。 */
  readonly footprintPath: string;
  /** 台座に切るスリット（幅 = 差込口幅、開口 = 板厚、中心 = (0, 前後オフセット)）。 */
  readonly slot: TopViewRect;
  /** 重心の鉛直投影。支持（凸包内）の可否を目で見るための赤点。 */
  readonly centroid: Point;
  /** 最悪方位（最小転倒角の方向）を指す矢印。重心投影から外向きへ伸ばす。 */
  readonly worst: { readonly from: Point; readonly to: Point };
  /** 最小転倒角(度)と方位角(度)。ラベル表示に使う。 */
  readonly worstAngleDeg: number;
  readonly worstAzimuthDeg: number;
  readonly viewBox: TopViewBox;
}

/**
 * 解析結果から上面図の図形一式を構築する。
 *
 * footprint は解析結果（base.footprint）がすでにローカル座標の実寸で持っているため、ここでは
 * 座標変換を一切行わない。スリット・重心投影も同じローカル座標で定義されている（analysis/base の
 * centroidProjection と同一の定義）ので、上面図は「解析が見ている幾何」をそのまま描くことになる。
 */
export function buildTopViewShapes(result: AnalysisResult): TopViewShapes {
  const { slot, base, stability, centroid } = result;
  const { footprint } = base;

  const slotRect: TopViewRect = {
    x: -slot.widthMm / 2,
    y: slot.depthOffsetMm - slot.tabDepthMm / 2,
    width: slot.widthMm,
    height: slot.tabDepthMm,
  };

  // 重心の鉛直投影：板はスリットへ差し込まれるため、奥行位置はスリット中心。
  const projection: Point = {
    x: centroid.mm.x - slot.centerXMm,
    y: slot.depthOffsetMm,
  };

  // 最悪方位（右 0°・前 90°）。y が前なので、方位角をそのまま (cos, sin) にすればよい。
  const span = Math.max(footprint.widthMm, footprint.depthMm);
  const arrowLength = span * ARROW_RATIO;
  const azimuthRad = degToRad(stability.worstAzimuthDeg);
  const worst = {
    from: projection,
    to: {
      x: projection.x + Math.cos(azimuthRad) * arrowLength,
      y: projection.y + Math.sin(azimuthRad) * arrowLength,
    },
  };

  const margin = span * MARGIN_RATIO;
  const halfWidth = footprint.widthMm / 2 + margin;
  const halfDepth = footprint.depthMm / 2 + margin;

  return {
    footprintPath: curvePathData(footprint.curve),
    slot: slotRect,
    centroid: projection,
    worst,
    worstAngleDeg: stability.tippingAngleMinDeg,
    worstAzimuthDeg: stability.worstAzimuthDeg,
    viewBox: {
      x: -halfWidth,
      y: -halfDepth,
      width: halfWidth * 2,
      height: halfDepth * 2,
    },
  };
}
