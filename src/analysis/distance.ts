// 距離変換（EDT）とマスク膨張：カットライン余白の「真のオフセット」を画像空間で行う。
//
// カットライン余白（SPEC「余白(mm)ぶん外側へオフセットした線」）は、以前はポリゴンの
// 素朴なミターオフセット＋ union（自己交差除去）で実装していた。しかし髪の毛のような
// 深く細い凹凸を持つ輪郭では、ミターオフセットが大量の自己交差ループを生み、それを
// 正規化する polygon-clipping の union が頂点数に対して超線形（実測：12,000 頂点で
// 約 2 秒、頂点数 2 倍で時間約 5 倍）に爆発し、3000px 級画像でフリーズ・メモリ枯渇の
// 原因になっていた。
//
// 本モジュールはこれを「不透明画素からの二乗ユークリッド距離変換（EDT）→ しきい値化」
// による形態学的膨張（＝円板とのミンコフスキー和）へ置き換える。これはオフセットの
// 数学的に正確な定義そのものであり、
//   - 結果のマスク境界は構造的に自己交差しない（union が不要になる）、
//   - 計算量は輪郭の複雑さに依存しない O(W×H)（実測：3000px 級で 300ms 前後）、
//   - 余白以内に近接する分離パーツは自動的に結合される、
// という性質を持つ。React にも DOM にも依存しない純粋ロジック。
//
// EDT は Felzenszwalb–Huttenlocher の 2 パス法（列方向 → 行方向、放物線の下側包絡）。
// 各パスは 1 次元の距離変換で、全体で厳密なユークリッド二乗距離が得られる。

/**
 * 「充填画素なし」を表す番兵距離。実在し得る二乗距離（対角長の 2 乗）より十分大きく、
 * かつ加算（q² + INF）で Infinity へ溢れて比較が壊れない有限値にする。
 */
const INF = 1e20;

/**
 * 1 次元の二乗距離変換（Felzenszwalb–Huttenlocher）。
 *
 * f[q]（格子 q の初期二乗距離。充填なら 0、空きなら INF、2 パス目は 1 パス目の結果）に
 * 対し、out[q] = min_i ((q-i)² + f[i]) を O(n) で求める。各 i の放物線 y=(q-i)²+f[i] の
 * 下側包絡を、頂点 v[]・区間境界 z[] のスタックで構築してから走査する。
 *
 * スクラッチ配列（v, z）は呼び出し側が確保して使い回す（行×列ぶんの再確保を避ける）。
 * 二乗距離・境界とも倍精度で計算し、包絡の順序判定が丸めで壊れないようにする。
 */
function distanceTransform1D(
  f: Float64Array,
  n: number,
  out: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    const fq = f[q] ?? INF;
    // 放物線 q と現在の包絡末尾 v[k] の交点。交点が末尾区間の左端より左なら
    // 末尾の放物線は包絡から外れるため取り除いて計算し直す。
    let vk = v[k] ?? 0;
    let s = (fq + q * q - ((f[vk] ?? INF) + vk * vk)) / (2 * q - 2 * vk);
    while (s <= (z[k] ?? -INF)) {
      k--;
      vk = v[k] ?? 0;
      s = (fq + q * q - ((f[vk] ?? INF) + vk * vk)) / (2 * q - 2 * vk);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? INF) < q) {
      k++;
    }
    const i = v[k] ?? 0;
    const d = q - i;
    out[q] = d * d + (f[i] ?? INF);
  }
}

/**
 * 2 次元の二乗ユークリッド距離変換。各画素について「最も近い充填画素（mask=1）までの
 * 距離の 2 乗」を返す。充填画素自身は 0、充填が皆無なら全画素 INF 級の値になる。
 *
 * 結果は Float32Array で持つ。二乗距離は整数（画像対角²＝数千万オーダー）で、Float32 の
 * 整数精度（2^24 ≈ 1,670 万）を超え得るが、しきい値（余白半径²）はそれよりはるかに
 * 小さいため、しきい値近傍の値は正確に表現され膨張結果には影響しない。中間計算は
 * 行・列単位の小さな Float64 スクラッチで行い、巨大な本体グリッドだけを半分のメモリに抑える。
 */
