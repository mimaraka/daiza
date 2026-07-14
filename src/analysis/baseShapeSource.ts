// 台座形状ソース（任意形状）の読み込み：PNG シルエット / SVG パス → 正規化済みの閉じた折れ線。
//
// SPEC「台座形状ソース（任意形状）」に対応する。imageLoader と同じく「入力の受け口」であり、
// ブラウザ API（createImageBitmap / Canvas / SVG DOM）に依存する。解析側（analysis/footprint）は
// ここが返した正規化折れ線だけを見るため、ファイル形式の違いは本モジュールで吸収される。
//
// プライバシー要件（SPEC）：読み込みはブラウザ内で完結し、外部へ送信しない。
// 失敗は例外で投げず、型付きの AnalysisError（baseShapeFailed）として返す。
//
// 出力（BaseShapeSource.outline）は bbox 正規化した閉じた折れ線（x・y とも ±0.5）。y は
// PNG / SVG の下方向 +Y をそのまま採り、上面図の「前（手前）が正」に対応させる。実寸・単位は
// 使わない（台座幅 × 台座奥行へ非等方スケールして footprint にする）。

import polygonClipping, { type Ring } from 'polygon-clipping';

import { extractContours, smoothContour } from '@/analysis/contour';
import type { AnalysisError, BaseShapeSource, Point } from '@/model/types';
import { simplifyPolyline } from '@/utils/geometry';

/**
 * PNG シルエットの二値化しきい値（α > 127）。
 *
 * 絵柄用の「アルファ閾値」パラメータは適用しない：シルエットのアンチエイリアス縁は不透明度 50% を
 * 境界に取るのが知覚的に正しく、絵柄（どこまでをアクリルとみなすか）とは判定の目的が異なるため
 * （SPEC「PNG シルエット」）。
 */
const SILHOUETTE_ALPHA_CUTOFF = 127;

/**
 * シルエット輪郭の平滑化強度（Chaikin 反復回数）と間引き許容誤差(px)。
 *
 * 画素段差を消すための「軽い平滑化」（SPEC）。SPEC に強度の指定はなく、調整可能な定数として扱う
 * （見た目の好みで変えてよい）。曲線補完は footprint 化のときに utils/curve が掛ける。
 */
const SILHOUETTE_SMOOTHING = 2;
const SILHOUETTE_SIMPLIFY_EPSILON_PX = 1;

/**
 * SVG パスをサンプリングする分割数の目安。
 *
 * 独自のパスパーサは書かず、ブラウザの SVG 実装へ解釈を委ねる（`getTotalLength` /
 * `getPointAtLength`）。分割数は正規化後の折れ線として十分な密度（数百〜千頂点）になるよう取る。
 * サンプル点は元曲線上にあるため、この密度なら偏差は footprint の許容誤差（0.05mm）に収まる。
 */
const SVG_SAMPLE_COUNT = 720;

/**
 * サブパスの切れ目を検出する係数。
 *
 * `getPointAtLength` は描かれた区間の弧長だけを進むため、`M`（moveto）による飛びは長さ 0 で
 * 起きる。したがって等間隔サンプルの連続 2 点がサンプル間隔よりはるかに離れていれば、そこが
 * サブパスの境界である。この性質を使えば `d` 属性を自前で解析せずにサブパスを切り出せる。
 */
const SUBPATH_JUMP_FACTOR = 8;

