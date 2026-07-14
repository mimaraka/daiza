// 閉じた折れ線を滑らかな曲線（3 次ベジェ列）へ補完する（純粋ロジック、React / SVG 非依存）。
//
// SPEC「曲線補完」節に対応する。平滑化後のカットラインは頂点を結ぶ折れ線のままだと、
// カクついた見た目・カット結果になる。ここでは各辺を直線のまま残し、頂点の近傍だけを
// 局所的にベジェで丸める「コーナーカット（角丸ポリゴン）」方式で曲線化する。
//
// 補間スプライン（全頂点を通す Catmull-Rom 等）を採らないのは、四角形のように頂点が真の
// コーナーだけの外形で、各辺が 1 本の曲線区間になりコーナーの斜め接線に引かれて辺全体が
// 外へ弓なりに膨らむ（樽型化）ためである。コーナーカットは辺を厳密に直線へ保つので、直線的な
// 外形は歪まず（四角形は「辺が直線・角だけ軽く丸い」形に）、曲線的な外形は角の連なりが
// 滑らかにつながる。丸め量は辺長への比率で決めるためスケール不変で、重心・台座・境界計算は
// 頂点列のまま行いつつ、描画・エクスポートだけを曲線として出力できる。
//
// 例外として、丸めてはならない角（差込部の肩＝首部とツメの接合部）は options.sharpCorners で
// 指定して直角のまま通せる。カットラインは板本体と差込部を一体化した 1 本のポリゴンなので、
// 「絵柄由来の角は丸め、加工寸法に直結する角は残す」を頂点単位で指定する必要がある。
//
// オーバーレイ（Preview の SVG）と SVG / .ai エクスポートがこのモジュールで path の `d`
// 属性を組み立てる。座標系（px / mm / pt）や丸め桁は呼び出し側で異なるため、数値の文字列化は
// format コールバックで外から与える。

import type { Point } from '@/model/types';
import { clamp } from '@/utils/geometry';

/** 3 次ベジェの 1 区間。始点は直前区間の終点（先頭区間は曲線の start）。 */
export interface CubicBezierSegment {
  /** 制御点 1（始点側の接線）。 */
  c1: Point;
  /** 制御点 2（終点側の接線）。 */
  c2: Point;
  /** 区間の終点（次の頂点）。 */
  end: Point;
}

/** 閉じた曲線：開始点と、各頂点間を結ぶベジェ区間列。 */
export interface ClosedCurve {
  start: Point;
  segments: CubicBezierSegment[];
}

/**
 * 閉じた頂点列を、辺を厳密な直線に保った閉曲線へ変換する（丸めなし）。
 *
 * 3 次ベジェの制御点を弦の 1/3・2/3 に置くと区間は厳密な直線になるため、直線だけで
 * できた形（矩形・正多角形）も曲線と同じ [[ClosedCurve]] として表せる。台座 footprint の
 * ように「直線のみの形」と「曲線を含む形」を 1 つの表現で扱うために要る
 * （analysis/footprint）。3 頂点未満は閉曲線にならないため null。
 */
export function closedPolylineCurve(points: readonly Point[]): ClosedCurve | null {
  const n = points.length;
  if (n < 3) {
    return null;
  }
  const at = (i: number): Point => points[i % n] ?? { x: 0, y: 0 };
  const segments: CubicBezierSegment[] = [];
  for (let i = 0; i < n; i++) {
    const from = at(i);
    const to = at(i + 1);
    segments.push({ c1: lerp(from, to, 1 / 3), c2: lerp(from, to, 2 / 3), end: to });
  }
  return { start: at(0), segments };
}

/** 閉曲線の全制御点・端点へ写像を適用する（平行移動・座標系変換に使う）。 */
export function mapCurve(curve: ClosedCurve, map: (point: Point) => Point): ClosedCurve {
  return {
    start: map(curve.start),
    segments: curve.segments.map((seg) => ({
      c1: map(seg.c1),
      c2: map(seg.c2),
      end: map(seg.end),
    })),
  };
}

