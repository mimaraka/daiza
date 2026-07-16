// アプリ状態の React バインディング。
//
// model/state.ts の純粋 reducer を useReducer で駆動し、UI から呼びやすい
// アクション関数群として公開する。状態遷移ロジック自体は reducer 側に集約し、
// この hook は「React への接続」と「呼び出し口の整形」だけを担う。

import { useCallback, useMemo, useReducer } from 'react';

import { appReducer, initialAppState, type AppState } from '../model/state';
import type {
  AnalysisError,
  AnalysisParameters,
  AnalysisResult,
  BaseShapeSource,
  FigureImage,
} from '../model/types';

/** UI へ公開する状態更新アクション。 */
export interface AppStateActions {
  /** 読み込み済み画像をセット（前回結果はクリアされる）。 */
  setImage: (image: FigureImage) => void;
  /** 画像を破棄して待機状態へ戻す。 */
  clearImage: () => void;
  /** パラメータを部分更新する（再解析トリガー）。 */
  updateParameters: (parameters: Partial<AnalysisParameters>) => void;
  /** 任意形状の台座形状ソースをセットする（台座奥行がアスペクト比へ追従する）。 */
  setBaseShapeSource: (source: BaseShapeSource) => void;
  /** 解析開始を通知する。 */
  startAnalysis: () => void;
  /** 解析成功を通知し結果を反映する。 */
  succeedAnalysis: (result: AnalysisResult) => void;
  /** 解析失敗を通知しエラーを反映する。 */
  failAnalysis: (error: AnalysisError) => void;
}

export interface UseAppStateReturn {
  state: AppState;
  actions: AppStateActions;
}

/**
 * アプリ状態を管理する唯一の入口。
 * dispatch を直接露出せず、意味のあるアクション関数へ包むことで呼び出し側の
 * 意図を明確にし、アクションの形（type 名等）を hook 内に隠蔽する。
 */
export function useAppState(): UseAppStateReturn {
  const [state, dispatch] = useReducer(appReducer, initialAppState);

  const setImage = useCallback((image: FigureImage) => dispatch({ type: 'setImage', image }), []);
  const clearImage = useCallback(() => dispatch({ type: 'clearImage' }), []);
  const updateParameters = useCallback(
    (parameters: Partial<AnalysisParameters>) => dispatch({ type: 'updateParameters', parameters }),
    [],
  );
  const setBaseShapeSource = useCallback(
    (source: BaseShapeSource) => dispatch({ type: 'setBaseShapeSource', source }),
    [],
  );
  const startAnalysis = useCallback(() => dispatch({ type: 'analysisStarted' }), []);
  const succeedAnalysis = useCallback(
    (result: AnalysisResult) => dispatch({ type: 'analysisSucceeded', result }),
    [],
  );
  const failAnalysis = useCallback(
    (error: AnalysisError) => dispatch({ type: 'analysisFailed', error }),
    [],
  );

  // アクション関数は安定参照のため、オブジェクトもメモ化して不要な再描画を抑える。
  const actions = useMemo<AppStateActions>(
    () => ({
      setImage,
      clearImage,
      updateParameters,
      setBaseShapeSource,
      startAnalysis,
      succeedAnalysis,
      failAnalysis,
    }),
    [
      setImage,
      clearImage,
      updateParameters,
      setBaseShapeSource,
      startAnalysis,
      succeedAnalysis,
      failAnalysis,
    ],
  );

  return { state, actions };
}
