// 3D プレビュー用のシーン幾何（純粋ロジック、React / three 非依存）。
//
// 解析結果（前面図のピクセル座標 + mm スカラー）を、3D シーンがそのまま組み立てられる
// 実寸(mm)の立体データへ変換する。three に依存させないのは、
//   ・座標系の定義（原点・軸の向き）を 3D ライブラリの都合から切り離すため
//   ・解析 → 幾何の対応を、描画（R3F）を起動せずに検算できるようにするため
// である（SPEC「3D用ジオメトリの構築は React 非依存の純粋ロジックとする」）。
//
// ■ シーン座標系（SPEC「シーン構成」）
//   原点 … 接地面（台座の底面）上の、台座 footprint の中心
//   X … 右が正（前面図の X と同じ向き）
//   Y … **上が正**（前面図のピクセル/mm 座標は下が正なので符号が反転する）
//   Z … **前（手前）が正**（奥行軸の規約「正 = 前」と一致。model/types 参照）
//
// 前面図（下向き +Y）からの換算は
//   X = x_mm − 差込部中心X          … 差込部中心 = 台座 footprint の中心
//   Y = 接地面_mm − y_mm            … 接地面 = 台座上面 + 板厚（＝台座の底面）
// の 2 式に集約される。この変換により
//   ・ツメの底面（台座上面 + 板厚）が Y = 0 …… 台座底面とツライチ（SPEC）
//   ・台座上面が Y = 板厚
// が構成的に成り立つ。

import { centroidProjection } from '@/analysis/base';
import { slotJunctionCorners } from '@/analysis/slot';
import type { AnalysisResult, Point } from '@/model/types';
import type { Tilt3dModel } from '@/render/tilt3d';
import { closedCurvePolyline } from '@/utils/curve';
import { degToRad } from '@/utils/geometry';

/**
 * カットラインの曲線を折れ線へ平坦化するときの許容誤差(mm)。
 * 押し出しジオメトリは頂点列しか取れないため曲線を刻む必要がある。0.05mm は
 * アクリル加工の実用精度より細かく、拡大しても折れが見えない水準。
 */
const CURVE_TOLERANCE_MM = 0.05;

/** カメラの画角(度)。初期構図の距離計算と Canvas の camera 設定で共有する。 */
export const CAMERA_FOV_DEG = 35;

/**
 * 初期視点の方向（右・上・手前）。正規化して距離を掛けた位置に置く。
 * 「正面やや斜め上から」（SPEC「カメラ・操作」）に対応する控えめな振り。
 */
const CAMERA_DIRECTION: readonly [number, number, number] = [0.45, 0.3, 1];

/** 初期構図の余白率。外接円をこの倍率で包むぶんだけカメラを引く。 */
const CAMERA_FIT_MARGIN = 1.12;

/** 3 次元の位置（mm）。 */
export type Vec3 = readonly [number, number, number];

/** 板の裏面へ貼る絵柄・白版の矩形（シーン XY 平面、mm）。 */
export interface Scene3dRect {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
}

/** アクリル板（フィギュア本体）。外形を板厚ぶん押し出したソリッドとして描く。 */
export interface Scene3dPlate {
  /** 曲線補完済みカットライン（板本体・首部・ツメを統合した 1 本）の頂点列。 */
  readonly outline: readonly Point[];
  /** 板厚(mm)。押し出し量。 */
  readonly thicknessMm: number;
  /** 板の奥行中心 Z(mm)。スリット位置（台座奥行中心 + 前後オフセット）に一致する。 */
  readonly centerZMm: number;
  /** 外形の最上端 Y(mm)。接地面からの全高＝指定フィギュア高さ。カメラ構図に使う。 */
  readonly topYMm: number;
  /** 外形の左右端 X(mm)。カメラ構図に使う。 */
  readonly minXMm: number;
  readonly maxXMm: number;
}

