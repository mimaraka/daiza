// 解析パイプライン：各解析ステップを 1 本の流れへ束ねる純粋オーケストレータ。
//
// パフォーマンス要件（SPEC「オーバーレイのみの更新で済む場合は画像解析全体を再実行
// しない」）のため、パイプラインを 2 相に分ける：
//
//   analyzeImage … 画像だけに依存する前処理（α プレーン抽出）。O(W×H)。画像が変わった
//                  時だけ実行し、α 値そのものを画像不変量として保持する。
//   runAnalysis  … パラメータに依存する計算（二値化・カットライン・重心・差込口・台座・
//                  転倒角）。パラメータ変更ごとに呼ばれる。このうち二値化とカットライン
//                  生成（EDT 膨張＋隙間埋め＋輪郭抽出）は O(W×H) と重いため、依存パラメータ
//                  を鍵に段ごとメモ化し、台座幅等の無関係な変更では再計算しない。
//
// 不透明判定のしきい値（alphaThreshold）がユーザーパラメータであるため、二値マスクは
// 画像不変量ではない。第 1 相は α 値のプレーンまでを担い、二値化は第 2 相が行う。
//
// 3000px 級のフリーズ対策として、両相とも hooks/useAnalysis が Web Worker 上で駆動する
// （カットライン生成は「軽量な第 2 相」の例外で、実測でメインスレッドを塞ぐ重さがある
// ため）。いずれも React には依存しない純粋ロジックとし、この合成を hooks/useAnalysis が
// 「画像・パラメータの変化 → 状態更新 → 再描画」へ接続する（責務分離）。
//
// 各ステップは失敗を null で表す純粋関数として実装済みなので、ここでは順に呼び、
// null を初めて踏んだ段階に応じたエラー種別へマッピングして早期に返す。例外で
// クラッシュさせず、UI がメッセージ表示へ落とせる形（AnalysisError）で失敗を伝える。

import { computeBase, computeBaseTopYPixel } from '@/analysis/base';
import { polygonCentroid, toCentroid } from '@/analysis/centroid';
import {
  attachSlotBody,
  buildCutlineMask,
  cutlineFromMask,
  neckFillPolygon,
  unionSlotRects,
} from '@/analysis/contour';
import type { DilatedMask } from '@/analysis/distance';
import { buildFootprint } from '@/analysis/footprint';
import { computeDpi, computeMmPerPixel, computePhysicalSize } from '@/analysis/scale';
import { findSlot } from '@/analysis/slot';
import { computeStability } from '@/analysis/stability';
import type {
  AnalysisError,
  AnalysisErrorKind,
  AnalysisParameters,
  AnalysisResult,
  BaseShapeSource,
  Contour,
  FigureImage,
  Size,
  SlotResult,
} from '@/model/types';
import {
  extractAlphaPlane,
  isAcrylicAlpha,
  MIN_ALPHA_THRESHOLD,
  opaqueRowRange,
  thresholdAlphaPlane,
} from '@/utils/image';

/**
 * パイプライン段で発生し得るエラー種別。
 * 読み込み系（imageLoadFailed / unsupportedImage）は前段の imageLoader が担うため、
 * ここではアクリル領域欠如・スケール計算不可・差込口配置不可・台座形状不可・台座計算不可を扱う。
 */
type PipelineErrorKind = Extract<
  AnalysisErrorKind,
  | 'transparentImage'
  | 'scaleCalculationFailed'
  | 'slotPlacementFailed'
  | 'baseShapeFailed'
  | 'baseCalculationFailed'
>;

