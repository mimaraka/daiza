// 外形（輪郭）抽出とカットライン生成：α>0 領域の外周を閉ポリゴン群として取り出し、
// 余白オフセット・自己交差除去・複数パーツ包絡・平滑化を経て 1 枚のカットラインへ整える。
//
// 用途はオーバーレイの「外形（半透明）」描画と SVG エクスポートの外形線。輪郭追跡は
// Moore 近傍追跡（Moore-Neighbor Tracing）に Jacob の停止条件を組み合わせる。分離した
// 複数パーツにも対応するため、まず 8 連結で連結成分へ分け、成分ごとに外周をたどる。
// React には依存しない純粋ロジック。
//
// 設計判断：
//  - しきい値は imageLoader・centroid と同じ「α>0 を充填」。座標系は画像左上
//    原点・下方向 +Y。
//  - 入力は RGBA ではなく事前構築済みの α ビットマスク（Uint8Array）。追跡は 1 画素
//    あたり最大 8 近傍を何度も参照するため、RGBA から都度 α を読むよりキャッシュ効率
//    が良い。マスク構築（buildAlphaMask）は呼び出し側（pipeline）が重心走査と共有する
//    ため、ここでは受け取るだけにして α 判定の全画素走査が二重にならないようにする。
//  - 複数パーツは各 1 閉ポリゴンとして抽出し（extractContours）、カットライン化段階
//    （cutlineFromMask）で余白膨張（EDT）による近接パーツの自動結合と、なお分離したパーツ
//    同士の最小幅ブリッジ連結により 1 枚のアクリル外形へまとめる（SPEC「複数パーツの連結」）。
//    各パーツの輪郭は保ったまま連結するため、凸包のように全体を緩く包み込むことはしない。

import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from 'polygon-clipping';

import { closeMask, dilateMask, type DilatedMask } from '@/analysis/distance';
import type { Contour, Point, SlotRect, SlotResult } from '@/model/types';
import { convexHull, simplifyPolyline } from '@/utils/geometry';

/**
 * 時計回り（下方向 +Y）8 近傍のインデックス → オフセット。
 * 0:E 1:SE 2:S 3:SW 4:W 5:NW 6:N 7:NE の順。追跡は「直前の空きセルの次」から
 * この順に走査して最初の充填セルを見つける。switch で必ず確定値を返すことで、
 * 配列添字経由の undefined（noUncheckedIndexedAccess）を避ける。
 */
function offsetAt(index: number): Point {
  switch (index & 7) {
    case 0:
      return { x: 1, y: 0 };
    case 1:
      return { x: 1, y: 1 };
    case 2:
      return { x: 0, y: 1 };
    case 3:
      return { x: -1, y: 1 };
    case 4:
      return { x: -1, y: 0 };
    case 5:
      return { x: -1, y: -1 };
    case 6:
      return { x: 0, y: -1 };
    default:
      return { x: 1, y: -1 };
  }
}

/**
 * 近傍オフセット (dx, dy) を上記インデックスへ逆変換する。
 * 進入元セル（backtrack）が中心から見てどの方向かを求め、走査開始位置に使う。
 * (0,0) は呼ばれない前提。
 */
function directionIndex(dx: number, dy: number): number {
  switch ((dy + 1) * 3 + (dx + 1)) {
    case 5:
      return 0;
    case 8:
      return 1;
    case 7:
      return 2;
    case 6:
      return 3;
    case 3:
      return 4;
    case 0:
      return 5;
    case 1:
      return 6;
    case 2:
      return 7;
    default:
      return 0;
  }
}

/** Moore 追跡の 1 ステップの結果。次の外周画素と、その進入元（空きセル）。 */
interface TraceStep {
  nx: number;
  ny: number;
  backX: number;
  backY: number;
}

/**
 * 中心 (bx,by) の周りを、進入元 (cx,cy) の次から時計回りに走査し、
 * 最初に見つかった充填ピクセルを次の外周画素として返す。
 * その直前に調べた（空きの）セルが新たな進入元 backtrack になる。
 * 充填近傍が皆無なら孤立点として null を返す。
 */
function findNextBoundary(
  bx: number,
  by: number,
  cx: number,
  cy: number,
  isFilled: (x: number, y: number) => boolean,
): TraceStep | null {
  const startIndex = directionIndex(cx - bx, cy - by);
  for (let k = 1; k <= 8; k++) {
    const index = (startIndex + k) & 7;
    const offset = offsetAt(index);
    const nx = bx + offset.x;
    const ny = by + offset.y;
    if (isFilled(nx, ny)) {
      // 直前（時計回りで 1 つ手前）の空きセルを次回の進入元とする。
      const back = offsetAt((index + 7) & 7);
      return { nx, ny, backX: bx + back.x, backY: by + back.y };
    }
  }
  return null;
}

/**
 * 起点 b0 から Moore 追跡で 1 つの連結成分の外周を時計回りにたどる。
 *
 * 起点は上・左が（その成分にとって）空きであることが呼び出し側で保証される前提で、
 * 西（左）から進入したとみなして追跡を始める。停止は Jacob の条件：起点 b0 へ戻り、
 * かつ次の一歩が最初の一歩 b1 と一致したとき閉じる。これにより起点を通過するだけの
 * 場合と真に一周した場合を区別でき、頂点の重複なく閉ポリゴンを得られる。isFilled は
 * 「その画素が対象成分に属するか」を返す述語で、単一マスク／成分ラベルのどちらでも使える。
 */
