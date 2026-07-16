// 解析結果一覧。
//
// AnalysisResult を「項目名：値」の一覧として提示するだけの presentational
// コンポーネント。計算は一切行わず、確定済みの結果を整形表示するのみ。
// 結果が無い（未解析・失敗）場合は各値をプレースホルダ（—）で表示する。

import { CircleAlert } from 'lucide-react';
import { useState } from 'react';

import { RECOMMENDED_DPI } from '@/analysis/scale';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation, type TranslationKey } from '@/locales';
import type { AnalysisResult, BaseShape, DesignMode } from '@/model/types';
import { formatAzimuth } from '@/utils/azimuth';

export interface ResultPanelProps {
  /** 直近の解析結果。未解析・失敗時は null。 */
  result: AnalysisResult | null;
  /** 現在のデザインモード。 */
  designMode?: DesignMode;
}

/** 未確定値のプレースホルダ。全項目で共通化して表記を揃える。 */
const PLACEHOLDER = '—';

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

function baseShapeLabel(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  shape: BaseShape,
): string {
  if (shape === 'custom') {
    return t('baseShape.customShort');
  }
  return t(`baseShape.${shape}` as TranslationKey);
}

/**
 * 結果オブジェクトを表示用の行データへ変換する。
 * 表示整形（桁数・単位）はここに集約し、JSX 側は並べるだけにする。
 */
function buildRows(
  result: AnalysisResult | null,
  designMode: DesignMode,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): ResultRow[] {
  // 数値の丸めと単位付与を一箇所に集約する。null の場合は必ず PLACEHOLDER。
  const num = (value: number | undefined, unit: string, digits = 1): string =>
    value === undefined ? PLACEHOLDER : `${value.toFixed(digits)} ${unit}`;

  const commonRows: ResultRow[] = [
    {
      label: t('result.imageSize'),
      value: result ? `${result.imageSize.width} × ${result.imageSize.height} px` : PLACEHOLDER,
    },
    {
      label: t('result.physicalSize'),
      value: result
        ? `${result.physicalSize.width.toFixed(1)} × ${result.physicalSize.height.toFixed(1)} mm`
        : PLACEHOLDER,
    },
    {
      label: t('result.dpi'),
      value: num(result?.dpi, 'dpi', 0),
      ...(result !== null && result.dpi < RECOMMENDED_DPI
        ? { warning: t('result.dpiWarning', { dpi: RECOMMENDED_DPI }) }
        : {}),
    },
    {
      label: t('result.centroid'),
      value: result
        ? `(${result.centroid.mm.x.toFixed(1)}, ${result.centroid.mm.y.toFixed(1)}) mm`
        : PLACEHOLDER,
    },
  ];

  if (designMode === 'keychain') {
    const keychain = result?.keychain;
    return [
      ...commonRows,
      {
        label: t('result.keychainHoleDiameter'),
        value: keychain ? `${(keychain.holeRadiusMm * 2).toFixed(1)} mm` : PLACEHOLDER,
      },
      {
        label: t('result.keychainHoleCenter'),
        value: keychain
          ? `(${keychain.holeCenterMm.x.toFixed(1)}, ${keychain.holeCenterMm.y.toFixed(1)}) mm`
          : PLACEHOLDER,
      },
      {
        label: t('result.keychainRotation'),
        value: keychain ? `${keychain.rotationDeg.toFixed(1)} °` : PLACEHOLDER,
      },
    ];
  }

  return [
    ...commonRows,
    { label: t('result.slotCenter'), value: num(result?.slot?.centerXMm, 'mm') },
    { label: t('result.slotWidth'), value: num(result?.slot?.widthMm, 'mm') },
    {
      label: t('result.baseShape'),
      value: result && result.base ? baseShapeLabel(t, result.base.shape) : PLACEHOLDER,
    },
    { label: t('result.baseWidth'), value: num(result?.base?.widthMm, 'mm') },
    { label: t('result.baseDepth'), value: num(result?.base?.depthMm, 'mm') },
    {
      label: t('result.tippingAngleLeft'),
      value: num(result?.stability?.tippingAngleLeftDeg, '°'),
    },
    {
      label: t('result.tippingAngleRight'),
      value: num(result?.stability?.tippingAngleRightDeg, '°'),
    },
    {
      label: t('result.tippingAngleFront'),
      value: num(result?.stability?.tippingAngleFrontDeg, '°'),
    },
    {
      label: t('result.tippingAngleBack'),
      value: num(result?.stability?.tippingAngleBackDeg, '°'),
    },
    {
      label: t('result.tippingAngleMin'),
      value: result && result.stability
        ? `${result.stability.tippingAngleMinDeg.toFixed(1)} ° / ${formatAzimuth(result.stability.worstAzimuthDeg)}`
        : PLACEHOLDER,
    },
  ];
}

/**
 * 推奨範囲外を知らせる注意アイコン＋ツールチップ。
 *
 * Radix の Tooltip はホバー／フォーカスで開くため、ホバーが発火しないタッチ端末
 * （スマートフォン・タブレット）ではアイコンをタップしても開かない。そこで open を
 * 制御し、タップ（クリック）でトグルできるようにする。マウス環境ではホバーで開く
 * 従来挙動を onOpenChange 経由でそのまま維持する。
 */
function WarningIndicator({ message }: { message: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      {/* Trigger は button なのでホバーだけでなくキーボードフォーカスでも開く。
          アイコン単体では読み上げ名を持たないため aria-label に注意文を持たせる。 */}
      <TooltipTrigger
        aria-label={message}
        // タップ端末向け：ホバーが無い環境ではこのトグルが唯一の開閉手段になる。
        onClick={() => setOpen((prev) => !prev)}
        className="focus-visible:ring-ring/50 rounded-full text-amber-600 outline-none focus-visible:ring-[3px] dark:text-amber-500"
      >
        <CircleAlert className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  );
}

export function ResultPanel({ result, designMode = 'baseFigure' }: ResultPanelProps) {
  const { t } = useTranslation();
  const rows = buildRows(result, designMode, t);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('resultPanel.title')}</CardTitle>
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
                {row.warning !== undefined && <WarningIndicator message={row.warning} />}
              </dt>
              <dd className="text-sm font-medium tabular-nums whitespace-nowrap">{row.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
