// 転倒シミュレーションの描画モデル構築（純粋ロジック、React / SVG 非依存）。
//
// stability.ts が数値として求めた左右の転倒角を、「プレビュー上でフィギュアを
// どう傾けて見せるか」という幾何へ翻訳する。overlay.ts と同じ責務分離で、ここでは
// ピクセル座標系の支点・回転量だけを決め、色や線種などの見た目は描画層に委ねる。
// これにより描画先を SVG / Canvas / WebGL のいずれへ差し替えても再利用できる。
//
// 表示の意味：各方向について、支持範囲の端（支点）を軸にフィギュアを転倒角ぶん
// 傾けた「転倒しかけの限界姿勢」を示す。この姿勢では重心の鉛直線が支点の真上を
// 通り、傾けるほど倒れやすいこと・左右で余裕が違うことを直感的に見せられる。
//
// 座標系は overlay.ts と同じく入力画像のピクセル座標（左上原点・下方向 +Y）。

import type { AnalysisResult, Point } from '@/model/types';
import { degToRad } from '@/utils/geometry';

/**
 * 片側（左 or 右）の転倒姿勢。
 * 描画層は、フィギュア（および付随オーバーレイ）を pivot を中心に angleRad だけ
 * 回転させて重ねることで、その方向の限界姿勢を表現する。SVG では符号付きの
 * angleRad を度へ直して rotate(度, pivot.x, pivot.y) に渡す（angleDeg は向きを
 * 持たない表示用の大きさなので回転量には使わない）。
 */
export interface TippingPose {
  readonly role: 'tippingLeft' | 'tippingRight';
  /** 回転の支点（支持範囲の端、台座上面上のピクセル座標）。 */
  readonly pivot: Point;
  /** 転倒角の大きさ(度)。stability.ts の値と一致する（非負）。表示・ラベル用。 */
  readonly angleDeg: number;
  /**
   * 支点まわりに適用する符号付き回転量(ラジアン)。y 下向き座標系での回転で、
   * 正は画面上で時計回り。左転倒は反時計回り（負）、右転倒は時計回り（正）とし、
   * 回転後に重心が支点の真上へ来るように向きを定める。描画層はこれを度へ変換して
   * SVG の rotate に渡す。
   */
  readonly angleRad: number;
}

/** 左右両方向の転倒姿勢。描画層はこの 2 姿勢を重ねて可視化する。 */
export interface SimulationShapes {
  readonly left: TippingPose;
  readonly right: TippingPose;
}

/**
 * 解析結果から左右の転倒姿勢を構築する。
 *
 * 支点は支持範囲の左右端。mm 座標で保持された supportLeftMm / supportRightMm を
 * mmPerPixel で割ってピクセルへ戻し、台座上面（接地面）の高さに置く。転倒角の分母
 * （重心高さ）も台座上面基準で求められているため、支点をこの線に揃えることで
 * 数値計算と描画の基準が一致する。
 *
 * 回転の向きは、支点まわりに傾けたとき重心が支点の真上へ向かう側に取る。左端を
 * 支点にすると重心（支点より右）は反時計回りで真上へ来るので angleRad は負、右端では
 * 時計回りで正になる。大きさはいずれも stability.ts の転倒角に一致させ、物理計算と
 * 描画で角度がぶれないようにする。
 */
export function buildSimulationShapes(result: AnalysisResult): SimulationShapes {
  const { mmPerPixel, slot, base, stability } = result;
  const baselineY = slot.baseTopYPixel;

  const leftPivot: Point = { x: base.supportLeftMm / mmPerPixel, y: baselineY };
  const rightPivot: Point = { x: base.supportRightMm / mmPerPixel, y: baselineY };

  return {
    left: {
      role: 'tippingLeft',
      pivot: leftPivot,
      angleDeg: stability.tippingAngleLeftDeg,
      // 左端支点：重心は右側にあり、反時計回り（負）に傾けると真上へ到達する。
      angleRad: -degToRad(stability.tippingAngleLeftDeg),
    },
    right: {
      role: 'tippingRight',
      pivot: rightPivot,
      angleDeg: stability.tippingAngleRightDeg,
      // 右端支点：重心は左側にあり、時計回り（正）に傾けると真上へ到達する。
      angleRad: degToRad(stability.tippingAngleRightDeg),
    },
  };
}
