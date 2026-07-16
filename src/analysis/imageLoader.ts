// PNG 読み込み：File を受け取り、ブラウザ内でデコードして FigureImage を得る。
//
// このモジュールは「入力の受け口」であり、解析パイプライン（重心・差込口…）の
// 前段に位置する純粋ロジック。React には依存しない。
//
// プライバシー要件（SPEC）：画像はブラウザ内でのみ処理し、外部へ送信しない。
// そのため createImageBitmap → Canvas という完全ローカルな経路でデコードする。
//
// 失敗は例外で投げず、型付きの AnalysisError として返す。呼び出し側（UI）が
// クラッシュせずにメッセージ表示へマッピングできるようにするため。

import { depositPixels } from '@/model/pixelStore';
import type { AnalysisError, AnalysisErrorKind, FigureImage } from '@/model/types';
import { hasVisiblePixels, MIN_ALPHA_THRESHOLD } from '@/utils/image';

/** imageLoader が返し得るエラー種別。 */
type ImageLoadErrorKind = Extract<
  AnalysisErrorKind,
  'imageLoadFailed' | 'unsupportedImage' | 'transparentImage'
>;

/** 画像読み込みの結果。成功なら FigureImage、失敗なら型付きエラー。 */
export type ImageLoadResult =
  { ok: true; image: FigureImage } | { ok: false; error: AnalysisError };

/** エラー結果を組み立てる小ヘルパー。 */
function fail(kind: ImageLoadErrorKind): ImageLoadResult {
  return { ok: false, error: { kind } };
}

/**
 * 読み込みごとに単調増加する画像 id を採番する。
 * FigureImage.id は「どの読み込みか」を一意に指すだけでよく、値の意味は問わない。
 * useAnalysis の解析照合と、pixelStore（解析用ピクセルの React 外の受け渡し）の
 * 鍵として使う。
 */
let nextImageId = 0;

/**
 * PNG ファイルかどうかを緩く判定する。
 * MIME 型が空になる環境（一部の D&D 等）もあるため、拡張子も併せて許容する。
 * 中身の厳密な検証は createImageBitmap のデコード可否に委ねる。
 */
function looksLikePng(file: File): boolean {
  return file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
}

/**
 * PNG ファイルを読み込み、描画用 ImageBitmap を持つ FigureImage を返す。
 *
 * 手順：PNG 判定 → createImageBitmap でデコード → Canvas へ描画して
 * getImageData で RGBA ピクセルを取得 → 全透明チェック。
 *
 * RGBA ピクセル（ImageData）は戻り値に含めず pixelStore へ預ける：ImageData を
 * React の state へ載せると dev ビルドの props シリアライズが picture 全画素を列挙して
 * フリーズするため（model/types の FigureImage 注記参照）。解析側（useAnalysis）が
 * 画像 id で一度だけ取り出して Worker へ転送する。
 */
export async function loadPngFile(file: File): Promise<ImageLoadResult> {
  if (!looksLikePng(file)) {
    return fail('unsupportedImage');
  }

  // createImageBitmap はネットワークを介さずローカルにデコードする（外部送信なし）。
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return fail('imageLoadFailed');
  }

  const width = bitmap.width;
  const height = bitmap.height;
  if (width === 0 || height === 0) {
    bitmap.close();
    return fail('imageLoadFailed');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // willReadFrequently: getImageData を前提とした描画であることを明示し、
  // ブラウザに読み出し向けの内部表現を選ばせて性能低下を避ける。
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return fail('imageLoadFailed');
  }

  ctx.drawImage(bitmap, 0, 0);

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    // 通常ローカル画像で汚染は起きないが、getImageData の失敗も握り潰さず扱う。
    bitmap.close();
    return fail('imageLoadFailed');
  }

  // 読み込み段階で弾くのは「α が全画素 0」の完全透明 PNG だけ。ユーザーが指定する
  // アルファ閾値（AnalysisParameters.alphaThreshold）はここでは未知であり、しきい値を
  // 上げた結果として不透明領域が消えるケースは解析側（analysis/pipeline）がエラーにする。
  if (!hasVisiblePixels(imageData, MIN_ALPHA_THRESHOLD)) {
    bitmap.close();
    return fail('transparentImage');
  }

  // bitmap はプレビュー描画用として FigureImage が長期保持する（close しない）。
  // 解析用ピクセルは React を経由させず、id を鍵に pixelStore で受け渡す。
  const id = nextImageId++;
  depositPixels(id, imageData);

  return {
    ok: true,
    image: { id, fileName: file.name, bitmap, width, height },
  };
}