export function squaredDistanceTransform(
  mask: Uint8Array,
  width: number,
  height: number,
): Float32Array {
  const grid = new Float32Array(width * height);
  const maxN = Math.max(width, height);
  const f = new Float64Array(maxN);
  const out = new Float64Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);

  // 列方向パス：各列で「同じ列内の充填画素までの縦距離²」を求める。
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = mask[y * width + x] === 1 ? 0 : INF;
    }
    distanceTransform1D(f, height, out, v, z);
    for (let y = 0; y < height; y++) {
      grid[y * width + x] = out[y] ?? INF;
    }
  }

  // 行方向パス：列方向の結果へ横距離²を加えた最小値＝厳密な二乗ユークリッド距離。
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      f[x] = grid[row + x] ?? INF;
    }
    distanceTransform1D(f, width, out, v, z);
    for (let x = 0; x < width; x++) {
      grid[row + x] = out[x] ?? INF;
    }
  }

  return grid;
}

/** 膨張済みマスク。元画像よりパディングぶん大きく、座標系がずれている。 */
export interface DilatedMask {
  /** 膨張後のマスク（1=カットライン内側）。radius≤0 のときは入力マスクそのもの。 */
  mask: Uint8Array;
  /** 膨張グリッドの幅（= 元幅 + 2×pad）。 */
  width: number;
  /** 膨張グリッドの高さ。 */
  height: number;
  /** 膨張グリッド座標へこの値を加えると元画像座標になる（= -pad ≤ 0）。 */
  offsetX: number;
  offsetY: number;
}

/**
 * マスクを半径 radiusPx の円板で膨張する（真のオフセット＝ミンコフスキー和）。
 *
 * 膨張は画像枠の外側（特に足元の下方向）へはみ出すため、グリッドを pad = ceil(radius)+2
 * だけ全周に広げてから EDT → しきい値化する（+2 は境界の円弧が格子丸めで欠けないための
 * 安全マージン）。呼び出し側は offsetX/offsetY で輪郭を元画像座標へ平行移動して使う。
 *
 * radius はグリッドの長辺でクランプする。余白(mm)をピクセルへ換算する際、フィギュア高さが
 * 極端に小さいと radius が画像サイズの何倍にもなり、パディングでメモリが暴走し得るため。
 * 長辺ぶん膨張すれば形状はほぼ円板に飽和しており、それ以上広げる意味もない。
 *
 * radius が非正・非有限なら膨張なしとして入力をそのまま返す（余白 0 ＝生の外形）。
 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): DilatedMask {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
    return { mask, width, height, offsetX: 0, offsetY: 0 };
  }

  const radius = Math.min(radiusPx, Math.max(width, height));
  const pad = Math.ceil(radius) + 2;
  const paddedWidth = width + pad * 2;
  const paddedHeight = height + pad * 2;

  const padded = new Uint8Array(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y++) {
    padded.set(mask.subarray(y * width, y * width + width), (y + pad) * paddedWidth + pad);
  }

  const dist = squaredDistanceTransform(padded, paddedWidth, paddedHeight);

  // 二乗距離のまま比較し、sqrt を全画素ぶん省く。
  const radiusSq = radius * radius;
  const dilated = new Uint8Array(paddedWidth * paddedHeight);
  for (let i = 0; i < dilated.length; i++) {
    dilated[i] = (dist[i] ?? INF) <= radiusSq ? 1 : 0;
  }

  return {
    mask: dilated,
    width: paddedWidth,
    height: paddedHeight,
    offsetX: -pad,
    offsetY: -pad,
  };
}
