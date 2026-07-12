// スケール計算：フィギュア高さ(mm)と画像高さ(px)から mm/px 換算係数を求める。
//
// 解析パイプライン（重心・差込口・台座…）はすべてピクセル座標で計算し、
// 結果表示・SVG 生成の段でここで得た mmPerPixel を掛けて実寸へ変換する。
// スケールの定義を一箇所へ集約することで、各層が同じ換算規則を共有する。
//
// React には依存しない純粋ロジック。

import type { AnalysisParameters, Point, Size } from '@/model/types';

/** スケール算出に必要なパラメータだけを抜き出した最小の入力。 */
export type ScaleParameters = Pick<
  AnalysisParameters,
  'figureHeightMm' | 'cutLineMarginMm' | 'plateLiftMm' | 'thicknessMm'
>;

/**
 * フィギュア高さのうち、絵柄（不透明領域）そのものではない部分の実寸(mm)。
 *
 * フィギュア高さは「接地面（台座底面）から**カットライン**（絵柄＋余白）の上端まで」の
 * 全高なので、絵柄の上下にそれぞれ次の高さが乗る：
 *   上：カットライン余白（絵柄の上端より上へ外形が広がるぶん）
 *   下：カットライン余白 ＋ アクリル板の持ち上げ量 ＋ 板厚（＝台座の厚み＝ツメ深さ）
 * スケール算出ではこの合計を差し引いて、絵柄そのものの高さ(mm)を得る。
 */
export function computeOutsideArtworkMm(params: ScaleParameters): number {
  return 2 * params.cutLineMarginMm + params.plateLiftMm + params.thicknessMm;
}

/**
 * mm/px 換算係数を求める。
 *
 * SPEC の定義では、フィギュア高さは**接地面（台座底面）からカットライン（絵柄＋余白）の
 * 上端まで**の全高である（＝ルーラーの Y 原点が接地面なので、カットライン上端の目盛りが
 * そのままフィギュア高さになる）。一方でピクセルで測れるのは絵柄の上端〜下端だけなので、
 *
 *   フィギュア高さ = 絵柄の高さ + 絵柄の外側の高さ（余白×2 + 持ち上げ量 + 板厚）
 *
 * を解いて mm/px を得る。画像高さではなく絵柄の高さを基準にするのは、PNG の透明余白の
 * 量でフィギュアの実寸が変わってしまわないようにするためでもある。
 *
 * figureHeightPixels は絵柄の上端・下端の**点間距離**（maxY − minY）であり、画素数
 * （+1）ではない。カットライン・台座・ルーラーがすべて同じ点座標系で位置を測るため、
 * こちらを使うとルーラーの読みと指定値が一致する。
 *
 * 差し引き後の絵柄高さが 0 以下（フィギュア高さが絵柄の外側の高さ以下）や、絵柄が高さを
 * 持たない退化入力では、ゼロ除算・不正値を下流へ伝播させないため計算不能を示す NaN を返し、
 * 呼び出し側で型付きエラーへ写す。
 */
export function computeMmPerPixel(params: ScaleParameters, figureHeightPixels: number): number {
  const artworkHeightMm = params.figureHeightMm - computeOutsideArtworkMm(params);
  if (!(artworkHeightMm > 0) || !(figureHeightPixels > 0)) {
    return Number.NaN;
  }
  return artworkHeightMm / figureHeightPixels;
}

/** 1 インチ = 25.4 mm（DPI 換算の定義値）。 */
const MM_PER_INCH = 25.4;

/**
 * 絵柄画像の実効解像度(DPI)を求める。
 *
 * mm/px は「画像 1px が実寸で何 mm になるか」なので、その逆数（px/mm）へ 25.4 を掛けると
 * 1 インチあたりの画素数、すなわち印刷時の解像度になる。フィギュア高さ(mm)を変えると
 * 同じ PNG でも実寸が伸縮するため、DPI は入力画像固有の値ではなく**解析結果**である
 * （印刷に耐える画素密度か＝画像の解像度が足りているかの判断材料になる）。
 */
export function computeDpi(mmPerPixel: number): number {
  return MM_PER_INCH / mmPerPixel;
}

/** ピクセル長を実寸(mm)へ換算する。 */
export function pixelLengthToMm(lengthPixel: number, mmPerPixel: number): number {
  return lengthPixel * mmPerPixel;
}

/** ピクセル座標の点を実寸(mm)座標へ換算する。 */
export function pixelPointToMm(pointPixel: Point, mmPerPixel: number): Point {
  return {
    x: pointPixel.x * mmPerPixel,
    y: pointPixel.y * mmPerPixel,
  };
}

/** 画像のピクセル寸法を実寸(mm)寸法へ換算する。 */
export function computePhysicalSize(imageSize: Size, mmPerPixel: number): Size {
  return {
    width: imageSize.width * mmPerPixel,
    height: imageSize.height * mmPerPixel,
  };
}
