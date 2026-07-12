// 解析結果一覧。
//
// AnalysisResult を「項目名：値」の一覧として提示するだけの presentational
// コンポーネント。計算は一切行わず、確定済みの結果を整形表示するのみ。
// 結果が無い（未解析・失敗）場合は各値をプレースホルダ（—）で表示する。

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AnalysisResult } from '@/model/types';

export interface ResultPanelProps {
  /** 直近の解析結果。未解析・失敗時は null。 */
  result: AnalysisResult | null;
}

/** 未確定値のプレースホルダ。全項目で共通化して表記を揃える。 */
const PLACEHOLDER = '—';

/** 結果一覧の 1 行分（項目名と表示値）。 */
interface ResultRow {
  label: string;
  value: string;
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
    { label: '画像解像度', value: num(result?.dpi, 'dpi', 0) },
    {
      label: '重心座標',
      value: result
        ? `(${result.centroid.mm.x.toFixed(1)}, ${result.centroid.mm.y.toFixed(1)}) mm`
        : PLACEHOLDER,
    },
    { label: '差込口中心', value: num(result?.slot.centerXMm, 'mm') },
    { label: '差込口幅', value: num(result?.slot.widthMm, 'mm') },
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
              <dt className="text-muted-foreground text-sm">{row.label}</dt>
              <dd className="text-sm font-medium tabular-nums whitespace-nowrap">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
