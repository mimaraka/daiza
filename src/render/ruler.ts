// ルーラー（目盛り）の構築（純粋ロジック、React / SVG 非依存）。
//
// プレビューの上端・左端に出す実寸(mm)ルーラーの「どの位置にどんな目盛りを描くか」だけを決める。
// 色・太さ・ラベル体裁は描画層（components/Ruler）に委ねる（overlay.ts と同じ責務分離）。
//
// 座標変換：ビューポート（画面）座標と実寸(mm)の関係は 1 本の 1 次式で表せる。
// 画像ピクセル座標 0 が mm 座標の 0（画像左上）に対応し、useViewport の変換が
//
//   screen = t + scale × contentPixel   （t は tx または ty）
//   contentPixel = mm / mmPerPixel
//
// なので、
//
//   screen = originPx + mm × pxPerMm    （originPx = t、pxPerMm = scale / mmPerPixel）
//
// となる。水平・垂直で軸が違うだけで式は同型のため、本モジュールは軸を区別せず
// 「1 次元の目盛り列」を返し、描画層が X 軸・Y 軸へ割り当てる。

/** ルーラーの目盛り 1 本。 */
export interface RulerTick {
  /** 目盛りの実寸位置(mm)。主目盛りのラベルにも使う。 */
  readonly mm: number;
  /** ビューポート内のスクリーン座標(px)。軸方向の位置。 */
  readonly position: number;
  /** 主目盛り（数値ラベルを付す）か。false なら副目盛り（線のみ）。 */
  readonly major: boolean;
}

/**
 * 主目盛り間隔の候補(mm)。SPEC の例（1 / 5 / 10 / 50 / 100mm）を含み、
 * 極端なズームアウトにも耐えるよう上位の桁まで用意する。
 */
const MAJOR_STEP_CANDIDATES_MM = [1, 5, 10, 50, 100, 500, 1000] as const;

/** 主目盛りの最小間隔(px)。ラベル（数値）が重ならない幅を確保する。 */
const MIN_MAJOR_SPACING_PX = 60;

/** 副目盛りの最小間隔(px)。これを下回るなら副目盛りは描かない（潰れて線が塗り潰される）。 */
const MIN_MINOR_SPACING_PX = 5;

/** 主目盛り 1 区間を副目盛りで割る数。 */
const MINOR_DIVISIONS = 5;

/** 目盛り本数の上限。極端なズームアウト時にループが暴走しないための安全弁。 */
const MAX_TICKS = 2000;

/**
 * 主目盛りの間隔(mm)を選ぶ。
 *
 * ラベルが重ならない最小間隔（MIN_MAJOR_SPACING_PX）を満たす最小の候補を採る。これにより
 * ズームインでは 1mm 刻み、ズームアウトでは 100mm 刻みというように自動で切り替わる。
 * 候補の最大（1000mm）でも足りない極端な縮小では 10 倍ずつ広げる。
 */
export function chooseMajorStepMm(pxPerMm: number): number {
  for (const candidate of MAJOR_STEP_CANDIDATES_MM) {
    if (candidate * pxPerMm >= MIN_MAJOR_SPACING_PX) {
      return candidate;
    }
  }
  let step = MAJOR_STEP_CANDIDATES_MM[MAJOR_STEP_CANDIDATES_MM.length - 1] ?? 1000;
  // 上限（1e6mm = 1km）は事実上到達しないが、非有限な pxPerMm での無限ループを防ぐ番人。
  while (step * pxPerMm < MIN_MAJOR_SPACING_PX && step < 1e6) {
    step *= 10;
  }
  return step;
}

/**
 * 1 軸ぶんの目盛り列を作る。
 *
 * lengthPx はビューポートのその軸方向の長さ、originPx は mm 座標 0 のスクリーン位置
 * （useViewport の tx / ty）、pxPerMm は 1mm あたりのスクリーン px（scale / mmPerPixel）。
 * 可視範囲に入る目盛りだけを返すため、ズーム・パンに追従して自然に増減する。
 *
 * 副目盛りは主目盛りを MINOR_DIVISIONS 等分した位置に置くが、間隔が潰れる（線が密集して
 * 帯になる）場合は主目盛りのみとする。入力が不正（非正の長さ・スケール）なら空配列を返す。
 */
export function buildRulerTicks(lengthPx: number, originPx: number, pxPerMm: number): RulerTick[] {
  if (!(lengthPx > 0) || !Number.isFinite(originPx) || !(pxPerMm > 0)) {
    return [];
  }

  const majorStep = chooseMajorStepMm(pxPerMm);
  const minorStep = majorStep / MINOR_DIVISIONS;
  // 副目盛りが密集しすぎるなら主目盛りだけを刻む。
  const drawMinor = minorStep * pxPerMm >= MIN_MINOR_SPACING_PX;
  const step = drawMinor ? minorStep : majorStep;

  // 可視範囲を mm へ逆算し、その中に入る刻み位置だけを列挙する。
  const startMm = -originPx / pxPerMm;
  const endMm = (lengthPx - originPx) / pxPerMm;
  const firstIndex = Math.ceil(startMm / step);
  const lastIndex = Math.floor(endMm / step);

  const ticks: RulerTick[] = [];
  for (let i = firstIndex; i <= lastIndex && ticks.length < MAX_TICKS; i++) {
    const mm = i * step;
    ticks.push({
      mm,
      position: originPx + mm * pxPerMm,
      // 副目盛りを刻んでいる場合、MINOR_DIVISIONS の倍数番目が主目盛りにあたる。
      major: !drawMinor || i % MINOR_DIVISIONS === 0,
    });
  }
  return ticks;
}

/**
 * 主目盛りのラベル文字列。
 * 刻みが 1mm 未満まで細かくなることは無い（候補の最小が 1mm）ため整数表記で足りるが、
 * 浮動小数の誤差（29.999999…）を出さないよう丸めてから文字列化する。
 */
export function formatTickLabel(mm: number): string {
  return String(Math.round(mm));
}
