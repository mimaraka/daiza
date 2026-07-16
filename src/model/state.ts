// アプリ状態の定義・初期値・遷移（reducer）。
//
// reducer は React に依存しない純粋関数として実装する。これにより状態遷移を
// UI から切り離してテスト可能にし、React バインディング（hooks/useAppState）と
// 責務を分離する。Redux 等のライブラリは使わない（SPEC 制約）。

import { clamp } from '@/utils/geometry';

import type {
  AnalysisError,
  AnalysisParameters,
  AnalysisResult,
  BaseShapeSource,
  FigureImage,
} from './types';

/** 解析パイプラインの進行状態。 */
export type AnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error';

/** アプリ全体の状態。 */
export interface AppState {
  /** 読み込み済み画像。未読み込みなら null。 */
  image: FigureImage | null;
  /** ユーザー操作のパラメータ。 */
  parameters: AnalysisParameters;
  /**
   * 任意形状の台座形状ソース（正規化済み折れ線）。未読込なら null。
   *
   * パラメータではなく独立した状態として持つ：数百〜千頂点の折れ線であり、値ではなく
   * 「読み込んだ資産」だからである（画像と同じ位置づけ）。台座形状が 'custom' の間は
   * これが無いと footprint を作れないため、解析は baseShapeFailed になる。
   */
  baseShapeSource: BaseShapeSource | null;
  /** 直近の解析結果。未解析・失敗時は null。 */
  result: AnalysisResult | null;
  /** 背面アクリル板に貼る画像。3D プレビューのみ使用する表示用アセット。 */
  backImage: FigureImage | null;
  /** 解析の進行状態。 */
  status: AnalysisStatus;
  /** 直近のエラー。正常時は null。 */
  error: AnalysisError | null;
}

/** パラメータの既定値。SPEC の例（高さ160 / 板厚3 等）に準拠。 */
export const DEFAULT_PARAMETERS: AnalysisParameters = {
  // 既定は SPEC の「α=0 を透明・α>0 をアクリル」と等価（しきい値より大きい α を不透明とする）。
  alphaThreshold: 0,
  figureHeightMm: 160,
  thicknessMm: 3,
  // 余白は SPEC 既定の 3mm。平滑化は「最小（無効）」から始め、UI で強められるようにする。
  cutLineMarginMm: 3,
  cutLineSmoothing: 0,
  // 印刷・加工で潰れやすい細い隙間は既定で埋める。0 にすれば無効化できる。
  gapFillThresholdMm: 3,
  // 分離パーツ連結部の最小幅。連結部はアクリル 1 枚を支える細い橋であり、板厚と同程度では
  // カット時・使用時に折れやすいため、板厚（既定 3mm）の 2 倍を既定とする。
  minBridgeWidthMm: 6,
  slotWidthMm: 20,
  // 差込口は既定で重心の真下（オフセット 0）。
  slotOffsetMm: 0,
  // 前後も既定で台座の奥行中心（オフセット 0）。前後の転倒角が左右対称に最大化される位置。
  slotDepthOffsetMm: 0,
  // 首部は差込口幅（20mm）より十分広く取り、肩を確保する。
  neckWidthMm: 40,
  // 既定では板の下端が台座上面にちょうど接する（持ち上げなし）。
  plateLiftMm: 0,
  // 台座幅は指定値がそのまま実寸になる（余白ではない）。一般的なアクリルスタンドの台座幅。
  baseWidthMm: 50,
  // 台座奥行も指定値がそのまま実寸。一般的なアクリルスタンドの台座奥行。
  baseDepthMm: 30,
  // 既定は矩形（＝台座形状の拡張前と完全に同じ挙動）。
  baseShape: 'rect',
  baseCornerRadiusMm: 5,
  baseDiameterMm: 50,
  basePolygonSides: 6,
  basePolygonRotationDeg: 0,
  showBackPlate: false,
  // デザインモードは UI 上のトグル。既定は台座設計。
  designMode: 'baseFigure',
  // キーホルダー穴の既定値（ grilling で確定：直径 4 mm、上端余裕 0、水平オフセット 0）。
  keychainHoleDiameterMm: 4,
  keychainHolePaddingMm: 0,
  keychainHoleOffsetXMm: 0,
};

/**
 * 首部の肩（ショルダー）の片側最小幅(mm)。
 * 肩は台座上面に乗って挿入深さをツメ深さで止めるストッパーであり、これが 0 だと
 * アクリル板がツメより深く台座へ刺さり込む。実加工で意味を持つ最小限として 0.5mm を採る。
 */
export const MIN_SHOULDER_WIDTH_MM = 0.5;

/**
 * 与えられた差込口幅に対して成立する首部幅の下限(mm)。
 * 首部幅 ≧ 差込口幅 + 2×最小ショルダー幅（SPEC「制約：首部幅 > 差込口幅」）。
 * 浮動小数の桁あふれ（5.6000000000000005 等）を UI へ出さないよう 3 桁で丸める。
 */