function traceBoundary(
  b0: Point,
  isFilled: (x: number, y: number) => boolean,
  maxSteps: number,
): Contour {
  // 進入元は西の空きセル。ここから時計回りに最初の外周画素を探す。
  const firstStep = findNextBoundary(b0.x, b0.y, b0.x - 1, b0.y, isFilled);
  if (!firstStep) {
    // 孤立 1 画素。外形はその点のみ。
    return [{ x: b0.x, y: b0.y }];
  }

  const boundary: Point[] = [{ x: b0.x, y: b0.y }];
  const b1: Point = { x: firstStep.nx, y: firstStep.ny };

  let bx = firstStep.nx;
  let by = firstStep.ny;
  let cx = firstStep.backX;
  let cy = firstStep.backY;

  for (let step = 0; step < maxSteps; step++) {
    const next = findNextBoundary(bx, by, cx, cy, isFilled);
    // Jacob の停止条件：起点に戻り、次の一歩が最初の一歩と一致したら一周完了。
    if (bx === b0.x && by === b0.y && next && next.nx === b1.x && next.ny === b1.y) {
      break;
    }
    boundary.push({ x: bx, y: by });
    if (!next) {
      // 追跡が行き止まり（通常は起こらない）。得られた分で打ち切る。
      break;
    }
    cx = next.backX;
    cy = next.backY;
    bx = next.nx;
    by = next.ny;
  }

  return boundary;
}

/** 追跡の無限ループを防ぐ上限。外周長は全画素周長を超えない。 */
function traceStepLimit(width: number, height: number): number {
  return width * height * 4 + 8;
}

/** 連結成分ラベリングの結果：画素ごとのラベル（0=空き）と各成分の起点。 */
interface LabeledComponents {
  /** 画素 idx → 成分ラベル（1..count、0=空き）。 */
  labels: Int32Array;
  /** 成分ごとの起点（ラスタ走査で最初に現れた画素＝最上・最左）。index+1 がラベル。 */
  seeds: Point[];
}

/**
 * α マスクを 8 連結で連結成分に分け、各画素へラベルを振る。
 *
 * 8 連結を採るのは、斜めに接する画素を別パーツと誤認しないため（外周追跡の 8 近傍とも整合）。
 * 各成分の起点はラスタ走査で最初に現れた画素なので、その西・北はその成分に属さないことが
 * 保証され、外周追跡の開始条件（西から進入）を満たす。反復スタックで実装し、巨大画像でも
 * 再帰スタック溢れを避ける。各画素は「ラベル付与時に 1 度だけ」push されるため、スタック
 * 長は総画素数を超えない。
 */
function labelComponents(mask: Uint8Array, width: number, height: number): LabeledComponents {
  const total = width * height;
  const labels = new Int32Array(total);
  const seeds: Point[] = [];
  // 各画素は 1 度だけ積むので容量は総画素数で足りる（number[] より GC 負荷が軽い）。
  const stack = new Int32Array(total);
  let label = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== 1 || labels[idx] !== 0) {
        continue;
      }
      label++;
      seeds.push({ x, y });
      let sp = 0;
      stack[sp++] = idx;
      labels[idx] = label;
      while (sp > 0) {
        const cur = stack[--sp] ?? 0;
        const cy = (cur / width) | 0;
        const cx = cur - cy * width;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= height) {
            continue;
          }
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) {
              continue;
            }
            const nx = cx + dx;
            if (nx < 0 || nx >= width) {
              continue;
            }
            const nidx = ny * width + nx;
            if (mask[nidx] === 1 && labels[nidx] === 0) {
              labels[nidx] = label;
              stack[sp++] = nidx;
            }
          }
        }
      }
    }
  }

  return { labels, seeds };
}

/**
 * α>0 領域の外形を、分離した複数パーツも含めてすべて抽出する（各パーツ 1 閉ポリゴン）。
 *
 * SPEC「複数パーツの包絡」の前段。まず連結成分へ分け、成分ごとに外周を追跡する。追跡述語は
 * 「その画素が対象成分に属するか（labels === 対象ラベル）」で、隣接する別パーツを巻き込まない。
 * ポリゴンを成さない退化成分（面積を持たない 1〜2 画素の孤立ノイズ）は 3 頂点未満として捨て、
 * 後段の余白オフセット・union（polygon-clipping）へ妥当な入力だけを渡す。
 *
 * 全透明（充填なし）や有効パーツ皆無なら空配列を返し、呼び出し側で透明画像として扱えるようにする。
 */
export function extractContours(mask: Uint8Array, width: number, height: number): Contour[] {
  const { labels, seeds } = labelComponents(mask, width, height);
  const maxSteps = traceStepLimit(width, height);
  const contours: Contour[] = [];

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    if (!seed) {
      continue;
    }
    const label = i + 1;
    const isFilled = (x: number, y: number): boolean =>
      x >= 0 && x < width && y >= 0 && y < height && labels[y * width + x] === label;
    const contour = traceBoundary(seed, isFilled, maxSteps);
    // 面積を持たない退化成分（孤立点・極小ノイズ）は外形として無意味なので捨てる。
    if (contour.length >= 3) {
      contours.push(contour);
    }
  }

  return contours;
}

// ---------------------------------------------------------------------------
// カットライン生成：αマスクを「余白ぶん膨張（EDT）→ 狭い隙間の充填（クロージング）→
// 輪郭抽出 → 残った分離パーツの最小幅ブリッジ連結 → 平滑化」して、実際に切り出す
// アクリル外形（カットライン）へ整える。SPEC「カットライン」節の手順。
//
// 余白オフセットは以前、間引き済みポリゴンへの素朴なミターオフセット＋ union（自己交差
// 除去）で実装していたが、細かい凹凸（髪の毛等）を持つ 3000px 級の輪郭では自己交差が
// 大量発生して union が超線形に爆発し（実測：12,000 頂点で約 2 秒・頂点数 2 倍で約 5 倍）、
// フリーズ・メモリ枯渇の主因だった。現在は analysis/distance の EDT 膨張（真のオフセット）
// を使う。膨張マスクの輪郭は構造的に自己交差せず、計算量 O(W×H) は形状の複雑さに依存
// しない。パラメータ（余白 mm・平滑化強さ）に依存するため第 2 相（pipeline.runAnalysis）
// から呼ばれるが、O(W×H) の重さがあるため呼び出し側でカットライン依存パラメータを鍵に
// メモ化し、さらに Worker 上で実行してメインスレッドを塞がない。
//
// 生成は「膨張マスク（buildCutlineMask）」と「マスク → 輪郭（cutlineFromMask）」の 2 段に
// 分かれている。差込部（首部）の位置は重心＝カットラインが決まらないと定まらないのに、
// 隙間埋めは首部を含んだ最終形状に対して掛けねばならない（首部の側面とフィギュア外形の
// 間にできる狭い隙間も充填対象）。そこで膨張マスクを共有したまま、首部を塗り足した
// マスクからカットラインを起こし直せるようにしてある。

