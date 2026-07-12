// 画像ピクセルデータの共通処理（純粋ロジック、React 非依存）。
//
// 解析各層（imageLoader・centroid・contour・slot）は RGBA の ImageData を走査し、
// いずれも「α がしきい値より大きい画素をアクリル、それ以外を透明とみなす」という
// 同一の判定規則に依存する。この規則をここへ一元化することで、各モジュールで規則が
// ズレるのを防ぐ。
//
// 走査そのものは各モジュールの用途（重心の 1 次モーメント・行スパン・輪郭マスク）で
// 最適な形が異なるため、ここでは「1 画素の判定」と「全体で使い回す前処理」だけを
// 提供し、ホットループの構造（行オフセットのホイスト等）は呼び出し側に委ねる。

/**
 * アクリル判定のしきい値の最小値（＝ SPEC 既定の「α=0 を透明・α>0 をアクリル」）。
 * しきい値はユーザーパラメータ（AnalysisParameters.alphaThreshold、0〜1 の割合）だが、
 * パラメータを持たない層（imageLoader の読み込み時チェック）はこの最小値で判定する：
 * 読み込み段階で弾きたいのは「どのしきい値でも解析できない完全透明 PNG」だけであり、
 * しきい値を上げた結果として不透明領域が消えるケースは解析側（analysis/pipeline）が
 * エラーとして扱う。
 */
export const MIN_ALPHA_THRESHOLD = 0;

/**
 * 正規化しきい値（0〜1 の割合）を、8bit の α 値と直接比較できる値へ変換する。
 *
 * パラメータは「不透明度の割合」としてユーザーへ提示する（0.5 = 半透明）一方、ピクセル
 * データの α は 0〜255 の整数である。全画素ループの内側で毎回この換算をしないよう、
 * 走査関数はこの値をループの外へホイストしてから比較する。
 */
export function alphaCutoff(threshold: number): number {
  return threshold * 255;
}

/**
 * α 値（0〜255）がアクリル（充填）とみなせるか。threshold は 0〜1 の割合。
 * 境界は「しきい値より大きい」（>）で判定する。しきい値 0 が SPEC 既定の「α>0 をアクリル」に
 * 一致し、上げるとアンチエイリアスの薄い縁を透明として切り捨てられる。
 */
export function isAcrylicAlpha(alpha: number, threshold: number): boolean {
  return alpha > alphaCutoff(threshold);
}

/**
 * アクリルとみなせる画素が 1 つでも存在するか。threshold は 0〜1 の割合。
 * 全透明画像は重心・差込口の計算対象が無く解析不能なため、上流（読み込み時）で弾く。
 * 最初の 1 つを見つけた時点で打ち切るので、通常画像では即座に判定できる。
 */
export function hasVisiblePixels(imageData: ImageData, threshold: number): boolean {
  const { data } = imageData;
  const cutoff = alphaCutoff(threshold);
  // RGBA の 4 番目（α）のみを走査する。範囲内アクセスだが noUncheckedIndexedAccess
  // 下では number | undefined になるため ?? で 0 に丸めて判定する。
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > cutoff) {
      return true;
    }
  }
  return false;
}

/**
 * RGBA から α チャンネルだけを抜き出した 1 バイト/画素のプレーンを作る。
 *
 * しきい値はユーザーパラメータなので、二値化した結果ではなく **α 値そのもの**を保持する。
 * これにより、しきい値の変更は「プレーンの再しきい値化」（O(W×H) の軽い 1 パス）だけで
 * 済み、RGBA（4 バイト/画素、3000px 級で 36MB）を解析側で抱え続けずに済む
 * （二値化は thresholdAlphaPlane、保持の方針は analysis/pipeline の ImageAnalysis 参照）。
 */
export function extractAlphaPlane(imageData: ImageData): Uint8Array {
  const { data, width, height } = imageData;
  const total = width * height;
  const alpha = new Uint8Array(total);
  for (let p = 0; p < total; p++) {
    alpha[p] = data[p * 4 + 3] ?? 0;
  }
  return alpha;
}

/**
 * α プレーンをしきい値（0〜1 の割合）で二値化し、アクリル画素を 1 とする 1 バイト/画素の
 * マスクを作る。
 *
 * 輪郭追跡のように 1 画素あたり 8 近傍を何度も参照する処理では、α 値を都度比較するより
 * この 0/1 表現を引く方がキャッシュ効率が良く、3000px 級でも実用的な速度を保てる。
 */
export function thresholdAlphaPlane(alpha: Uint8Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(alpha.length);
  const cutoff = alphaCutoff(threshold);
  for (let p = 0; p < alpha.length; p++) {
    mask[p] = (alpha[p] ?? 0) > cutoff ? 1 : 0;
  }
  return mask;
}

/** 不透明領域（アクリルとみなす画素）が存在する行の範囲。 */
export interface RowRange {
  /** 最も上の不透明画素の行 Y。 */
  minY: number;
  /** 最も下の不透明画素の行 Y。 */
  maxY: number;
}

/**
 * α マスクから不透明領域（＝絵柄）の上端・下端の行を求める。存在しなければ null。
 *
 * スケール（mm/px）は画像高さではなく**絵柄の高さ**を基準に取る（SPEC「フィギュア高さ」）。
 * PNG の透明余白の量でフィギュアの実寸が変わってしまわないようにするためであり、この行範囲が
 * その基準になる。同時に「不透明画素が 1 つも無い（しきい値が高すぎる／全透明画像）」の検査も
 * 兼ねるので、二値化後の全画素走査は解析 1 回につき 1 度で収まる。
 */
export function opaqueRowRange(mask: Uint8Array, width: number, height: number): RowRange | null {
  let minY = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x] === 1) {
        if (minY < 0) {
          minY = y;
        }
        maxY = y;
        break;
      }
    }
  }
  return minY < 0 ? null : { minY, maxY };
}