export function minNeckWidthMm(slotWidthMm: number): number {
  return Math.round((slotWidthMm + 2 * MIN_SHOULDER_WIDTH_MM) * 1000) / 1000;
}

/**
 * 角丸半径の上限(mm) = min(台座幅, 台座奥行) / 2。
 * 上限に達すると短辺側が半円になる（スタジアム形。幅 = 奥行なら円と一致する）。
 * これを超える半径は角丸同士が重なって形状が破綻するため、常にここへクランプする。
 */
export function maxCornerRadiusMm(widthMm: number, depthMm: number): number {
  return Math.min(widthMm, depthMm) / 2;
}

/**
 * パラメータ間の不変条件を満たすよう正規化する。
 *
 * 不変条件は 2 つ：
 *  - 首部幅 ≧ 下限（差込口幅 + 2×最小ショルダー幅）。差込口幅を広げた結果として首部幅が
 *    下限を割る場合は、肩が消えないよう首部幅を自動的に下限まで押し上げる。
 *  - 角丸半径 ≦ min(台座幅, 台座奥行)/2、正多角形の辺数は 3〜12 の整数。台座幅・奥行を
 *    縮めた結果として角丸半径が上限を割る場合も、ここでクランプされる。
 *
 * UI 側の入力制約だけに頼ると（差込口幅や台座幅を先に変えるなど）容易に破れるため、状態遷移の
 * 中心である reducer で常に強制し、解析側は制約成立を前提にできるようにする。値が既に条件を
 * 満たしていれば同一オブジェクトを返し、無用な再解析（参照変化）を起こさない。
 */
export function normalizeParameters(params: AnalysisParameters): AnalysisParameters {
  const minNeck = minNeckWidthMm(params.slotWidthMm);
  const neckWidthMm = Math.max(params.neckWidthMm, minNeck);

  const maxRadius = maxCornerRadiusMm(params.baseWidthMm, params.baseDepthMm);
  const baseCornerRadiusMm = clamp(params.baseCornerRadiusMm, 0, Math.max(0, maxRadius));

  const sides = PARAMETER_CONSTRAINTS.basePolygonSides;
  const basePolygonSides = clamp(Math.round(params.basePolygonSides), sides.min, sides.max);

  if (
    neckWidthMm === params.neckWidthMm &&
    baseCornerRadiusMm === params.baseCornerRadiusMm &&
    basePolygonSides === params.basePolygonSides
  ) {
    return params;
  }
  return { ...params, neckWidthMm, baseCornerRadiusMm, basePolygonSides };
}

/**
 * 1 パラメータ分の入力制約。
 * max は**任意**：値の大小そのものが破綻を招かないパラメータ（首部幅など）には上限を設けず、
 * 省略する。UI 側は max が無ければ入力欄に上限を出さない（＝いくらでも大きくできる）。
 */
export interface ParameterConstraint {
  min: number;
  max?: number;
  step: number;
}

/**
 * 数値で指定するパラメータのキー。
 * 台座形状（baseShape）だけは列挙値であり min/max/step を持たないため、制約表の対象から外す。
 */
export type NumericParameterKey = {
  [K in keyof AnalysisParameters]: AnalysisParameters[K] extends number ? K : never;
}[keyof AnalysisParameters];

/**
 * スライダー等の入力 UI・バリデーションで共有するパラメータ制約。
 * min/max/step を一元管理し、UI と検証のズレを防ぐ。
 */
