// 台座サイズの検査：ユーザー指定の寸法・形状で台座が成立するかを footprint に対して判定する。
//
// アクリルフィギュアは差込口（スリット）へツメを挿して自立する。台座の寸法（幅・奥行・直径 等）は
// いずれもユーザー指定値をそのまま実寸として用いる（自動では拡大しない）ため、本モジュールは
// 「その指定で成立するか」を検査するだけで、寸法は作らない。React には依存しない純粋ロジック。
//
// SPEC「台座サイズの検査」の 2 検査（いずれも境界上ちょうどは成立側に倒す）：
//
//  1. スリットの内包 … スリット矩形（幅 = 差込口幅、奥行方向の開口 = 板厚、中心 = ローカル
//     (0, 前後オフセット)）が footprint の内側に完全に含まれること。含まれなければスリットが
//     台座の縁を割ってしまう。この検査は「ツメが台座を貫通しない（ツメ深さ = 板厚 ≦ 奥行）」も
//     同時に満たす。非凸形状では隅の内包だけでは不十分なので、4 隅の内包に加えて 4 辺が輪郭と
//     交差しないことも見る。
//  2. 重心の支持 … 重心の鉛直投影（ローカル (重心X − 差込口中心X, 前後オフセット)。板はスリットへ
//     差し込まれるので投影の奥行位置はスリット中心）が footprint の**凸包**の内側にあること。
//     転倒に抗する支持範囲は凸包で決まる（非凸の凹みは接地の支持範囲を狭めない）。
//
// 矩形 footprint では従来式（台座幅 ≧ 差込口幅 かつ ≧ 2×|重心X − 差込口中心X|、台座奥行 ≧
// 板厚 + 2×|前後オフセット|）と厳密に一致する。両検査は「静的に成立するか」の可否だけを見て、
// 倒れにくさの**余裕**は含まない。余裕は転倒角（stability）が表す。
//
// 座標系：台座は差込口中心（slot.centerXMm）を軸に配置する（footprint の原点 X = 差込口中心 X）。
// 奥行方向は台座の奥行原点が 0 で、スリットはそこから slot.depthOffsetMm ずれた位置（正 = 前）。

import type { BaseResult, Centroid, Contour, Footprint, Point, SlotResult } from '@/model/types';
import { pointInPolygon, segmentsCross } from '@/utils/geometry';

/**
 * 内包検査の許容誤差(mm)。
 *
 * 「境界上ちょうどは成立側」（SPEC）を浮動小数の丸めで取りこぼさないための許容。矩形台座で
 * 台座奥行 = 板厚 + 2×|前後オフセット| をちょうど指定した構成が、奥行/2 − 板厚/2 − |オフセット|
 * の演算誤差（1e-13mm 程度）で不成立に落ちるのを防ぐ。1μm は加工精度から見て無視できる。
 */
const CONTAINMENT_EPSILON_MM = 1e-3;

/**
 * 台座上面 Y（ピクセル）を求める。
 *
 * SPEC「アクリル板と台座の上下関係」の不変条件（板の最下端 ≦ 台座上面）を成立させる
 * ための基準線。カットライン余白を大きく取ると外形は画像下端より下へ広がるため、
 * 基準は「画像下端」ではなく**カットラインの最下端**に取る。そこへ持ち上げ量を足した
 * 位置を台座上面とし、持ち上げ量 0 なら板の下端と台座上面がちょうど接する（Y は下方向 +）。
 *
 * 退化入力（空のカットライン・不正な持ち上げ量／スケール）では NaN を返し、
 * 呼び出し側で台座計算不可として弾けるようにする。
 */
export function computeBaseTopYPixel(
  contour: Contour,
  plateLiftMm: number,
  mmPerPixel: number,
): number {
  if (!Number.isFinite(plateLiftMm) || plateLiftMm < 0 || !(mmPerPixel > 0)) {
    return Number.NaN;
  }
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of contour) {
    if (p.y > maxY) {
      maxY = p.y;
    }
  }
  if (!Number.isFinite(maxY)) {
    return Number.NaN;
  }
  return maxY + plateLiftMm / mmPerPixel;
}

/**
 * 閉多角形が矩形（4 隅で与える）を完全に内包するか。
 *
 * 4 隅がすべて内部（境界含む）にあり、かつ矩形の 4 辺が輪郭のどの辺とも真に交差しないことを
 * 見る。隅の内包だけでは不十分なのは非凸形状のため：たとえば C 字の凹みへ矩形を重ねると、
 * 4 隅は内側でも辺が凹みの縁を跨ぐことがある。逆に、辺同士が接する・重なるだけ（矩形台座で
 * スリットが縁にちょうど接する構成）は交差とみなさない（境界上は成立側。segmentsCross）。
 */
