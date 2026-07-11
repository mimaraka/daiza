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
  /**
   * フィギュア高さ(mm)。**接地面（台座の底面）からカットライン（絵柄＋余白）の上端まで**の
   * 全高。ルーラーの Y 原点が接地面なので、カットライン上端の目盛りがそのままこの値になる
   * （SPEC「フィギュア高さ」）。スケール(mm/px)は、この全高から絵柄の外側の高さ
   * （カットライン余白×2＋持ち上げ量＋板厚）を差し引いた「絵柄の高さ(mm)」を、絵柄の
   * 高さ(px) で割って求める（analysis/scale の computeMmPerPixel）。画像高さではなく
   * 絵柄の高さを基準にすることで、PNG の透明余白の量で実寸が変わらないようにしている。
   */
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
   * 隙間埋め閾値(mm, 0=無効)。カットライン同士の隙間がこの値より狭いと、そこに残る
   * アクリルが細くなりカット時・使用時に破損しやすい。そこで幅がこの閾値未満の隙間を
   * アクリルで充填する（分離パーツ間の隙間にも、同一パーツ内のくびれにも働く）。
   * 実装は半径 = 閾値/2 の円板によるモルフォロジカルクロージング（膨張→収縮）で、
   * 「半径 r の円板が入り込めない隙間」だけが円弧でなめらかに埋まる
   * （analysis/distance の closeMask を analysis/contour の cutlineFromMask が使用）。
   * 充填は差込部の首部を合流させた後のマスクに対して行うため、首部の側面とフィギュア
   * 外形の間にできる狭い隙間も対象になる（SPEC「隙間埋めと差込部の整合」）。
   */
  gapFillThresholdMm: number;
  /**
   * 分離した複数パーツを連結する際の最小幅(mm)。不透明領域が余白を足しても結合しない
   * 複数パーツに分かれる場合、凸包で緩く包むのではなく各パーツの輪郭に沿わせたまま
   * 細い連結部（ブリッジ）で 1 枚のアクリルにまとめる。連結部が細すぎるとアクリルの
   * 耐久性が落ちるため、連結部の幅がこの値を下回らないようにする。単一パーツ画像では
   * 連結が発生しないため影響しない（analysis/contour の cutlineFromMask が使用）。
   */
  minBridgeWidthMm: number;
  /** 差込口幅(mm)。差込部のうち台座スリットへ挿す「ツメ」の幅にあたる。 */
  slotWidthMm: number;
  /**
   * 差込口オフセット(mm)。差込口は基本的に重心の真下（重心X）へ置くが、左右方向の
   * 微調整のためにこの値ぶんずらす。正で右、負で左（差込口中心X = 重心X + オフセット）。
   * 初期値 0。
   */
  slotOffsetMm: number;
  /**
   * 首部幅(mm)。差込部は「首部（板と台座の間を埋める矩形）」と「ツメ（スリットへ挿す矩形）」
   * の 2 段構成で、首部はツメより広い。その差分の肩（ショルダー）が台座上面に乗ることで
   * 挿入深さがツメ深さ（板厚）で止まるため、必ず 差込口幅 + 2×最小ショルダー幅 以上に保つ
   * （model/state の minNeckWidthMm / normalizeParameters が不変条件として強制する）。
   */
  neckWidthMm: number;
  /**
   * アクリル板の持ち上げ量(mm, 0〜50 程度)。台座上面 Y = カットライン最下端 Y + この値。
   * 0 で板の下端が台座上面にちょうど接し、増やすほど板が浮く（隙間は首部が埋める）。
   * 板本体が台座へ潜り込まないための不変条件（板の最下端 ≦ 台座上面）の調整代でもある。
   */
  plateLiftMm: number;
  /** 安全率（1.0〜2.0）。指定台座幅が満たすべき必要幅の余裕度を決める。 */
  safetyFactor: number;
  /**
   * 台座幅(mm)。ユーザーが指定した値が**そのまま台座の実寸の幅**になる（左右へ 2 倍しない）。
   * 台座は差込口中心を軸に左右対称へ置くため、支持範囲は差込口中心 ± 台座幅/2。
   * 指定幅が支持に足りない（重心が支持範囲外／安全率を満たさない）場合は台座計算不可とする。
   */
  baseWidthMm: number;
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

/** 差込部を構成する軸平行矩形（ピクセル座標系、左上原点）。 */
export interface SlotRect {
  xPixel: number;
  yPixel: number;
  widthPixel: number;
  heightPixel: number;
}

/**
 * 差込部の配置結果。
 *
 * 差込部は幅の異なる 2 矩形から成る（SPEC「差込部の構造」）：
 *   首部 … 幅 = 首部幅。カットライン下端〜台座上面。板と台座の隙間を埋める。
 *   ツメ … 幅 = 差込口幅（首部より狭い）。台座上面から板厚ぶん下へ挿さる。
 * 幅の差でできる肩が台座上面に乗り、挿入深さがツメ深さで止まる。
 *
 * 現状は単一の差込部を前提とするが、将来の複数差込口対応を見据え、台座計算とは
 * 独立した 1 単位として表現する。
 */
export interface SlotResult {
  /** 差込部中心の X（ピクセル）。重心X + 差込口オフセットで決まる。首部・ツメ共通の軸。 */
  centerXPixel: number;
  /** 実寸換算した中心 X（mm）。 */
  centerXMm: number;
  /**
   * 台座上面 Y（ピクセル）＝首部下端＝ツメ上端。カットライン最下端 + 持ち上げ量。
   * 板本体はこの線より上、下へ出てよいのはツメだけ（SPEC「アクリル板と台座の上下関係」）。
   */
  baseTopYPixel: number;
  /** 首部の矩形（ピクセル）。上端はカットラインと重なり、下端は台座上面に一致する。 */
  neck: SlotRect;
  /** ツメの矩形（ピクセル）。台座上面から板厚ぶん下へ伸びる。 */
  tab: SlotRect;
  /** 差込口幅（＝ツメ幅、mm）。 */
  widthMm: number;
  /** 首部幅(mm)。 */
  neckWidthMm: number;
  /** ツメ深さ(mm)。板厚と同じで、台座を貫通しない（≦ 台座奥行）。 */
  tabDepthMm: number;
}

/**
 * 台座サイズの計算結果。
 * 支持多角形の考え方に基づき、重心が支持範囲内に収まることを最低条件とする。
 * 現状は矩形台座前提。円形・楕円・任意形状は将来拡張。
 */
export interface BaseResult {
  /** 台座幅(mm)。ユーザー指定値（AnalysisParameters.baseWidthMm）がそのまま入る。 */
  widthMm: number;
  /** 推奨奥行(mm)。ツメ深さ（板厚）を内包し、貫通しない大きさを保証する。 */
  depthMm: number;
  /**
   * 台座上面 Y（実寸 mm 座標系）。カットライン最下端 + 持ち上げ量。
   * 支持範囲・重心高さ（転倒角・奥行）の基準線であり、SlotResult.baseTopYPixel と同一の線。
   */
  topYMm: number;
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
  | 'scaleCalculationFailed' // スケール計算不可（フィギュア高さが接地面までのオフセット以下）
  | 'slotPlacementFailed' // 差込口が配置不可
  | 'baseCalculationFailed' // 台座計算不可（重心が支持範囲外等）
  | 'unexpectedError'; // 想定外の例外（バグ等）の受け皿。クラッシュさせず表示する

/** UI へ提示するためのエラー情報。 */
export interface AnalysisError {
  kind: AnalysisErrorKind;
  /** ユーザー向けの説明文（日本語）。 */
  message: string;
}
