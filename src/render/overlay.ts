// オーバーレイ描画モデルの構築（純粋ロジック、React / SVG 非依存）。
//
// AnalysisResult を「プレビュー上に重ねる図形の集合」へ変換する。ここでは
// 幾何（ピクセル座標系の図形）だけを決め、色・線種などの見た目は描画層
// （components/Preview の SVG）に委ねる。こう分離しておくことで、将来
// 描画先を Canvas / WebGL へ差し替えても図形定義をそのまま再利用できる。
//
// 座標系は入力画像のピクセル座標（左上原点・下方向 +Y）で統一する。プレビューは
// この座標をそのまま viewBox にとった SVG で描くため、ズーム/パン（TODO 9）は
// SVG 側の座標変換だけで完結し、本モジュールは影響を受けない。

import { slotJunctionCorners } from '@/analysis/slot';
import type { AnalysisResult, Point } from '@/model/types';

/** 外形（半透明の塗り）。ピクセル座標の頂点列。 */
export interface OverlayPolygon {
  readonly role: 'contour';
  readonly points: readonly Point[];
  /**
   * 曲線補完で丸めない頂点（差込部の肩＝首部とツメの接合部）。描画層はこれを
   * utils/curve の sharpCorners としてそのまま渡す（analysis/slot の slotJunctionCorners 参照）。
   */
  readonly sharpCorners: readonly Point[];
}

/**
 * 重心マーカー（赤丸）の位置。半径は持たない：マーカーの大きさは解析結果ではなく
 * 見た目の都合で決まる量であり、線幅と同じく「画面上で一定サイズ」であるべきなので、
 * 画像ピクセル座標に依存しない描画層（components/Preview）の責務とする。
 */
export interface OverlayPoint {
  readonly role: 'centroid';
  readonly center: Point;
}

/** 差込部の首部・ツメ（青矩形）／台座（緑矩形）。左上原点 (x, y) と幅・高さ。 */
export interface OverlayRect {
  readonly role: 'slotNeck' | 'slotTab' | 'base';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 支持範囲（オレンジ線）／重心からの鉛直線（点線）。 */
export interface OverlaySegment {
  readonly role: 'support' | 'plumb';
  readonly from: Point;
  readonly to: Point;
}

/**
 * プレビューへ重ねる図形一式。
 * 描画層はこの構造体の各要素を role に応じたスタイルで SVG 化するだけでよい。
 */
export interface OverlayShapes {
  readonly contour: OverlayPolygon;
  readonly centroid: OverlayPoint;
  /** 差込部の首部（幅=首部幅、カットライン下辺〜台座上面）。 */
  readonly neck: OverlayRect;
  /** 差込部のツメ（幅=差込口幅、台座上面から板厚ぶん下）。 */
  readonly tab: OverlayRect;
  readonly base: OverlayRect;
  readonly support: OverlaySegment;
  readonly plumb: OverlaySegment;
}

/**
 * 解析結果からオーバーレイ図形一式を構築する。
 *
 * mm 座標で保持している値（台座幅・支持範囲）は mmPerPixel で割ってピクセル座標へ
 * 戻す。支持範囲・台座・鉛直線は**台座上面**（カットライン最下端 + 持ち上げ量）を共通の
 * ベースラインとして配置し、重心の鉛直線をそこまで下ろすことで「重心の真下が支持範囲内か」
 * を目視できるようにする。画像下端ではなく台座上面を基準にするのは、カットライン余白で
 * 外形が画像下端より下へ広がっても板が台座に潜り込まないようにするため（SPEC「アクリル板と
 * 台座の上下関係」）。
 */
export function buildOverlayShapes(result: AnalysisResult): OverlayShapes {
  const { mmPerPixel, contour, centroid, slot, base } = result;

  // 支持範囲・台座・鉛直線の基準となる台座上面（＝首部下端＝ツメ上端）。
  const baselineY = slot.baseTopYPixel;

  const neckRect: OverlayRect = {
    role: 'slotNeck',
    x: slot.neck.xPixel,
    y: slot.neck.yPixel,
    width: slot.neck.widthPixel,
    height: slot.neck.heightPixel,
  };

  const tabRect: OverlayRect = {
    role: 'slotTab',
    x: slot.tab.xPixel,
    y: slot.tab.yPixel,
    width: slot.tab.widthPixel,
    height: slot.tab.heightPixel,
  };

  // 台座（緑矩形）：上辺を台座上面に合わせ、下方向へ描く。前面図における台座の縦寸法は
  // 板厚（＝ツメ深さ）とする。奥行(depthMm)は上面図の寸法であり、前面図の縦へ載せると
  // 重心高さ由来の大きな値がそのまま縦長の帯になって形状を覆い隠すため使わない。
  // 縦をツメ深さに揃えることで、ツメが台座を貫通していない（＝ちょうど収まる）ことも
  // そのまま目で確認できる。
  //
  // 横幅は台座形状によらず footprint のバウンディングボックス幅（＝凸包の左右端＝支持範囲の
  // オレンジ線と一致）。奥行方向の形状は前面図に現れないため、上面図インセット（render/topView）で
  // 確認する（SPEC「台座（緑矩形）の縦の長さ」）。
  const baseWidthPixel = base.widthMm / mmPerPixel;
  const baseRect: OverlayRect = {
    role: 'base',
    x: slot.centerXPixel - baseWidthPixel / 2,
    y: baselineY,
    width: baseWidthPixel,
    height: slot.tab.heightPixel,
  };

  // 支持範囲（オレンジ線）：mm 座標の左右端をピクセルへ戻した水平線分。
  const support: OverlaySegment = {
    role: 'support',
    from: { x: base.supportLeftMm / mmPerPixel, y: baselineY },
    to: { x: base.supportRightMm / mmPerPixel, y: baselineY },
  };

  // 重心からの鉛直線（点線）：重心の真下がどこに落ちるかを支持範囲と対比させる。
  const plumb: OverlaySegment = {
    role: 'plumb',
    from: { x: centroid.pixel.x, y: centroid.pixel.y },
    to: { x: centroid.pixel.x, y: baselineY },
  };

  return {
    contour: { role: 'contour', points: contour, sharpCorners: slotJunctionCorners(slot) },
    centroid: { role: 'centroid', center: centroid.pixel },
    neck: neckRect,
    tab: tabRect,
    base: baseRect,
    support,
    plumb,
  };
}
