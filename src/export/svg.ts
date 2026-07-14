// SVG エクスポート（純粋ロジック、React / DOM 非依存）。
//
// AnalysisResult を実寸(mm)座標系の SVG 文字列へ変換する。SPEC のエクスポート指定
// どおり「外形・差込口・台座」の 3 要素を描き、支持範囲・重心・鉛直線などの
// プレビュー専用オーバーレイは含めない。絵柄画像は任意で最背面へ重ねられる（下記）。
// ダウンロード（Blob 生成・a要素クリック）は DOM 依存の副作用のため本モジュールには
// 置かず、呼び出し側（App）に委ねる。こうして生成ロジックを純粋に保つことで、
// テスト容易性と将来の WebAssembly 置き換えに備える。
//
// 図形の座標（mm）は export/geometry へ集約し、.ai エクスポートと同一の幾何を共有する。
// SVG の user unit を mm と 1:1 に対応させる（width/height に "mm" を付し、viewBox の
// 数値をそのまま mm とみなす）ため、印刷・CAD 取り込み時に実寸となる。

import {
  buildExportGeometry,
  EXPORT_COLORS,
  fmt,
  strokeWidthMm,
  type ExportGeometry,
  type RectMm,
} from '@/export/geometry';
import type { AnalysisResult } from '@/model/types';
import { closedCurvePathData, curvePathData } from '@/utils/curve';

/** generateSvg の切り替え。 */
export interface SvgExportOptions {
  /**
   * 絵柄画像の data URL。指定したときだけ画像を最背面へ埋め込む。
   * 画素データの取得は DOM（canvas）依存なので、本モジュールは data URL を受け取るに
   * とどめ、生成は呼び出し側（export/raster）に任せる。
   */
  imageHref?: string;
}

/** 矩形を SVG rect 要素文字列へ変換する。 */
function rectElement(rect: RectMm, attrs: string): string {
  return `<rect x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.width)}" height="${fmt(rect.height)}" ${attrs} />`;
}

/** 絵柄画像を実寸で置く image 要素。カットラインと同じ mm 座標系にそのまま乗る。 */
function imageElement(geometry: ExportGeometry, href: string): string {
  const { image } = geometry;
  return (
    `<image href="${href}" x="${fmt(image.x)}" y="${fmt(image.y)}" ` +
    `width="${fmt(image.width)}" height="${fmt(image.height)}" preserveAspectRatio="none" />`
  );
}

/**
 * 解析結果から実寸(mm)座標系の SVG ドキュメント文字列を生成する。
 *
 * 塗りは持たせず輪郭線のみとし、外形・差込口・台座を色分けする。options.imageHref を
 * 渡した場合のみ絵柄画像を最背面に敷き、線データが絵柄の上に載った状態で出力する。
 */
export function generateSvg(result: AnalysisResult, options: SvgExportOptions = {}): string {
  const { imageHref } = options;
  const geometry = buildExportGeometry(result, { includeImage: imageHref !== undefined });
  const { viewBox } = geometry;

  const strokeAttr = `stroke-width="${fmt(strokeWidthMm(viewBox))}"`;
  const viewBoxAttr = `${fmt(viewBox.x)} ${fmt(viewBox.y)} ${fmt(viewBox.width)} ${fmt(viewBox.height)}`;

  // 外形（カットライン）は折れ線ではなく曲線補完した path（C コマンド）で出力する（SPEC 要件）。
  // 差込部の肩（首部とツメの接合部）だけは丸めず直角のまま出す（加工寸法に直結するため）。
  const contourEl =
    `<path d="${closedCurvePathData(geometry.contour, fmt, { sharpCorners: geometry.sharpCorners })}" ` +
    `fill="none" stroke="${EXPORT_COLORS.contour}" ${strokeAttr} />`;
  // 差込部は首部・ツメの 2 矩形。どちらも外形（カットライン）に含まれるが、加工時に
  // 差込部だと判別できるよう独立した矩形としても出力する。
  const neckEl = rectElement(
    geometry.neck,
    `fill="none" stroke="${EXPORT_COLORS.slot}" ${strokeAttr}`,
  );
  const tabEl = rectElement(
    geometry.tab,
    `fill="none" stroke="${EXPORT_COLORS.slot}" ${strokeAttr}`,
  );
  // 台座は「台座形状」で選んだ footprint の上面図。矩形以外（円・楕円・角丸・任意形状）も
  // カットラインと同じく曲線コマンドで出力する（footprint のパス表現をそのまま写す）。
  const baseEl =
    `<path d="${curvePathData(geometry.base.curve, fmt)}" ` +
    `fill="none" stroke="${EXPORT_COLORS.base}" ${strokeAttr} />`;
  // 台座に切るスリット（差込口）。台座の内側に置かれるため、台座より後に描いて重ねる。
  const baseSlotEl = rectElement(
    geometry.baseSlot,
    `fill="none" stroke="${EXPORT_COLORS.slot}" ${strokeAttr}`,
  );

  // 画像は線データに隠されないよう最背面（先頭）へ。fill/stroke の既定は g に持たせるが、
  // image はそれらの影響を受けないのでグループ内に置いて差し支えない。
  const elements = [
    ...(imageHref !== undefined ? [imageElement(geometry, imageHref)] : []),
    contourEl,
    neckEl,
    tabEl,
    baseEl,
    baseSlotEl,
  ];

  // width/height に "mm" を付け、viewBox の数値を mm と 1:1 対応させて実寸出力とする。
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${fmt(viewBox.width)}mm" height="${fmt(viewBox.height)}mm" ` +
      `viewBox="${viewBoxAttr}">`,
    '  <title>Daiza 台座設計図（実寸 mm）</title>',
    `  <g fill="none" stroke-linejoin="round">`,
    ...elements.map((el) => `    ${el}`),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}
