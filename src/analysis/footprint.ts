// 台座 footprint（上面図の外形）の構築：形状パラメータ → 実寸(mm)の閉じた幾何。
//
// SPEC「台座 footprint（形状の幾何）」に対応する。台座形状（矩形・角丸・円・楕円・正多角形・
// 任意形状）は、ここで**単一の footprint 表現**へ畳み込まれる。成立検査（base）・転倒角
// （stability）・プレビュー・3D・エクスポートはすべてこの footprint にだけ従うため、形状の
// 種類ごとの分岐は本モジュールの中で閉じる。矩形はその特殊形にすぎない。
//
// 座標系（model/types の Footprint 参照）：
//   原点 … footprint のバウンディングボックス中心（配置時は X = 差込口中心 X、Y = 奥行原点）
//   x   … 右が正
//   y   … **前（手前）が正**（3D シーンの Z 軸・上面図の下方向に対応する）
//
// 内部表現は「閉パス（直線＋3 次ベジェ）」と「折れ線（許容誤差 0.05mm）」の二重表現。パスは
// 曲線出力（プレビュー・SVG・.ai）に、折れ線は検査・転倒角・3D 押し出しに使う。両者を同じ
// 生成元から導くことで、見た目の曲線と計算に使う形が食い違わない。
//
// 計算量は頂点数百程度で軽く、カットライン系の重い段とは独立している。したがって台座形状・
// 寸法を変えてもカットライン段の再計算は起きない（pipeline のメモ化粒度を維持する）。
//
// React には依存しない純粋ロジック。失敗（寸法不正・ソース未読込）は例外ではなく null で返す。

import type {
  AnalysisParameters,
  BaseShape,
  BaseShapeSource,
  Footprint,
  Point,
} from '@/model/types';
import {
  closedPolylineCurve,
  closedRoundedCorners,
  flattenClosedCurve,
  mapCurve,
  type ClosedCurve,
} from '@/utils/curve';
import { convexHull, degToRad } from '@/utils/geometry';

/**
 * 曲線を折れ線へ平坦化するときの許容誤差(mm)（SPEC「内部表現（パス＋折れ線）」）。
 * アクリル加工の実用精度より細かく、内包検査・転倒角・3D の押し出しで折れが問題にならない水準。
 */
const FLATTEN_TOLERANCE_MM = 0.05;

/**
 * 四分円を 3 次ベジェで近似するときの制御点距離／半径の比（4/3·tan(π/8)）。
 * 半径方向の誤差は 0.03% 未満（φ50mm の台座で 8μm 未満）で、加工精度に対して十分。
 */
const KAPPA = 0.5522847498307936;

/** 円弧・楕円弧の 4 分割ベジェ。中心 c、半径 (rx, ry) の閉曲線を返す。 */
function ellipseCurve(rx: number, ry: number, center: Point = { x: 0, y: 0 }): ClosedCurve {
  const { x: cx, y: cy } = center;
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  // 右 →（下＝前）→ 左 → 上（＝後）→ 右 の順に 4 つの四分円弧をつなぐ。
  const right = { x: cx + rx, y: cy };
  const front = { x: cx, y: cy + ry };
  const left = { x: cx - rx, y: cy };
  const back = { x: cx, y: cy - ry };
  return {
    start: right,
    segments: [
      { c1: { x: right.x, y: cy + oy }, c2: { x: cx + ox, y: front.y }, end: front },
      { c1: { x: cx - ox, y: front.y }, c2: { x: left.x, y: cy + oy }, end: left },
      { c1: { x: left.x, y: cy - oy }, c2: { x: cx - ox, y: back.y }, end: back },
      { c1: { x: cx + ox, y: back.y }, c2: { x: right.x, y: cy - oy }, end: right },
    ],
  };
}

/** 直線区間（制御点を弦の 1/3・2/3 に置くと 3 次ベジェは厳密な直線になる）。 */
function lineSegment(from: Point, to: Point) {
  return {
    c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
    c2: { x: from.x + ((to.x - from.x) * 2) / 3, y: from.y + ((to.y - from.y) * 2) / 3 },
    end: to,
  };
}

/**
 * 角丸矩形（半径 r の四分円弧＋直線 4 辺）。r = 0 で矩形、r = min(w,d)/2 でスタジアム形。
 * 円弧は円と同じベジェ近似（KAPPA）を使う。
 */