/**
 * 各コーナーを丸める量（隣接 2 辺の短い方に対する比率）。
 *
 * 頂点から各隣接辺に沿ってこの比率ぶん戻った/進んだ 2 点を丸めの開始/終了とし、その間だけを
 * ベジェで丸める。辺長への比率なので画像スケール（px / mm）に依らず一定の見た目になる。値を
 * 大きくするほど角が丸くなり、0 に近づくほど元の折れ線（＝鋭い角）へ近づく。「軽い曲線補完」
 * （SPEC）に収まるよう控えめな値にする。0.5 で隣接コーナーが辺の中点で接し、それを超えると
 * 重なるため上限は 0.5。SPEC に丸め量の指定はなく、見た目の好みで調整可。
 */
const CORNER_ROUND_RATIO = 0.25;

/** 辺長がこれ未満の頂点は方向が定まらないため丸めをスキップ（＝その頂点は鋭角のまま通す）。 */
const MIN_EDGE_LEN = 1e-9;

/**
 * sharpCorners を頂点列へ対応づける際の許容距離。
 *
 * 呼び出し側は「解析が生成した頂点そのもの」を座標で指定する（頂点インデックスは
 * polygon-clipping による外形合成で入れ替わるため使えない）。したがって照合は一致判定に
 * 近く、ここで吸収したいのは mm / pt への線形換算で入る丸め誤差だけ。無関係な隣接頂点を
 * 巻き込まないよう、単位に依らず十分小さい値（px / mm / pt いずれでも 1μm 相当以下）に取る。
 */
const SHARP_MATCH_EPSILON = 1e-3;

/** closedRoundedCorners / closedCurvePathData の切り替え。 */
export interface ClosedCurveOptions {
  /**
   * 曲線補完せず角のまま通す頂点（座標で指定。頂点列に無い座標は無視される）。
   *
   * 差込部の肩（首部とツメの接合部）のように、台座と噛み合う機能面の直角は丸めてはならない
   * （丸めるとツメ根元が太ってスリットへ入らない・肩が台座上面に密着しない）。カットラインは
   * 板本体と差込部を一体化した 1 本のポリゴンなので、この例外は「どの頂点か」でしか表せない。
   */
  sharpCorners?: readonly Point[];
}

/** a→b 上を a から比率 t だけ進んだ点。直線区間の制御点配置に使う。 */
function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/**
 * コーナー弧のハンドル長（丸め半径 r に対する比率）。両辺に接する円弧を 3 次ベジェで近似する値。
 *
 * 制御点を頂点 V にそのまま置く（比率 1.0）とハンドルが長すぎ、曲線が V へ強く引き寄せられて
 * 角が尖った（折れ線に張り付いた）見た目になる。円弧近似の定石どおり、頂点の内角 θ から
 * ハンドル長を決める：弧の中心角 φ = π − θ、半径 R = r·tan(θ/2) の円弧に対する 3 次ベジェの
 * ハンドル長は (4/3)·tan(φ/4)·R で、r で割って整理すると
 *
 *   k = (4/3) · sin(θ/2) / (1 + sin(θ/2))
 *
 * となる（tan の発散を含まないので θ→π でも数値的に安定）。直角コーナー θ=π/2 では
 * k ≈ 0.552（円の 4 分割ベジェ近似の定数と一致）、ほぼ直線 θ→π では 2/3、鋭いスパイク θ→0
 * では 0 に収束し、角が鋭いほど自動的にハンドルが短くなる。
 */
function cornerHandleRatio(cosTheta: number): number {
  // 半角公式 sin(θ/2) = √((1 − cos θ)/2)。丸め誤差で定義域外へ出ないようクランプする。
  const c = Math.min(1, Math.max(-1, cosTheta));
  const halfSin = Math.sqrt((1 - c) / 2);
  return ((4 / 3) * halfSin) / (1 + halfSin);
}

