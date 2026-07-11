// アプリ状態の定義・初期値・遷移（reducer）。
//
// reducer は React に依存しない純粋関数として実装する。これにより状態遷移を
// UI から切り離してテスト可能にし、React バインディング（hooks/useAppState）と
// 責務を分離する。Redux 等のライブラリは使わない（SPEC 制約）。

import type { AnalysisError, AnalysisParameters, AnalysisResult, FigureImage } from './types';

/** 解析パイプラインの進行状態。 */
export type AnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error';

/** アプリ全体の状態。 */
export interface AppState {
  /** 読み込み済み画像。未読み込みなら null。 */
  image: FigureImage | null;
  /** ユーザー操作のパラメータ。 */
  parameters: AnalysisParameters;
  /** 直近の解析結果。未解析・失敗時は null。 */
  result: AnalysisResult | null;
  /** 解析の進行状態。 */
  status: AnalysisStatus;
  /** 直近のエラー。正常時は null。 */
  error: AnalysisError | null;
}

/** パラメータの既定値。SPEC の例（高さ160 / 安全率1.3 等）に準拠。 */
export const DEFAULT_PARAMETERS: AnalysisParameters = {
  figureHeightMm: 160,
  thicknessMm: 3,
  // 余白は SPEC 既定の 3mm。平滑化は「最小（無効）」から始め、UI で強められるようにする。
  cutLineMarginMm: 3,
  cutLineSmoothing: 0,
  // 分離パーツ連結部の最小幅。板厚（既定 3mm）と同程度を既定とし、細すぎる連結を防ぐ。
  minBridgeWidthMm: 3,
  slotWidthMm: 5,
  // 差込口は既定で重心の真下（オフセット 0）。
  slotOffsetMm: 0,
  safetyFactor: 1.3,
  baseMarginMm: 5,
};

/**
 * スライダー等の入力 UI・バリデーションで共有するパラメータ制約。
 * min/max/step を一元管理し、UI と検証のズレを防ぐ。
 */
export const PARAMETER_CONSTRAINTS = {
  figureHeightMm: { min: 1, max: 2000, step: 1 },
  thicknessMm: { min: 0.1, max: 20, step: 0.1 },
  cutLineMarginMm: { min: 0, max: 10, step: 0.5 },
  cutLineSmoothing: { min: 0, max: 5, step: 1 },
  // 連結部は 0 幅だと union で結合できないため下限を正値にする。
  minBridgeWidthMm: { min: 0.5, max: 20, step: 0.5 },
  slotWidthMm: { min: 0.1, max: 50, step: 0.1 },
  // オフセットは左右対称に振れるよう負値も許容する（正=右／負=左）。
  slotOffsetMm: { min: -50, max: 50, step: 0.5 },
  safetyFactor: { min: 1.0, max: 2.0, step: 0.1 },
  baseMarginMm: { min: 0, max: 30, step: 1 },
} as const satisfies Record<keyof AnalysisParameters, { min: number; max: number; step: number }>;

/**
 * 選択式で提示する標準値プリセット。
 * 板厚はアクリル板の一般的な規格値（SPEC の例 2/3/5mm）が決まっているため既定選択肢とする。
 * これらに無い値は UI 側で「カスタム」入力へフォールバックできるようにし、規格外の値も許容する。
 * 差込口幅は SPEC 改訂によりプリセットを廃止し、数値入力のみとした（ここには含めない）。
 */
export const PARAMETER_PRESETS = {
  thicknessMm: [2, 3, 5],
} as const satisfies Partial<Record<keyof AnalysisParameters, readonly number[]>>;

/** 初期状態。画像未読み込みの待機状態から始まる。 */
export const initialAppState: AppState = {
  image: null,
  parameters: DEFAULT_PARAMETERS,
  result: null,
  status: 'idle',
  error: null,
};

/**
 * 状態遷移アクション。
 * 解析パイプライン（hooks/useAnalysis, TODO 13）と UI がこれらを dispatch する。
 */
export type AppAction =
  | { type: 'setImage'; image: FigureImage }
  | { type: 'clearImage' }
  | { type: 'updateParameters'; parameters: Partial<AnalysisParameters> }
  | { type: 'analysisStarted' }
  | { type: 'analysisSucceeded'; result: AnalysisResult }
  | { type: 'analysisFailed'; error: AnalysisError };

/**
 * 純粋な状態遷移関数。
 * 新しい画像・パラメータが入ると解析結果は陳腐化するため、該当時は result を破棄する。
 */
export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'setImage':
      // 新しい画像が来たら前回結果・エラーは無効。解析待ちへ戻す。
      return {
        ...state,
        image: action.image,
        result: null,
        status: 'idle',
        error: null,
      };

    case 'clearImage':
      // 画像を破棄したら初期状態相当へ。ただしパラメータはユーザー設定を維持する。
      return {
        ...state,
        image: null,
        result: null,
        status: 'idle',
        error: null,
      };

    case 'updateParameters':
      // パラメータ変更は再解析のトリガー。直前の結果は破棄せず、新しい解析結果が届く
      // まで表示し続ける（再解析は Worker 非同期のため、破棄するとオーバーレイが
      // 変更のたびに消えてちらつく）。結果を保持している場合のみ「再計算中」を示す
      // analyzing へ進める。結果が無い状態（初回解析中・エラー表示中）は状態を保ち、
      // 再解析の成否が届いた時点で置き換える（第 1 相失敗などで再解析自体が走らない
      // ケースで、スピナーが出続けるのを防ぐ）。
      return {
        ...state,
        parameters: { ...state.parameters, ...action.parameters },
        status: state.result ? 'analyzing' : state.status,
      };

    case 'analysisStarted':
      return { ...state, status: 'analyzing', error: null };

    case 'analysisSucceeded':
      return {
        ...state,
        result: action.result,
        status: 'ready',
        error: null,
      };

    case 'analysisFailed':
      // クラッシュさせず、結果を無効化してエラーを保持する。
      return {
        ...state,
        result: null,
        status: 'error',
        error: action.error,
      };

    default:
      // 網羅性チェック：新アクション追加時に型エラーで検出する。
      return assertNever(action);
  }
}

/** switch の網羅性を型レベルで保証するためのヘルパー。 */
function assertNever(action: never): never {
  throw new Error(`Unhandled action: ${JSON.stringify(action)}`);
}