function polygonContainsRect(polygon: readonly Point[], corners: readonly Point[]): boolean {
  for (const corner of corners) {
    if (!pointInPolygon(corner, polygon, CONTAINMENT_EPSILON_MM)) {
      return false;
    }
  }

  const n = polygon.length;
  const m = corners.length;
  for (let i = 0; i < m; i++) {
    const a1 = corners[i];
    const a2 = corners[(i + 1) % m];
    if (!a1 || !a2) {
      return false;
    }
    for (let j = 0; j < n; j++) {
      const b1 = polygon[j];
      const b2 = polygon[(j + 1) % n];
      if (!b1 || !b2) {
        continue;
      }
      if (segmentsCross(a1, a2, b1, b2, CONTAINMENT_EPSILON_MM)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * 台座ローカル座標でのスリット矩形の 4 隅を返す。
 * 幅（x）= 差込口幅、奥行方向の開口（y）= 板厚（＝ツメ深さ）、中心 = (0, 前後オフセット)。
 */
function slotRectCorners(slot: SlotResult): Point[] {
  const halfWidth = slot.widthMm / 2;
  const halfOpening = slot.tabDepthMm / 2;
  const cy = slot.depthOffsetMm;
  return [
    { x: -halfWidth, y: cy - halfOpening },
    { x: halfWidth, y: cy - halfOpening },
    { x: halfWidth, y: cy + halfOpening },
    { x: -halfWidth, y: cy + halfOpening },
  ];
}

/**
 * 重心の鉛直投影（台座ローカル座標）。
 * 板はスリットへ差し込まれるため、投影の奥行位置はスリット中心（前後オフセット）になる。
 * 支持・転倒角はこの 1 点だけを見る（stability と共有する定義）。
 */
export function centroidProjection(centroid: Centroid, slot: SlotResult): Point {
  return { x: centroid.mm.x - slot.centerXMm, y: slot.depthOffsetMm };
}

/**
 * 指定された台座形状・寸法が成立するかを検査し、台座の結果を組み立てる。
 *
 * footprint は analysis/footprint が形状パラメータから構築済みのものを受け取る（形状ごとの
 * 分岐はここには持ち込まない）。検査は上記 2 つ：スリットの内包（footprint そのものに対して。
 * 「材料の中に切れるか」）と、重心の支持（凸包に対して。「倒れずに立てるか」）。
 *
 * 支持範囲（オレンジ線・前面図の台座幅）は footprint の左右端。凸包の x 範囲は footprint の
 * bbox と一致するため、差込口中心 ± bbox幅/2 になる（矩形では従来の 差込口中心 ± 台座幅/2）。
 *
 * 重心高さは台座上面（接地面）から測る（SPEC）。台座上面はカットライン最下端 + 持ち上げ量で
 * 決まるため、画像下端ではなく baseTopYMm を基準にする。
 *
 * null（＝ baseCalculationFailed）を返すのは、入力が不正（非有限）な場合と、いずれかの検査を
 * 通らなかった場合。呼び出し側はこれをエラー表示へマッピングする。
 */
export function computeBase(
  centroid: Centroid,
  slot: SlotResult,
  baseTopYMm: number,
  footprint: Footprint,
): BaseResult | null {
  // 不正値を下流へ伝播させない。
  if (
    !Number.isFinite(centroid.mm.x) ||
    !Number.isFinite(slot.centerXMm) ||
    !Number.isFinite(slot.widthMm) ||
    !Number.isFinite(slot.tabDepthMm) ||
    !Number.isFinite(slot.depthOffsetMm) ||
    !Number.isFinite(baseTopYMm) ||
    !(slot.widthMm > 0) ||
    !(slot.tabDepthMm > 0)
  ) {
    return null;
  }

  // 検査 1：スリットが footprint の内側に完全に収まるか（縁を割らないか）。
  if (!polygonContainsRect(footprint.polyline, slotRectCorners(slot))) {
    return null;
  }

  // 検査 2：重心の鉛直投影が凸包の内側にあるか（静的に自立できるか）。
  if (!pointInPolygon(centroidProjection(centroid, slot), footprint.hull, CONTAINMENT_EPSILON_MM)) {
    return null;
  }

  // 支持範囲は footprint の左右端（bbox 中心が原点なので ± 幅/2）。
  const halfWidthMm = footprint.widthMm / 2;

  return {
    shape: footprint.shape,
    footprint,
    widthMm: footprint.widthMm,
    depthMm: footprint.depthMm,
    topYMm: baseTopYMm,
    supportLeftMm: slot.centerXMm - halfWidthMm,
    supportRightMm: slot.centerXMm + halfWidthMm,
  };
}
