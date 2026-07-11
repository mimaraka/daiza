// 解析パイプラインの React バインディング。
//
// analysis/pipeline.ts の二相解析を、アプリ状態（画像・パラメータ）の変化へ接続する。
// SPEC の「パラメータ変更時は 解析 → 状態更新 → 再描画 を即時実行」を満たす唯一の
// 駆動点であり、ロジック自体は持たず「いつ解析を回し、結果をどう dispatch するか」だけを
// 担う（useAppState が reducer を React へ繋ぐのと同じ責務分離）。
//
// 大画像フリーズ対策（SPEC「重い解析でメインスレッドを塞がない」）として、第 1 相
// （analyzeImage：α マスク構築、O(W×H)）と第 2 相（runAnalysis）の両方を Web Worker で
// 実行する。SPEC は第 2 相を「軽量なので原則メインスレッド」とするが、第 2 相の
// カットライン生成（EDT 膨張＋輪郭抽出、O(W×H)）は 3000px 級で数百 ms あり、実測で
// UI を固める重さだったため原則の例外とした。第 1 相の成果物（約 9MB の α マスク）は
// Worker 内にキャッシュされ、第 2 相要求はパラメータだけを送る（画素の再転送なし）。
//
// 解析用 RGBA ピクセル（ImageData）は React の state を経由させず、pixelStore から
// 画像 id で一度だけ取り出して ArrayBuffer を Transferable として Worker へ転送する
// （コピーなし・返送なし。プレビュー描画は FigureImage.bitmap が担うため復元は不要）。
// ImageData を props に載せると React dev ビルドのシリアライズが全画素を列挙して
// フリーズするため（model/types の FigureImage 注記参照）、この経路が必須である。
//
// パラメータ変更は短いデバウンスで束ね（スライダードラッグ・連続キー入力で要求が
// 積み上がるのを防ぐ）、requestId 世代で陳腐化した応答を破棄する。応答待ちの間も直前の
// 結果を表示し続けるため、UI は常に応答性を保つ。

import { useEffect, useRef, useState } from 'react';

import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from '@/analysis/analysis.worker';
import {
  analyzeImage,
  createCutlineMemo,
  runAnalysis,
  type CutlineMemo,
  type ImageAnalysis,
} from '@/analysis/pipeline';
import type { AppStateActions } from '@/hooks/useAppState';
import { toUnexpectedError } from '@/model/errors';
import { takePixels } from '@/model/pixelStore';
import type { AppState } from '@/model/state';

/**
 * パラメータ変更を第 2 相要求へ束ねるデバウンス幅(ms)。
 * スライダーのドラッグは 1 操作で数十回の変更を発火するため、最後の値だけを解析する。
 * 人の操作に対して知覚できない短さに留め、「即時実行」の体感を保つ。
 */
const PARAM_DEBOUNCE_MS = 120;

/** Worker 経由の第 1 相が完了した画像（FigureImage.id）。第 2 相要求のゲートになる。 */
interface Phase1Ready {
  forId: number;
}

/**
 * Worker 非対応環境向け：メインスレッドで確定した第 1 相結果一式。
 * カットラインメモは同じ画像への連続解析で使い回すため、結果と一緒に持ち替える。
 */
interface Phase1Local {
  forId: number;
  value: ImageAnalysis;
  memo: CutlineMemo;
}

/**
 * 画像またはパラメータが変わるたびに解析を実行し、結果／エラーを状態へ反映する。
 *
 * 第 1 相（画像走査）は新規画像のときだけ、第 2 相（パラメータ解析）は画像・第 1 相・
 * パラメータが揃うたびに、いずれも Worker で非同期実行する。reducer は setImage の時点で
 * result を陳腐化するため、この hook はそれを埋め直す役割を持つ。二相とも想定内の失敗は
 * 型付き結果で返るが、想定外の例外（バグ等）は捕捉して UI 表示可能なエラーへ写し、
 * 白画面クラッシュを防ぐ。
 */