export const PARAMETER_CONSTRAINTS = {
  // 不透明度の割合。判定が「> しきい値」のため 1 では全画素が透明になり解析できないので、
  // 1 段（0.01 = α 2.55 相当）手前を上限に取る。
  alphaThreshold: { min: 0, max: 0.99, step: 0.01 },
  figureHeightMm: { min: 1, max: 2000, step: 1 },
  thicknessMm: { min: 0.1, max: 20, step: 0.1 },
  cutLineMarginMm: { min: 0, max: 10, step: 0.5 },
  cutLineSmoothing: { min: 0, max: 5, step: 1 },
  // 0 は「隙間埋め無効」を表す（クロージング自体をスキップする）。
  gapFillThresholdMm: { min: 0, max: 20, step: 0.5 },
  // 連結部は 0 幅だと union で結合できないため下限を正値にする。
  minBridgeWidthMm: { min: 0.5, max: 20, step: 0.5 },
  slotWidthMm: { min: 0.1, max: 50, step: 0.1 },
  // オフセットは左右対称に振れるよう負値も許容する（正=右／負=左）。
  slotOffsetMm: { min: -50, max: 50, step: 0.5 },
  // 前後オフセットも同様に負値を許容する（正=前／負=後）。実効範囲は台座奥行と板厚で決まり、
  // スリットが台座からはみ出す指定は analysis/base が台座計算不可として弾く。
  slotDepthOffsetMm: { min: -150, max: 150, step: 0.5 },
  // 首部幅の実効下限は差込口幅に連動する（minNeckWidthMm）。ここでの min は絶対的な床。
  // 上限は設けない：妥当な首部幅は板の大きさ次第（大きなフィギュアほど肩を広く取れる）で、
  // 一律の頭打ちには意味がないため。広げすぎて首部の左右端が板から外れる場合は、入力の
  // 制限ではなく解析側が差込口配置不可として弾く（analysis/slot の lowerCrossing）。
  neckWidthMm: { min: 1, step: 0.5 },
  plateLiftMm: { min: 0, max: 50, step: 0.5 },
  // 指定値がそのまま台座の実寸幅になるため、下限は「スリットが切れる」程度の正値に取る。
  baseWidthMm: { min: 1, max: 300, step: 1 },
  // 奥行も指定値がそのまま実寸。実効下限は板厚（スリットを内包できること）に連動する。
  baseDepthMm: { min: 1, max: 300, step: 1 },
  // 角丸半径の実効上限は min(台座幅, 台座奥行)/2 に連動する（maxCornerRadiusMm）。
  // ここでの max は絶対的な天井（台座幅・奥行の上限 300 の半分）。
  baseCornerRadiusMm: { min: 0, max: 150, step: 0.5 },
  // 円形・正多角形の直径。台座幅・奥行と同じ実寸レンジに揃える。
  baseDiameterMm: { min: 1, max: 300, step: 1 },
  // 正多角形の辺数。3 未満は多角形にならず、12 を超えると円と見分けがつかない。
  basePolygonSides: { min: 3, max: 12, step: 1 },
  // 回転角。正の向きは方位角（右 0° → 前 90°）と同じ。
  basePolygonRotationDeg: { min: -180, max: 180, step: 1 },
  // キーホルダー穴の直径。1–10 mm、0.5 mm 刻み（grilling で確定）。
  keychainHoleDiameterMm: { min: 1, max: 10, step: 0.5 },
  // キーホルダー穴の上端からの余裕。実効範囲はカットライン高さで決まるため、
  // ここでは広めの絶対レンジを与え、解析側で余裕内にクランプ・失敗判定する。
  keychainHolePaddingMm: { min: -50, max: 150, step: 0.5 },
  // キーホルダー穴の水平オフセット。実効範囲はカットライン幅で決まるため、
  // ここでは広めの絶対レンジを与え、解析側で余裕内にクランプ・失敗判定する。
  keychainHoleOffsetXMm: { min: -150, max: 150, step: 0.5 },
} as const satisfies Record<NumericParameterKey, ParameterConstraint>;

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
  baseShapeSource: null,
  result: null,
  backImage: null,
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
  | { type: 'setBackImage'; image: FigureImage }
  | { type: 'clearBackImage' }
  | { type: 'updateParameters'; parameters: Partial<AnalysisParameters> }
  | { type: 'setBaseShapeSource'; source: BaseShapeSource }
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

    case 'setBackImage':
      // 背面画像は表示アセットであり、解析結果には影響しない。
      return {
        ...state,
        backImage: action.image,
      };

    case 'clearBackImage':
      return {
        ...state,
        backImage: null,
      };

    case 'updateParameters':
      // パラメータ変更は再解析のトリガー。直前の結果は破棄せず、新しい解析結果が届く
      // まで表示し続ける（再解析は Worker 非同期のため、破棄するとオーバーレイが
      // 変更のたびに消えてちらつく）。結果を保持している場合のみ「再計算中」を示す
      // analyzing へ進める。結果が無い状態（初回解析中・エラー表示中）は状態を保ち、
      // 再解析の成否が届いた時点で置き換える（第 1 相失敗などで再解析自体が走らない
      // ケースで、スピナーが出続けるのを防ぐ）。
      // 正規化を通し、パラメータ間の不変条件（首部幅 > 差込口幅）を常に成立させる。
      return {
        ...state,
        parameters: normalizeParameters({ ...state.parameters, ...action.parameters }),
        status: state.result ? 'analyzing' : state.status,
      };

    case 'setBaseShapeSource': {
      // 読み込んだ時点で台座奥行をソースのアスペクト比へ合わせる（台座幅は維持。SPEC
      // 「正規化とスケール」）。以後は幅・奥行を独立に変更でき、引き伸ばしも許す。
      // 奥行の変更は角丸半径の上限にも効くため、必ず normalizeParameters を通す。
      const { baseWidthMm } = state.parameters;
      const aspect = action.source.aspectRatio;
      const depth = aspect > 0 ? baseWidthMm / aspect : state.parameters.baseDepthMm;
      const constraint = PARAMETER_CONSTRAINTS.baseDepthMm;
      const baseDepthMm = Number.isFinite(depth)
        ? clamp(Math.round(depth * 10) / 10, constraint.min, constraint.max)
        : state.parameters.baseDepthMm;
      // パラメータ変更と同じ扱い：直前の結果・エラーは破棄せず、再解析の応答が届いた時点で
      // 置き換える（第 1 相が失敗している状態でここだけ error を消すと、再解析が走らず
      // エラー表示だけが消えてしまう）。
      return {
        ...state,
        baseShapeSource: action.source,
        parameters: normalizeParameters({ ...state.parameters, baseDepthMm }),
        status: state.result ? 'analyzing' : state.status,
      };
    }

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
