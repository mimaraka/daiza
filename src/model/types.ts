// ドメイン型定義。
//
// このモジュールは React に依存しない純粋な型のみを持つ。UI・解析・描画・
// エクスポートの各層が共通の語彙で会話できるようにするための「型の辞書」であり、
// ここに実装（関数）は置かない。
//
// 座標系は 2 系統存在する。混同を避けるため、フィールド名の末尾に単位を付す。
//   - ピクセル座標系（`...Pixel` / `pixel`）：画像の左上原点・下方向が +Y。
//   - 実寸座標系（`...Mm` / `mm`）：mm 単位。ピクセル座標を `mmPerPixel` で換算したもの。

/** 2 次元の点。座標系（px / mm）は利用側のフィールド名で区別する。 */
export interface Point {
  x: number;
  y: number;
}

/** 幅・高さの組。 */
export interface Size {
  width: number;
  height: number;
}

/**
 * 外形（輪郭）ポリゴン。ピクセル座標系の頂点列。
 * 将来的に穴あき形状・複数輪郭へ拡張する場合は型を Contour[] へ広げる。
 */
export type Contour = Point[];

/**
 * ブラウザ内でデコード済みの入力画像。
 * プライバシー要件（外部送信禁止）のため、ピクセルデータはメモリ内のみで保持する。
 *
 * 重要：この型は React の state / props に載るため、**巨大な配列を own プロパティに
 * 持つオブジェクト（ImageData 等）を含めてはならない**。Chrome では ImageData の
 * `data`（数千万要素の Uint8ClampedArray）が own プロパティであり、React 19 の
 * dev ビルド（Performance Tracks）が props 変更を performance.measure へシリアライズ
 * する際に全要素を列挙してしまい、3000px 級で数十秒のフリーズと GB 級の GC を
 * 起こすことが実測で確認された。解析用の RGBA ピクセルは React の外
 * （model/pixelStore）で受け渡し、state には描画用の ImageBitmap だけを持たせる。
 */
export interface FigureImage {
  /**
   * 読み込みごとに一意な識別子（読み込み時に採番）。
   * hooks/useAnalysis が「どの画像の解析か」を照合する鍵であり、pixelStore から
   * 解析用ピクセルを引くための鍵でもある。
   */
  id: number;
  /** 元ファイル名。結果表示や SVG のダウンロード名に利用する。 */
  fileName: string;
  /**
   * プレビュー描画用のデコード済みビットマップ（drawImage で Canvas へ描く）。
   * ImageData と違い巨大な own プロパティを持たないため React の state に置ける。
   */
  bitmap: ImageBitmap;
  /** ピクセル寸法。 */
  width: number;
  height: number;
}

/**
 * ユーザーが操作する解析パラメータ。
 * これらの変更が「解析 → 状態更新 → 再描画」パイプラインのトリガーになる。
 */
export interface AnalysisParameters {
  /** フィギュア高さ(mm)。画像高さ(px)と合わせてスケール換算に使う。 */
  figureHeightMm: number;
  /** アクリル板の板厚(mm)。差込口の奥行・SVG 生成に影響する。 */
  thicknessMm: number;
  /**
   * カットライン余白(mm, 0〜10 程度)。実際のアクリルフィギュアは絵柄（不透明領域）の
   * 外側に余白を取ってカットするため、不透明境界そのものではなく、この余白ぶん外側へ
   * オフセットした線をアクリル外形（カットライン）とする。重心・台座計算・外形描画・
   * SVG はすべてこのカットラインを基準にする。
   */
  cutLineMarginMm: number;
  /**
   * カットライン平滑化の強さ（0=無効。大きいほど滑らか）。不透明境界は画素段差で
   * 細かく波打つため、余白オフセット後に角を丸めて滑らかなカットラインに整える。
   * 値は平滑化の反復回数として解釈する（analysis/contour の Chaikin 反復数）。
   */
  cutLineSmoothing: number;
  /**
   * 分離した複数パーツを連結する際の最小幅(mm)。不透明領域が余白を足しても結合しない
   * 複数パーツに分かれる場合、凸包で緩く包むのではなく各パーツの輪郭に沿わせたまま
   * 細い連結部（ブリッジ）で 1 枚のアクリルにまとめる。連結部が細すぎるとアクリルの
   * 耐久性が落ちるため、連結部の幅がこの値を下回らないようにする。単一パーツ画像では
   * 連結が発生しないため影響しない（analysis/contour の buildCutline が使用）。
   */
  minBridgeWidthMm: number;
  /** 差込口幅(mm)。 */
  slotWidthMm: number;
  /**
   * 差込口オフセット(mm)。差込口は基本的に重心の真下（重心X）へ置くが、左右方向の
   * 微調整のためにこの値ぶんずらす。正で右、負で左（差込口中心X = 重心X + オフセット）。
   * 初期値 0。
   */
  slotOffsetMm: number;
  /** 安全率（1.0〜2.0）。推奨台座幅の余裕度を決める。 */
  safetyFactor: number;
  /** 台座の左右余白(mm, 0〜30)。支持範囲の外側に付ける余白。 */
  baseMarginMm: number;
}

