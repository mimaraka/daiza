// 解析結果一覧。
//
// AnalysisResult を「項目名：値」の一覧として提示するだけの presentational
// コンポーネント。計算は一切行わず、確定済みの結果を整形表示するのみ。
// 結果が無い（未解析・失敗）場合は各値をプレースホルダ（—）で表示する。

import { CircleAlert } from 'lucide-react';

import { RECOMMENDED_DPI } from '@/analysis/scale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { AnalysisResult, BaseShape } from '@/model/types';

export interface ResultPanelProps {
  /** 直近の解析結果。未解析・失敗時は null。 */
  result: AnalysisResult | null;
}

/** 未確定値のプレースホルダ。全項目で共通化して表記を揃える。 */
const PLACEHOLDER = '—';

/** 台座形状の表示名（LeftPanel のセレクタと同じ語彙を使う）。 */
const BASE_SHAPE_LABELS: Record<BaseShape, string> = {
  rect: '矩形',
  roundedRect: '角丸矩形',
  circle: '円形',
  ellipse: '楕円',
  polygon: '正多角形',
  custom: '任意形状',
};

/** 8 方位のラベル。方位角は右 0°・前 90°・左 180°・後 270°（SPEC「最小転倒角」）。 */
const AZIMUTH_LABELS = ['右', '右前', '前', '左前', '左', '左後', '後', '右後'] as const;

/**
 * 方位角(度)を「135°（左前）」の形へ整える。
 * 45° 刻みの 8 方位へ最近傍で丸めた目安ラベルを添える（正確な角度は数値で示す）。
 */
function formatAzimuth(azimuthDeg: number): string {
  const normalized = ((azimuthDeg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return `${normalized.toFixed(0)}°（${AZIMUTH_LABELS[index]}）`;
}

/** 結果一覧の 1 行分（項目名と表示値）。 */
interface ResultRow {
  label: string;
  value: string;
  /**
   * 値が推奨範囲を外れている場合の注意文。
   * 解析は成立している（＝エラーではない）ため、項目名の隣に注意アイコンで添えるだけに留める。
   */
  warning?: string;
}

/**
 * 結果オブジェクトを表示用の行データへ変換する。
 * 表示整形（桁数・単位）はここに集約し、JSX 側は並べるだけにする。
 */
function buildRows(result: AnalysisResult | null): ResultRow[] {
  // 数値の丸めと単位付与を一箇所に集約する。null の場合は必ず PLACEHOLDER。
  const num = (value: number | undefined, unit: string, digits = 1): string =>
    value === undefined ? PLACEHOLDER : `${value.toFixed(digits)} ${unit}`;

  return [
    {
      label: '画像サイズ',
      value: result ? `${result.imageSize.width} × ${result.imageSize.height} px` : PLACEHOLDER,
    },
    {
      label: '実寸',
      value: result
        ? `${result.physicalSize.width.toFixed(1)} × ${result.physicalSize.height.toFixed(1)} mm`
        : PLACEHOLDER,
    },
    // 絵柄の画素密度。実寸（＝フィギュア高さ指定）に対して画像の解像度が足りているかを
    // 印刷業界で馴染みのある単位で示す。小数は判断に寄与しないため整数で丸める。
    // 推奨値を下回るときは、印刷すると絵柄が粗くなることに気付けるよう警告を添える。
    {
      label: '画像解像度',
      value: num(result?.dpi, 'dpi', 0),
      // exactOptionalPropertyTypes 下では undefined を直接代入できないため、条件付きで生やす。
      ...(result !== null && result.dpi < RECOMMENDED_DPI
        ? { warning: `推奨解像度 (${RECOMMENDED_DPI}dpi) を下回っています` }
        : {}),
    },
    {
      label: '重心座標',
      value: result
        ? `(${result.centroid.mm.x.toFixed(1)}, ${result.centroid.mm.y.toFixed(1)}) mm`
        : PLACEHOLDER,
    },
    { label: '差込口中心', value: num(result?.slot.centerXMm, 'mm') },
    { label: '差込口幅', value: num(result?.slot.widthMm, 'mm') },
    { label: '台座形状', value: result ? BASE_SHAPE_LABELS[result.base.shape] : PLACEHOLDER },
    // 台座幅・奥行は footprint のバウンディングボックス実寸（円形では直径×直径。SPEC）。
    { label: '台座幅', value: num(result?.base.widthMm, 'mm') },
    { label: '台座奥行', value: num(result?.base.depthMm, 'mm') },
    {
      label: '転倒角（左）',
      value: num(result?.stability.tippingAngleLeftDeg, '°'),
    },
    {
      label: '転倒角（右）',
      value: num(result?.stability.tippingAngleRightDeg, '°'),
    },
    {
      label: '転倒角（前）',
      value: num(result?.stability.tippingAngleFrontDeg, '°'),
    },
    {
      label: '転倒角（後）',
      value: num(result?.stability.tippingAngleBackDeg, '°'),
    },
    // 全方位で最も倒れやすい方向。正多角形・任意形状では斜めになり得るため、4 方向だけでは
    // 見落とす（矩形・円・楕円では 4 方向の最小と一致する）。
    {
      label: '転倒角（最小）',
      value: result
        ? `${result.stability.tippingAngleMinDeg.toFixed(1)} ° / ${formatAzimuth(result.stability.worstAzimuthDeg)}`
        : PLACEHOLDER,
    },
  ];
}

export function ResultPanel({ result }: ResultPanelProps) {
  const rows = buildRows(result);

  return (
    <Card>
      <CardHeader>
        <CardTitle>解析結果</CardTitle>
      </CardHeader>
      <CardContent>
        {/* 広幅では右列（縦長・幅の狭い1カラム）に置かれるため lg 以上は1列へ戻す。
            狭幅で縦積みになるときだけ2列にして、縦方向の間延びを抑える。 */}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-1">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-baseline justify-between gap-2 border-b py-1 last:border-b-0"
            >
              <dt className="text-muted-foreground flex items-center gap-1 text-sm">
                {row.label}
                {row.warning !== undefined && (
                  <Tooltip>
                    {/* Trigger は button なのでホバーだけでなくキーボードフォーカスでも開く。
                        アイコン単体では読み上げ名を持たないため aria-label に注意文を持たせる。 */}
                    <TooltipTrigger
                      aria-label={row.warning}
                      className="focus-visible:ring-ring/50 rounded-full text-amber-600 outline-none focus-visible:ring-[3px] dark:text-amber-500"
                    >
                      <CircleAlert className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{row.warning}</TooltipContent>
                  </Tooltip>
                )}
              </dt>
              <dd className="text-sm font-medium tabular-nums whitespace-nowrap">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