/**
 * Chaikin 反復で増えた頂点を間引く際の許容ずれ(px)。
 * 平滑化は角を丸めるため頂点が指数的に増える。見た目をほぼ保てる 0.5px で間引き、
 * 描画・SVG 文字列化を軽く保つ（輪郭抽出直後の 1px 間引きと役割は同じ）。
 */
const CUTLINE_SIMPLIFY_EPSILON_PX = 0.5;

/**
 * 膨張マスクから追跡した輪郭を間引く際の許容ずれ(px)。
 * Moore 追跡は境界ピクセル 1 個 = 1 頂点を返すため、後段（ブリッジ連結・平滑化・重心）へ
 * 渡す前に画素段差ノイズを落とす。第 1 相の生外形と同じ 1px（視認不能・mm 換算で無視可能）。
 */
const TRACE_SIMPLIFY_EPSILON_PX = 1;

/**
 * 閉ポリゴンを Chaikin の角切り法で平滑化する（iterations 回反復）。
 *
 * 各辺を 1/4・3/4 の内分点 2 つへ置き換えて角を落とすため、反復ごとに輪郭が滑らかになる。
 * SPEC「値を大きくするほど滑らか」に対応し、iterations=0 は素通し（無効）。反復ごとに頂点が
 * 倍増するので、呼び出し側（cutlineFromMask）で最後に間引いて頂点数を抑える。
 */
export function smoothContour(contour: readonly Point[], iterations: number): Point[] {
  let points: Point[] = contour.slice();
  const iters = Math.max(0, Math.floor(iterations));
  for (let it = 0; it < iters && points.length >= 3; it++) {
    const n = points.length;
    const next: Point[] = [];
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const q = points[(i + 1) % n];
      if (!p || !q) {
        continue;
      }
      next.push({ x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 });
      next.push({ x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 });
    }
    points = next;
  }
  return points;
}

/** Point[] を polygon-clipping の閉リング（Pair[]、始点=終点で閉じる）へ変換する。 */
function toClosedRing(points: readonly Point[]): Ring {
  const ring: Ring = points.map((p) => [p.x, p.y]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push([first[0], first[1]]);
  }
  return ring;
}

/** polygon-clipping のリング（Pair[]、閉じている）を Point[]（開いた頂点列）へ戻す。 */
function ringToPoints(ring: Ring): Point[] {
  const pts: Point[] = ring.map(([x, y]) => ({ x, y }));
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (pts.length > 1 && first && last && first.x === last.x && first.y === last.y) {
    pts.pop();
  }
  return pts;
}

/** 全パーツの頂点を集めた凸包。union 破綻時・連結失敗時の安全な包絡フォールバック。 */
function convexHullOfParts(parts: readonly Point[][]): Point[] {
  const all: Point[] = [];
  for (const part of parts) {
    for (const p of part) {
      all.push(p);
    }
  }
  return convexHull(all);
}

/**
 * ポリゴン群を union し、各結果ポリゴンの外輪（穴を除く外周）を頂点列で返す。
 *
 * 単一入力でも呼べる（素朴なミターオフセットが作った自己交差を単純多角形へ正規化する）。
 * union が例外を投げた場合は呼び出し側で扱えるよう再スローする。3 頂点未満へ潰れた退化リングは捨てる。
 */
function unionOuterRings(polysPts: readonly Point[][]): Point[][] {
  const polys: Polygon[] = polysPts.filter((p) => p.length >= 3).map((p) => [toClosedRing(p)]);
  const first = polys[0];
  if (!first) {
    return [];
  }
  const merged: MultiPolygon =
    polys.length === 1
      ? polygonClipping.union(first)
      : polygonClipping.union(first, ...polys.slice(1));

  const rings: Point[][] = [];
  for (const poly of merged) {
    const outer = poly[0];
    if (!outer) {
      continue;
    }
    const pts = ringToPoints(outer);
    if (pts.length >= 3) {
      rings.push(pts);
    }
  }
  return rings;
}

