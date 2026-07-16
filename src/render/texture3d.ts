// 3D プレビュー用テクスチャの生成（DOM 依存のアダプタ層。React / three 非依存）。
//
// 実物のアクリルフィギュアは板の**裏面**に UV 印刷され、奥から「白版 → 絵柄 → アクリル板」と
// 重なる（SPEC「印刷レイヤ」）。3D ではこれを 2 枚のテクスチャ平面として再現するため、
// 読み込み済みビットマップから
//   ・絵柄  … 画像そのもの（α をそのまま残す。前から見るとアクリル越しに見える）
//   ・白版  … α をしきい値で 2 値化した白いシルエット（後ろから見ると直接見える）
// の 2 枚を作る。
//
// 解析用の RGBA（ImageData）は Worker へ transfer 済みで手元に残らないため、素材は
// プレビュー用の ImageBitmap に限られる（export/raster.ts と同じ事情）。canvas は DOM API
// なので、純粋に保ちたい render/scene3d.ts からは切り離し、ラスタ変換だけをここへ隔離する。
//
// 3000px 級の入力をそのまま GPU へ送ると VRAM・アップロード時間が嵩むため、長辺を
// [[MAX_TEXTURE_SIZE]] px へ抑えてから作る（SPEC「テクスチャは長辺 2048px 程度を上限に」）。
// 解析はあくまで原寸のピクセルで行われており、ここでの縮小は**表示にしか影響しない**。
//
// 床タイル（[[buildFloorTexture]]）も同じ理由でここに置く。こちらは「敷き詰めて使う 1 枚の
// タイル」であり、目盛りグリッドもこのタイルへ**焼き込む**（透明なグリッド面を床へ重ねない）。
// 印刷レイヤと同じ制約が理由で、three の transmission は屈折の背景バッファへ不透明オブジェクト
// しか描かないため、半透明のグリッド面はアクリル板・台座越しに消えてしまう（＝台座の footprint
// だけ格子が抜ける）。床の map に焼けば床は不透明のままなので、アクリル越しでも格子が見える。

import { alphaCutoff } from '@/utils/image';

/** テクスチャの長辺の上限(px)。 */
const MAX_TEXTURE_SIZE = 2048;

/**
 * 床タイル 1 枚の実寸(mm)。テクスチャ画像 1 枚がこの正方形に収まる形で敷き詰められる。
 * グリッドの目盛りもこのタイルへ焼き込むため、[[GRID_CELL_MM]] / [[GRID_SECTION_MM]] は
 * この値を割り切る必要がある（割り切れないと、タイルの継ぎ目で格子がずれる）。
 */
export const FLOOR_TILE_MM = 400;

/** 床タイルの解像度(px)。400mm を 1024px ＝ 約 2.56px/mm。 */
const FLOOR_TILE_PX = 1024;

/** グリッドのマス目(mm)と、強調線の間隔(mm)。いずれも [[FLOOR_TILE_MM]] を割り切ること。 */
const GRID_CELL_MM = 10;
const GRID_SECTION_MM = 50;

/** グリッド線の色と太さ(px)。任意のテクスチャの上に載るため、暗色を薄く重ねる。 */
const GRID_CELL_COLOR = 'rgba(15, 23, 42, 0.22)';
const GRID_SECTION_COLOR = 'rgba(15, 23, 42, 0.45)';
const GRID_CELL_WIDTH_PX = 1;
const GRID_SECTION_WIDTH_PX = 2;

/** 板の裏面へ貼る 2 枚のレイヤ。いずれも同じ寸法・同じ向き（画像そのままの向き）。 */
export interface ArtworkTextures {
  /** 前から見えるレイヤ：白版の上に絵柄を刷った合成（不透明領域は α=1）。 */
  readonly artwork: HTMLCanvasElement;
  /** 後ろから見えるレイヤ：白版（不透明領域のみ白・それ以外は完全透明）。 */
  readonly white: HTMLCanvasElement;
}

/**
 * 印刷レイヤを切り抜く alphaTest のしきい値。
 *
 * 印刷レイヤは**半透明合成を使えない**（後述）ため、α で切り抜く。three の alphaTest は
 * 「α < しきい値なら破棄」なので、解析の判定（α > cutoff を不透明）と揃えるには cutoff を
 * 正規化した値をそのまま渡せばよい。ただし既定のしきい値 0（＝α>0 をアクリル）では
 * alphaTest 0 は何も破棄しないため、1/255（＝α=0 だけを破棄）を下限に取る。
 */
export function inkAlphaTest(alphaThreshold: number): number {
  return Math.max(alphaThreshold, 1 / 255);
}

/** 指定サイズの 2D canvas とコンテキストを用意する。 */
function createCanvas(
  width: number,
  height: number,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas の 2D コンテキストを取得できませんでした。');
  }
  return [canvas, ctx];
}

/**
 * 絵柄テクスチャ（白版と合成済み）と白版テクスチャを作る。
 *
 * 白版のシルエットは解析と同一の判定（utils/image の alphaCutoff：しきい値 × 255 **より
 * 大きい** α を不透明とみなす）で決める。これにより白版がカットライン内の絵柄と食い違わない。
 *
 * 絵柄側は「α をそのまま残した半透明テクスチャ」にはせず、**白版の上に絵柄を刷った合成**
 * （不透明領域は α=1）にする。理由は 2 つあり、どちらも同じ結論に至る：
 *
 *  ・物理：実物のインクは白版の上に載るので、半透明のインクも白に裏打ちされて不透明に見える。
 *    α=0.5 の画素は「透けたまま」ではなく「白と混ざった淡い色」になるのが正しい。
 *  ・描画：three の透過（transmission）は、屈折の背景となるバッファへ**不透明オブジェクトしか
 *    描かない**（WebGLRenderer.renderTransmissionPass が opaque のみを描画する）。半透明マテリアル
 *    のままだと、アクリル板越しに絵柄が一切見えなくなる。合成して不透明にし、シルエットは
 *    alphaTest（[[inkAlphaTest]]）で切り抜くことで、この制約を正面から満たす。
 */