/** 台座（footprint を板厚ぶん押し出し、スリットを貫通穴として開けたもの）。 */
export interface Scene3dBase {
  /**
   * footprint の外形（折れ線、台座ローカル座標 mm）。x = 右正、y = **前正**（＝シーンの Z）。
   * 押し出しは this を水平面へ寝かせて行う（components/preview3d/geometry3d）。
   */
  readonly outline: readonly Point[];
  /** footprint のバウンディングボックス寸法(mm)。カメラ構図・影の大きさに使う。 */
  readonly widthMm: number;
  readonly depthMm: number;
  /** 台座の厚み(mm)。板厚と同じ（ツメ深さ = 板厚 = 台座厚でツライチになる）。 */
  readonly thicknessMm: number;
  /** 貫通スリット。幅 = 差込口幅、奥行方向の開口 = 板厚、中心 = 奥行原点 + 前後オフセット。 */
  readonly slot: {
    readonly widthMm: number;
    readonly openingMm: number;
    readonly centerZMm: number;
  };
}

/** 初期構図（＝視点リセットの戻り先）。 */
export interface Scene3dCamera {
  readonly position: Vec3;
  readonly target: Vec3;
}

/** 3D シーンを組み立てるのに必要な幾何一式（すべて実寸 mm・シーン座標系）。 */
export interface Scene3dGeometry {
  readonly plate: Scene3dPlate;
  readonly base: Scene3dBase;
  /** 絵柄（と白版）を板の裏面へ貼る矩形。画像全体を実寸で置いたもの。 */
  readonly artwork: Scene3dRect;
  /** 傾け（転倒シミュレーション）の姿勢を任意方位について求めるためのモデル。 */
  readonly tilt: Tilt3dModel;
  /** 分解アニメーションで板を持ち上げる高さ(mm)。 */
  readonly explodeLiftMm: number;
  readonly camera: Scene3dCamera;
}

/**
 * 解析結果を 3D シーンの幾何へ変換する。
 *
 * 板の外形には、プレビュー（overlay）・エクスポート（geometry）と**同一の**カットラインを
 * 使う。曲線補完（差込部の肩は直角のまま）も同じ utils/curve を通し、頂点列へ平坦化する
 * だけに留めることで、2D で見た形と 3D の立体が食い違わないようにしている。
 *
 * 板厚は slot.tabDepthMm（＝ツメ深さ＝板厚）から取る。AnalysisResult はパラメータを
 * 持たないが、板厚は差込部にそのまま現れているため、この 1 引数で自己完結できる。
 */
export function buildScene3d(result: AnalysisResult): Scene3dGeometry {
  const { mmPerPixel, imageSize, contour, centroid, slot, base, stability } = result;

  // 板厚。板・台座・ツメ深さで共通の値（SPEC）。
  const thicknessMm = slot.tabDepthMm;
  // 接地面（台座の底面）の、前面図 mm-y。台座上面から板厚ぶん下。
  const groundYMm = base.topYMm + thicknessMm;

  // 前面図（px、下向き +Y）→ シーン（mm、上向き +Y、原点 = 接地面上の台座中心）。
  const toScene = (p: Point): Point => ({
    x: p.x * mmPerPixel - slot.centerXMm,
    y: groundYMm - p.y * mmPerPixel,
  });

  // 曲線補完 → 折れ線化はピクセル座標のまま行う（sharpCorners がピクセル座標のため）。
  // 許容誤差も px へ直して渡すので、平坦化の細かさは mm 基準で一定になる。
  const outline = closedCurvePolyline(contour, CURVE_TOLERANCE_MM / mmPerPixel, {
    sharpCorners: slotJunctionCorners(slot),
  }).map(toScene);

  let topYMm = 0;
  let minXMm = 0;
  let maxXMm = 0;
  for (const p of outline) {
    if (p.y > topYMm) topYMm = p.y;
    if (p.x < minXMm) minXMm = p.x;
    if (p.x > maxXMm) maxXMm = p.x;
  }

  // 絵柄は画像そのものを実寸で板の裏面へ貼る（画像左上が px 原点）。
  const imageWidthMm = imageSize.width * mmPerPixel;
  const imageHeightMm = imageSize.height * mmPerPixel;
  const imageTopLeft = toScene({ x: 0, y: 0 });

  const plate: Scene3dPlate = {
    outline,
    thicknessMm,
    centerZMm: slot.depthOffsetMm,
    topYMm,
    minXMm,
    maxXMm,
  };

  return {
    plate,
    base: {
      // 台座は「台座形状」で選んだ footprint（解析が確定済み）をそのまま押し出す。折れ線は
      // 許容誤差 0.05mm で平坦化済みなので、3D 側で曲線を刻み直す必要はない。
      outline: base.footprint.polyline,
      widthMm: base.widthMm,
      depthMm: base.depthMm,
      thicknessMm,
      slot: {
        widthMm: slot.widthMm,
        openingMm: thicknessMm,
        centerZMm: slot.depthOffsetMm,
      },
    },
    artwork: {
      centerX: imageTopLeft.x + imageWidthMm / 2,
      centerY: imageTopLeft.y - imageHeightMm / 2,
      width: imageWidthMm,
      height: imageHeightMm,
    },
    tilt: {
      // 支点・転倒角はどちらも凸包の支持関数で決まる（render/tilt3d）。重心の鉛直投影は
      // 転倒角と同じ定義を使わないと支点と警告色の境界がずれるため、analysis/base から取る。
      hull: hullOf(base),
      groundCentroid: centroidProjection(centroid, slot),
      centroidHeightMm: stability.centroidHeightMm,
      spanMm: Math.max(base.widthMm, base.depthMm),
      minTippingDeg: stability.tippingAngleMinDeg,
      worstAzimuthDeg: stability.worstAzimuthDeg,
    },
    explodeLiftMm: explodeLift(thicknessMm, topYMm),
    camera: cameraFrame(plate, base.widthMm),
  };
}