/**
 * sharpCorners で指定された座標に対応する頂点のインデックス集合を求める。
 *
 * 各指定点について許容距離 [[SHARP_MATCH_EPSILON]] 内で最も近い頂点を 1 つだけ選ぶ。
 * 対応する頂点が存在しない指定（差込部が外形へ現れない退化ケース等）は単に無視され、
 * その頂点は通常どおり丸められる（曲線補完自体は壊れない）。
 */
function sharpIndicesOf(points: readonly Point[], corners: readonly Point[]): Set<number> {
  const indices = new Set<number>();
  for (const corner of corners) {
    let best = -1;
    let bestDist = SHARP_MATCH_EPSILON;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p) continue;
      const dist = Math.hypot(p.x - corner.x, p.y - corner.y);
      if (dist <= bestDist) {
        best = i;
        bestDist = dist;
      }
    }
    if (best >= 0) {
      indices.add(best);
    }
  }
  return indices;
}

/**
 * 閉じた頂点列を、各コーナーを局所的に丸めた曲線（3 次ベジェ列）へ変換する。
 *
 * 各頂点 V について、入り辺・出辺に沿って r = min(入り辺長, 出辺長) * [[CORNER_ROUND_RATIO]]
 * だけ戻った点 A・進んだ点 B を求め、A→B を「両辺に接する円弧」を近似する 3 次ベジェで丸める
 * （ハンドル長は [[cornerHandleRatio]] を参照）。丸めの外側
 * （B_i → 次コーナーの A_{i+1}）は辺そのものなので直線で結ぶ。これにより辺は厳密に直線へ
 * 保たれ、四角形のような外形が樽型に歪まない。丸め区間は隣接辺の短い方の半分以内に収まる
 * （比率 ≤ 0.5）ため、隣り合うコーナーの丸めが重ならない。頂点が 3 未満だと面積を持つ閉曲線に
 * ならないため null を返し、呼び出し側で折れ線へフォールバックさせる。
 *
 * options.sharpCorners で指定された頂点だけは丸めず、折れ線のまま（＝元の角のまま）通す。
 */
