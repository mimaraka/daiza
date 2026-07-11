// 左パネル：画像読み込み・各種パラメータ入力・エクスポート操作を配置する。
//
// このコンポーネントは「表示と入力の受け口」に徹する純粋な presentational
// コンポーネントであり、状態は保持しない。値と変更ハンドラはすべて props で
// 受け取り、解析・状態更新は上位（App / useAnalysis, TODO 13）へ委ねる。

import { useRef, useState } from 'react';

import { Download, ImagePlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { minNeckWidthMm, PARAMETER_CONSTRAINTS, PARAMETER_PRESETS } from '@/model/state';
import type { AnalysisParameters } from '@/model/types';

export interface LeftPanelProps {
  /** 現在のパラメータ値。 */
  parameters: AnalysisParameters;
  /** パラメータの部分更新を通知する（再解析トリガー）。 */
  onParametersChange: (parameters: Partial<AnalysisParameters>) => void;
  /** ユーザーが選択した PNG ファイルを通知する。未指定なら読み込みボタンは無効。 */
  onImageFile?: (file: File) => void;
  /** SVG エクスポートを要求する。結果が無い／未実装時は未指定で無効化される。 */
  onExportSvg?: () => void;
}

/**
 * 単位付きの数値入力フィールド。
 * ラベル・単位・制約（min/max/step）を一箇所で束ね、パラメータ間の見た目を揃える。
 */
interface NumberFieldProps {
  id: string;
  label: string;
  unit: string;
  value: number;
  constraint: { min: number; max: number; step: number };
  onValueChange: (value: number) => void;
  /** ラベルだけでは基準が伝わらないパラメータの補足（省略可）。 */
  hint?: string;
}

/** 単位付き数値入力の本体。プリセット選択の「カスタム」欄でも再利用する。 */
function UnitNumberInput({
  id,
  unit,
  value,
  constraint,
  onValueChange,
}: Omit<NumberFieldProps, 'label'>) {
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={constraint.min}
        max={constraint.max}
        step={constraint.step}
        value={value}
        // 空文字や不正入力では NaN になるため、数値化できた場合のみ反映する。
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          if (!Number.isNaN(next)) {
            onValueChange(next);
          }
        }}
      />
      <span className="text-muted-foreground w-8 shrink-0 text-sm">{unit}</span>
    </div>
  );
}

function NumberField({
  id,
  label,
  unit,
  value,
  constraint,
  onValueChange,
  hint,
}: NumberFieldProps) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <UnitNumberInput
        id={id}
        unit={unit}
        value={value}
        constraint={constraint}
        onValueChange={onValueChange}
      />
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** Select 内で「カスタム入力」を表す番兵値。数値プリセットと衝突しない文字列にする。 */
const CUSTOM_OPTION = 'custom';

interface PresetNumberFieldProps extends NumberFieldProps {
  /** 標準値の選択肢。ここに無い値は「カスタム」入力へフォールバックする。 */
  presets: readonly number[];
}

/**
 * 標準規格値をプルダウンで選びつつ、規格外の値も「カスタム」で入力できるフィールド。
 * 板厚・差込口幅のように一般的な規格値が決まっているパラメータ向け。
 */