/** 2 点間の距離の 2 乗。ブリッジ探索は比較のみなので sqrt を省く。 */
function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** 点 p から線分 a→b への最近点。t を [0,1] にクランプして端点外へ出ないようにする。 */
function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) {
    return { x: a.x, y: a.y };
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** 2 つの閉リング間の最短連結：一方の頂点から他方の辺への最近点対（連結部の端点）。 */
interface RingLink {
  /** リング A 側の端点。 */
  a: Point;
  /** リング B 側の端点。 */
  b: Point;
  /** 端点間の距離の 2 乗（連結の近さ＝MST の重み）。 */
  gap2: number;
}

/**
 * 2 つの閉リングの境界間で最も近い点対を求める（片方の頂点 × 他方の辺の総当たり）。
 *
 * 頂点同士だけでなく「頂点→辺の最近点」も見るため、辺の途中が最接近する場合も取りこぼさない。
 * リングは間引き済み（数十〜数百点）でパーツ数も少ないため、O(Va×Vb) の総当たりで実用上十分。
 */
function closestBetweenRings(ringA: readonly Point[], ringB: readonly Point[]): RingLink {
  const nA = ringA.length;
  const nB = ringB.length;
  let best: RingLink = { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, gap2: Number.POSITIVE_INFINITY };

  // A の各頂点 × B の各辺。
  for (let i = 0; i < nA; i++) {
    const p = ringA[i];
    if (!p) continue;
    for (let j = 0; j < nB; j++) {
      const s = ringB[j];
      const e = ringB[(j + 1) % nB];
      if (!s || !e) continue;
      const q = closestPointOnSegment(p, s, e);
      const gap2 = distanceSquared(p, q);
      if (gap2 < best.gap2) best = { a: p, b: q, gap2 };
    }
  }
  // B の各頂点 × A の各辺（端点の所属を保つよう a は常に A 側、b は常に B 側にする）。
  for (let j = 0; j < nB; j++) {
    const p = ringB[j];
    if (!p) continue;
    for (let i = 0; i < nA; i++) {
      const s = ringA[i];
      const e = ringA[(i + 1) % nA];
      if (!s || !e) continue;
      const q = closestPointOnSegment(p, s, e);
      const gap2 = distanceSquared(p, q);
      if (gap2 < best.gap2) best = { a: q, b: p, gap2 };
    }
  }
  return best;
}

/**
 * 連結部（ブリッジ）の矩形ポリゴンを作る。
 *
 * 端点対 a→b を中心線とし、幅 widthPx の帯（矩形）を張る。両端は各パーツ内部へ ext ぶん
 * 延長して union で確実に重なるようにする（端点はパーツ境界上にあるため、延長で内部へ食い込む）。
 * 端点が一致（既に重なり）していれば連結不要として null を返す。
 */
function bridgeRect(a: Point, b: Point, widthPx: number): Point[] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) {
    return null;
  }
  const ux = dx / len;
  const uy = dy / len;
  // 中心線に直交する単位ベクトル（帯の幅方向）。
  const vx = -uy;
  const vy = ux;
  const half = widthPx / 2;
  // 端点をパーツ内部へ延長する量。連結部幅ぶん延ばせば union の重なりを確実にできる。
  const ext = Math.max(half, 1);
  const sx = a.x - ux * ext;
  const sy = a.y - uy * ext;
  const ex = b.x + ux * ext;
  const ey = b.y + uy * ext;
  return [
    { x: sx + vx * half, y: sy + vy * half },
    { x: ex + vx * half, y: ey + vy * half },
    { x: ex - vx * half, y: ey - vy * half },
    { x: sx - vx * half, y: sy - vy * half },
  ];
}

/**
 * 分離した複数リングを連結するブリッジ矩形群を生成する（最小全域木＝連結の総延長最小）。
 *
 * すべてのパーツを 1 枚へつなぐには最低でも (パーツ数-1) 本の連結が要る。連結部の総延長が
 * 最小になるよう、パーツ間の最短ギャップを辺重みとした最小全域木（Prim 法）を張り、その各辺を
 * 幅 widthPx のブリッジ矩形にする。これにより「すべてのパーツを囲みつつ、連結部は最小幅で、
 * 余分な材料を増やさない」外形になる。パーツ間の最近点対は事前に総当たりで求めてキャッシュする。
 */
function buildBridges(rings: readonly Point[][], widthPx: number): Point[][] {
  const k = rings.length;
  if (k < 2 || !(widthPx > 0)) {
    return [];
  }

  // パーツ対ごとの最短連結を事前計算（対称なので上三角のみ）。
  const links: (RingLink | null)[][] = Array.from({ length: k }, () =>
    new Array<RingLink | null>(k).fill(null),
  );
  const linkOf = (i: number, j: number): RingLink => {
    const a = i < j ? i : j;
    const b = i < j ? j : i;
    const cached = links[a]?.[b];
    if (cached) return cached;
    const ra = rings[a];
    const rb = rings[b];
    const link =
      ra && rb
        ? closestBetweenRings(ra, rb)
        : { a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, gap2: Number.POSITIVE_INFINITY };
    const row = links[a];
    if (row) row[b] = link;
    return link;
  };

  // Prim 法：ノード 0 から木を育て、木内→木外で最短の辺を 1 本ずつ採用する。
  const inTree = new Array<boolean>(k).fill(false);
  inTree[0] = true;
  const bridges: Point[][] = [];

  for (let added = 1; added < k; added++) {
    let bestI = -1;
    let bestJ = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let i = 0; i < k; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < k; j++) {
        if (inTree[j]) continue;
        const gap = linkOf(i, j).gap2;
        if (gap < bestGap) {
          bestGap = gap;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestJ < 0) break;
    inTree[bestJ] = true;
    const link = linkOf(bestI, bestJ);
    const rect = bridgeRect(link.a, link.b, widthPx);
    if (rect) bridges.push(rect);
  }

  return bridges;
}

/**
 * 膨張後もなお分離している複数パーツから 1 枚のアクリル外形（カットライン）を求める。
 *
 * SPEC「複数パーツの連結」に対応する中核。入力は膨張マスク由来の単純な（自己交差の
 * ない）分離リング群で、手順は：
 * (1) union でリング群を正規化する（分離入力なら実質素通しで軽量）。
 * (2) 分離したパーツを、凸包で緩く包む代わりに、各パーツの輪郭を保ったまま最小幅
 *     minBridgeWidthPx のブリッジ（MST で総延長最小）で連結し、再度 union で 1 枚へまとめる。
 * これにより外形は不透明領域の輪郭に沿い、連結部だけが最小幅の細い首になる。連結部を作れない
 * （幅 0 等）／数値誤差で連結し切れない／union が例外を投げる異常時は、パーツを分断させない
 * 安全網として凸包へフォールバックする（通常経路では発生しない）。
 */