/**
 * 傾けの支持範囲に使う凸包。
 *
 * 通常は footprint の凸包そのもの。頂点が 3 未満に退化した凸包は解析（computeStability）が
 * 弾いており 3D まで来ないが、支持関数が定義できず支点が消えるため、念のため bbox の矩形へ
 * 落として姿勢だけは成り立たせる。
 */
function hullOf(base: AnalysisResult['base']): readonly Point[] {
  const hull = base.footprint.hull;
  if (hull.length >= 3) {
    return hull;
  }
  const hw = base.widthMm / 2;
  const hd = base.depthMm / 2;
  return [
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
    { x: -hw, y: -hd },
  ];
}

/**
 * 分解アニメーションの持ち上げ量(mm)。
 *
 * 最低でもツメが完全にスリットから抜ける（＝板厚ぶん）必要があり、そこへ「離れた」と
 * 目で分かるだけの隙間を足す。隙間は全高に比例させ（小さなフィギュアで開きすぎない）、
 * 下限を設けて極小サイズでも見て取れるようにする。
 */
function explodeLift(thicknessMm: number, topYMm: number): number {
  return thicknessMm + Math.max(10, topYMm * 0.12);
}

/**
 * 全体が収まる初期構図を求める（SPEC「初期視点は正面やや斜め上から全体が収まる構図」）。
 *
 * 被写体の外接円（前面から見た幅・高さ）を画角へ収める距離を三角比で出し、正面やや斜め上の
 * 方向へその距離だけ引く。注視点は全高の中ほど（やや下）に取り、台座も画角へ入れる。
 */
function cameraFrame(plate: Scene3dPlate, baseWidthMm: number): Scene3dCamera {
  const widthMm = Math.max(baseWidthMm, plate.maxXMm - plate.minXMm, 1);
  const heightMm = Math.max(plate.topYMm, 1);
  const radiusMm = 0.5 * Math.hypot(widthMm, heightMm);
  const distanceMm = (radiusMm / Math.tan(degToRad(CAMERA_FOV_DEG) / 2)) * CAMERA_FIT_MARGIN;

  const [dx, dy, dz] = CAMERA_DIRECTION;
  const length = Math.hypot(dx, dy, dz);
  const target: Vec3 = [0, heightMm * 0.45, 0];

  return {
    position: [
      target[0] + (dx / length) * distanceMm,
      target[1] + (dy / length) * distanceMm,
      target[2] + (dz / length) * distanceMm,
    ],
    target,
  };
}
