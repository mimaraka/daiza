// 解析パイプライン：各解析ステップを 1 本の流れへ束ねる純粋オーケストレータ。
//
// パフォーマンス要件（SPEC「オーバーレイのみの更新で済む場合は画像解析全体を再実行
// しない」）のため、パイプラインを 2 相に分ける：
//
//   analyzeImage … 画像だけに依存する前処理（α マスク構築・アクリル領域の存在検査）。
//                  O(W×H)。画像が変わった時だけ実行し、マスクを画像不変量として保持する。
//   runAnalysis  … パラメータに依存する計算（カットライン・重心・差込口・台座・転倒角）。
//                  パラメータ変更ごとに呼ばれる。このうちカットライン生成（EDT 膨張＋
//                  輪郭抽出）だけは O(W×H) と重いため、依存パラメータを鍵にメモ化し、
//                  安全率スライダー等の無関係な変更では再計算しない。
//
// 3000px 級のフリーズ対策として、両相とも hooks/useAnalysis が Web Worker 上で駆動する
// （カットライン生成は「軽量な第 2 相」の例外で、実測でメインスレッドを塞ぐ重さがある
// ため）。いずれも React には依存しない純粋ロジックとし、この合成を hooks/useAnalysis が
// 「画像・パラメータの変化 → 状態更新 → 再描画」へ接続する（責務分離）。
//
// 各ステップは失敗を null で表す純粋関数として実装済みなので、ここでは順に呼び、
// null を初めて踏んだ段階に応じたエラー種別へマッピングして早期に返す。例外で
// クラッシュさせず、UI がメッセージ表示へ落とせる形（AnalysisError）で失敗を伝える。

import { computeBase } from '@/analysis/base';
import { polygonCentroid, toCentroid } from '@/analysis/centroid';
import { attachSlotTab, buildCutline } from '@/analysis/contour';
import { computeMmPerPixel, computePhysicalSize } from '@/analysis/scale';
import { findSlot } from '@/analysis/slot';
import { computeStability } from '@/analysis/stability';
import type {
  AnalysisError,
  AnalysisErrorKind,
  AnalysisParameters,
  AnalysisResult,
  Contour,
  FigureImage,
  Size,
} from '@/model/types';
import { buildAlphaMask } from '@/utils/image';

/**
 * パイプライン段で発生し得るエラー種別。
 * 読み込み系（imageLoadFailed / unsupportedImage）は前段の imageLoader が担うため、
 * ここではアクリル領域欠如・差込口配置不可・台座計算不可の 3 種のみを扱う。
 */
type PipelineErrorKind = Extract<
  AnalysisErrorKind,
  'transparentImage' | 'slotPlacementFailed' | 'baseCalculationFailed'
>;

/** UI へ提示するエラーメッセージ（日本語）。 */
const ERROR_MESSAGES: Record<PipelineErrorKind, string> = {
  transparentImage:
    'アクリル領域（α>0）が見つからないため解析できません。透明でないPNG画像を選択してください。',
  slotPlacementFailed:
    '差込口を配置できる位置が見つかりません。差込口幅を小さくするか、下端に十分な幅のある画像を使用してください。',
  baseCalculationFailed:
    '台座サイズを計算できません。安全率やフィギュア高さなどのパラメータを見直してください。',
};

/** 解析の成否。成功なら結果一式、失敗なら型付きエラー。 */
export type AnalysisOutcome =
  { ok: true; result: AnalysisResult } | { ok: false; error: AnalysisError };

/**
 * 画像だけに依存する解析（第 1 相）の成果物。
 * パラメータに一切依存しないため、画像が同じである限り再計算不要。呼び出し側
 * （Worker／フォールバック時の useAnalysis）が画像単位でメモ化し、パラメータ変更時は
 * runAnalysis の入力として使い回す。
 *
 * マスクは 1 バイト/画素（3000px 級で約 9MB）と大きいため、Worker 実行時は Worker 内に
 * 留め、メインスレッドへ構造化クローンで送らないこと（hooks/useAnalysis 参照）。
 *
 * 重心・外形はカットライン（余白・平滑化パラメータ依存）に対して求めるため、この相では
 * 確定できない。カットライン化（EDT 膨張・輪郭抽出）と重心計算は第 2 相（runAnalysis）が担う。
 */