function envelopeFromParts(parts: readonly Point[][], minBridgeWidthPx: number): Point[] {
  if (parts.length === 0) {
    return [];
  }

  let rings: Point[][];
  try {
    rings = unionOuterRings(parts);
  } catch {
    return convexHullOfParts(parts);
  }

  if (rings.length === 0) {
    return convexHullOfParts(parts);
  }
  if (rings.length === 1) {
    return rings[0] ?? [];
  }

  // 分離したパーツが複数残った。各輪郭を保ったまま最小幅ブリッジで連結する。
  const bridges = buildBridges(rings, minBridgeWidthPx);
  if (bridges.length === 0) {
    // 連結部を張れない（幅が非正）。分断を避けるため凸包で包絡する。
    return convexHullOfParts(parts);
  }

  try {
    const connected = unionOuterRings([...rings, ...bridges]);
    if (connected.length === 1) {
      return connected[0] ?? [];
    }
    // 連結し切れなかった（数値誤差等）。全パーツを内包する安全網として凸包へ退避する。
    return convexHullOfParts(parts);
  } catch {
    return convexHullOfParts(parts);
  }
}

/**
 * カットラインの元になる「余白ぶん膨張したマスク」を作る（SPEC「カットライン」手順 1〜2）。
 *
 * 膨張は画像枠の外（特に足元の下）へはみ出すため、グリッドはパディングぶん広く、原点が
 * ずれている（DilatedMask.offsetX/offsetY で元画像座標へ戻す）。スケールと余白だけに
 * 依存する最も重い段（O(W×H)）なので、呼び出し側はこの結果を使い回し、隙間埋め・平滑化
 * だけが変わる再解析や、差込部を描き込んだ 2 回目のカットライン生成（cutlineFromMask の
 * neckFill）で再膨張しないようにする。
 */
export function buildCutlineMask(
  mask: Uint8Array,
  width: number,
  height: number,
  marginPx: number,
): DilatedMask {
  return dilateMask(mask, width, height, marginPx);
}

/**
 * マスクグリッドへ閉多角形（画像座標）を塗り足した新しいグリッドを返す。
 *
 * 差込部の首部をカットラインへ「隙間埋めより前に」合流させるための操作。首部は
 * 台座上面まで下へ伸びて元のグリッド外へ出得るため、必要なら多角形を覆うまでグリッドを
 * 広げる（ただし退化パラメータでスケールが極端に小さいときに際限なく広がらないよう、
 * 拡張量は元グリッドの長辺までに抑え、はみ出した部分は塗りをクリップする。クリップされた
 * 首部の下端は後段 unionSlotRects の crisp な多角形合成で復元されるため形状は壊れない）。
 *
 * 入力グリッド（呼び出し側がメモ化して使い回す膨張マスク）を破壊しないよう、常に新しい
 * バッファへコピーしてから塗る。塗りは走査線＋偶奇規則で、弧が上下に波打つ多角形でも
 * 正しく内部だけを充填する。
 */
function paintPolygon(base: DilatedMask, polygon: readonly Point[]): DilatedMask {
  let polyMinX = Number.POSITIVE_INFINITY;
  let polyMinY = Number.POSITIVE_INFINITY;
  let polyMaxX = Number.NEGATIVE_INFINITY;
  let polyMaxY = Number.NEGATIVE_INFINITY;
  for (const p of polygon) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return base;
    }
    if (p.x < polyMinX) polyMinX = p.x;
    if (p.y < polyMinY) polyMinY = p.y;
    if (p.x > polyMaxX) polyMaxX = p.x;
    if (p.y > polyMaxY) polyMaxY = p.y;
  }

  const baseMinX = base.offsetX;
  const baseMinY = base.offsetY;
  const baseMaxX = base.offsetX + base.width - 1;
  const baseMaxY = base.offsetY + base.height - 1;
  const maxGrow = Math.max(base.width, base.height);

  // 多角形を覆うまで（ただし maxGrow まで）グリッドを広げる。
  const minX = Math.max(baseMinX - maxGrow, Math.min(baseMinX, Math.floor(polyMinX) - 1));
  const minY = Math.max(baseMinY - maxGrow, Math.min(baseMinY, Math.floor(polyMinY) - 1));
  const maxX = Math.min(baseMaxX + maxGrow, Math.max(baseMaxX, Math.ceil(polyMaxX) + 1));
  const maxY = Math.min(baseMaxY + maxGrow, Math.max(baseMaxY, Math.ceil(polyMaxY) + 1));

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const mask = new Uint8Array(width * height);
  const shiftX = baseMinX - minX;
  const shiftY = baseMinY - minY;
  for (let y = 0; y < base.height; y++) {
    const src = y * base.width;
    mask.set(base.mask.subarray(src, src + base.width), (y + shiftY) * width + shiftX);
  }

  // 走査線は多角形の Y 範囲だけを見る（グリッド全体を舐めない）。
  const firstRow = Math.max(0, Math.ceil(polyMinY) - minY);
  const lastRow = Math.min(height - 1, Math.floor(polyMaxY) - minY);
  const n = polygon.length;
  const crossings: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) {
    const y = row + minY;
    crossings.length = 0;
    for (let i = 0; i < n; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % n];
      if (!a || !b) continue;
      // 半開区間で straddle 判定し、頂点を共有する 2 辺で交点を二重計上しない。
      const straddles = (a.y <= y && b.y > y) || (b.y <= y && a.y > y);
      if (!straddles) continue;
      crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    if (crossings.length < 2) continue;
    crossings.sort((p, q) => p - q);
    const rowOffset = row * width;
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = crossings[k];
      const to = crossings[k + 1];
      if (from === undefined || to === undefined) continue;
      const startX = Math.max(0, Math.ceil(from) - minX);
      const endX = Math.min(width - 1, Math.floor(to) - minX);
      for (let x = startX; x <= endX; x++) {
        mask[rowOffset + x] = 1;
      }
    }
  }

  return { mask, width, height, offsetX: minX, offsetY: minY };
}