function roundedRectCurve(widthMm: number, depthMm: number, radiusMm: number): ClosedCurve {
  const hw = widthMm / 2;
  const hd = depthMm / 2;
  const r = Math.min(radiusMm, hw, hd);

  // 上面図なので +y が前（手前）。右辺の後端から、右 → 前 → 左 → 後 の順に一周する。
  const segments: ClosedCurve['segments'] = [];
  const start: Point = { x: hw, y: -hd + r };
  let cur = start;
  const lineTo = (p: Point): void => {
    segments.push(lineSegment(cur, p));
    cur = p;
  };
  /**
   * 角の頂点 corner を挟む四分円弧（cur → p）。始終点はいずれも corner から距離 r にあるので、
   * 制御点を各端点から corner の方向へ KAPPA·r だけ伸ばせば円弧のベジェ近似になる。
   */
  const arcTo = (p: Point, corner: Point): void => {
    const toward = (from: Point): Point => ({
      x: from.x + (corner.x - from.x) * KAPPA,
      y: from.y + (corner.y - from.y) * KAPPA,
    });
    segments.push({ c1: toward(cur), c2: toward(p), end: p });
    cur = p;
  };

  lineTo({ x: hw, y: hd - r }); // 右辺（後 → 前）
  if (r > 0) arcTo({ x: hw - r, y: hd }, { x: hw, y: hd }); // 右前の角
  lineTo({ x: -hw + r, y: hd }); // 前辺（右 → 左）
  if (r > 0) arcTo({ x: -hw, y: hd - r }, { x: -hw, y: hd }); // 左前の角
  lineTo({ x: -hw, y: -hd + r }); // 左辺（前 → 後）
  if (r > 0) arcTo({ x: -hw + r, y: -hd }, { x: -hw, y: -hd }); // 左後の角
  lineTo({ x: hw - r, y: -hd }); // 後辺（左 → 右）
  // 右後の角。r = 0 のときは後辺の終点がすでに始点なので、閉じ辺は要らない（長さ 0 の
  // 退化区間を出すと折れ線に重複頂点が生まれる）。
  if (r > 0) arcTo(start, { x: hw, y: -hd });

  return { start, segments };
}

/**
 * 正多角形の頂点列（外接円半径 radius、辺数 sides、回転角 rotationDeg）。
 *
 * 回転 0° で**前（手前）側に 1 辺が正対**する（前縁の辺の中点が奥行軸上に来る）ように、頂点を
 * 方位角 90° ± 180°/n から並べる。方位角は右 0°・前 90°（SPEC）なので、方位 φ の点は
 * (cos φ, sin φ)（y が前）で表せ、回転角はそのまま φ へ足せばよい。
 */
function regularPolygonPoints(sides: number, radius: number, rotationDeg: number): Point[] {
  const points: Point[] = [];
  const step = 360 / sides;
  for (let i = 0; i < sides; i++) {
    const azimuthDeg = 90 + step / 2 + i * step + rotationDeg;
    const rad = degToRad(azimuthDeg);
    points.push({ x: radius * Math.cos(rad), y: radius * Math.sin(rad) });
  }
  return points;
}

