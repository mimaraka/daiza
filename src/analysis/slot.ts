// 差込部の配置：中心を「重心X + 差込口オフセット」に置き、「首部＋ツメ」の 2 矩形を確定する。
//
// アクリルフィギュアは下端の「ツメ」を台座のスリット（差込口）へ挿し込む。SPEC の改訂により、
// 差込部は画像最下部の充填スパンから探索するのではなく、
//
//   差込部中心 X = 重心X + 差込口オフセット
//
// で決める。差込部は基本的に重心の真下へ置き、左右方向の微調整だけをオフセットで行う。
//
// 縦方向は台座上面（カットライン最下端 + 持ち上げ量。呼び出し側が算出）を境界に 2 段構成とする：
//
//   首部 … 幅 = 首部幅。カットライン下辺〜台座上面。板と台座の隙間・板下端の凹凸を埋める。
//   ツメ … 幅 = 差込口幅（首部より狭い）。台座上面から板厚ぶん下へ挿さる。
//
// 幅の差でできる肩（ショルダー）が台座上面に乗ることで、挿入深さがツメ深さ（板厚）で止まる。
// この肩が設計上の要であり、首部幅 ≦ 差込口幅 では成立しないため制約として検査する
// （通常は model/state の normalizeParameters が状態遷移の時点で成立させている）。
//
// 実際のカットライン拡張（首部・ツメを外形へ一体化する）は analysis/contour の
// attachSlotBody が担う。ここではその形状（矩形 2 つ）と接続位置だけを決める。
//
// React には依存しない純粋ロジック。座標は画像左上原点・下方向 +Y。

import { lowerCrossing } from '@/analysis/contour';
import { pixelLengthToMm } from '@/analysis/scale';
import { minNeckWidthMm } from '@/model/state';
import type { AnalysisParameters, Centroid, Contour, SlotResult } from '@/model/types';

/**
 * 差込部（首部・ツメ）の位置と形状を決める。
 *
 * 中心 X は「重心X + 差込口オフセット」。首部は、その中心に首部幅ぶんの矩形を取り、
 * 上端をカットライン下辺（左右端の下辺交点のうち浅い方＝板と確実に重なる高さ）に、
 * 下端を台座上面 baseTopYPixel に合わせる。ツメは台座上面から板厚ぶん下へ伸ばす。
 *
 * null（＝差込口配置不可）を返すのは：
 *  - カットラインが退化（3 頂点未満）／スケール・幅・オフセットが不正
 *  - 首部幅が下限（差込口幅 + 2×最小ショルダー幅）を割り、肩が成立しない
 *  - 首部の左右端がカットラインの下辺と交わらない（差込部が板から外れており一体化できない）
 * いずれも呼び出し側で slotPlacementFailed へマッピングさせる。
 */
export function findSlot(
  contour: Contour,
  centroid: Centroid,
  params: AnalysisParameters,
  mmPerPixel: number,
  baseTopYPixel: number,
): SlotResult | null {
  const { slotWidthMm, slotOffsetMm, neckWidthMm, thicknessMm } = params;

  if (contour.length < 3 || !(mmPerPixel > 0) || !Number.isFinite(baseTopYPixel)) {
    return null;
  }

  // 肩が消えると板がツメより深く台座へ刺さり込む。制約が破れていれば配置不可として扱う。
  if (!(neckWidthMm >= minNeckWidthMm(slotWidthMm))) {
    return null;
  }

  const slotWidthPixel = slotWidthMm / mmPerPixel;
  const neckWidthPixel = neckWidthMm / mmPerPixel;
  const tabDepthPixel = thicknessMm / mmPerPixel;
  const offsetPixel = slotOffsetMm / mmPerPixel;
  if (
    !(slotWidthPixel > 0) ||
    !(neckWidthPixel > 0) ||
    !(tabDepthPixel > 0) ||
    !Number.isFinite(offsetPixel)
  ) {
    return null;
  }

  // SPEC の定義どおり、差込部中心は重心の真下（重心X）＋左右オフセット。
  const centerXPixel = centroid.pixel.x + offsetPixel;
  const neckLeftX = centerXPixel - neckWidthPixel / 2;
  const neckRightX = centerXPixel + neckWidthPixel / 2;

  // 首部の左右端がカットライン下辺と交わる高さ。ここが首部と板本体の接続部になる。
  // 交点が無い＝差込部が板の外にはみ出しており、一体形状としてカットできない。
  const left = lowerCrossing(contour, neckLeftX);
  const right = lowerCrossing(contour, neckRightX);
  if (!left || !right) {
    return null;
  }

  // 浅い（Y の小さい）方を首部の上端に取り、左右どちらの側でも板と確実に重なるようにする。
  const neckTopY = Math.min(left.y, right.y);
  // 台座上面は必ずカットライン最下端以下にあるため、首部高さは非負になる（持ち上げ量 0 で
  // 最深部が台座上面に接する場合は 0 に潰れ得るので、負値だけを防いでおく）。
  const neckHeight = Math.max(0, baseTopYPixel - neckTopY);

  return {
    centerXPixel,
    // 中心 X はピクセル座標の位置。原点 0 起点なので長さ換算と同じ乗算でよい。
    centerXMm: pixelLengthToMm(centerXPixel, mmPerPixel),
    baseTopYPixel,
    neck: {
      xPixel: neckLeftX,
      yPixel: neckTopY,
      widthPixel: neckWidthPixel,
      heightPixel: neckHeight,
    },
    tab: {
      xPixel: centerXPixel - slotWidthPixel / 2,
      yPixel: baseTopYPixel,
      widthPixel: slotWidthPixel,
      heightPixel: tabDepthPixel,
    },
    // 幅・深さは与えられた実寸値をそのまま保持し、往復換算による丸め誤差を避ける。
    widthMm: slotWidthMm,
    neckWidthMm,
    // ツメ深さは板厚に固定（SPEC）。台座奥行はこの値を内包する大きさに取られる（base.ts）。
    tabDepthMm: thicknessMm,
  };
}