/**
 * 膨張マスクから最終カットラインを起こす（SPEC「カットライン」手順 4〜5）。
 *
 * 手順は：(1) 差込部の首部領域（neckFill、任意）をマスクへ塗り足す、(2) 閾値 gapFillPx
 * より狭い隙間を半径 gapFillPx/2 の円板クロージングで充填、(3) マスクの外周を抽出して
 * 間引き、なお分離したパーツは最小幅 minBridgeWidthPx のブリッジで連結（残れば凸包で
 * 包絡）、(4) 平滑化、(5) 間引き。曲線補完は折れ線を保ったまま描画層（overlay/SVG）が
 * 頂点列から曲線パスを起こす。以降の重心・台座計算・オーバーレイ・SVG はこの単一
 * カットライン（が囲む領域）を外形として共有する。
 *
 * neckFill を渡すのは 2 回目の生成（差込部の配置が決まった後）。隙間埋めは「最終的な
 * カットライン間の隙間」を対象とするため、首部を合流させた**後**のマスクに対して測る
 * 必要がある（首部の側面とフィギュア外形の間にできる狭い隙間も充填対象になる。
 * SPEC「隙間埋めと差込部の整合」）。首部を含まない 1 回目の結果は、重心・台座上面・
 * 差込部の配置を決める基準として使う。
 *
 * 膨張は画像枠の外へはみ出すため、返す頂点は負座標や画像寸法超の座標を含み得る
 * （グリッドの原点ずれは元画像座標へ戻してから返す）。有効パーツ（3 頂点以上）が皆無の
 * 退化入力では空配列を返す（呼び出し側でエラーへ写す）。
 */
export function cutlineFromMask(
  dilated: DilatedMask,
  gapFillPx: number,
  smoothing: number,
  minBridgeWidthPx: number,
  neckFill?: readonly Point[],
): Contour {
  // 差込部（首部）をカットラインの一部としてマスクへ合流させてから隙間埋めへ渡す。
  const merged = neckFill && neckFill.length >= 3 ? paintPolygon(dilated, neckFill) : dilated;

  // 隙間埋め：半径 r = 閾値/2 の円板クロージングは幅 2r 未満の隙間だけを、円弧で
  // なめらかに埋める。閾値 0（無効）なら素通し。
  const closed = closeMask(merged.mask, merged.width, merged.height, gapFillPx / 2);

  // 2 段のグリッド拡張（膨張・塗り足し＋クロージング）を合成した、元画像座標への原点ずれ。
  const offsetX = merged.offsetX + closed.offsetX;
  const offsetY = merged.offsetY + closed.offsetY;

  // 充填後マスクの外周を抽出 → 画素段差を間引き → グリッドの原点ずれを元画像座標へ戻す。
  // クロージングで結合したパーツはここで 1 リングとして現れ、以降のブリッジ連結・凸包
  // 退避の対象から自動的に外れる。
  const rings = extractContours(closed.mask, closed.width, closed.height)
    .map((c) => simplifyPolyline(c, TRACE_SIMPLIFY_EPSILON_PX))
    .filter((c) => c.length >= 3)
    .map((c) =>
      offsetX === 0 && offsetY === 0 ? c : c.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })),
    );

  if (rings.length === 0) {
    return [];
  }

  // 単一リングなら追跡結果そのままが外形（自己交差なしが保証されるため union 不要）。
  // 複数リングが残った場合のみブリッジ連結（＋軽量な union）で 1 枚へまとめる。
  const base = rings.length === 1 ? (rings[0] ?? []) : envelopeFromParts(rings, minBridgeWidthPx);
  const smoothed = smoothContour(base, smoothing);
  return simplifyPolyline(smoothed, CUTLINE_SIMPLIFY_EPSILON_PX);
}

// ---------------------------------------------------------------------------
// 差込部（首部＋ツメ）の一体化：カットラインの下辺を、首部・ツメを含む形へ下方向へ
// 拡張して 1 枚の外形にする。SPEC「カットラインとの一体化」節に対応する。

/** 垂直線 x との交差のうち最も下（Y 最大）の下辺クロッシング。 */
export interface LowerCrossing {
  /** 交点の Y。 */
  y: number;
  /** 交差した辺のインデックス（辺 i = 頂点 i → i+1）。 */
  edge: number;
}

/**
 * 閉ポリゴンと垂直線 x=lineX の交差のうち、最も下（Y 最大）＝外側下辺の交点を返す。
 * 半開区間で straddle 判定し、共有頂点での二重計上を避ける。交差が無ければ null。
 *
 * 差込部の接続位置（首部が板本体と重なる高さ）を決める共通の基準でもあるため、
 * analysis/slot からも参照できるよう公開する（両者が同じ交点を見ることで、
 * 描画上の首部矩形と実際に拡張されるカットラインがずれない）。
 */
export function lowerCrossing(contour: readonly Point[], lineX: number): LowerCrossing | null {
  const n = contour.length;
  let best: LowerCrossing | null = null;
  for (let i = 0; i < n; i++) {
    const a = contour[i];
    const b = contour[(i + 1) % n];
    if (!a || !b) continue;
    const straddles = (a.x <= lineX && lineX < b.x) || (b.x <= lineX && lineX < a.x);
    if (!straddles) continue;
    const t = (lineX - a.x) / (b.x - a.x);
    const y = a.y + t * (b.y - a.y);
    if (!best || y > best.y) {
      best = { y, edge: i };
    }
  }
  return best;
}

/** 頂点インデックス from → to（両端含む）を前方向（必要なら巻き戻し）に収集する。 */
function collectForward(contour: readonly Point[], from: number, to: number): Point[] {
  const n = contour.length;
  const out: Point[] = [];
  let i = from;
  while (true) {
    const p = contour[i];
    if (p) out.push(p);
    if (i === to) break;
    i = (i + 1) % n;
  }
  return out;
}

