// 距離変換（EDT）とマスクの形態学的操作：カットライン余白の「真のオフセット」（膨張）と、
// 狭い隙間の充填（膨張→収縮＝クロージング）を画像空間で行う。
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
// という性質を持つ。収縮（erodeMask）は同じ EDT を背景に対して取るだけの双対であり、
// 膨張との合成（closeMask）が SPEC の「狭い隙間の充填」になる。
// React にも DOM にも依存しない純粋ロジック。
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

/** マスク膨張時に確保するパディング。境界の円弧が格子丸めで欠けないよう +2 の余裕を取る。 */
function padFor(radius: number): number {
  return Math.ceil(radius) + 2;
}

/**
 * 膨張半径をグリッド長辺でクランプする。
 * 余白(mm)をピクセルへ換算する際、フィギュア高さが極端に小さいと radius が画像サイズの
 * 何倍にもなり、パディングでメモリが暴走し得る。長辺ぶん膨張すれば形状はほぼ円板に飽和
 * しており、それ以上広げる意味もない。
 */
function clampRadius(radiusPx: number, width: number, height: number): number {
  return Math.min(radiusPx, Math.max(width, height));
}

/**
 * マスクを半径 radiusPx の円板で膨張する（真のオフセット＝ミンコフスキー和）。
 *
 * 膨張は画像枠の外側（特に足元の下方向）へはみ出すため、グリッドを pad = ceil(radius)+2
 * だけ全周に広げてから EDT → しきい値化する。呼び出し側は offsetX/offsetY で輪郭を
 * 元画像座標へ平行移動して使う。
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

  const radius = clampRadius(radiusPx, width, height);
  const pad = padFor(radius);
  const paddedWidth = width + pad * 2;
  const paddedHeight = height + pad * 2;

  const padded = new Uint8Array(paddedWidth * paddedHeight);
  for (let y = 0; y < height; y++) {
    padded.set(mask.subarray(y * width, y * width + width), (y + pad) * paddedWidth + pad);
  }

  const dist = squaredDistanceTransform(padded, paddedWidth, paddedHeight);

  // 二乗距離のまま比較し、sqrt を全画素ぶん省く。「充填画素まで radius 以内」＝膨張後の内側。
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

/**
 * マスクを半径 radiusPx の円板で収縮する（dilateMask の双対）。
 *
 * 膨張が「充填画素までの距離 ≦ r」だったのに対し、収縮は「背景画素までの距離 > r」＝
 * 半径 r の円板がマスク内部に完全に収まる点だけを残す。EDT を背景（mask=0）を充填と
 * みなして取ることで、同じ 2 パス EDT 基盤をそのまま流用できる。
 *
 * 膨張と違い領域は縮むだけなのでグリッドは広げず、入力と同じ座標系のマスクを返す。
 * ただしグリッド外は「背景でも充填でもない」扱い（EDT の対象外）なので、グリッド境界に
 * 接する領域は境界の外側から削られない。クロージング用途では膨張が確保したパディングが
 * 常に背景として周囲を囲むため、この扱いで期待どおりの結果になる。
 *
 * radius が非正・非有限なら収縮なしとして入力をそのまま返す。
 */
export function erodeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): Uint8Array {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
    return mask;
  }

  const radius = clampRadius(radiusPx, width, height);

  // 背景を充填とみなした EDT → 各画素から最も近い背景画素までの二乗距離。
  const background = new Uint8Array(width * height);
  for (let i = 0; i < background.length; i++) {
    background[i] = mask[i] === 1 ? 0 : 1;
  }
  const dist = squaredDistanceTransform(background, width, height);

  // 背景までの距離が radius を「超える」画素だけが、半径 radius の円板を内部に収められる。
  const radiusSq = radius * radius;
  const eroded = new Uint8Array(width * height);
  for (let i = 0; i < eroded.length; i++) {
    eroded[i] = (dist[i] ?? 0) > radiusSq ? 1 : 0;
  }
  return eroded;
}

/**
 * マスクへ半径 radiusPx の円板でモルフォロジカルクロージング（膨張 → 収縮）を施す。
 *
 * SPEC「狭い隙間の充填（隙間埋め）」の中核。半径 r の円板によるクロージングは
 * 「半径 r の円板が入り込めない隙間」＝**幅が 2r 未満の隙間だけ**を充填し、それ以外の
 * 領域は変えない（充填の要否判定と充填処理が単一の操作で同時に達成される）。充填後の
 * 境界は円板の包絡（半径 r の円弧）になるため、隙間は自動的になめらかに補間され、
 * 折れ線状の継ぎ目や尖りは生じない。分離パーツ間の隙間にも、同一パーツ内のくびれ
 * （向かい合う凹部）にも同様に働く。
 *
 * 膨張は枠外へはみ出すため、返すグリッドは dilateMask 同様パディングぶん広く、原点が
 * ずれている（offsetX/offsetY で元座標へ戻す）。収縮側は膨張が作ったパディング（背景）を
 * そのまま使うため、膨張前のマスクは常に結果へ含まれる（クロージングの外延性）。
 *
 * radius が非正・非有限なら何もせず入力をそのまま返す（隙間埋め無効）。
 */
export function closeMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): DilatedMask {
  if (!Number.isFinite(radiusPx) || radiusPx <= 0) {
    return { mask, width, height, offsetX: 0, offsetY: 0 };
  }

  // 膨張と収縮で同じ半径を使わないと形状が痩せる／太るため、クランプ後の値を共有する。
  const radius = clampRadius(radiusPx, width, height);
  const dilated = dilateMask(mask, width, height, radius);
  const eroded = erodeMask(dilated.mask, dilated.width, dilated.height, radius);

  return {
    mask: eroded,
    width: dilated.width,
    height: dilated.height,
    offsetX: dilated.offsetX,
    offsetY: dilated.offsetY,
  };
}
