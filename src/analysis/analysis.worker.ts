// 解析（第 1 相・第 2 相）を担う Web Worker。
//
// フリーズ対策（SPEC「重い解析でメインスレッドを塞がない」）の要。第 1 相（α プレーン
// 抽出、O(W×H)）に加えて、第 2 相もここで実行する。SPEC は「パラメータのみの変更は
// 軽量な第 2 相なので原則メインスレッドで即時計算してよい」とするが、第 2 相に含まれる
// 二値化・カットライン生成（EDT 膨張＋輪郭抽出、O(W×H)）は 3000px 級で数百 ms あり、実測で
// メインスレッドを塞ぐ重さだったため、原則の例外としてここへ移した。これにより
// どんな入力でも UI の描画・入力は止まらない。
//
// 第 1 相の成果物（α プレーン、3000px 級で約 9MB）は Worker 内に imageId キーで保持し、
// メインスレッドへは送らない。第 2 相要求はパラメータだけを受け取り、キャッシュ済みの
// プレーンから解析結果（間引き済みの輪郭数千点＝クローン軽量）だけを返す。二値化・カット
// ラインのメモ（依存パラメータが同じ間の再利用）もキャッシュに同居させ、画像が変われば
// 丸ごと捨てる。α しきい値の変更は第 2 相のメモだけを失効させ、RGBA の再転送は起こさない。
//
// 解析ロジック自体は analysis/pipeline の純粋関数を再利用する。この Worker は
// 「メッセージ受け渡し」と「キャッシュの生存管理」だけを担い、ドメインロジックは
// 持たない（レイヤ分離の維持）。

import {
  analyzeImage,
  createCutlineMemo,
  runAnalysis,
  type AnalysisOutcome,
  type CutlineMemo,
  type ImageAnalysis,
} from '@/analysis/pipeline';
import { toUnexpectedError } from '@/model/errors';
import type { AnalysisError, AnalysisParameters, BaseShapeSource } from '@/model/types';

/** メインスレッド → Worker：第 1 相（画像解析）要求。RGBA バッファは転送で渡す。 */
export interface AnalyzeImageRequest {
  type: 'analyzeImage';
  /** リクエストの世代番号。応答の取り違え（古い画像の結果の混入）を防ぐために往復させる。 */
  requestId: number;
  /** 解析対象の画像 id（FigureImage.id）。Worker 内キャッシュの鍵になる。 */
  imageId: number;
  /** RGBA ピクセルの ArrayBuffer。Transferable として転送される（コピーなし）。 */
  buffer: ArrayBuffer;
  width: number;
  height: number;
}

/** メインスレッド → Worker：第 2 相（パラメータ解析）要求。画素は再送しない。 */
export interface RunAnalysisRequest {
  type: 'runAnalysis';
  requestId: number;
  /** どの画像に対する解析か。キャッシュ（第 1 相結果）との整合を検査する。 */
  imageId: number;
  params: AnalysisParameters;
  /**
   * 台座形状ソース（任意形状のときだけ使う）。正規化済みの折れ線（数百〜千頂点）なので
   * 構造化クローンでも軽く、パラメータと同じく要求ごとに送る（Worker 側でキャッシュしない）。
   */
  baseShapeSource: BaseShapeSource | null;
}

export type AnalysisWorkerRequest = AnalyzeImageRequest | RunAnalysisRequest;

/**
 * Worker → メインスレッド：第 1 相の完了通知。
 * 受け取った RGBA バッファは返送しない：メインスレッドの表示は ImageBitmap
 * （FigureImage.bitmap）が担うため復元が不要になった。バッファはここで破棄（GC）する。
 */
export interface AnalyzeImageResponse {
  type: 'analyzeImage';
  requestId: number;
  imageId: number;
  /**
   * 第 1 相の失敗（透明画像・想定外例外）。成功なら null。成功時の解析データは
   * Worker 内へキャッシュされ、メインスレッドへは送らない（約 9MB のマスク転送を避ける）。
   */
  error: AnalysisError | null;
}

/** Worker → メインスレッド：第 2 相の結果一式（成功／型付きエラー）。 */
export interface RunAnalysisResponse {
  type: 'runAnalysis';
  requestId: number;
  imageId: number;
  outcome: AnalysisOutcome;
}

export type AnalysisWorkerResponse = AnalyzeImageResponse | RunAnalysisResponse;

// Worker のグローバルスコープ。tsconfig の lib は DOM のため、DOM lib の `self`（Window）
// とは postMessage のシグネチャが異なる。WebWorker lib を足すと DOM lib とグローバル
// 定義が衝突するため、ここでは使う API だけを持つ最小 interface へキャストして受ける。
interface WorkerScope {
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
  postMessage(message: AnalysisWorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

/** 直近に解析した画像の第 1 相結果とカットラインメモ。アプリは単一画像なので 1 エントリで足りる。 */
interface CachedAnalysis {
  imageId: number;
  analysis: ImageAnalysis;
  cutlineMemo: CutlineMemo;
}
let cache: CachedAnalysis | null = null;

/** 第 1 相要求：α プレーンを抽出してキャッシュし、完了を通知する。 */
function handleAnalyzeImage(request: AnalyzeImageRequest): void {
  const { requestId, imageId, buffer, width, height } = request;

  // Uint8ClampedArray は buffer を共有する（コピーしない）。解析後、バッファはこの
  // 関数を抜けた時点で参照が切れて GC される（メインスレッドへの返送は不要）。
  // 例外も型付きエラーへ畳み、必ず応答してメイン側を解析中のまま待たせない。
  let error: AnalysisError | null = null;
  try {
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const outcome = analyzeImage({ imageData, width, height });
    if (outcome.ok) {
      cache = { imageId, analysis: outcome.value, cutlineMemo: createCutlineMemo() };
    } else {
      cache = null;
      error = outcome.error;
    }
  } catch (cause) {
    cache = null;
    error = toUnexpectedError(cause);
  }

  const response: AnalyzeImageResponse = { type: 'analyzeImage', requestId, imageId, error };
  ctx.postMessage(response);
}

/** 第 2 相要求：キャッシュ済みの第 1 相結果とパラメータから解析結果一式を返す。 */
function handleRunAnalysis(request: RunAnalysisRequest): void {
  const { requestId, imageId, params, baseShapeSource } = request;

  let outcome: AnalysisOutcome;
  if (!cache || cache.imageId !== imageId) {
    // 第 1 相の完了応答後にしか要求されないため通常は起きない防御分岐
    // （Worker の再生成タイミング等）。握り潰さず型付きエラーで表面化させる。
    outcome = {
      ok: false,
      error: toUnexpectedError(new Error(`解析キャッシュ不一致（imageId=${imageId}）`)),
    };
  } else {
    try {
      const { width, height } = cache.analysis;
      outcome = runAnalysis(
        { width, height },
        cache.analysis,
        params,
        baseShapeSource,
        cache.cutlineMemo,
      );
    } catch (cause) {
      // 型付き結果で表せない予期しない失敗。UI へ表示可能なエラーとして返す。
      outcome = { ok: false, error: toUnexpectedError(cause) };
    }
  }

  const response: RunAnalysisResponse = { type: 'runAnalysis', requestId, imageId, outcome };
  ctx.postMessage(response);
}

ctx.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'analyzeImage') {
    handleAnalyzeImage(request);
  } else {
    handleRunAnalysis(request);
  }
};