function PresetNumberField({
  id,
  label,
  unit,
  value,
  presets,
  constraint,
  onValueChange,
}: PresetNumberFieldProps) {
  // 現在値がプリセットに無ければカスタム入力とみなす。ユーザーが明示的に「カスタム」を
  // 選んだ状態も保持したいため、選択状態は value から毎回導出せずローカルに持つ。
  const [isCustom, setIsCustom] = useState(() => !presets.includes(value));

  // Select の選択値：カスタムモードは番兵、それ以外は現在値の数値文字列。
  const selectValue = isCustom ? CUSTOM_OPTION : String(value);

  const handleSelect = (next: string) => {
    if (next === CUSTOM_OPTION) {
      // カスタムへ切り替え。値は直前のものを引き継ぎ、下部の入力欄で編集させる。
      setIsCustom(true);
      return;
    }
    setIsCustom(false);
    onValueChange(Number(next));
  };

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={selectValue} onValueChange={handleSelect}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {presets.map((preset) => (
            <SelectItem key={preset} value={String(preset)}>
              {preset}
              {unit}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_OPTION}>カスタム…</SelectItem>
        </SelectContent>
      </Select>
      {/* カスタム選択時のみ数値入力欄を表示する。 */}
      {isCustom && (
        <UnitNumberInput
          id={`${id}-custom`}
          unit={unit}
          value={value}
          constraint={constraint}
          onValueChange={onValueChange}
        />
      )}
    </div>
  );
}

export function LeftPanel({
  parameters,
  onParametersChange,
  onImageFile,
  onExportSvg,
}: LeftPanelProps) {
  const smoothing = PARAMETER_CONSTRAINTS.cutLineSmoothing;
  // 首部幅の下限は差込口幅に連動する（肩が消えないための不変条件）。入力側でも下限を
  // 差込口幅へ追従させ、そもそも制約を割る値を入れられないようにする（状態側の
  // normalizeParameters が最終的な番人）。
  const neckWidth = {
    ...PARAMETER_CONSTRAINTS.neckWidthMm,
    min: minNeckWidthMm(parameters.slotWidthMm),
  };
  // ネイティブのファイル選択ダイアログは非表示 input を経由して開く。
  // 見た目は shadcn の Button に統一し、input 自体は UI から隠す。
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>画像</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                onImageFile?.(file);
              }
              // 同じファイルを再選択しても onChange が発火するよう値をリセットする。
              event.target.value = '';
            }}
          />
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={!onImageFile}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus />
            PNGを読み込む
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>パラメータ</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <NumberField
            id="figure-height"
            label="フィギュア高さ"
            unit="mm"
            value={parameters.figureHeightMm}
            constraint={PARAMETER_CONSTRAINTS.figureHeightMm}
            onValueChange={(figureHeightMm) => onParametersChange({ figureHeightMm })}
            hint="接地面（台座の底面）からカットライン（絵柄＋余白）の上端までの全高。"
          />
          <PresetNumberField
            id="thickness"
            label="板厚"
            unit="mm"
            value={parameters.thicknessMm}
            presets={PARAMETER_PRESETS.thicknessMm}
            constraint={PARAMETER_CONSTRAINTS.thicknessMm}
            onValueChange={(thicknessMm) => onParametersChange({ thicknessMm })}
          />
          <NumberField
            id="cutline-margin"
            label="カットライン余白"
            unit="mm"
            value={parameters.cutLineMarginMm}
            constraint={PARAMETER_CONSTRAINTS.cutLineMarginMm}
            onValueChange={(cutLineMarginMm) => onParametersChange({ cutLineMarginMm })}
          />

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="cutline-smoothing">カットライン平滑化</Label>
              {/* 平滑化は整数の強さ。0=無効を明示するため現在値を併記する。 */}
              <span className="text-muted-foreground text-sm tabular-nums">
                {parameters.cutLineSmoothing}
              </span>
            </div>
            <Slider
              id="cutline-smoothing"
              min={smoothing.min}
              max={smoothing.max}
              step={smoothing.step}
              value={[parameters.cutLineSmoothing]}
              onValueChange={([cutLineSmoothing]) => {
                if (cutLineSmoothing !== undefined) {
                  onParametersChange({ cutLineSmoothing });
                }
              }}
            />
          </div>

          {/* 0 は隙間埋め無効。閾値より狭い隙間だけがアクリルで充填される。 */}
          <NumberField
            id="gap-fill-threshold"
            label="隙間埋め閾値（0=無効）"
            unit="mm"
            value={parameters.gapFillThresholdMm}
            constraint={PARAMETER_CONSTRAINTS.gapFillThresholdMm}
            onValueChange={(gapFillThresholdMm) => onParametersChange({ gapFillThresholdMm })}
          />

          <NumberField
            id="min-bridge-width"
            label="パーツ連結部の最小幅"
            unit="mm"
            value={parameters.minBridgeWidthMm}
            constraint={PARAMETER_CONSTRAINTS.minBridgeWidthMm}
            onValueChange={(minBridgeWidthMm) => onParametersChange({ minBridgeWidthMm })}
          />

          <NumberField
            id="slot-width"
            label="差込口幅"
            unit="mm"
            value={parameters.slotWidthMm}
            constraint={PARAMETER_CONSTRAINTS.slotWidthMm}
            onValueChange={(slotWidthMm) => onParametersChange({ slotWidthMm })}
          />
          <NumberField
            id="slot-offset"
            label="差込口オフセット（正=右／負=左）"
            unit="mm"
            value={parameters.slotOffsetMm}
            constraint={PARAMETER_CONSTRAINTS.slotOffsetMm}
            onValueChange={(slotOffsetMm) => onParametersChange({ slotOffsetMm })}
          />
          <NumberField
            id="neck-width"
            label={`首部幅（下限 ${neckWidth.min}mm）`}
            unit="mm"
            value={parameters.neckWidthMm}
            constraint={neckWidth}
            onValueChange={(neckWidthMm) => onParametersChange({ neckWidthMm })}
          />
          <NumberField
            id="plate-lift"
            label="アクリル板の持ち上げ量"
            unit="mm"
            value={parameters.plateLiftMm}
            constraint={PARAMETER_CONSTRAINTS.plateLiftMm}
            onValueChange={(plateLiftMm) => onParametersChange({ plateLiftMm })}
          />

          <NumberField
            id="base-width"
            label="台座幅"
            unit="mm"
            value={parameters.baseWidthMm}
            constraint={PARAMETER_CONSTRAINTS.baseWidthMm}
            onValueChange={(baseWidthMm) => onParametersChange({ baseWidthMm })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>エクスポート</CardTitle>
        </CardHeader>
        <CardContent>
          {/* SVG 生成（実寸座標系）は onExportSvg に委ねる。解析結果が無ければ無効。 */}
          <Button type="button" className="w-full" disabled={!onExportSvg} onClick={onExportSvg}>
            <Download />
            SVGをエクスポート
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