export function buildArtworkTextures(bitmap: ImageBitmap, alphaThreshold: number): ArtworkTextures {
  const scale = Math.min(1, MAX_TEXTURE_SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  // 白版：いったん絵柄を縮小して描き、その α をしきい値で 2 値化して白へ置き換える
  // （putImageData は合成ではなく上書きなので、下絵は残らない）。縮小で生じた中間 α も
  // この 2 値化で落ちるため、白版の縁は絵柄の芯に沿う。
  const [white, whiteCtx] = createCanvas(width, height);
  whiteCtx.drawImage(bitmap, 0, 0, width, height);
  const source = whiteCtx.getImageData(0, 0, width, height);
  const mask = whiteCtx.createImageData(width, height);
  const cutoff = alphaCutoff(alphaThreshold);
  for (let i = 3; i < source.data.length; i += 4) {
    if ((source.data[i] ?? 0) > cutoff) {
      mask.data[i - 3] = 255;
      mask.data[i - 2] = 255;
      mask.data[i - 1] = 255;
      mask.data[i] = 255;
    }
  }
  whiteCtx.putImageData(mask, 0, 0);

  // 絵柄：白版を下敷きにして絵柄を重ねる（＝実物の印刷順）。白版の範囲は α=1 になり、
  // その外側は元の α（＝しきい値以下）のまま残るので、alphaTest で同じシルエットに切り抜ける。
  const [artwork, artworkCtx] = createCanvas(width, height);
  artworkCtx.drawImage(white, 0, 0);
  artworkCtx.drawImage(bitmap, 0, 0, width, height);

  return { artwork, white };
}

/** 床タイルの内容。 */
export interface FloorTextureOptions {
  /** テクスチャ画像が無いときのタイルの下地色（無地の床の色）。 */
  readonly background: string;
  /** 実寸(mm)の目盛りグリッドを焼き込むか。 */
  readonly grid: boolean;
}

/**
 * 床へ敷き詰めるタイル 1 枚を作る。
 *
 * 画像は正方形のタイル（[[FLOOR_TILE_MM]] 角）へ **cover** で収める（アスペクト比を保ち、
 * はみ出しは中央基準で切り落とす）。引き伸ばして歪ませないためであり、またグリッドのマス目を
 * 実寸の正方形に保つには、タイル自体が実寸の正方形でなければならないからでもある。
 *
 * グリッドはタイルの内側だけでなく**境界（0 と端）にも引く**。境界の線は半分ずつ描かれるが、
 * 敷き詰めると隣のタイルの半分と合わさって 1 本になる。マス目がタイルを割り切る前提と合わせて、
 * 床全体で切れ目のない格子になる。原点（台座中心）はタイル境界に一致する（床サイズ / タイルが
 * 整数、かつ床は原点中心のため）ので、格子線は原点から 10mm 刻みちょうどに並ぶ。
 *
 * 画像もグリッドも無い（＝無地の床）ときも、下地色で塗ったタイルを返して**必ず map を持たせる**。
 * three がシェーダを組み直すのは material.version が上がったときだけで、map を null ↔ テクスチャに
 * 差し替えても（R3F は needsUpdate を立てない）USE_MAP の有無が切り替わらないため、無地から
 * グリッドへ戻したときにテクスチャが無視されてしまう。常に map があれば、この落とし穴を踏まない。
 */
export function buildFloorTexture(
  image: ImageBitmap | null,
  { background, grid }: FloorTextureOptions,
): HTMLCanvasElement {
  const size = FLOOR_TILE_PX;
  const [canvas, ctx] = createCanvas(size, size);

  if (image) {
    // cover：短辺をタイルへ合わせ、長辺のはみ出しを中央で切る。
    const scale = Math.max(size / image.width, size / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  } else {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, size, size);
  }

  if (grid) {
    // マス目 → 強調線の順に引き、交差部は強調線の色で上書きする。
    drawGridLines(ctx, size, FLOOR_TILE_MM / GRID_CELL_MM, GRID_CELL_WIDTH_PX, GRID_CELL_COLOR);
    drawGridLines(
      ctx,
      size,
      FLOOR_TILE_MM / GRID_SECTION_MM,
      GRID_SECTION_WIDTH_PX,
      GRID_SECTION_COLOR,
    );
  }

  return canvas;
}

/**
 * タイルを divisions 等分する格子線を縦横へ引く。
 *
 * 線の位置は「間隔を足し込む」のではなく等分から直に求める（浮動小数の誤差が溜まり、端の 1 本が
 * 落ちるのを避ける）。ぼけを避けるためストロークではなく整数座標の矩形で塗り、線の中心を格子位置に
 * 置く。タイル境界（0 と size）の線ははみ出したぶんが切り取られるが、敷き詰めると隣のタイルの
 * 残り半分と合わさって正しい太さの 1 本になる。
 */
function drawGridLines(
  ctx: CanvasRenderingContext2D,
  size: number,
  divisions: number,
  widthPx: number,
  color: string,
): void {
  ctx.fillStyle = color;
  for (let i = 0; i <= divisions; i++) {
    const start = Math.round((i * size) / divisions - widthPx / 2);
    ctx.fillRect(start, 0, widthPx, size);
    ctx.fillRect(0, start, size, widthPx);
  }
}