/** 頂点列のバウンディングボックス（空・非有限を含む入力は null）。 */
function boundsOf(
  points: readonly Point[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (points.length === 0) {
    return null;
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return null;
    }
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 曲線から footprint を組み立てる（平坦化 → bbox 中心を原点へ移動 → 凸包）。
 *
 * bbox は**平坦化後の折れ線**から測る。曲線（円・楕円・角丸）は軸上の端点を必ず頂点として
 * 持つため、これは真の外接寸法と一致する。任意形状は曲線補完で角がわずかに削れるので、
 * 「実際に切り出される形の外接寸法」を返すこの測り方が結果表示（台座幅・奥行）として正しい。
 * 原点を bbox 中心へ揃えることで、スリット（原点基準）と配置規則が形状によらず一定になる。
 */
function finalizeFootprint(shape: BaseShape, curve: ClosedCurve): Footprint | null {
  const flat = flattenClosedCurve(curve, FLATTEN_TOLERANCE_MM);
  const bounds = boundsOf(flat);
  if (!bounds || flat.length < 3) {
    return null;
  }

  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const widthMm = bounds.maxX - bounds.minX;
  const depthMm = bounds.maxY - bounds.minY;
  if (!(widthMm > 0) || !(depthMm > 0)) {
    return null;
  }

  const centered = cx === 0 && cy === 0;
  const shift = (p: Point): Point => ({ x: p.x - cx, y: p.y - cy });
  const polyline = centered ? flat : flat.map(shift);

  return {
    shape,
    curve: centered ? curve : mapCurve(curve, shift),
    polyline,
    hull: convexHull(polyline),
    widthMm,
    depthMm,
  };
}

/**
 * 台座形状パラメータ（＋任意形状のソース）から footprint を構築する。
 *
 * null を返す（＝ SPEC の `baseShapeFailed`）のは、寸法が不正（非正・非有限）な場合と、
 * 任意形状でソースが未読込・退化している場合。呼び出し側（pipeline）は台座形状が利用できない
 * エラーとして UI へ提示する。
 */
export function buildFootprint(
  params: AnalysisParameters,
  source: BaseShapeSource | null,
): Footprint | null {
  const {
    baseShape,
    baseWidthMm,
    baseDepthMm,
    baseCornerRadiusMm,
    baseDiameterMm,
    basePolygonSides,
    basePolygonRotationDeg,
  } = params;

  // 形状ごとに使う寸法だけを検査する（円形で台座幅が不正でも問題にしない）。
  const validSize = (value: number): boolean => Number.isFinite(value) && value > 0;

  switch (baseShape) {
    case 'rect': {
      if (!validSize(baseWidthMm) || !validSize(baseDepthMm)) return null;
      const hw = baseWidthMm / 2;
      const hd = baseDepthMm / 2;
      // 上辺が後（奥）・下辺が前（手前）。頂点は右後 → 右前 → 左前 → 左後 の順。
      const curve = closedPolylineCurve([
        { x: hw, y: -hd },
        { x: hw, y: hd },
        { x: -hw, y: hd },
        { x: -hw, y: -hd },
      ]);
      return curve && finalizeFootprint('rect', curve);
    }

    case 'roundedRect': {
      if (!validSize(baseWidthMm) || !validSize(baseDepthMm)) return null;
      // 半径は reducer（normalizeParameters）が min(幅, 奥行)/2 以下へクランプ済みだが、
      // 解析側だけで呼ばれる可能性に備えて念のため丸める（0 なら矩形と一致する）。
      const radius = Math.max(0, Math.min(baseCornerRadiusMm, baseWidthMm / 2, baseDepthMm / 2));
      return finalizeFootprint('roundedRect', roundedRectCurve(baseWidthMm, baseDepthMm, radius));
    }

    case 'circle': {
      if (!validSize(baseDiameterMm)) return null;
      const r = baseDiameterMm / 2;
      return finalizeFootprint('circle', ellipseCurve(r, r));
    }

    case 'ellipse': {
      if (!validSize(baseWidthMm) || !validSize(baseDepthMm)) return null;
      return finalizeFootprint('ellipse', ellipseCurve(baseWidthMm / 2, baseDepthMm / 2));
    }

    case 'polygon': {
      if (!validSize(baseDiameterMm)) return null;
      const sides = Math.round(basePolygonSides);
      if (!Number.isFinite(sides) || sides < 3) return null;
      const rotation = Number.isFinite(basePolygonRotationDeg) ? basePolygonRotationDeg : 0;
      const curve = closedPolylineCurve(regularPolygonPoints(sides, baseDiameterMm / 2, rotation));
      return curve && finalizeFootprint('polygon', curve);
    }

    case 'custom': {
      // ソース未読込は「台座形状が利用できない」。UI でファイルを読み込ませる。
      if (!source || source.outline.length < 3) return null;
      if (!validSize(baseWidthMm) || !validSize(baseDepthMm)) return null;
      // 正規化済み折れ線（±0.5）を台座幅 × 台座奥行へ非等方スケールし、曲線補完でパス化する
      // （SPEC「内部表現」）。丸め量は辺長比なのでスケール不変。
      const scaled = source.outline.map((p) => ({
        x: p.x * baseWidthMm,
        y: p.y * baseDepthMm,
      }));
      const curve = closedRoundedCorners(scaled);
      return curve && finalizeFootprint('custom', curve);
    }

    default:
      return assertNever(baseShape);
  }
}

/** switch の網羅性を型レベルで保証するためのヘルパー（形状追加時に型エラーで気づける）。 */
function assertNever(shape: never): null {
  void shape;
  return null;
}
