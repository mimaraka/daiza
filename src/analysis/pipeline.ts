// 解析パイプライン：各解析ステップを 1 本の流れへ束ねる純粋オーケストレータ。
//
// パフォーマンス要件（SPEC「オーバーレイのみの更新で済む場合は画像解析全体を再実行
// しない」）のため、パイプラインを 2 相に分ける：
//
//   analyzeImage … 画像だけに依存する前処理（α マスク構築・絵柄の高さ測定）。
//                  O(W×H)。画像が変わった時だけ実行し、マスクを画像不変量として保持する。
//   runAnalysis  … パラメータに依存する計算（カットライン・重心・差込口・台座・転倒角）。
//                  パラメータ変更ごとに呼ばれる。このうちカットライン生成（EDT 膨張＋
//                  隙間埋め＋輪郭抽出）だけは O(W×H) と重いため、依存パラメータを鍵に
//                  段ごとメモ化し、安全率スライダー等の無関係な変更では再計算しない。
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
  SlotResult,
} from '@/model/types';
import { buildAlphaMask, opaqueRowRange } from '@/utils/image';

/**
 * パイプライン段で発生し得るエラー種別。
 * 読み込み系（imageLoadFailed / unsupportedImage）は前段の imageLoader が担うため、
 * ここではアクリル領域欠如・スケール計算不可・差込口配置不可・台座計算不可の 4 種を扱う。
 */
type PipelineErrorKind = Extract<
  AnalysisErrorKind,
  'transparentImage' | 'scaleCalculationFailed' | 'slotPlacementFailed' | 'baseCalculationFailed'
>;

/** UI へ提示するエラーメッセージ（日本語）。 */
const ERROR_MESSAGES: Record<PipelineErrorKind, string> = {
  transparentImage:
    'アクリル領域（α>0）が見つからないため解析できません。透明でないPNG画像を選択してください。',
  scaleCalculationFailed:
    'フィギュア高さが小さすぎます。フィギュア高さは「接地面（台座底面）からカットライン（絵柄＋余白）の上端まで」の全高です。カットライン余白×2＋アクリル板の持ち上げ量＋板厚 より大きい値を指定してください。',
  slotPlacementFailed:
    '差込部（首部・ツメ）を配置できません。差込口オフセットを小さくする、首部幅を差込口幅より大きくする、などパラメータを見直してください。',
  baseCalculationFailed:
    '台座サイズを計算できません。指定した台座幅では重心を支えられない可能性があります。台座幅を広げる、差込口オフセットを小さくする、安全率を下げる、などパラメータを見直してください。',
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
  /**
   * 絵柄（不透明領域）の上端〜下端の点間距離(px)。スケール(mm/px)の基準。
   * 画像高さではなくこの値を使うことで、PNG の透明余白の量でフィギュアの実寸が
   * 変わらないようにする（analysis/scale の computeMmPerPixel）。
   */
  figureHeightPixels: number;
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
 * 第 1 相：画像から不透明領域の α マスクを構築し、絵柄の高さ(px)を測る。
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

  // 絵柄の上端・下端。スケールの基準であり、同時に「アクリル領域が無い（全透明）」の
  // 検査でもある（無ければ差込口・台座・転倒角の基準が取れないため弾く）。
  const rows = opaqueRowRange(mask, width, height);
  if (!rows) {
    return { ok: false, error: makeError('transparentImage') };
  }

  // 上端・下端の「点間距離」（画素数 −1）。カットライン・台座・ルーラーが同じ点座標系で
  // 位置を測るため、こちらを基準にするとルーラーの読みとフィギュア高さが一致する。
  // 1 行しか無い退化画像でもゼロ除算しないよう下限 1 を置く。
  const figureHeightPixels = Math.max(1, rows.maxY - rows.minY);

  return { ok: true, value: { mask, width, height, figureHeightPixels } };
}

