// キーホルダーモードの解析ロジック（純粋関数）。
//
// カットライン（輪郭）の上部にリング穴を開ける。穴縁とカットラインの間に
// 最低 1.5 mm の余裕を保ち、それだけでは収まらないときは穴周りに円形のタブ（耳）を
// 追加してトップを可動にする。アクリル本体は水平オフセットで回転させず、
// 穴の位置だけを動かす。

import polygonClipping, { type Polygon, type Ring } from 'polygon-clipping';

import { polygonCentroid, toCentroid } from '@/analysis/centroid';
import type { Centroid, Contour, KeychainResult, Point } from '@/model/types';
import { distanceToSegment, pointInPolygon, simplifyPolyline } from '@/utils/geometry';

/** 穴縁とカットラインの間の最小余裕(mm)。grilling で確定。 */
export const KEYCHAIN_HOLE_MARGIN_MM = 1.5;

/** 円形タブを近似する線分數。 */
const TAB_CIRCLE_SEGMENTS = 48;

/** タブ合成後の輪郭を軽量化する許容誤差(px)。 */
const TAB_SIMPLIFY_EPSILON_PX = 0.25;

/** 点が閉多角形の内部にあるか（境界含む）。ピクセル座標。 */
function isInsideContour(point: Point, contour: Contour): boolean {
  return pointInPolygon(point, contour, 0);
}

/**
 * 点から多角形輪郭までの最短距離（内部なら正、外部なら負）。
 * 内部に近い辺までの距離を正で返し、外部なら境界までの距離を負で返す。
 */
function signedDistanceToContour(point: Point, contour: Contour): number {
  const inside = isInsideContour(point, contour);
  let minDist = Infinity;
  const n = contour.length;
  for (let i = 0; i < n; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % n];
    if (!a || !b) continue;
    const d = distanceToSegment(point, a, b);
    if (d < minDist) minDist = d;
  }
  return inside ? minDist : -minDist;
}