export interface ImageAnalysis {
  /** 不透明領域（α>0）を 1 とする 1 バイト/画素のマスク。カットライン膨張の入力。 */
  mask: Uint8Array;
  /** マスクのピクセル寸法。 */
  width: number;
  height: number;
}

/** 第 1 相の成否。成功なら画像不変量、失敗なら型付きエラー（透明画像）。 */
export type ImageAnalysisOutcome =
  { ok: true; value: ImageAnalysis } | { ok: false; error: AnalysisError };

/**
 * 第 1 相が必要とする画像データの最小形。
 * ファイル名・id 等の付随情報には依存しないため、Web Worker 側が転送バッファから
 * この形だけを組み立てて解析できるよう、独立した狭い型で受ける（FigureImage は
 * React state 用に ImageBitmap を持ち、ImageData は含まない）。
 */
export interface ImagePixels {
  /** RGBA ピクセルデータ。α チャンネルだけを解析に使う。 */
  imageData: ImageData;
  width: number;
  height: number;
}

/** 型付きエラーを組み立てる小ヘルパー。 */
function makeError(kind: PipelineErrorKind): AnalysisError {
  return { kind, message: ERROR_MESSAGES[kind] };
}

/** エラー結果（第 2 相用）を組み立てる小ヘルパー。 */
function fail(kind: PipelineErrorKind): AnalysisOutcome {
  return { ok: false, error: makeError(kind) };
}

/**
 * 第 1 相：画像から不透明領域の α マスクを構築する。
 *
 * α 判定の全画素走査を 1 回にまとめ、以降の相（カットライン膨張・輪郭抽出）はこの
 * 1 バイト/画素マスクだけを参照する。この相はパラメータに依存しないため、画像が
 * 変わった時だけ実行すれば足りる。輪郭抽出はカットライン（余白パラメータ依存）の
 * 膨張マスクに対して第 2 相が行うので、ここでは行わない。
 *
 * α>0 が皆無なら透明画像として型付きエラーを返す。本来 imageLoader が読み込み段階で
 * 弾くが、防御的に検査する。
 */
export function analyzeImage(image: ImagePixels): ImageAnalysisOutcome {
  const { imageData, width, height } = image;

  // α マスク：カットライン膨張・輪郭抽出の画像不変な前処理。1 回だけ構築する。
  const mask = buildAlphaMask(imageData);

  // アクリル領域が無い（全透明）なら差込口・台座・転倒角の基準が取れないため弾く。
  if (!mask.includes(1)) {
    return { ok: false, error: makeError('transparentImage') };
  }

  return { ok: true, value: { mask, width, height } };
}

/**
 * カットラインのメモ。runAnalysis の入力パラメータのうちカットラインに影響するものが
 * 変わらない限り、O(W×H) の膨張・輪郭抽出を再実行しないための可変ホルダ。
 *
 * 呼び出し側が「同じ画像の連続した解析」の単位で 1 つ保持する（画像が変われば
 * 新しいメモに取り替える）。Worker 実行時は Worker 内の第 1 相キャッシュに同居させる。
 */
export interface CutlineMemo {
  key: string | null;
  contour: Contour | null;
}

/** 空のカットラインメモを作る。 */
export function createCutlineMemo(): CutlineMemo {
  return { key: null, contour: null };
}

/** カットラインが依存するパラメータだけから成るメモ鍵。 */
function cutlineKey(params: AnalysisParameters): string {
  return `${params.figureHeightMm}/${params.cutLineMarginMm}/${params.cutLineSmoothing}/${params.minBridgeWidthMm}`;
}

