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
// オーバーレイ（Preview の SVG）と SVG エクスポートの双方がこのモジュールで path の `d`
// 属性を組み立てる。座標系（px / mm）や丸め桁は呼び出し側で異なるため、数値の文字列化は
// format コールバックで外から与える。

import type { Point } from '@/model/types';

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
 * 閉じた頂点列を、各コーナーを局所的に丸めた曲線（3 次ベジェ列）へ変換する。
 *
 * 各頂点 V について、入り辺・出辺に沿って r = min(入り辺長, 出辺長) * [[CORNER_ROUND_RATIO]]
 * だけ戻った点 A・進んだ点 B を求め、A→B を「両辺に接する円弧」を近似する 3 次ベジェで丸める
 * （ハンドル長は [[cornerHandleRatio]] を参照）。丸めの外側
 * （B_i → 次コーナーの A_{i+1}）は辺そのものなので直線で結ぶ。これにより辺は厳密に直線へ
 * 保たれ、四角形のような外形が樽型に歪まない。丸め区間は隣接辺の短い方の半分以内に収まる
 * （比率 ≤ 0.5）ため、隣り合うコーナーの丸めが重ならない。頂点が 3 未満だと面積を持つ閉曲線に
 * ならないため null を返し、呼び出し側で折れ線へフォールバックさせる。
 */
export function closedRoundedCorners(points: readonly Point[]): ClosedCurve | null {
  const n = points.length;
  if (n < 3) {
    return null;
  }

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

    if (lenIn < MIN_EDGE_LEN || lenOut < MIN_EDGE_LEN) {
      // 退化辺（重複点）。方向が定まらないので丸めず頂点をそのまま通す。
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
    const b = leave[i] ?? at(i);
    const nextA = enter[(i + 1) % n] ?? at(i + 1);
    // コーナー弧：制御点は頂点そのものではなく、両辺に接する円弧に合わせて短縮したハンドル。
    segments.push({ c1: handleIn[i] ?? b, c2: handleOut[i] ?? b, end: b });
    // 直線辺：B_i → 次コーナーの A_{i+1}。
    segments.push({ c1: lerp(b, nextA, 1 / 3), c2: lerp(b, nextA, 2 / 3), end: nextA });
  }

  return { start: enter[0] ?? at(0), segments };
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
): string {
  const f = format;
  const curve = closedRoundedCorners(points);

  if (!curve) {
    // 頂点不足で曲線化できない。持っている頂点をそのまま折れ線でつなぐ。
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

  let d = `M ${f(curve.start.x)} ${f(curve.start.y)}`;
  for (const s of curve.segments) {
    d += ` C ${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.end.x)} ${f(s.end.y)}`;
  }
  return `${d} Z`;
}
