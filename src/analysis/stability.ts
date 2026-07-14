// 転倒シミュレーション：各方向の転倒角と、全方位で最小の転倒角（最悪方向）を求める。
//
// 台座に立ったフィギュアは、外力で傾けられると支持範囲の「端」を支点に回転して倒れる。ある方向へ
// 倒れ始める限界は、重心の鉛直投影がその支点の真上に到達した瞬間であり、そこまでに必要な傾き角が
// 「転倒角」＝その方向の転倒に対する余裕を表す。角が大きいほど倒れにくい。React 非依存の純粋ロジック。
//
// SPEC の定義：
//   θ(d) = atan(支持端距離(d) / 重心高さ)
//   支持端距離(d) = h(d) − ⟨g, d⟩
//     h(d) … footprint 凸包の**支持関数**（凸包の頂点 v にわたる max ⟨v, d⟩）
//     g    … 重心の鉛直投影（台座ローカル座標 (重心X − 差込口中心X, 前後オフセット)）
//   ・重心高さ … 台座上面（接地面）から測った重心の高さ。方向によらず一定（重心は板の面内に
//     あり、奥行方向へ傾けても高さは変わらない）。
//
// 左右前後は d = (−1,0)／(+1,0)／(0,+1)／(0,−1) の特殊形（y は前が正）。矩形 footprint では
// h(±x) = 台座幅/2、h(±y) = 台座奥行/2 となり、従来式（支持範囲の端・台座奥行と前後オフセット）と
// 厳密に一致する。
//
// 最小転倒角（最悪方向）は探索不要で閉形式に落ちる：支持端距離の全方位にわたる最小値は
// **g から凸包の最近傍辺（の載る支持直線）までの距離**に等しく、最悪方位はその辺の外向き法線。
// 非対称な footprint（正多角形・任意形状）では最悪方向が斜めになり得るため、4 方向だけでは
// 見落とす（対称形では 4 方向の最小と一致する）。

import { centroidProjection } from '@/analysis/base';
import type { BaseResult, Centroid, Point, SlotResult, StabilityResult } from '@/model/types';
import { radToDeg } from '@/utils/geometry';

/** 単位方向 d に対する凸包の支持関数 h(d) = max ⟨v, d⟩。 */
function supportValue(hull: readonly Point[], dx: number, dy: number): number {
  let best = Number.NEGATIVE_INFINITY;
  for (const v of hull) {
    const value = v.x * dx + v.y * dy;
    if (value > best) {
      best = value;
    }
  }
  return best;
}

/** 方向 d へ倒すときの支持端距離（＝ h(d) − ⟨g, d⟩）。負値は 0 へ丸めない（検査の破れを隠さない）。 */
function supportDistance(hull: readonly Point[], g: Point, dx: number, dy: number): number {
  return supportValue(hull, dx, dy) - (g.x * dx + g.y * dy);
}

/** θ = atan(支持端距離 / 重心高さ) を度で返す。SPEC の定義そのもの。 */
function tippingAngleDeg(distanceMm: number, heightMm: number): number {
  return radToDeg(Math.atan(distanceMm / heightMm));
}

/** 最小転倒角の探索結果（最悪方向の支持端距離と方位角）。 */
interface WorstDirection {
  distanceMm: number;
  /** 方位角(度、0〜360)。右 0°・前 90°・左 180°・後 270°。 */
  azimuthDeg: number;
}

/**
 * 重心投影 g から最も近い凸包の辺（の支持直線）を探し、その距離と外向き法線の方位を返す。
 *
 * 支持端距離(d) の d にわたる最小値がこの距離に等しい：凸包を法線 d の直線で支えたときの
 * 支持端距離は「g から支持直線までの距離」であり、d を回すと支持直線は凸包の各辺を順に
 * なぞるため、最小は「最近傍辺の載る直線までの距離」になる。
 *
 * 頂点が 3 未満（退化）の凸包では方向が定まらないため null。
 */
function worstDirection(hull: readonly Point[], g: Point): WorstDirection | null {
  const n = hull.length;
  if (n < 3) {
    return null;
  }

  // 外向き法線を得るため、凸包の巻き方向を符号付き面積から判定する（convexHull の実装に
  // 依存しないようにする）。反時計回り（面積 > 0）なら辺 a→b の外向き法線は (dy, −dx)。
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    if (!a || !b) continue;
    area2 += a.x * b.y - b.x * a.y;
  }
  const orientation = area2 >= 0 ? 1 : -1;

  let best: WorstDirection | null = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    if (!a || !b) continue;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (!(len > 0)) continue;

    // 外向き単位法線。
    const nx = (orientation * ey) / len;
    const ny = (orientation * -ex) / len;
    // この法線方向の支持直線は辺の上に載るので、支持端距離は g から直線までの符号付き距離。
    const distance = (a.x - g.x) * nx + (a.y - g.y) * ny;
    if (!best || distance < best.distanceMm) {
      best = { distanceMm: distance, azimuthDeg: azimuthOf(nx, ny) };
    }
  }
  return best;
}

/** 方向ベクトルの方位角(度、0〜360)。右 0°・前 90°（y が前）。 */
function azimuthOf(dx: number, dy: number): number {
  const deg = radToDeg(Math.atan2(dy, dx));
  return (deg + 360) % 360;
}

/**
 * 転倒角を左右・前後の 4 方向と、全方位の最小について計算する。
 *
 * 支持範囲は台座 footprint の凸包（base.footprint.hull、台座ローカル座標）。重心の鉛直投影も
 * 同じローカル座標で取り（analysis/base と共有）、支持関数で各方向の支持端距離を求める。
 *
 * null を返すのは、入力が非有限か、重心高さが正でない場合、または凸包が退化している場合。
 * 重心が接地面上（高さ 0）だと分母が 0 になり atan が定義できない（幾何的にも自立し得ない）ため、
 * 台座計算失敗と同様に呼び出し側でエラー扱いできるよう null とする。
 *
 * なお成立した構成では重心投影は凸包の内側にある（base.ts が検査済み）ため、どの方向の支持端
 * 距離も非負になり、転倒角も非負で得られる。
 */
export function computeStability(
  centroid: Centroid,
  slot: SlotResult,
  base: BaseResult,
): StabilityResult | null {
  const hull = base.footprint.hull;
  const g = centroidProjection(centroid, slot);

  // 台座上面（接地面）から測った重心高さ。全方向で共通。
  const centroidHeightMm = base.topYMm - centroid.mm.y;

  if (
    !Number.isFinite(g.x) ||
    !Number.isFinite(g.y) ||
    !Number.isFinite(centroidHeightMm) ||
    centroidHeightMm <= 0 ||
    hull.length < 3
  ) {
    return null;
  }

  const worst = worstDirection(hull, g);
  if (!worst) {
    return null;
  }

  return {
    tippingAngleLeftDeg: tippingAngleDeg(supportDistance(hull, g, -1, 0), centroidHeightMm),
    tippingAngleRightDeg: tippingAngleDeg(supportDistance(hull, g, 1, 0), centroidHeightMm),
    tippingAngleFrontDeg: tippingAngleDeg(supportDistance(hull, g, 0, 1), centroidHeightMm),
    tippingAngleBackDeg: tippingAngleDeg(supportDistance(hull, g, 0, -1), centroidHeightMm),
    tippingAngleMinDeg: tippingAngleDeg(worst.distanceMm, centroidHeightMm),
    worstAzimuthDeg: worst.azimuthDeg,
  };
}