export function useAnalysis(state: AppState, actions: AppStateActions): void {
  const { image, parameters } = state;

  // Worker 経由の第 1 相完了フラグ。Worker 応答（非同期）で立つ。
  const [phase1Ready, setPhase1Ready] = useState<Phase1Ready | null>(null);
  // フォールバック（Worker 非対応）時のみ使う第 1 相結果。
  const [phase1Local, setPhase1Local] = useState<Phase1Local | null>(null);

  // Worker は 1 度だけ生成し、その onmessage から常に最新の actions を触れるよう ref 経由にする。
  // ref の更新はレンダー中ではなく effect で行う（レンダー中の ref 書き換えは避ける）。
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const workerRef = useRef<Worker | null>(null);
  // 第 1 相の有効世代。新規投入で ++ し、古い応答（別画像の結果）を弾く鍵にする。
  const imageRequestIdRef = useRef(0);
  // 第 2 相の有効世代。パラメータ変更のたびに ++ し、陳腐化した応答を弾く。
  const paramsRequestIdRef = useRef(0);
  // 直近に Worker へ投げた画像 id。restore による参照変化で第 1 相を再投入しないための番兵。
  const lastPostedIdRef = useRef<number | null>(null);

  // Worker の生成と応答処理（マウント時 1 回）。第 1 相応答では完了フラグを立て、
  // 第 2 相応答では結果／エラーを確定する。
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      // Vite はこの静的な new URL を解析して Worker をバンドルする（相対パス指定が必要）。
      worker = new Worker(new URL('../analysis/analysis.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      // Worker 非対応環境ではメインスレッド同期解析へフォールバックする（下の投入 effect）。
      workerRef.current = null;
      return;
    }

    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const response = event.data;
      const acts = actionsRef.current;

      if (response.type === 'analyzeImage') {
        // 世代不一致は古い画像の応答。状態は触らない。
        if (response.requestId !== imageRequestIdRef.current) {
          return;
        }
        if (response.error) {
          // 第 1 相の失敗（透明画像等）はそのまま提示。第 2 相は回さない。
          acts.failAnalysis(response.error);
          setPhase1Ready(null);
        } else {
          setPhase1Ready({ forId: response.imageId });
        }
        return;
      }

      // 第 2 相応答。世代不一致（応答待ちの間にパラメータや画像が変わった）は破棄する。
      if (response.requestId !== paramsRequestIdRef.current) {
        return;
      }
      if (response.outcome.ok) {
        acts.succeedAnalysis(response.outcome.result);
      } else {
        acts.failAnalysis(response.outcome.error);
      }
    };

    worker.onerror = () => {
      // Worker 内の想定外エラー。握り潰さず UI へ出し、解析中のまま固まらせない。
      actionsRef.current.failAnalysis(
        toUnexpectedError(new Error('解析ワーカーでエラーが発生しました。')),
      );
    };

    workerRef.current = worker;
    return () => {
      worker?.terminate();
      workerRef.current = null;
    };
  }, []);

  // 第 1 相の投入：新規画像のときだけ Worker へ走査を依頼する。
  useEffect(() => {
    if (!image) {
      // 画像なし。進行中の応答を無効化する（世代を進めて古い応答を弾く）。第 1 相結果は
      // 明示クリアしない：画像 id は単調増加のため、第 2 相ガード（forId 照合）が
      // 陳腐化した結果を自然に無視する。
      lastPostedIdRef.current = null;
      imageRequestIdRef.current++;
      paramsRequestIdRef.current++;
      return;
    }
    // 同一 id の再実行（actions 参照変化等での effect 再評価）は再投入しない。
    // 既に解析済み／解析中で、pixelStore のピクセルも消費済みである。
    if (image.id === lastPostedIdRef.current) {
      return;
    }

    lastPostedIdRef.current = image.id;
    const requestId = ++imageRequestIdRef.current;
    // 前の画像に対する第 2 相の応答が新しい画像の結果に混ざらないよう世代を進める。
    paramsRequestIdRef.current++;
    actions.startAnalysis();

    // 解析用ピクセルは読み込み時に pixelStore へ預けられている（1 回きりの取り出し）。
    // 取り出せないのは読み込みフローを経ていない異常系のみで、解析続行は不可能。
    const pixels = takePixels(image.id);
    if (!pixels) {
      actions.failAnalysis(
        toUnexpectedError(new Error(`解析用ピクセルが見つかりません（imageId=${image.id}）。`)),
      );
      return;
    }

    const worker = workerRef.current;
    if (!worker) {
      // フォールバック：Worker 非対応時のみメインスレッドで同期解析する。setState を
      // effect 本体から逃がしつつ 'analyzing' を一度描画させるため次タスクへ遅延し、
      // 切替済みなら破棄する。
      const targetId = image.id;
      const timer = setTimeout(() => {
        if (requestId !== imageRequestIdRef.current) {
          return;
        }
        const outcome = analyzeImage({
          imageData: pixels,
          width: pixels.width,
          height: pixels.height,
        });
        if (outcome.ok) {
          setPhase1Local({ forId: targetId, value: outcome.value, memo: createCutlineMemo() });
        } else {
          actionsRef.current.failAnalysis(outcome.error);
        }
      }, 0);
      return () => clearTimeout(timer);
    }

    // ImageData の buffer を転送して Worker へ委譲する（コピーなし・返送なし）。
    // プレビュー描画は FigureImage.bitmap が担うため、detach 後の復元は不要。
    const buffer = pixels.data.buffer;
    const request: AnalysisWorkerRequest = {
      type: 'analyzeImage',
      requestId,
      imageId: image.id,
      buffer,
      width: pixels.width,
      height: pixels.height,
    };
    worker.postMessage(request, [buffer]);
  }, [image, actions]);

  // 第 2 相：画像・第 1 相結果・パラメータが揃うたびにデバウンスして解析する。
  // 第 1 相確定やパラメータ変更で再実行される。
  useEffect(() => {
    if (!image) {
      return;
    }

    const worker = workerRef.current;
    if (worker) {
      // 第 1 相が未確定、または結果が現在の画像に属さない（投入直後で応答待ち）なら回さない。
      if (!phase1Ready || phase1Ready.forId !== image.id) {
        return;
      }
      // 世代は即時に進め、応答待ちの古い要求を無効化する。投入自体はデバウンスする。
      const requestId = ++paramsRequestIdRef.current;
      const imageId = image.id;
      const params = parameters;
      const timer = setTimeout(() => {
        const request: AnalysisWorkerRequest = { type: 'runAnalysis', requestId, imageId, params };
        worker.postMessage(request);
      }, PARAM_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }

    // フォールバック（Worker 非対応）：メインスレッドで同期計算する。デバウンスは共通で、
    // 連続変更の間に重い計算を挟まないための最低限の保護になる。
    if (!phase1Local || phase1Local.forId !== image.id) {
      return;
    }
    const requestId = ++paramsRequestIdRef.current;
    const timer = setTimeout(() => {
      if (requestId !== paramsRequestIdRef.current) {
        return;
      }
      try {
        const outcome = runAnalysis(image, phase1Local.value, parameters, phase1Local.memo);
        if (outcome.ok) {
          actionsRef.current.succeedAnalysis(outcome.result);
        } else {
          actionsRef.current.failAnalysis(outcome.error);
        }
      } catch (cause) {
        // 型付き結果で表せない予期しない失敗。握り潰さずエラー状態として提示する。
        actionsRef.current.failAnalysis(toUnexpectedError(cause));
      }
    }, PARAM_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [image, phase1Ready, phase1Local, parameters]);
}