export function closedRoundedCorners(
  points: readonly Point[],
  options: ClosedCurveOptions = {},
): ClosedCurve | null {
  const n = points.length;
  if (n < 3) {
    return null;
  }

  const sharp = options.sharpCorners?.length ? sharpIndicesOf(points, options.sharpCorners) : null;

  // 巡回アクセサ。?? は範囲内アクセスでは発火しないが、noUncheckedIndexedAccess を満たす。
  const at = (i: number): Point => points[((i % n) + n) % n] ?? { x: 0, y: 0 };

  // 各頂点の丸め開始点 A（入り辺側）・終了点 B（出辺側）と、コーナー弧のハンドル（制御点）を
  // 先に確定する。ハンドルは A・B から頂点へ向かって k 倍だけ伸ばした点（k < 1 なので頂点には
  // 届かない）。
  const enter: Point[] = [];
  const leave: Point[] = [];
  const handleIn: Point[] = [];
  const handleOut: Point[] = [];
  for (let i = 0; i < n; i++) {
    const prev = at(i - 1);
    const cur = at(i);
    const next = at(i + 1);
    const inX = cur.x - prev.x;
    const inY = cur.y - prev.y;
    const outX = next.x - cur.x;
    const outY = next.y - cur.y;
    const lenIn = Math.hypot(inX, inY);
    const lenOut = Math.hypot(outX, outY);

    if (sharp?.has(i) || lenIn < MIN_EDGE_LEN || lenOut < MIN_EDGE_LEN) {
      // 丸めない頂点：機能面の直角（sharpCorners）か、方向の定まらない退化辺（重複点）。
      // A=B=頂点 に潰すことで、前後の辺が頂点まで直線で届き、角がそのまま残る。
      enter.push(cur);
      leave.push(cur);
      handleIn.push(cur);
      handleOut.push(cur);
      continue;
    }
    const r = Math.min(lenIn, lenOut) * CORNER_ROUND_RATIO;
    const a = { x: cur.x - (inX / lenIn) * r, y: cur.y - (inY / lenIn) * r };
    const b = { x: cur.x + (outX / lenOut) * r, y: cur.y + (outY / lenOut) * r };
    // 内角 θ は「V→A」と「V→B」のなす角。V→A は入り辺の逆向きなので符号を反転して内積を取る。
    const cosTheta = -((inX * outX + inY * outY) / (lenIn * lenOut));
    const k = cornerHandleRatio(cosTheta);

    enter.push(a);
    leave.push(b);
    handleIn.push(lerp(a, cur, k));
    handleOut.push(lerp(b, cur, k));
  }

  // コーナー弧（A_i→B_i）と、その後の直線辺（B_i→A_{i+1}）を交互に並べる。
  // 直線辺は端点を 1/3・2/3 で内分した制御点にすることで 3 次ベジェとして厳密な直線になる。
  const segments: CubicBezierSegment[] = [];
  for (let i = 0; i < n; i++) {
    const a = enter[i] ?? at(i);
    const b = leave[i] ?? at(i);
    const nextA = enter[(i + 1) % n] ?? at(i + 1);
    // コーナー弧：制御点は頂点そのものではなく、両辺に接する円弧に合わせて短縮したハンドル。
    // 丸めない頂点（A=B）は弧が長さ 0 になるので、無意味な区間を出力しない。
    if (a.x !== b.x || a.y !== b.y) {
      segments.push({ c1: handleIn[i] ?? b, c2: handleOut[i] ?? b, end: b });
    }
    // 直線辺：B_i → 次コーナーの A_{i+1}。
    segments.push({ c1: lerp(b, nextA, 1 / 3), c2: lerp(b, nextA, 2 / 3), end: nextA });
  }

  return { start: enter[0] ?? at(0), segments };
}

/** 1 区間あたりの分割数の上限。丸め区間は短いので、これ以上刻んでも見た目は変わらない。 */
const MAX_FLATTEN_STEPS = 16;

/** 3 次ベジェ上の点（t ∈ [0, 1]）。P0 = start, P1 = c1, P2 = c2, P3 = end。 */
function cubicAt(start: Point, seg: CubicBezierSegment, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * start.x + b * seg.c1.x + c * seg.c2.x + d * seg.end.x,
    y: a * start.y + b * seg.c1.y + c * seg.c2.y + d * seg.end.y,
  };
}

/** 点 p の、弦 a→b からの垂直距離。a≡b の退化ケースは a からの距離で代用する。 */
function chordDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < MIN_EDGE_LEN) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/**
 * 区間を折れ線で近似するのに要する分割数。
 *
 * 制御点の弦からのずれ d が曲がりの強さを表す。3 次ベジェを n 等分した折れ線の弦誤差は
 * およそ (3/4)·d / n² で抑えられるので、これが tolerance 以下になる最小の n を取る。
 * closedRoundedCorners が辺に出す直線区間は制御点が弦上にある（d = 0）ため n = 1 となり、
 * 「直線は直線のまま・頂点も増えない」が自動的に成り立つ。
 */
function flattenSteps(start: Point, seg: CubicBezierSegment, tolerance: number): number {
  const deviation = Math.max(
    chordDistance(seg.c1, start, seg.end),
    chordDistance(seg.c2, start, seg.end),
  );
  if (!(deviation > 0)) {
    return 1;
  }
  return clamp(Math.ceil(Math.sqrt((0.75 * deviation) / tolerance)), 1, MAX_FLATTEN_STEPS);
}