/** UI へ提示するエラーメッセージ（日本語）。 */
const ERROR_MESSAGES: Record<PipelineErrorKind, string> = {
  transparentImage:
    'アクリル領域が見つからないため解析できません。アルファ閾値を下げる、または透明でないPNG画像を選択してください。',
  scaleCalculationFailed:
    'フィギュア高さが小さすぎます。フィギュア高さは「接地面（台座底面）からカットライン（絵柄＋余白）の上端まで」の全高です。カットライン余白×2＋アクリル板の持ち上げ量＋板厚 より大きい値を指定してください。',
  slotPlacementFailed:
    '差込部（首部・ツメ）を配置できません。首部の左右端が板からはみ出している可能性があります。首部幅を小さくする、差込口オフセットを小さくする、などパラメータを見直してください。',
  baseShapeFailed:
    '台座形状が利用できません。任意形状を選んでいる場合は台座形状ソース（PNG / SVG）を読み込んでください。台座の寸法（幅・奥行・直径）が正しいかも確認してください。',
  baseCalculationFailed:
    '台座サイズを計算できません。指定した台座では重心を支えられない、またはスリット（幅=差込口幅・開口=板厚）が台座の縁を割っている可能性があります。台座を大きくする、差込口オフセット（左右・前後）を小さくする、などパラメータを見直してください。',
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
 * 保持するのは二値マスクではなく **α 値そのもの**である：不透明判定のしきい値
 * （alphaThreshold）はユーザーパラメータであり、二値マスクはしきい値に依存するため
 * 画像不変量にならない。α プレーンなら 1 バイト/画素（3000px 級で約 9MB）で、しきい値
 * 変更時も RGBA（36MB）を抱え直さずに二値化し直せる。この大きさゆえ Worker 実行時は
 * Worker 内に留め、メインスレッドへ構造化クローンで送らないこと（hooks/useAnalysis 参照）。
 *
 * 重心・外形はカットライン（しきい値・余白・平滑化パラメータ依存）に対して求めるため、
 * この相では確定できない。二値化・カットライン化（EDT 膨張・輪郭抽出）・重心計算は
 * 第 2 相（runAnalysis）が担う。
 */
export interface ImageAnalysis {
  /** α チャンネルのみを抜き出した 1 バイト/画素のプレーン。二値化（第 2 相）の入力。 */
  alpha: Uint8Array;
  /** プレーンのピクセル寸法。 */
  width: number;
  height: number;
}

/** 第 1 相の成否。成功なら画像不変量、失敗なら型付きエラー（透明画像）。 */
export type ImageAnalysisOutcome =
  { ok: true; value: ImageAnalysis } | { ok: false; error: AnalysisError };

/**
 * しきい値で二値化した画像（第 2 相の最初の段）。
 * マスクとその行範囲から求まる絵柄の高さは、どちらも「どの α をアクリルとみなすか」に
 * 依存するため、しきい値を鍵に一体でメモ化する（CutlineMemo）。
 */
interface BinaryImage {
  /** アクリル画素を 1 とする 1 バイト/画素のマスク。カットライン膨張の入力。 */
  mask: Uint8Array;
  /**
   * 絵柄（不透明領域）の上端〜下端の点間距離(px)。スケール(mm/px)の基準。
   * 画像高さではなくこの値を使うことで、PNG の透明余白の量でフィギュアの実寸が
   * 変わらないようにする（analysis/scale の computeMmPerPixel）。
   */
  figureHeightPixels: number;
}

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
 * 第 1 相：RGBA から α プレーンを抜き出す。
 *
 * RGBA の全画素走査をこの 1 回にまとめ、以降の相（二値化・カットライン膨張・輪郭抽出）は
 * 1 バイト/画素のプレーンだけを参照する。しきい値（alphaThreshold）に依存しないため、
 * この相は画像が変わった時だけ実行すれば足り、しきい値の変更では再実行されない。
 *
 * 不透明とみなせる画素が 1 つも無ければ（α が全画素 0）透明画像として型付きエラーを返す。
 * 本来 imageLoader が読み込み段階で弾くが、防御的に検査する。しきい値を上げた結果として
 * 不透明領域が消えるケースはしきい値依存なので、第 2 相（binarize）が同じ種別で弾く。
 */
export function analyzeImage(image: ImagePixels): ImageAnalysisOutcome {
  const { imageData, width, height } = image;

  // α プレーン：二値化・カットライン生成の画像不変な前処理。1 回だけ構築する。
  const alpha = extractAlphaPlane(imageData);

  // 完全透明（α が全画素 0）の検査。RGBA ではなく抽出済みプレーンを見れば足りる。
  if (!alpha.some((value) => isAcrylicAlpha(value, MIN_ALPHA_THRESHOLD))) {
    return { ok: false, error: makeError('transparentImage') };
  }

  return { ok: true, value: { alpha, width, height } };
}

/**
 * カットラインのメモ。runAnalysis の入力パラメータのうち各段に影響するものが変わらない
 * 限り、O(W×H) の二値化・膨張・隙間埋め・輪郭抽出を再実行しないための可変ホルダ。
 *
 * 段は 4 つ：二値化（α しきい値に依存）／膨張マスク（＋スケール・余白）／カットライン
 * （＋隙間埋め・平滑化・連結幅）／差込部を合流させたカットライン（＋差込部の配置）。
 * 上流の段ほど変わりにくく重いため、それぞれ独立した鍵で保持する（台座幅だけの変更では
 * どの段も再計算されない）。
 *
 * 呼び出し側が「同じ画像の連続した解析」の単位で 1 つ保持する（画像が変われば
 * 新しいメモに取り替える）。Worker 実行時は Worker 内の第 1 相キャッシュに同居させる。
 */
export interface CutlineMemo {
  /** 二値化に使った α しきい値。未計算なら null。 */
  binaryKey: number | null;
  /** 二値化の結果。しきい値が高すぎて不透明画素が消えた場合は null（失敗も含めてメモする）。 */
  binary: BinaryImage | null;
  maskKey: string | null;
  mask: DilatedMask | null;
  contourKey: string | null;
  contour: Contour | null;
  mergedKey: string | null;
  merged: Contour | null;
}

/** 空のカットラインメモを作る。 */
export function createCutlineMemo(): CutlineMemo {
  return {
    binaryKey: null,
    binary: null,
    maskKey: null,
    mask: null,
    contourKey: null,
    contour: null,
    mergedKey: null,
    merged: null,
  };
}

/**
 * 膨張マスクが依存する値だけから成るメモ鍵。
 * 入力の二値マスク（α しきい値に依存）と、余白の実効ピクセル値（余白(mm) / mmPerPixel）で
 * 一意に決まる。しきい値が変わっても絵柄の高さ(px)が偶然変わらないことはあり得るため、
 * mmPerPixel だけに頼らずしきい値も鍵に含める。
 */
function maskKeyOf(params: AnalysisParameters, mmPerPixel: number): string {
  return [params.alphaThreshold, mmPerPixel, params.cutLineMarginMm].join('/');
}

/**
 * α プレーンをしきい値で二値化し、絵柄の高さ(px)を測る（第 2 相の最初の段、O(W×H)）。
 * 不透明画素が 1 つも残らなければ null（＝しきい値が高すぎる）。
 *
 * しきい値だけを鍵にメモ化する。台座幅のような無関係なパラメータの変更では再計算されず、
 * 「しきい値が高すぎて解析不能」という失敗も含めてメモするため、その状態で他のパラメータを
 * 動かしても走査は繰り返さない。
 */
function binarize(
  imageAnalysis: ImageAnalysis,
  threshold: number,
  memo?: CutlineMemo,
): BinaryImage | null {
  if (memo && memo.binaryKey === threshold) {
    return memo.binary;
  }

  const { alpha, width, height } = imageAnalysis;
  const mask = thresholdAlphaPlane(alpha, threshold);

  // 絵柄の上端・下端。スケールの基準であり、同時に「アクリル領域が無い」の検査でもある
  // （無ければ差込口・台座・転倒角の基準が取れないため弾く）。
  const rows = opaqueRowRange(mask, width, height);
  // 上端・下端の「点間距離」（画素数 −1）。カットライン・台座・ルーラーが同じ点座標系で
  // 位置を測るため、こちらを基準にするとルーラーの読みとフィギュア高さが一致する。
  // 1 行しか無い退化画像でもゼロ除算しないよう下限 1 を置く。
  const binary = rows ? { mask, figureHeightPixels: Math.max(1, rows.maxY - rows.minY) } : null;

  if (memo) {
    memo.binaryKey = threshold;
    memo.binary = binary;
  }
  return binary;
}

/** カットライン（差込部を含まない）が依存するパラメータだけから成るメモ鍵。 */
function cutlineKeyOf(params: AnalysisParameters, mmPerPixel: number): string {
  return [
    maskKeyOf(params, mmPerPixel),
    params.gapFillThresholdMm,
    params.cutLineSmoothing,
    params.minBridgeWidthMm,
  ].join('/');
}

/** 差込部を合流させたカットラインのメモ鍵。差込部の幾何（首部・ツメの矩形）を含める。 */
function mergedKeyOf(base: string, slot: SlotResult): string {
  return [
    base,
    slot.neck.xPixel,
    slot.neck.yPixel,
    slot.neck.widthPixel,
    slot.neck.heightPixel,
    slot.tab.xPixel,
    slot.tab.widthPixel,
    slot.tab.heightPixel,
  ].join('/');
}

/**
 * 差込部（首部＋ツメ）を含む最終カットラインを求める。
 *
 * 隙間埋めが無効（閾値 0）なら、多角形のまま首部・ツメを一体化すれば足りる（マスクの
 * 再走査が不要な軽い経路）。有効なら「首部をマスクへ塗り足す → 隙間埋め（クロージング）→
 * 輪郭抽出」をやり直し、首部の側面とフィギュア外形の間にできる狭い隙間も充填する
 * （SPEC「隙間埋めと差込部の整合」）。平滑化で丸まる首部・ツメの矩形は、実寸がスリット
 * 加工に直結するため union で crisp に戻す。
 *
 * 再走査は O(W×H) と重いので、差込部の幾何を含む鍵でメモ化する（台座幅だけの
 * 変更では再実行されない）。塗り足しや union が破綻した場合は従来経路へフォールバックし、
 * 差込部の無いカットラインを返してしまわないようにする。
 */
function buildSlottedCutline(
  dilated: DilatedMask,
  contour: Contour,
  slot: SlotResult,
  params: AnalysisParameters,
  mmPerPixel: number,
  contourKey: string,
  memo?: CutlineMemo,
): Contour {
  const gapFillPx = params.gapFillThresholdMm / mmPerPixel;
  if (!(gapFillPx > 0)) {
    return attachSlotBody(contour, slot);
  }

  const key = mergedKeyOf(contourKey, slot);
  if (memo && memo.mergedKey === key && memo.merged) {
    return memo.merged;
  }

  const neckFill = neckFillPolygon(contour, slot);
  const filled = neckFill
    ? cutlineFromMask(
        dilated,
        gapFillPx,
        params.cutLineSmoothing,
        params.minBridgeWidthMm / mmPerPixel,
        neckFill,
      )
    : null;
  // 首部の crisp 合成には矩形ではなく neckFill（下辺の弧に沿う多角形）を使う。矩形だと
  // 板の下辺が首部幅の範囲内で大きく上下する形状で、板の輪郭の外へ張り出してしまう。
  const merged =
    (filled && unionSlotRects(filled, slot, neckFill)) ?? attachSlotBody(contour, slot);

  if (memo) {
    memo.mergedKey = key;
    memo.merged = merged;
  }
  return merged;
}

/**
 * 第 2 相：画像不変量（analyzeImage の結果）とパラメータから解析結果一式を求める。
 *
 * α プレーンをしきい値で二値化して不透明領域を確定し、スケール（mm/px）を求め、以降の
 * 幾何はすべてピクセル座標で計算して結果の段で mm へ換算する。各ステップの null は
 * 「その段で計算不能」を意味し、意味の近いエラー種別へ写して早期に返す。全段を通れば
 * AnalysisResult を組み立てて返す。
 *
 * 重いのは二値化（O(W×H)）とカットライン生成（EDT 膨張＋隙間埋め＋輪郭抽出、O(W×H)）で、
 * 隙間埋めが有効なときは差込部を合流させた 2 回目の生成も走る。cutlineMemo を渡せば、
 * 二値化／膨張マスク／カットライン／差込部込みカットラインの各段が、それぞれの依存
 * パラメータが同じ間は再利用される。それ以外（重心・差込口・台座 footprint・台座・転倒角）は
 * 頂点数に比例する軽量計算のみで、台座形状・寸法を変えてもカットライン段は再計算されない。
 *
 * baseShapeSource は台座形状「任意形状」のときだけ使う（それ以外の形状では無視される）。
 *
 * image は寸法だけを使うため、Worker 側は ImageData を持たない {width, height} でも呼べる。
 */
export function runAnalysis(
  image: Pick<FigureImage, 'width' | 'height'>,
  imageAnalysis: ImageAnalysis,
  params: AnalysisParameters,
  baseShapeSource: BaseShapeSource | null,
  cutlineMemo?: CutlineMemo,
): AnalysisOutcome {
  const { width, height } = image;

  // 不透明領域の確定。しきい値が高すぎてアクリル画素が 1 つも残らなければ、以降の基準
  // （絵柄の高さ・重心・差込口）が取れないため透明画像と同じ扱いで弾く。
  const binary = binarize(imageAnalysis, params.alphaThreshold, cutlineMemo);
  if (!binary) {
    return fail('transparentImage');
  }

  // スケールは「フィギュア高さ（接地面〜カットライン上端の全高）から絵柄の外側の高さを
  // 引いた絵柄の高さ(mm)」を「絵柄の高さ(px)」で割って得る。フィギュア高さが絵柄の外側の
  // 高さ（余白×2＋持ち上げ量＋板厚）以下だと絵柄が存在できないため、計算不能として弾く。
  const mmPerPixel = computeMmPerPixel(params, binary.figureHeightPixels);
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
    return fail('scaleCalculationFailed');
  }

  // 二値マスクを余白ぶん膨張したマスク。カットライン生成で最も重い段（O(W×H)）であり、
  // 差込部を合流させた 2 回目の生成でも使い回すため、しきい値・スケール・余白を鍵にメモ化する。
  const maskKey = maskKeyOf(params, mmPerPixel);
  let dilated: DilatedMask;
  if (cutlineMemo && cutlineMemo.maskKey === maskKey && cutlineMemo.mask) {
    dilated = cutlineMemo.mask;
  } else {
    dilated = buildCutlineMask(
      binary.mask,
      imageAnalysis.width,
      imageAnalysis.height,
      params.cutLineMarginMm / mmPerPixel,
    );
    if (cutlineMemo) {
      cutlineMemo.maskKey = maskKey;
      cutlineMemo.mask = dilated;
    }
  }

  // 膨張マスクから起こした「カットライン」。以降の重心・台座上面・差込部の配置はすべて
  // これを基準にする（差込部を含む最終外形はこの後に組み立てる）。隙間埋め閾値 mm・
  // 連結部最小幅 mm はスケールでピクセルへ換算する（解析はピクセル座標で完結）。
  const contourKey = cutlineKeyOf(params, mmPerPixel);
  let contour: Contour;
  if (cutlineMemo && cutlineMemo.contourKey === contourKey && cutlineMemo.contour) {
    contour = cutlineMemo.contour;
  } else {
    contour = cutlineFromMask(
      dilated,
      params.gapFillThresholdMm / mmPerPixel,
      params.cutLineSmoothing,
      params.minBridgeWidthMm / mmPerPixel,
    );
    if (cutlineMemo) {
      cutlineMemo.contourKey = contourKey;
      cutlineMemo.contour = contour;
    }
  }

  // 重心はカットラインが囲む領域の面積重心。差込口・台座・転倒角の基準になる。
  const centroidPixel = polygonCentroid(contour);
  if (!centroidPixel) {
    return fail('baseCalculationFailed');
  }
  const centroid = toCentroid(centroidPixel, mmPerPixel);

  // 台座上面は「カットライン最下端 + 持ち上げ量」。板本体が台座へ潜り込まないための
  // 基準線であり、差込部（首部下端・ツメ上端）・支持範囲・重心高さがすべてこの線を共有する。
  const baseTopYPixel = computeBaseTopYPixel(contour, params.plateLiftMm, mmPerPixel);
  if (!Number.isFinite(baseTopYPixel)) {
    return fail('baseCalculationFailed');
  }

  // 差込部（首部＋ツメ）の中心は重心の真下＋オフセット。縦位置は台座上面を境に決まる。
  const slot = findSlot(contour, centroid, params, mmPerPixel, baseTopYPixel);
  if (!slot) {
    return fail('slotPlacementFailed');
  }

  // 首部・ツメを含むようカットラインを下方向へ拡張し、板本体と一体の外形にする。隙間埋めが
  // 有効なら、首部を合流させたうえで充填をやり直す（首部とフィギュアの合成部にできる狭い
  // 隙間も埋める）。以降 result.contour（オーバーレイ・SVG が参照）はこの外形になる。
  const finalContour = buildSlottedCutline(
    dilated,
    contour,
    slot,
    params,
    mmPerPixel,
    contourKey,
    cutlineMemo,
  );

  // 台座 footprint（上面図の外形）。形状パラメータだけから決まり、カットライン系の重い段とは
  // 独立している（台座形状・寸法の変更で二値化・膨張・輪郭抽出は再計算されない）。
  const footprint = buildFootprint(params, baseShapeSource);
  if (!footprint) {
    return fail('baseShapeFailed');
  }

  const base = computeBase(centroid, slot, baseTopYPixel * mmPerPixel, footprint);
  if (!base) {
    return fail('baseCalculationFailed');
  }

  // 転倒角の失敗（重心高さ 0 等）も、幾何的に自立し得ない＝台座計算不可の一種として扱う。
  const stability = computeStability(centroid, slot, base);
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
      dpi: computeDpi(mmPerPixel),
      contour: finalContour,
      centroid,
      slot,
      base,
      stability,
    },
  };
}
