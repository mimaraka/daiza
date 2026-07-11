// 台座サイズ計算：支持多角形の考え方で指定台座幅の妥当性を検査し、推奨奥行を求める。
//
// アクリルフィギュアは差込口（スリット）へタブを挿して自立する。左右方向の
// 転倒に抗するのは台座の横幅であり、その台座の接地範囲＝「支持範囲」に重心の
// 鉛直投影が収まっていれば静的には倒れない（支持多角形の考え方）。台座幅はユーザーが
// 実寸で指定するため、本モジュールはその指定幅が最低条件を安全率込みで満たすかを検査し、
// 支持範囲と前後方向の安定を担保する推奨奥行を算出する。React には依存しない純粋ロジック。
//
// SPEC の定義：
//  - 最低条件：重心が支持範囲内。
//  - 台座幅はユーザー指定値をそのまま実寸幅とする。
//  - 安全率を掛けた必要幅を下回る指定は台座計算不可とする。
//  - 推奨奥行を算出する。
//
// 座標系：台座は差込口中心（slot.centerXMm）を軸に左右対称へ配置する。差込口は
// フィギュアのタブ位置＝重心の真下に最も近い位置に置かれるため、台座もそこを中心に
// 取るのが物理的に自然で、overlay の緑矩形（slot 中心対称で描画）とも一致する。

import type { AnalysisParameters, BaseResult, Centroid, Contour, SlotResult } from '@/model/types';
import { degToRad } from '@/utils/geometry';

/**
 * 推奨奥行を決める前後方向の目標転倒角(度)。
 * 薄板フィギュアの重心は板の面内にあり、前後方向には台座中心の真上へ落ちる。
 * よって前後の静的安定はどんな奥行でも成立するが、外乱に耐える余裕として
 * 「重心高さに対しこの角度まで傾けても倒れない」奥行を確保する。アプリが左右
 * 転倒に用いるのと同じ θ=atan(支持端距離 / 重心高さ) の関係を前後へ流用する。
 */
const DEPTH_TARGET_TIPPING_ANGLE_DEG = 15;

/** 上記目標角の tan。奥行 = 2 × 重心高さ × tan(目標角) の係数として使う。 */
const DEPTH_ANGLE_TAN = Math.tan(degToRad(DEPTH_TARGET_TIPPING_ANGLE_DEG));

/**
 * スリットを切るために台座奥行が最低限必要な、ツメ深さ（＝板厚）に対する倍率。
 * 差込口はツメ深さぶんの溝＋その前後を支える壁が要る。前後それぞれにツメ深さぶんの
 * 壁を見込み、3 倍を製造上の下限とする。これは同時に「ツメが台座を貫通しない
 * （ツメ深さ ≦ 台座奥行）」という SPEC の要件を構成的に保証する床でもある。
 */
const SLOT_WALL_FACTOR = 3;

/**
 * 台座上面 Y（ピクセル）を求める。
 *
 * SPEC「アクリル板と台座の上下関係」の不変条件（板の最下端 ≦ 台座上面）を成立させる
 * ための基準線。カットライン余白を大きく取ると外形は画像下端より下へ広がるため、
 * 基準は「画像下端」ではなく**カットラインの最下端**に取る。そこへ持ち上げ量を足した
 * 位置を台座上面とし、持ち上げ量 0 なら板の下端と台座上面がちょうど接する（Y は下方向 +）。
 *
 * 退化入力（空のカットライン・不正な持ち上げ量／スケール）では NaN を返し、
 * 呼び出し側で台座計算不可として弾けるようにする。
 */
export function computeBaseTopYPixel(
  contour: Contour,
  plateLiftMm: number,
  mmPerPixel: number,
): number {
  if (!Number.isFinite(plateLiftMm) || plateLiftMm < 0 || !(mmPerPixel > 0)) {
    return Number.NaN;
  }
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of contour) {
    if (p.y > maxY) {
      maxY = p.y;
    }
  }
  if (!Number.isFinite(maxY)) {
    return Number.NaN;
  }
  return maxY + plateLiftMm / mmPerPixel;
}