/** 重心解析の結果。 */
export interface Centroid {
  /** ピクセル座標系の重心（オーバーレイ描画用）。 */
  pixel: Point;
  /** 実寸(mm)座標系の重心（結果表示用）。 */
  mm: Point;
  /**
   * カットラインが囲む領域の面積(px²)。均一密度とみなした重心計算の 0 次モーメント
   * （＝面積）に相当し、密度マップ等の将来拡張の起点になる。
   */
  pixelCount: number;
}

/**
 * 差込口の探索結果。
 * 現状は単一の矩形差込口を前提とするが、将来の複数差込口対応を見据え、
 * 台座計算とは独立した 1 単位として表現する。
 */
export interface SlotResult {
  /** 差込口中心の X（ピクセル）。重心X + 差込口オフセットで決まる。 */
  centerXPixel: number;
  /** 差込口（ツメ）の上端 Y（ピクセル）。ここから bottomYPixel までがツメの縦帯。 */
  yPixel: number;
  /**
   * 差込口（ツメ）の下端 Y（ピクセル）。カットラインの最下端（足元）に合わせる。
   * ツメが本体から離れている場合はここまでカットラインを下方向へ拡張して一体化する。
   */
  bottomYPixel: number;
  /** 差込口幅（ピクセル）。 */
  widthPixel: number;
  /** 実寸換算した中心 X（mm）。 */
  centerXMm: number;
  /** 実寸換算した差込口幅（mm）。 */
  widthMm: number;
}

/**
 * 台座サイズの計算結果。
 * 支持多角形の考え方に基づき、重心が支持範囲内に収まることを最低条件とする。
 * 現状は矩形台座前提。円形・楕円・任意形状は将来拡張。
 */
export interface BaseResult {
  /** 推奨台座幅(mm)。安全率を反映済み。 */
  widthMm: number;
  /** 推奨奥行(mm)。 */
  depthMm: number;
  /** 支持範囲の左端 X（実寸 mm 座標系）。オレンジ線・転倒角の基準。 */
  supportLeftMm: number;
  /** 支持範囲の右端 X（実寸 mm 座標系）。 */
  supportRightMm: number;
}

/** 転倒シミュレーションの結果。左右方向それぞれの転倒角。 */
export interface StabilityResult {
  /** 左方向へ倒れる際の転倒角(度)。θ = atan(支持端距離 / 重心高さ)。 */
  tippingAngleLeftDeg: number;
  /** 右方向へ倒れる際の転倒角(度)。 */
  tippingAngleRightDeg: number;
}

/**
 * 1 回の解析で確定する結果一式。
 * オーバーレイ描画・結果表示・SVG エクスポートは、この単一オブジェクトを入力とする。
 */
export interface AnalysisResult {
  /** 画像のピクセル寸法。 */
  imageSize: Size;
  /** 実寸(mm)寸法。 */
  physicalSize: Size;
  /** スケール換算係数（mm/px）。 */
  mmPerPixel: number;
  /** 外形（輪郭）ポリゴン。 */
  contour: Contour;
  centroid: Centroid;
  slot: SlotResult;
  base: BaseResult;
  stability: StabilityResult;
}

/**
 * 解析が失敗し得る種別。UI 側でメッセージへマッピングするために列挙で持つ。
 * 例外でクラッシュさせず、これらを state に載せて表示する。
 */
export type AnalysisErrorKind =
  | 'imageLoadFailed' // PNG 読み込み失敗
  | 'unsupportedImage' // 非対応画像（RGBA でない等）
  | 'transparentImage' // 全透明でアクリル領域が存在しない
  | 'slotPlacementFailed' // 差込口が配置不可
  | 'baseCalculationFailed' // 台座計算不可（重心が支持範囲外等）
  | 'unexpectedError'; // 想定外の例外（バグ等）の受け皿。クラッシュさせず表示する

/** UI へ提示するためのエラー情報。 */
export interface AnalysisError {
  kind: AnalysisErrorKind;
  /** ユーザー向けの説明文（日本語）。 */
  message: string;
}