/** SVG から取り込む図形要素と、その幾何を決める属性（スクリプト・イベント属性は持ち込まない）。 */
const SVG_SHAPES: Record<string, readonly string[]> = {
  path: ['d'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  polygon: ['points'],
};

/** 読み込みの成否。成功なら正規化済みソース、失敗なら型付きエラー。 */
export type BaseShapeSourceResult =
  { ok: true; source: BaseShapeSource } | { ok: false; error: AnalysisError };

/** UI へ提示するエラーメッセージ（日本語）。原因ごとに次の一手が分かる文面にする。 */
const ERROR_MESSAGES = {
  unsupported: '対応していないファイルです。台座形状には PNG または SVG を選択してください。',
  decode: 'ファイルを読み込めませんでした。壊れていないか確認してください。',
  emptyPng:
    '台座形状の輪郭を抽出できませんでした。不透明（α>127）な領域を持つ PNG を選択してください。',
  emptySvg:
    '台座形状の輪郭を抽出できませんでした。閉じたパス（または rect / circle / ellipse / polygon）を含む SVG を選択してください。',
} as const;

function fail(message: string): BaseShapeSourceResult {
  return { ok: false, error: { kind: 'baseShapeFailed', message } };
}

/**
 * 台座形状ソースのファイル（PNG / SVG）を読み込み、正規化済みの外形を返す。
 * 拡張子・MIME で経路を分け、いずれも最大面積の閉じた外形 1 本だけを採る（穴は無視する。
 * 穴あき台座は将来拡張）。
 */
export async function loadBaseShapeSource(file: File): Promise<BaseShapeSourceResult> {
  const name = file.name.toLowerCase();
  if (file.type === 'image/svg+xml' || name.endsWith('.svg')) {
    return loadSvgSource(file);
  }
  if (file.type === 'image/png' || name.endsWith('.png')) {
    return loadPngSource(file);
  }
  return fail(ERROR_MESSAGES.unsupported);
}

/**
 * PNG シルエットから外形を取り出す。
 *
 * 固定しきい値 α > 127 で二値化し、既存の輪郭追跡（analysis/contour）で全パーツの輪郭を抽出、
 * **最大面積のパーツ**だけを採用する（小さな飛び地・ごみ画素を無視できる）。画素段差は軽い
 * 平滑化で均す。パーツ内部の穴は輪郭追跡が外輪郭しか返さないため自然に無視される。
 */
async function loadPngSource(file: File): Promise<BaseShapeSourceResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return fail(ERROR_MESSAGES.decode);
  }

  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) {
      return fail(ERROR_MESSAGES.decode);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      return fail(ERROR_MESSAGES.decode);
    }
    ctx.drawImage(bitmap, 0, 0);

    let imageData: ImageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch {
      return fail(ERROR_MESSAGES.decode);
    }

    const mask = new Uint8Array(width * height);
    const { data } = imageData;
    for (let p = 0; p < mask.length; p++) {
      mask[p] = (data[p * 4 + 3] ?? 0) > SILHOUETTE_ALPHA_CUTOFF ? 1 : 0;
    }

    const contours = extractContours(mask, width, height);
    const largest = largestByArea(contours);
    if (!largest) {
      return fail(ERROR_MESSAGES.emptyPng);
    }

    // 画素段差を消す：間引き → 平滑化 → 再間引き（平滑化は頂点を倍増させるため）。
    const simplified = simplifyPolyline(largest, SILHOUETTE_SIMPLIFY_EPSILON_PX);
    const smoothed = simplifyPolyline(
      smoothContour(simplified, SILHOUETTE_SMOOTHING),
      SILHOUETTE_SIMPLIFY_EPSILON_PX,
    );

    const source = normalizeOutline(smoothed, 'png', file.name);
    return source ? { ok: true, source } : fail(ERROR_MESSAGES.emptyPng);
  } finally {
    // 台座形状は折れ線として保持するので、ビットマップはここで解放してよい。
    bitmap.close();
  }
}

/**
 * SVG から外形を取り出す。
 *
 * パスの解釈はブラウザの SVG 実装へ委ねる（SPEC「独自のパスパーサを書かない」）：図形要素を
 * 非表示の SVG へ複製して DOM へ一時挿入し、`getTotalLength` / `getPointAtLength` で折れ線へ
 * サンプリングする。曲線の種類（C / Q / A …）を問わず、正確に元曲線上の点が得られる。
 *
 * 複製時に持ち込むのは幾何属性だけ（SVG_SHAPES）。原本の SVG をそのまま DOM へ挿すと、
 * `<script>` や `onload` 属性が同一オリジンで実行され得るため、必要な属性だけを移し替える。
 * `transform` は非対応（SPEC）。閉じたパスが見つからない・面積 0 のときは失敗として返す。
 */
async function loadSvgSource(file: File): Promise<BaseShapeSourceResult> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return fail(ERROR_MESSAGES.decode);
  }

  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (parsed.getElementsByTagName('parsererror').length > 0) {
    return fail(ERROR_MESSAGES.decode);
  }

  const svgNs = 'http://www.w3.org/2000/svg';
  const host = document.createElementNS(svgNs, 'svg');
  // 描画には出さないがレイアウトは必要（一部ブラウザは切り離された要素で弧長を返さない）。
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'absolute';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';

  const geometry: SVGGeometryElement[] = [];
  for (const [tag, attributes] of Object.entries(SVG_SHAPES)) {
    for (const element of Array.from(parsed.getElementsByTagName(tag))) {
      const clone = document.createElementNS(svgNs, tag);
      for (const attribute of attributes) {
        const value = element.getAttribute(attribute);
        if (value !== null) {
          clone.setAttribute(attribute, value);
        }
      }
      host.appendChild(clone);
      geometry.push(clone as SVGGeometryElement);
    }
  }
  if (geometry.length === 0) {
    return fail(ERROR_MESSAGES.emptySvg);
  }

  document.body.appendChild(host);
  let best: Point[] | null = null;
  try {
    for (const element of geometry) {
      for (const ring of sampleGeometry(element)) {
        if (!best || polygonArea(ring) > polygonArea(best)) {
          best = ring;
        }
      }
    }
  } finally {
    host.remove();
  }

  if (!best) {
    return fail(ERROR_MESSAGES.emptySvg);
  }

  const source = normalizeOutline(removeSelfIntersections(best), 'svg', file.name);
  return source ? { ok: true, source } : fail(ERROR_MESSAGES.emptySvg);
}