/**
 * 第 2 相：画像不変量（analyzeImage の結果）とパラメータから解析結果一式を求める。
 *
 * スケール（mm/px）をまず確定し、以降の幾何はすべてピクセル座標で計算して結果の
 * 段で mm へ換算する。各ステップの null は「その段で計算不能」を意味し、意味の近い
 * エラー種別へ写して早期に返す。全段を通れば AnalysisResult を組み立てて返す。
 *
 * 唯一重いのはカットライン生成（EDT 膨張＋輪郭抽出、O(W×H)）で、cutlineMemo を渡せば
 * 依存パラメータ（フィギュア高さ・余白・平滑化・連結最小幅）が同じ間は再利用される。
 * それ以外（重心・差込口・台座・転倒角）は頂点数に比例する軽量計算のみ。
 *
 * image は寸法だけを使うため、Worker 側は ImageData を持たない {width, height} でも呼べる。
 */
export function runAnalysis(
  image: Pick<FigureImage, 'width' | 'height'>,
  imageAnalysis: ImageAnalysis,
  params: AnalysisParameters,
  cutlineMemo?: CutlineMemo,
): AnalysisOutcome {
  const { width, height } = image;

  // スケールが出せないと以降の実寸計算がすべて破綻する。UI の入力制約下では起きない
  // が、防御的に検査し、計算不能として扱う（下流へ NaN を伝播させない）。
  const mmPerPixel = computeMmPerPixel(params.figureHeightMm, height);
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
    return fail('baseCalculationFailed');
  }

  // α マスクを余白ぶん膨張・平滑化した「カットライン」を確定する。以降の重心・台座・
  // オーバーレイ・SVG はすべてこのカットライン（が囲む領域）を外形として扱う。
  // 余白 mm・連結部最小幅 mm はスケールでピクセルへ換算する（解析はピクセル座標で完結）。
  // O(W×H) と重いため、依存パラメータが変わらない限りメモから再利用する。
  const key = cutlineKey(params);
  let contour: Contour;
  if (cutlineMemo && cutlineMemo.key === key && cutlineMemo.contour) {
    contour = cutlineMemo.contour;
  } else {
    const marginPx = params.cutLineMarginMm / mmPerPixel;
    const minBridgeWidthPx = params.minBridgeWidthMm / mmPerPixel;
    contour = buildCutline(
      imageAnalysis.mask,
      imageAnalysis.width,
      imageAnalysis.height,
      marginPx,
      params.cutLineSmoothing,
      minBridgeWidthPx,
    );
    if (cutlineMemo) {
      cutlineMemo.key = key;
      cutlineMemo.contour = contour;
    }
  }

  // 重心はカットラインが囲む領域の面積重心。差込口・台座・転倒角の基準になる。
  const centroidPixel = polygonCentroid(contour);
  if (!centroidPixel) {
    return fail('baseCalculationFailed');
  }
  const centroid = toCentroid(centroidPixel, mmPerPixel);

  // 差込口中心は重心の真下＋オフセット。縦位置はカットライン足元を基準に決める。
  const slot = findSlot(contour, centroid, params.slotWidthMm, params.slotOffsetMm, mmPerPixel);
  if (!slot) {
    return fail('slotPlacementFailed');
  }

  // ツメが本体から離れている場合はカットラインを足元まで下方向へ拡張して一体化する。
  // 以降 result.contour（オーバーレイ・SVG が参照）はこの拡張後の外形になる。
  const finalContour = attachSlotTab(
    contour,
    slot.centerXPixel - slot.widthPixel / 2,
    slot.centerXPixel + slot.widthPixel / 2,
    slot.bottomYPixel,
  );

  const base = computeBase(centroid, slot, params);
  if (!base) {
    return fail('baseCalculationFailed');
  }

  // 転倒角の失敗（重心高さ 0 等）も、幾何的に自立し得ない＝台座計算不可の一種として扱う。
  const stability = computeStability(centroid, base, params);
  if (!stability) {
    return fail('baseCalculationFailed');
  }

  const imageSize: Size = { width, height };
  return {
    ok: true,
    result: {
      imageSize,
      physicalSize: computePhysicalSize(imageSize, mmPerPixel),
      mmPerPixel,
      contour: finalContour,
      centroid,
      slot,
      base,
      stability,
    },
  };
}
