// エクスポート共通の幾何（純粋ロジック、React / DOM 非依存）。
//
// SVG（export/svg.ts）と Illustrator/.ai（export/ai.ts）は、同じ解析結果を別の
// ファイル形式へ書き出すだけで、**描く図形そのものは同一**である。座標変換や外接矩形の
// 算出を各形式に持たせると、片方だけ直したときに 2 つの成果物がズレる。そこで
// 「解析結果 → mm 座標の図形一式」への変換をこのモジュールへ一元化し、各形式は
// ここで得た幾何を自分の構文へ写すだけにする。
//
// 座標系：解析と同じくピクセル左上原点・下方向 +Y を維持し、mmPerPixel で mm へ換算する。

import { slotJunctionCorners } from '@/analysis/slot';
import type { AnalysisResult, Point } from '@/model/types';
import { mapCurve, type ClosedCurve } from '@/utils/curve';

/** 図形を配置する余白(mm)。外接矩形の外周に取り、線が縁で切れないようにする。 */
const MARGIN_MM = 5;

/**
 * 要素の描き分けに使う色。レーザー加工などで各要素を判別しやすいよう色分けする
 * （プレビューのオーバーレイと同じ配色にして認知負荷を下げる）。
 */
export const EXPORT_COLORS = {
  /** 外形（カットライン）。 */
  contour: '#374151',
  /** 差込部（首部・ツメ）。 */
  slot: '#2563eb',
  /** 台座。 */
  base: '#16a34a',
} as const;

/**
 * mm 値をファイル出力向けの短い文字列へ整える。
 * 浮動小数の桁あふれ（0.1 + 0.2 = 0.30000…）で出力が肥大するのを防ぐため小数
 * 3 桁で丸め、末尾の余分な 0 を Number 経由で落とす。3 桁 = 1μm 相当で実用十分。
 */
export function fmt(value: number): string {
  return Number(value.toFixed(3)).toString();
}