/** 点から輪郭までの最短距離を常に正で返す。 */
function unsignedDistanceToContour(point: Point, contour: Contour): number {
  let minDist = Infinity;
  const n = contour.length;
  for (let i = 0; i < n; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % n];
    if (!a || !b) continue;
    const d = distanceToSegment(point, a, b);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/** Point[] を polygon-clipping の閉リング（始点=終点）へ変換する。 */
function toClosedRing(points: readonly Point[]): Ring {
  const ring: Ring = points.map((p) => [p.x, p.y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

/** polygon-clipping の閉リングを Point[]（開いた頂点列）へ戻す。 */
function ringToContour(ring: Ring): Contour {
  const pts = ring.map(([x, y]) => ({ x, y }));
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (first && last && first.x === last.x && first.y === last.y) {
      pts.pop();
    }
  }
  return pts;
}

/** 中心・半径から円形ポリゴンを作る。 */
function circleContour(center: Point, radiusPx: number, segments: number): Contour {
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push({
      x: center.x + radiusPx * Math.cos(theta),
      y: center.y + radiusPx * Math.sin(theta),
    });
  }
  return points;
}

/**
 * 元のカットラインに、穴中心を中心とする円形タブを合成する。
 * タブは元の輪郭と必ず重なるよう半径を取り、失敗時は null を返す。
 */
function mergeCircularTab(contour: Contour, center: Point, tabRadiusPx: number): Contour | null {
  if (contour.length < 3) {
    return null;
  }

  try {
    const original: Polygon = [toClosedRing(contour)];
    const tab: Polygon = [toClosedRing(circleContour(center, tabRadiusPx, TAB_CIRCLE_SEGMENTS))];
    const merged = polygonClipping.union(original, tab);

    if (merged.length === 0) {
      return null;
    }

    // 通常は 1 つのポリゴン。複数になった場合は穴中心を含む方を選ぶ。
    if (merged.length === 1) {
      const outer = merged[0]?.[0];
      if (!outer) return null;
      return simplifyPolyline(ringToContour(outer), TAB_SIMPLIFY_EPSILON_PX);
    }

    for (const poly of merged) {
      const outer = poly[0];
      if (!outer) continue;
      const candidate = ringToContour(outer);
      if (pointInPolygon(center, candidate, 1e-6)) {
        return simplifyPolyline(candidate, TAB_SIMPLIFY_EPSILON_PX);
      }
    }

    // フォールバック：最大面積のポリゴン。
    let best: Contour | null = null;
    let bestArea = -Infinity;
    for (const poly of merged) {
      const outer = poly[0];
      if (!outer) continue;
      const candidate = ringToContour(outer);
      const centroid = polygonCentroid(candidate);
      if (centroid && centroid.pixelCount > bestArea) {
        bestArea = centroid.pixelCount;
        best = candidate;
      }
    }

    return best ? simplifyPolyline(best, TAB_SIMPLIFY_EPSILON_PX) : null;
  } catch {
    return null;
  }
}

/**
 * リング穴の配置を計算する。
 *
 * 既定位置は (重心 X + 水平オフセット, 絵柄上端)。padding は上（画像から離れる方向）へ
 * 追加する。穴縁が元のカットラインから 1.5 mm 以上離れていればそのまま、不足していれば
 * 穴周りに円形タブを追加して素材を確保する。
 */
export function computeKeychainHole(
  contour: Contour,
  centroid: Centroid,
  imageTopY: number,
  holeDiameterMm: number,
  holePaddingMm: number,
  holeOffsetXMm: number,
  mmPerPixel: number,
): { center: Point; radiusPx: number; tabRadiusPx?: number } | null {
  if (contour.length < 3) {
    return null;
  }

  const radiusMm = holeDiameterMm / 2;
  const radiusPx = radiusMm / mmPerPixel;
  const marginPx = KEYCHAIN_HOLE_MARGIN_MM / mmPerPixel;

  // 目標とする余裕 = 半径 + 1.5 mm
  const requiredPx = radiusPx + marginPx;

  // 穴は「重心 X + 水平オフセット」の真上に置き、絵柄上端からの余裕で離す。
  // padding は上（画像から離れる方向、Y 減少方向）へ追加する。
  const targetX = centroid.pixel.x + holeOffsetXMm / mmPerPixel;
  const paddingPx = holePaddingMm / mmPerPixel;
  const center: Point = { x: targetX, y: imageTopY + requiredPx - paddingPx };

  const signedDist = signedDistanceToContour(center, contour);
  if (signedDist >= requiredPx - 1e-6) {
    // 元のカットライン内に安全に収まる → タブ不要。
    return { center, radiusPx };
  }

  // 安全に収まらない → 穴中心から輪郭までの距離 + requiredPx の円形タブを追加。
  const dist = unsignedDistanceToContour(center, contour);
  const tabRadiusPx = dist + requiredPx;
  if (!Number.isFinite(tabRadiusPx) || tabRadiusPx <= 0) {
    return null;
  }

  return { center, radiusPx, tabRadiusPx };
}

/**
 * キーホルダーモードの結果一式を組み立てる。
 *
 * 呼び出し側は既にカットライン・重心が確定していることを前提とする。
 * タブが必要な場合は輪郭を合成し、重心は合成後の輪郭から再計算する。
 */
export function buildKeychainResult(
  contour: Contour,
  centroid: Centroid,
  imageTopY: number,
  holeDiameterMm: number,
  holePaddingMm: number,
  holeOffsetXMm: number,
  mmPerPixel: number,
): KeychainResult | null {
  const hole = computeKeychainHole(
    contour,
    centroid,
    imageTopY,
    holeDiameterMm,
    holePaddingMm,
    holeOffsetXMm,
    mmPerPixel,
  );
  if (!hole) {
    return null;
  }

  let finalContour = contour;
  if (hole.tabRadiusPx) {
    const tabbed = mergeCircularTab(contour, hole.center, hole.tabRadiusPx);
    if (!tabbed) {
      return null;
    }
    finalContour = tabbed;
  }

  const finalCentroidPixel = polygonCentroid(finalContour);
  if (!finalCentroidPixel) {
    return null;
  }
  const finalCentroid = toCentroid(finalCentroidPixel, mmPerPixel);

  return {
    holeCenterPixel: hole.center,
    holeCenterMm: { x: hole.center.x * mmPerPixel, y: hole.center.y * mmPerPixel },
    holeRadiusMm: holeDiameterMm / 2,
    // 水平オフセットでアクリル全体を回転させないよう、回転は 0 に固定。
    rotationDeg: 0,
    rotatedCentroidPixel: finalCentroid.pixel,
    rotatedCentroidMm: finalCentroid.mm,
    rotatedContour: finalContour,
  };
}