/**
 * 閉じた頂点列を曲線補完し、その曲線を**折れ線として標本化**した頂点列を返す。
 *
 * SVG / PDF はベジェをそのまま出力できるが（closedCurvePathData）、3D の押し出しジオメトリ
 * （render/scene3d）は頂点列しか受け取れない。プレビュー・エクスポート・3D が「同じ 1 本の
 * カットライン」を共有するには、曲線化を各所で作り直すのではなく、ここで平坦化して渡すのが
 * 唯一の整合手段になる。
 *
 * tolerance は入力座標と同じ単位での許容誤差（弦と曲線のずれ）。曲線化できない退化入力
 * （3 頂点未満）や tolerance が非正の場合は、入力をそのまま複製して返す。
 * 戻り値は閉じた頂点列の規約に従い、始点を末尾で繰り返さない。
 */
export function closedCurvePolyline(
  points: readonly Point[],
  tolerance: number,
  options: ClosedCurveOptions = {},
): Point[] {
  const curve = closedRoundedCorners(points, options);
  if (!curve || !(tolerance > 0)) {
    return points.slice();
  }
  return flattenClosedCurve(curve, tolerance);
}

/**
 * 閉曲線を許容誤差 tolerance（入力座標と同じ単位）で折れ線へ標本化する。
 *
 * 曲線を持たない区間（制御点が弦上にある直線）は 1 区間 = 1 頂点のまま通るため、直線だけで
 * できた形（矩形・正多角形）は頂点が増えない。戻り値は閉じた頂点列の規約に従い、始点を
 * 末尾で繰り返さない。tolerance が非正なら曲線の端点（＝元の頂点列）だけを返す。
 */
export function flattenClosedCurve(curve: ClosedCurve, tolerance: number): Point[] {
  const result: Point[] = [curve.start];
  let from = curve.start;
  for (const seg of curve.segments) {
    const steps = tolerance > 0 ? flattenSteps(from, seg, tolerance) : 1;
    for (let i = 1; i <= steps; i++) {
      result.push(i === steps ? seg.end : cubicAt(from, seg, i / steps));
    }
    from = seg.end;
  }
  // 閉曲線の最終区間は始点へ戻るため、末尾は curve.start の複製になる。閉じた頂点列は
  // 始点を繰り返さない規約なので落とす。
  result.pop();
  return result;
}

/** 既定の座標フォーマッタ。サブピクセル精度を保ちつつ属性文字列を短く保つ。 */
function defaultFormat(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/**
 * 閉じた頂点列を、曲線補完した SVG path の `d` 属性文字列へ変換する。
 *
 * 曲線化できる（3 頂点以上）場合は `M … C … Z` を、できない退化入力は折れ線 `M … L … Z`
 * （または点）を返す。数値の文字列化は format で外から与える（px は既定、mm は 3 桁丸め等）。
 */
export function closedCurvePathData(
  points: readonly Point[],
  format: (value: number) => string = defaultFormat,
  options: ClosedCurveOptions = {},
): string {
  const curve = closedRoundedCorners(points, options);
  return curve ? curvePathData(curve, format) : polylinePathData(points, format);
}

/** 閉曲線を SVG path の `d` 属性（`M … C … Z`）へ変換する。 */
export function curvePathData(
  curve: ClosedCurve,
  format: (value: number) => string = defaultFormat,
): string {
  const f = format;
  let d = `M ${f(curve.start.x)} ${f(curve.start.y)}`;
  for (const s of curve.segments) {
    d += ` C ${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.end.x)} ${f(s.end.y)}`;
  }
  return `${d} Z`;
}

/** 曲線化できない退化入力（3 頂点未満）向けに、頂点をそのまま折れ線でつなぐ。 */
function polylinePathData(points: readonly Point[], format: (value: number) => string): string {
  const f = format;
  const first = points[0];
  if (!first) {
    return '';
  }
  let d = `M ${f(first.x)} ${f(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p) {
      d += ` L ${f(p.x)} ${f(p.y)}`;
    }
  }
  return points.length > 1 ? `${d} Z` : d;
}