/**
 * 自己交差を含む輪郭を union で単純化し、単純化後の最大面積リングを採る（SPEC「正規化とスケール」）。
 *
 * SVG のパスは 8 の字のように自らと交差し得る。そのまま footprint にすると内包検査（交差数判定）が
 * 破綻するため、polygon-clipping で単純多角形へ正規化する。連続する重複点は union が退化リングと
 * して誤処理する原因になるので事前に落とす。union が破綻した場合は入力をそのまま返す（後段の
 * 面積検査で弾ける）。PNG 由来の輪郭は Moore 追跡が構造的に自己交差しないため通さない。
 */
function removeSelfIntersections(outline: readonly Point[]): Point[] {
  const points: Point[] = [];
  for (const p of outline) {
    const last = points[points.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) {
      points.push(p);
    }
  }
  if (points.length < 3) {
    return points;
  }

  try {
    const ring: Ring = points.map((p) => [p.x, p.y]);
    const first = ring[0];
    if (first) {
      ring.push([first[0], first[1]]);
    }
    const merged = polygonClipping.union([ring]);
    let best: Point[] | null = null;
    let bestArea = 0;
    for (const polygon of merged) {
      const outer = polygon[0];
      if (!outer) continue;
      const pts = outer.map(([x, y]) => ({ x, y }));
      // union の出力は閉じている（始点＝終点）。閉じた頂点列の規約へ戻す。
      const head = pts[0];
      const tail = pts[pts.length - 1];
      if (pts.length > 1 && head && tail && head.x === tail.x && head.y === tail.y) {
        pts.pop();
      }
      const area = polygonArea(pts);
      if (pts.length >= 3 && area > bestArea) {
        bestArea = area;
        best = pts;
      }
    }
    return best ?? points;
  } catch {
    return points;
  }
}

/**
 * 図形要素を等間隔にサンプリングし、サブパスごとの閉じた折れ線へ切り分ける。
 *
 * `getPointAtLength` は moveto の飛びを長さ 0 で越えるため、連続サンプルの距離がサンプル間隔を
 * 大きく超えた箇所がサブパスの境界になる（SUBPATH_JUMP_FACTOR）。これにより `d` 属性を
 * 解析せずに複数サブパス（穴・複数の島）を分離でき、呼び出し側は最大面積のものを選べる。
 */
function sampleGeometry(element: SVGGeometryElement): Point[][] {
  let total: number;
  try {
    total = element.getTotalLength();
  } catch {
    return [];
  }
  if (!(total > 0)) {
    return [];
  }

  const step = total / SVG_SAMPLE_COUNT;
  const jumpLimit = step * SUBPATH_JUMP_FACTOR;
  const rings: Point[][] = [];
  let current: Point[] = [];
  let previous: Point | null = null;

  for (let i = 0; i <= SVG_SAMPLE_COUNT; i++) {
    let point: DOMPoint;
    try {
      point = element.getPointAtLength(Math.min(i * step, total));
    } catch {
      break;
    }
    const p: Point = { x: point.x, y: point.y };
    if (previous && Math.hypot(p.x - previous.x, p.y - previous.y) > jumpLimit) {
      // サブパスの切れ目。ここまでを 1 本の閉じた輪郭として確定する。
      if (current.length >= 3) rings.push(current);
      current = [];
    }
    current.push(p);
    previous = p;
  }
  if (current.length >= 3) {
    rings.push(current);
  }

  // 閉パスの最終サンプルは始点と重なるため、閉じた頂点列の規約（始点を繰り返さない）へ直す。
  return rings.map((ring) => {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (ring.length > 1 && first && last && Math.hypot(last.x - first.x, last.y - first.y) < step) {
      ring.pop();
    }
    return ring;
  });
}

/** 閉じた頂点列の符号なし面積（shoelace）。最大パーツの選択に使う。 */
function polygonArea(points: readonly Point[]): number {
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    area2 += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area2) / 2;
}

/** 輪郭群から面積最大のものを選ぶ（3 頂点未満の退化輪郭は無視する）。 */
function largestByArea(contours: readonly Point[][]): Point[] | null {
  let best: Point[] | null = null;
  let bestArea = 0;
  for (const contour of contours) {
    if (contour.length < 3) continue;
    const area = polygonArea(contour);
    if (area > bestArea) {
      bestArea = area;
      best = contour;
    }
  }
  return best;
}

/**
 * 外形をバウンディングボックスで正規化する（±0.5、bbox 中心が原点）。
 *
 * 元ファイルの実寸・単位は使わない（SPEC）。アスペクト比だけは保持し、読み込み時に台座奥行を
 * 自動設定するのに使う。面積 0（線分に潰れた輪郭）は台座として使えないため null。
 */
function normalizeOutline(
  outline: readonly Point[],
  kind: BaseShapeSource['kind'],
  fileName: string,
): BaseShapeSource | null {
  if (outline.length < 3) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of outline) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return null;
    }
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    kind,
    fileName,
    outline: outline.map((p) => ({ x: (p.x - cx) / width, y: (p.y - cy) / height })),
    aspectRatio: width / height,
  };
}