/** インデックス範囲 [from, to]（前方向・両端含む）の平均 Y を求める。 */
function averageY(contour: readonly Point[], from: number, to: number): number {
  const pts = collectForward(contour, from, to);
  if (pts.length === 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const p of pts) sum += p.y;
  return sum / pts.length;
}

/**
 * 差込部が置き換える「下辺の弧」の抽出結果。
 * 首部の左右端の垂直線とカットライン下辺の交点 PL・PR で、閉ポリゴンは 2 本の弧に分かれる。
 * そのうち下辺（弧内頂点の平均 Y が大きい側）が差込部で置き換わり、他方が残る。
 */
interface SlotArc {
  /** 首部左端の下辺交点。 */
  pl: Point;
  /** 首部右端の下辺交点。 */
  pr: Point;
  /** 下辺の弧が頂点インデックスの増加方向（PL→PR）に並んでいるか。 */
  forward: boolean;
  /** 下辺の弧の内部頂点を PL→PR の向きに並べたもの（両交点が同一辺上なら空）。 */
  lowerInterior: Point[];
  /** 置換後に残す弧の頂点列（差込部の外周に続けて並べる順序）。 */
  kept: Point[];
}

/**
 * 首部の左右端で下辺を切り、置き換える弧と残す弧に分ける。
 *
 * attachSlotBody（多角形の一体化）と neckFillPolygon（マスクへの塗り足し）が同じ弧を
 * 見ることで、「首部が板へ足す領域」の解釈が 2 経路でずれないようにする。
 * 交点が取れない（差込部が板の外にある）場合は null。ただし analysis/slot.findSlot が
 * 同じ交点を検査して配置不可としているため、正常系では到達しない防御的分岐である。
 */
function extractSlotArc(contour: Contour, slot: SlotResult): SlotArc | null {
  const n = contour.length;
  const neckLeftX = slot.neck.xPixel;
  const neckRightX = slot.neck.xPixel + slot.neck.widthPixel;
  if (n < 3 || !(neckLeftX < neckRightX) || !Number.isFinite(slot.baseTopYPixel)) {
    return null;
  }

  const cl = lowerCrossing(contour, neckLeftX);
  const cr = lowerCrossing(contour, neckRightX);
  if (!cl || !cr) {
    return null;
  }

  const pl: Point = { x: neckLeftX, y: cl.y };
  const pr: Point = { x: neckRightX, y: cr.y };
  const iL = cl.edge;
  const iR = cr.edge;

  // 同一辺が両端の垂直線をまたぐ（下辺が 1 本の長い辺）場合、下辺の弧に内部頂点は無く、
  // 残る弧は全周になる。差込部を差し込む向きはその辺の向き（左→右／右→左）で決まる。
  if (iL === iR) {
    const a = contour[iL];
    const b = contour[(iL + 1) % n];
    if (!a || !b) return null;
    return {
      pl,
      pr,
      forward: a.x <= b.x,
      lowerInterior: [],
      kept: collectForward(contour, (iL + 1) % n, iL),
    };
  }

  // 2 本の弧のうち平均 Y が大きい側が下辺。
  const forward = averageY(contour, (iL + 1) % n, iR) >= averageY(contour, (iR + 1) % n, iL);
  if (forward) {
    return {
      pl,
      pr,
      forward,
      lowerInterior: collectForward(contour, (iL + 1) % n, iR),
      kept: collectForward(contour, (iR + 1) % n, iL),
    };
  }
  return {
    pl,
    pr,
    forward,
    // 下辺は PR→PL 向きに並んでいる。塗り足し用に PL→PR の向きへそろえる。
    lowerInterior: collectForward(contour, (iR + 1) % n, iL).reverse(),
    kept: collectForward(contour, (iL + 1) % n, iR),
  };
}

/**
 * 差込部（首部＋ツメ）をカットラインへ一体化する。
 *
 * 首部の X 区間の下辺を、首部・肩・ツメを描く外周へ置き換えた新しいカットラインを返す。
 * アクリル板本体・首部・ツメが常に 1 枚として切り出されるようにするための拡張であり、
 * 拡張後の形状がオーバーレイ・SVG エクスポートの外形になる（SPEC「カットラインとの一体化」）。
 * 置き換える外周は：
 *
 *   PL →(首部左側面)→ 台座上面 →(左の肩)→ ツメ左 →(ツメ底)→ ツメ右 →(右の肩)→ 台座上面 →(首部右側面)→ PR
 *
 * 台座上面より下へ出るのはツメだけで、板本体は台座に潜り込まない。区間内は元々アクリル
 * 本体の下端なので、下辺だけを下げるこの置換は自己交差を生まない。
 *
 * 隙間埋めが無効（閾値 0）のときの一体化経路。有効なときは首部をマスクへ塗り足して
 * カットラインを起こし直す（cutlineFromMask + unionSlotRects）ため、こちらは使わない。
 * 弧が取れない異常時はそのまま返す。
 */
export function attachSlotBody(contour: Contour, slot: SlotResult): Contour {
  const tabLeftX = slot.tab.xPixel;
  const tabRightX = slot.tab.xPixel + slot.tab.widthPixel;
  const baseTopY = slot.baseTopYPixel;
  const tabBottomY = slot.tab.yPixel + slot.tab.heightPixel;

  const arc =
    !(tabLeftX < tabRightX) || !Number.isFinite(tabBottomY) ? null : extractSlotArc(contour, slot);
  if (!arc) {
    return contour.slice();
  }

  // 差込部の外周を左→右向きに並べたもの。下辺の弧が逆向きなら反転して使う。
  const bodyLeftToRight: Point[] = [
    arc.pl,
    { x: arc.pl.x, y: baseTopY },
    { x: tabLeftX, y: baseTopY },
    { x: tabLeftX, y: tabBottomY },
    { x: tabRightX, y: tabBottomY },
    { x: tabRightX, y: baseTopY },
    { x: arc.pr.x, y: baseTopY },
    arc.pr,
  ];
  const body = arc.forward ? bodyLeftToRight : [...bodyLeftToRight].reverse();
  return [...body, ...arc.kept];
}

