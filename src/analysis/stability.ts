// 転倒シミュレーション：左右方向それぞれの転倒角を求める。
//
// 台座に立ったフィギュアは、外力で傾けられると支持範囲の「端」を支点に回転して
// 倒れる。ある方向へ倒れ始める限界は、重心の鉛直投影がその支点の真上に到達した
// 瞬間であり、そこまでに必要な傾き角が「転倒角」＝その方向の転倒に対する余裕を表す。
// 角が大きいほど倒れにくい。React には依存しない純粋ロジック。
//
// SPEC の定義：
//   θ = atan(支持端距離 / 重心高さ)
//   ・支持端距離：重心の鉛直投影から、倒れる側の支持端までの水平距離。
//   ・重心高さ ：台座上面（接地面）から測った重心の高さ。
//   左右それぞれについて計算する。
//
// 幾何は base.ts が確定した支持範囲（supportLeftMm / supportRightMm）と台座上面
// （topYMm）をそのまま使い、台座計算と同じ基準で角度を出す（いずれも mm 座標）。

import type { BaseResult, Centroid, StabilityResult } from '@/model/types';
import { radToDeg } from '@/utils/geometry';

/**
 * 転倒角を左右それぞれ計算する。
 *
 * 左へ倒れる支点は支持範囲の左端 supportLeftMm、右へ倒れる支点は右端
 * supportRightMm。重心の鉛直投影 centroidXMm から各支点までの水平距離を分子、
 * 重心高さ centroidHeightMm を分母に取り、θ = atan(距離 / 高さ) を度で返す。
 *
 * 重心高さは base.ts と同一の式（台座上面 topYMm − 重心の mm-y）。台座上面は
 * カットライン最下端 + 持ち上げ量で決まるため、画像下端ではなくこの線を基準にする。
 *
 * null を返すのは、入力が非有限か、重心高さが正でない場合。重心が接地面上
 * （高さ 0）だと分母が 0 になり atan が定義できない（幾何的にも自立し得ない）ため、
 * 台座計算失敗と同様に呼び出し側でエラー扱いできるよう null とする。
 *
 * なお安定な構成では重心は支持範囲内にある（base.ts が保証）ため、両距離は
 * いずれも非負になり、転倒角も非負で得られる。
 */
export function computeStability(centroid: Centroid, base: BaseResult): StabilityResult | null {
  const centroidXMm = centroid.mm.x;
  const { supportLeftMm, supportRightMm, topYMm } = base;

  // 台座上面（接地面）から測った重心高さ。base.ts と同じ導出。
  const centroidHeightMm = topYMm - centroid.mm.y;

  // 不正値・ゼロ除算を下流へ伝播させない。高さが正でなければ角度は定義できない。
  if (
    !Number.isFinite(centroidXMm) ||
    !Number.isFinite(supportLeftMm) ||
    !Number.isFinite(supportRightMm) ||
    !Number.isFinite(centroidHeightMm) ||
    centroidHeightMm <= 0
  ) {
    return null;
  }

  // 各支点までの水平距離。支持範囲内なら左右いずれも非負になる。
  const distanceLeftMm = centroidXMm - supportLeftMm;
  const distanceRightMm = supportRightMm - centroidXMm;

  return {
    tippingAngleLeftDeg: tippingAngleDeg(distanceLeftMm, centroidHeightMm),
    tippingAngleRightDeg: tippingAngleDeg(distanceRightMm, centroidHeightMm),
  };
}

/** θ = atan(支持端距離 / 重心高さ) を度で返す。SPEC の定義そのもの。 */
function tippingAngleDeg(distanceMm: number, heightMm: number): number {
  return radToDeg(Math.atan(distanceMm / heightMm));
}
