// 解析用 RGBA ピクセル（ImageData）の React 外の受け渡し口。
//
// ImageData は React の state / props に載せてはならない（model/types の FigureImage の
// 注記参照：Chrome では `data` が数千万要素の own プロパティで、React 19 dev ビルドの
// props シリアライズが全要素を列挙して数十秒フリーズする）。そこで、読み込み時に
// imageLoader がここへ predeposit し、解析の駆動点（hooks/useAnalysis）が画像 id で
// 一度だけ取り出して Web Worker へ転送する。取り出しは 1 回きり（take）：バッファは
// Worker へ Transferable として渡った時点で detach され再利用できないため、残しておく
// 意味がなく、確実に参照を切ってメモリも解放する。
//
// モジュールスコープの Map で持つ単純な仕組みで足りる：アプリは単一画像・単一読み込み
// フローであり、書き込み（loadPngFile）→ 読み出し（useAnalysis の第 1 相投入）が
// 常に 1 対 1 で対応する。

/** 画像 id → 解析用ピクセル。エントリは take で必ず消費される。 */
const store = new Map<number, ImageData>();

/** 読み込んだ画像の解析用ピクセルを預ける（imageLoader が呼ぶ）。 */
export function depositPixels(imageId: number, imageData: ImageData): void {
  store.set(imageId, imageData);
}

/**
 * 解析用ピクセルを取り出す（1 回きり。取り出した時点でストアから消える）。
 * 対応するエントリが無ければ null（読み込みフローを経ていない・既に消費済み）。
 */
export function takePixels(imageId: number): ImageData | null {
  const pixels = store.get(imageId);
  if (!pixels) {
    return null;
  }
  store.delete(imageId);
  return pixels;
}