/**
 * 差込部の首部がカットラインへ足す領域（閉多角形、画像座標）を返す。
 *
 * 下辺の弧と台座上面で囲まれた領域＝attachSlotBody が首部として板へ足すのと同じ範囲。
 * これをマスクへ塗り足してから隙間埋め（クロージング）を掛けることで、首部の側面と
 * フィギュア外形の間にできる狭い隙間（脚の内側と首部の間など）も充填対象になる
 * （SPEC「隙間埋めと差込部の整合」）。ツメは含めない：ツメ幅は台座スリットへ挿さる
 * 実寸なので、クロージングの円弧でツメ根元が太らないよう後段で crisp に合成する。
 * 後段 unionSlotRects の crisp 合成でも首部形状としてこの多角形を使う（矩形だと板の
 * 下辺が大きく上下する形状で板の外へ張り出すため。SPEC「首部」）。
 */
export function neckFillPolygon(contour: Contour, slot: SlotResult): Point[] | null {
  const arc = extractSlotArc(contour, slot);
  if (!arc) {
    return null;
  }
  const baseTopY = slot.baseTopYPixel;
  // 弧が下辺の閉じ辺（台座上面）と同一線上に重なると（持ち上げ量 0 では板の最下端が必ず
  // 触れる）、辺が自己重複する退化リングになり、unionSlotRects の polygon-clipping が
  // 不正な結果（切り欠き）を生む。弧を閉じ辺から SLOT_UNION_OVERLAP_PX だけ浮かせて
  // 単純多角形に保つ。浮かせた分は板の下辺のすぐ上（板の内部）へ食い込むだけなので、
  // マスクへの塗り足し・union のどちらの用途でも形状は変わらない。
  const maxArcY = baseTopY - SLOT_UNION_OVERLAP_PX;
  const liftOffBase = (p: Point): Point => (p.y > maxArcY ? { x: p.x, y: maxArcY } : p);
  return [
    liftOffBase(arc.pl),
    ...arc.lowerInterior.map(liftOffBase),
    liftOffBase(arc.pr),
    { x: arc.pr.x, y: baseTopY },
    { x: arc.pl.x, y: baseTopY },
  ];
}

/** ツメ矩形を union する際に首部側へ食い込ませる重なり(px)。接続を数値誤差から守る。 */
const SLOT_UNION_OVERLAP_PX = 1;

/** SlotRect（左上原点・幅・高さ）を閉ポリゴンの頂点列へ。 */
function slotRectPoints(rect: SlotRect, extendTopPx = 0): Point[] {
  const left = rect.xPixel;
  const right = rect.xPixel + rect.widthPixel;
  const top = rect.yPixel - extendTopPx;
  const bottom = rect.yPixel + rect.heightPixel;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

/** 閉リングの符号なし面積（shoelace）。 */
function ringArea(points: readonly Point[]): number {
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    area2 += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area2) / 2;
}

/** リング群から面積最大のものを選ぶ（union が複数ポリゴンへ割れた異常時の保険）。 */
function largestRing(rings: readonly Point[][]): Point[] | null {
  let best: Point[] | null = null;
  let bestArea = 0;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const area = ringArea(ring);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return best;
}

/**
 * 首部を合流させた（＝隙間埋め済みの）カットラインへ、首部・ツメの形状を crisp に合成する。
 *
 * マスク経由のカットラインは画素段差の間引きと平滑化（Chaikin）を受けるため、首部の側壁や
 * ツメの角が丸まって実寸から痩せる。ツメ幅＝差込口幅・首部下端＝台座上面はスリット加工に
 * 直結する寸法なので、平滑化後に本来の形状を union して正確な形へ戻す（union は材料を足す
 * だけなので、隙間埋めで充填された部分は失われない）。ツメは首部側へわずかに食い込ませ、
 * 台座上面での接続が数値誤差で切れないようにする。
 *
 * 首部に合成するのは矩形ではなく neckFill（下辺の弧と台座上面で囲む多角形、
 * neckFillPolygon の結果）。矩形（上端＝左右端交点の浅い方）だと、板の下辺が首部幅の
 * 範囲内で大きく上下する形状で、浅い側の高さに合わせた上部が板の輪郭の外へ張り出して
 * しまう。neckFill は左右側壁 X と下端 Y が矩形と同一（＝加工寸法は不変）のまま、
 * 上辺だけが板の下辺に沿うため、張り出しが生じない。
 *
 * union が破綻した（例外・リング無し）場合は null を返し、呼び出し側で従来経路
 * （attachSlotBody）へフォールバックさせる。
 */
export function unionSlotRects(
  contour: Contour,
  slot: SlotResult,
  neckFill: readonly Point[] | null,
): Contour | null {
  if (contour.length < 3) {
    return null;
  }
  // 面積 0 の形状（持ち上げ量 0 で首部が潰れる等）は union へ渡さない。ツメは首部側へ
  // 食い込ませてあるため、首部が潰れていてもカットラインと確実に重なる。
  const parts: Point[][] = [contour.slice()];
  if (neckFill && neckFill.length >= 3 && ringArea(neckFill) > 0) {
    parts.push(neckFill.slice());
  }
  if (slot.tab.widthPixel > 0 && slot.tab.heightPixel > 0) {
    parts.push(slotRectPoints(slot.tab, SLOT_UNION_OVERLAP_PX));
  }
  try {
    const merged = largestRing(unionOuterRings(parts));
    return merged && merged.length >= 3 ? merged : null;
  } catch {
    return null;
  }
}