/**
 * カットラインのメモ。runAnalysis の入力パラメータのうち各段に影響するものが変わらない
 * 限り、O(W×H) の膨張・隙間埋め・輪郭抽出を再実行しないための可変ホルダ。
 *
 * 段は 3 つ：膨張マスク（スケール・余白に依存）／カットライン（＋隙間埋め・平滑化・連結幅）／
 * 差込部を合流させたカットライン（＋差込部の配置）。上流の段ほど変わりにくく重いため、
 * それぞれ独立した鍵で保持する（安全率や台座幅だけの変更ではどの段も再計算されない）。
 *
 * 呼び出し側が「同じ画像の連続した解析」の単位で 1 つ保持する（画像が変われば
 * 新しいメモに取り替える）。Worker 実行時は Worker 内の第 1 相キャッシュに同居させる。
 */
export interface CutlineMemo {
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
 * 余白の実効ピクセル値は 余白(mm) / mmPerPixel なので、この 2 つで一意に決まる。
 */
function maskKeyOf(params: AnalysisParameters, mmPerPixel: number): string {
  return [mmPerPixel, params.cutLineMarginMm].join('/');
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
 * 再走査は O(W×H) と重いので、差込部の幾何を含む鍵でメモ化する（安全率・台座幅だけの
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
  const merged = (filled && unionSlotRects(filled, slot)) ?? attachSlotBody(contour, slot);

  if (memo) {
    memo.mergedKey = key;
    memo.merged = merged;
  }
  return merged;
}

/**
 * 第 2 相：画像不変量（analyzeImage の結果）とパラメータから解析結果一式を求める。
 *
 * スケール（mm/px）をまず確定し、以降の幾何はすべてピクセル座標で計算して結果の
 * 段で mm へ換算する。各ステップの null は「その段で計算不能」を意味し、意味の近い
 * エラー種別へ写して早期に返す。全段を通れば AnalysisResult を組み立てて返す。
 *
 * 重いのはカットライン生成（EDT 膨張＋隙間埋め＋輪郭抽出、O(W×H)）で、隙間埋めが有効な
 * ときは差込部を合流させた 2 回目の生成も走る。cutlineMemo を渡せば、膨張マスク／
 * カットライン／差込部込みカットラインの各段が、それぞれの依存パラメータが同じ間は
 * 再利用される。それ以外（重心・差込口・台座・転倒角）は頂点数に比例する軽量計算のみ。
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

  // スケールは「フィギュア高さ（接地面〜カットライン上端の全高）から絵柄の外側の高さを
  // 引いた絵柄の高さ(mm)」を「絵柄の高さ(px)」で割って得る。フィギュア高さが絵柄の外側の
  // 高さ（余白×2＋持ち上げ量＋板厚）以下だと絵柄が存在できないため、計算不能として弾く。
  const mmPerPixel = computeMmPerPixel(params, imageAnalysis.figureHeightPixels);
  if (!Number.isFinite(mmPerPixel) || mmPerPixel <= 0) {
    return fail('scaleCalculationFailed');
  }

  // α マスクを余白ぶん膨張したマスク。カットライン生成で最も重い段（O(W×H)）であり、
  // 差込部を合流させた 2 回目の生成でも使い回すため、スケール・余白を鍵にメモ化する。
  const maskKey = maskKeyOf(params, mmPerPixel);
  let dilated: DilatedMask;
  if (cutlineMemo && cutlineMemo.maskKey === maskKey && cutlineMemo.mask) {
    dilated = cutlineMemo.mask;
  } else {
    dilated = buildCutlineMask(
      imageAnalysis.mask,
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

  const base = computeBase(centroid, slot, params, baseTopYPixel * mmPerPixel);
  if (!base) {
    return fail('baseCalculationFailed');
  }

  // 転倒角の失敗（重心高さ 0 等）も、幾何的に自立し得ない＝台座計算不可の一種として扱う。
  const stability = computeStability(centroid, base);
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