/**
 * 台座サイズを計算する。
 *
 * 台座幅はユーザー指定値（params.baseWidthMm）をそのまま実寸幅として採る。差込口中心を
 * 軸に左右対称な矩形台座を想定するため、支持範囲は 差込口中心 ± 台座幅/2 になる。
 *
 * 安全率はここでは幅を作る係数ではなく**指定幅の検査**に使う。重心が差込口中心から水平に
 * offset だけずれているとき、重心を支持範囲へ収める最小幅は 2×offset（台座端がちょうど
 * 重心の真下に届く幅）であり、これに安全率を掛けた値を必要幅とする。さらにスリットを
 * 内包できる必要があるため差込口幅も下限に取る。指定幅がこの必要幅に満たなければ
 * 台座計算不可（null）とし、UI で台座幅を広げるよう促す。
 *
 * 奥行は前後方向の安定（DEPTH_TARGET_TIPPING_ANGLE_DEG）を満たす footing と、
 * スリット加工上の下限（ツメ深さ基準）の大きい方を採る。
 *
 * 重心高さは台座上面（接地面）から測る（SPEC「重心高さは台座上面を基準」）。台座上面は
 * カットライン最下端 + 持ち上げ量で決まるため、画像下端ではなく baseTopYMm を基準にする。
 *
 * 失敗（null）を返すのは、入力が不正（非有限・安全率や台座幅が非正）な場合と、最低条件
 * 「重心が支持範囲内」（＋安全率・スリット内包）を満たせなかった場合。呼び出し側はこれを
 * baseCalculationFailed としてエラー表示へマッピングする。
 */
export function computeBase(
  centroid: Centroid,
  slot: SlotResult,
  params: AnalysisParameters,
  baseTopYMm: number,
): BaseResult | null {
  const { safetyFactor, baseWidthMm, slotWidthMm } = params;

  // 実寸(mm)座標での重心 X・差込口中心 X。以降の幾何はすべて mm で完結する。
  const centroidXMm = centroid.mm.x;
  const slotCenterXMm = slot.centerXMm;

  // 不正値を下流へ伝播させない。安全率は正でなければ「最小幅×安全率」が破綻する。
  if (
    !Number.isFinite(centroidXMm) ||
    !Number.isFinite(slotCenterXMm) ||
    !Number.isFinite(slotWidthMm) ||
    !Number.isFinite(baseWidthMm) ||
    !Number.isFinite(safetyFactor) ||
    !Number.isFinite(baseTopYMm) ||
    !Number.isFinite(slot.tabDepthMm) ||
    safetyFactor <= 0 ||
    baseWidthMm <= 0
  ) {
    return null;
  }

  // 重心の差込口中心からの水平ずれ。台座を対称に取るとき、片側がこれを覆えば
  // 反対側は自動的に覆われるため、支持幅の必要量はこの片側ずれで決まる。
  const offsetMm = Math.abs(centroidXMm - slotCenterXMm);

  // 必要幅：最低条件（重心が支持範囲内＝幅 2×offset）に安全率を掛けたもの。加えて
  // スリットを内包できるよう差込口幅を下限に取る（切り欠きが台座からはみ出さない床）。
  const requiredWidthMm = Math.max(2 * offsetMm * safetyFactor, slotWidthMm);

  // 台座幅はユーザー指定値そのもの。必要幅に届かない指定は自立を保証できないため、
  // 黙って広げず台座計算不可として返し、UI で台座幅・オフセットの見直しを促す。
  if (baseWidthMm < requiredWidthMm) {
    return null;
  }

  const widthMm = baseWidthMm;
  const halfWidthMm = widthMm / 2;

  const supportLeftMm = slotCenterXMm - halfWidthMm;
  const supportRightMm = slotCenterXMm + halfWidthMm;

  // 重心高さは台座上面（接地面）から測る。カットライン余白・持ち上げ量で接地面は
  // 画像下端から動くため、baseTopYMm を基準に取る（Y は下方向 + なので差の符号に注意）。
  const centroidHeightMm = Math.max(0, baseTopYMm - centroid.mm.y);

  // 奥行の床をツメ深さの SLOT_WALL_FACTOR 倍に取ることで、ツメ（深さ＝板厚）が台座を
  // 貫通しないこと（ツメ深さ ≦ 台座奥行）が構成的に保証される。
  const depthMm = Math.max(
    2 * centroidHeightMm * DEPTH_ANGLE_TAN,
    slot.tabDepthMm * SLOT_WALL_FACTOR,
  );

  return {
    widthMm,
    depthMm,
    topYMm: baseTopYMm,
    supportLeftMm,
    supportRightMm,
  };
}