/** 軸平行な矩形の左上原点・寸法（mm）。 */
export interface RectMm {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 台座 footprint（上面図の外形）を書き出し座標系(mm)へ写したもの。
 *
 * 曲線パス（curve）は SVG / .ai が同じ幾何を曲線コマンドで出力するために持つ（矩形以外の
 * footprint も折れ線に落とさない。SPEC「台座のスリット」）。折れ線（outline）は viewBox の
 * 外接算出に使う。
 */
export interface BaseFootprintMm {
  /** 曲線パス（直線＋3 次ベジェ）。 */
  curve: ClosedCurve;
  /** 曲線を平坦化した頂点列。 */
  outline: readonly Point[];
  /** バウンディングボックス（上辺 = 台座上面）。 */
  bounds: RectMm;
}

/**
 * 書き出す図形一式を mm 座標で束ねた中間表現。
 * 外接矩形（viewBox）の算出と各形式への文字列化の双方がこれを入力にすることで、
 * 座標変換を 1 箇所（buildExportGeometry）へ集約し、要素追加時の座標系ずれを防ぐ。
 */
export interface ExportGeometry {
  /** 外形（アクリル板本体＋首部＋ツメを一体化したカットライン）の頂点列（mm）。 */
  contour: readonly Point[];
  /**
   * 外形のうち曲線補完で丸めない頂点（差込部の肩＝首部とツメの接合部、mm）。
   * contour と同じ mm 換算を通しているため、頂点列に現れる座標と厳密に一致する。
   */
  sharpCorners: readonly Point[];
  /** 差込部の首部（mm）。baseFigure のみ。 */
  neck?: RectMm;
  /** 差込部のツメ（mm）。baseFigure のみ。 */
  tab?: RectMm;
  /** 台座（台座上面へ bbox 上辺を合わせて置く実寸の footprint、mm）。baseFigure のみ。 */
  base?: BaseFootprintMm;
  /**
   * 台座に切るスリット（差込口）の footprint（mm）。baseFigure のみ。
   */
  baseSlot?: RectMm;
  /** キーホルダー穴（mm）。keychain のみ。 */
  hole?: { center: Point; radius: number };
  /** 絵柄画像を実寸で置く矩形（mm）。画像は解析と同じ左上原点なので常に原点始まり。 */
  image: RectMm;
  /** 全要素を包む外接矩形に余白を足した領域（mm）。 */
  viewBox: RectMm;
}

/** buildExportGeometry の切り替え。 */
export interface ExportGeometryOptions {
  /**
   * 絵柄画像を成果物に含めるか。含める場合のみ viewBox が画像矩形を包む。
   * 画像とカットラインは互いにはみ出し得る（カットラインは余白ぶん外側へ膨らみ、
   * 一方で画像は透明余白を持ち得る）ため、含める時だけ外接に加える。
   */
  includeImage: boolean;
}

/**
 * 解析結果を mm 座標の描画幾何へ変換する。
 *
 * 外形・差込部はプレビュー（render/overlay）と同じ前面図として mm 換算する。
 * 台座は前面図に現れない奥行を持つため、「台座形状」で選んだ footprint の**上面図**を、
 * バウンディングボックスの上辺を**台座上面**（base.topYMm＝カットライン最下端＋持ち上げ量）に
 * 合わせて下方向へ描く。これにより幅・奥行の両方を実寸のまま 1 枚の図へ載せつつ、板本体が
 * 台座と重ならないこと・ツメ（深さ=板厚 ≦ 奥行）が台座を貫通しないことが出力形状の上でも
 * 保証される。矩形以外の footprint も曲線パスのまま写すので、SVG と .ai は同一の幾何を共有する。
 *
 * この台座 footprint は上面図（真上から見た平面）なので、その**縦方向が奥行軸**になる。
 * 上辺（台座上面 Y）を台座の後縁、下辺を前縁とみなす（真上から見て手前が下＝前）。
 * 差込口の前後オフセット（正=前）は下方向のずれとして写り、スリットは
 * 「奥行中心 + 前後オフセット」を中心に板厚ぶんの幅で切られる。
 */
export function buildExportGeometry(
  result: AnalysisResult,
  options: ExportGeometryOptions,
): ExportGeometry {
  const { mmPerPixel, imageSize, contour } = result;

  const toMm = (p: Point): Point => ({ x: p.x * mmPerPixel, y: p.y * mmPerPixel });
  const contourMm = contour.map(toMm);

  // 絵柄画像：解析と同じ画素座標系にそのまま乗るので、原点から実寸サイズぶん。
  const imageRect: RectMm = {
    x: 0,
    y: 0,
    width: imageSize.width * mmPerPixel,
    height: imageSize.height * mmPerPixel,
  };

  // keychain モード：回転済み contour + 穴のみ。
  if (result.keychain) {
    const { keychain } = result;
    const hole = {
      center: toMm(keychain.holeCenterPixel),
      radius: keychain.holeRadiusMm,
    };
    const bounds = [holeRect(hole), ...(options.includeImage ? [imageRect] : [])];
    return {
      contour: contourMm,
      sharpCorners: [],
      hole,
      image: imageRect,
      viewBox: computeViewBox(contourMm, bounds),
    };
  }

  // baseFigure モード：既存の首・ツメ・台座・スリットを含める。
  const { slot, base } = result;
  if (!slot || !base) {
    throw new Error('buildExportGeometry requires slot/base for baseFigure mode');
  }

  const baseTopYMm = base.topYMm;

  const neckTopYMm = slot.neck.yPixel * mmPerPixel;
  const neckRect: RectMm = {
    x: slot.centerXMm - slot.neckWidthMm / 2,
    y: neckTopYMm,
    width: slot.neckWidthMm,
    height: Math.max(0, baseTopYMm - neckTopYMm),
  };

  const tabRect: RectMm = {
    x: slot.centerXMm - slot.widthMm / 2,
    y: baseTopYMm,
    width: slot.widthMm,
    height: slot.tabDepthMm,
  };

  const baseOriginYMm = baseTopYMm + base.depthMm / 2;
  const toBaseMm = (p: Point): Point => ({
    x: slot.centerXMm + p.x,
    y: baseOriginYMm + p.y,
  });
  const baseFootprint: BaseFootprintMm = {
    curve: mapCurve(base.footprint.curve, toBaseMm),
    outline: base.footprint.polyline.map(toBaseMm),
    bounds: {
      x: slot.centerXMm - base.widthMm / 2,
      y: baseTopYMm,
      width: base.widthMm,
      height: base.depthMm,
    },
  };

  const slitCenterYMm = baseOriginYMm + slot.depthOffsetMm;
  const baseSlotRect: RectMm = {
    x: slot.centerXMm - slot.widthMm / 2,
    y: slitCenterYMm - slot.tabDepthMm / 2,
    width: slot.widthMm,
    height: slot.tabDepthMm,
  };

  const bounds = [
    neckRect,
    tabRect,
    baseFootprint.bounds,
    ...(options.includeImage ? [imageRect] : []),
  ];

  return {
    contour: contourMm,
    sharpCorners: slotJunctionCorners(slot).map(toMm),
    neck: neckRect,
    tab: tabRect,
    base: baseFootprint,
    baseSlot: baseSlotRect,
    image: imageRect,
    viewBox: computeViewBox(contourMm, bounds),
  };
}

/** 穴の外接矩形。viewBox 計算用。 */
function holeRect(hole: { center: Point; radius: number }): RectMm {
  return {
    x: hole.center.x - hole.radius,
    y: hole.center.y - hole.radius,
    width: hole.radius * 2,
    height: hole.radius * 2,
  };
}

/** 頂点列と矩形群を包む境界（mm）に余白を足した領域を求める。 */
function computeViewBox(contour: readonly Point[], rects: readonly RectMm[]): RectMm {
  const xs: number[] = [];
  const ys: number[] = [];

  for (const p of contour) {
    xs.push(p.x);
    ys.push(p.y);
  }
  for (const rect of rects) {
    xs.push(rect.x, rect.x + rect.width);
    ys.push(rect.y, rect.y + rect.height);
  }

  const minX = Math.min(...xs) - MARGIN_MM;
  const minY = Math.min(...ys) - MARGIN_MM;
  const maxX = Math.max(...xs) + MARGIN_MM;
  const maxY = Math.max(...ys) + MARGIN_MM;

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 図全体の大きさに見合う線幅(mm)。
 * 対角の 0.3% とし、拡大率に依らず見やすい太さを保つ。極小図でも線が消えないよう
 * 0.2mm を下限にする。
 */
export function strokeWidthMm(viewBox: RectMm): number {
  return Math.max(0.2, Math.hypot(viewBox.width, viewBox.height) * 0.003);
}

/**
 * 矩形を閉じたパスの `d` 属性文字列へ変換する。
 * SVG は `<rect>` を持つが PDF（.ai）は矩形を含めすべてパスで描くため、両者が同じ
 * 形状を出すよう矩形のパス化をここに置く。曲線は不要なので直線 4 辺で閉じる。
 */
export function rectPathData(rect: RectMm, format: (value: number) => string = fmt): string {
  const f = format;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return (
    `M ${f(rect.x)} ${f(rect.y)} L ${f(right)} ${f(rect.y)} ` +
    `L ${f(right)} ${f(bottom)} L ${f(rect.x)} ${f(bottom)} Z`
  );
}
