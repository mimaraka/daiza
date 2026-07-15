// 左パネル：画像読み込みと各種パラメータ入力を配置する。
// エクスポート操作は解析結果があって初めて意味を持つため、右列（ExportPanel）に置く。
//
// このコンポーネントは「表示と入力の受け口」に徹する純粋な presentational
// コンポーネントであり、状態は保持しない。値と変更ハンドラはすべて props で
// 受け取り、解析・状態更新は上位（App / useAnalysis, TODO 13）へ委ねる。

import { useMemo, useRef, useState, type ReactNode } from 'react';

import { ImagePlus, Shapes } from 'lucide-react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useTranslation } from '@/locales';
import {
  maxCornerRadiusMm,
  minNeckWidthMm,
  PARAMETER_CONSTRAINTS,
  PARAMETER_PRESETS,
  type ParameterConstraint,
} from '@/model/state';
import type { AnalysisParameters, BaseShape, BaseShapeSource, FigureImage } from '@/model/types';

/**
 * パラメータのカテゴリ（アコーディオンのセクション）。パラメータは十数個あり
 * 平坦に並べると目的の項目を探しづらいため、「どの部品を決める値か」で束ねる。
 * 既定はすべて開いた状態（初見で全項目が見えることを優先し、折りたたみは任意）。
 */
const PARAMETER_SECTIONS = ['acrylic', 'slot', 'neck', 'base'] as const;

export interface LeftPanelProps {
  /** 現在のパラメータ値。 */
  parameters: AnalysisParameters;
  /** パラメータの部分更新を通知する（再解析トリガー）。 */
  onParametersChange: (parameters: Partial<AnalysisParameters>) => void;
  /** ユーザーが選択した PNG ファイルを通知する。未指定なら読み込みボタンは無効。 */
  onImageFile?: (file: File) => void;
  /** 背面アクリル板用に読み込んだ画像。未読込なら null。 */
  backImage?: FigureImage | null;
  /** ユーザーが選択した背面画像ファイルを通知する。 */
  onBackImageFile?: (file: File) => void;
  /** 読み込み済みの台座形状ソース（任意形状）。未読込なら null。 */
  baseShapeSource?: BaseShapeSource | null;
  /** ユーザーが選択した台座形状ソース（PNG / SVG）を通知する。 */
  onBaseShapeFile?: (file: File) => void;
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
  constraint: ParameterConstraint;
  onValueChange: (value: number) => void;
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
        // 上限を持たないパラメータ（constraint.max 省略）では max 属性ごと出さず、頭打ちを作らない。
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

function NumberField({ id, label, unit, value, constraint, onValueChange }: NumberFieldProps) {
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
  const { t } = useTranslation();

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
          <SelectItem value={CUSTOM_OPTION}>{t('leftPanel.custom')}</SelectItem>
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

/** パラメータのカテゴリ 1 つ。見出しと、その配下のフィールド群の縦並びを束ねる。 */
function ParameterSection({
  value,
  title,
  children,
}: {
  value: (typeof PARAMETER_SECTIONS)[number];
  title: string;
  children: ReactNode;
}) {
  return (
    <AccordionItem value={value}>
      {/* 見出しの上下・最終フィールドと区切り線の間を既定より広げ、隣接カテゴリの
          フィールドどうしが地続きに見えないようにする（境目をはっきりさせる）。 */}
      <AccordionTrigger className="py-5">{title}</AccordionTrigger>
      <AccordionContent className="grid gap-4 pb-7">{children}</AccordionContent>
    </AccordionItem>
  );
}

export function LeftPanel({
  parameters,
  onParametersChange,
  onImageFile,
  backImage,
  onBackImageFile,
  baseShapeSource,
  onBaseShapeFile,
}: LeftPanelProps) {
  const { t } = useTranslation();

  /** 台座形状の選択肢（UI の表示順・ラベル）。既定は矩形。 */
  const baseShapeOptions = useMemo<readonly { value: BaseShape; label: string }[]>(
    () => [
      { value: 'rect', label: t('baseShape.rect') },
      { value: 'roundedRect', label: t('baseShape.roundedRect') },
      { value: 'circle', label: t('baseShape.circle') },
      { value: 'ellipse', label: t('baseShape.ellipse') },
      { value: 'polygon', label: t('baseShape.polygon') },
      { value: 'custom', label: t('baseShape.custom') },
    ],
    [t],
  );

  const smoothing = PARAMETER_CONSTRAINTS.cutLineSmoothing;
  const alphaThreshold = PARAMETER_CONSTRAINTS.alphaThreshold;
  // 首部幅の下限は差込口幅に連動する（肩が消えないための不変条件）。入力側でも下限を
  // 差込口幅へ追従させ、そもそも制約を割る値を入れられないようにする（状態側の
  // normalizeParameters が最終的な番人）。上限は持たない（PARAMETER_CONSTRAINTS 参照）。
  const neckWidth: ParameterConstraint = {
    ...PARAMETER_CONSTRAINTS.neckWidthMm,
    min: minNeckWidthMm(parameters.slotWidthMm),
  };
  // 角丸半径の上限は台座幅・奥行に連動する（min(幅, 奥行)/2 を超えると角丸同士が重なる）。
  // 入力側でも上限を追従させ、そもそも破れる値を入れられないようにする（状態側の
  // normalizeParameters が最終的な番人）。
  const cornerRadius: ParameterConstraint = {
    ...PARAMETER_CONSTRAINTS.baseCornerRadiusMm,
    max: Math.min(
      PARAMETER_CONSTRAINTS.baseCornerRadiusMm.max,
      maxCornerRadiusMm(parameters.baseWidthMm, parameters.baseDepthMm),
    ),
  };
  // 形状ごとに使う寸法だけを出す（SPEC「選択中の形状に該当するパラメータ欄だけを表示」）。
  const shape = parameters.baseShape;
  const usesWidthDepth =
    shape === 'rect' || shape === 'roundedRect' || shape === 'ellipse' || shape === 'custom';
  const usesDiameter = shape === 'circle' || shape === 'polygon';

  // ネイティブのファイル選択ダイアログは非表示 input を経由して開く。
  // 見た目は shadcn の Button に統一し、input 自体は UI から隠す。
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backImageFileRef = useRef<HTMLInputElement>(null);
  const baseShapeFileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('leftPanel.imageCardTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
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
            {t('leftPanel.loadImage')}
          </Button>

          {/* 両面アクリル：前面画像の次に置き、ON のときだけ背面画像を読み込める。 */}
          <div className="flex items-start gap-2">
            <Checkbox
              id="show-back-plate"
              checked={parameters.showBackPlate}
              onCheckedChange={(checked) =>
                onParametersChange({ showBackPlate: checked === true })
              }
            />
            <Label htmlFor="show-back-plate" className="font-normal leading-none">
              {t('leftPanel.doubleSidedAcrylic')}
            </Label>
          </div>

          {parameters.showBackPlate && (
            <div className="grid gap-2">
              <input
                ref={backImageFileRef}
                type="file"
                accept="image/png"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    onBackImageFile?.(file);
                  }
                  event.target.value = '';
                }}
              />
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={!onBackImageFile}
                onClick={() => backImageFileRef.current?.click()}
              >
                <ImagePlus />
                {t('leftPanel.loadBackImage')}
              </Button>
              <p className="text-muted-foreground truncate text-xs">
                {backImage ? backImage.fileName : t('leftPanel.backImageNotLoaded')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('leftPanel.parametersCardTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* 決める部品ごとにカテゴリへ束ねる（type="multiple" ＝ 複数同時に開ける）。
              既定値ですべて開いておくので、折りたたみは「今いじらない分類を畳む」任意操作。 */}
          <Accordion type="multiple" defaultValue={[...PARAMETER_SECTIONS]}>
            {/* アクリル板：不透明判定・スケール・カットラインの形そのものを決める段。 */}
            <ParameterSection value="acrylic" title={t('leftPanel.section.acrylic')}>
              {/* 不透明領域の判定そのものを決める最上流のパラメータなので先頭に置く。 */}
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="alpha-threshold">{t('leftPanel.alphaThreshold')}</Label>
                  {/* 0=既定（α>0 をすべて不透明）を明示するため現在値を併記する。 */}
                  <span className="text-muted-foreground text-sm tabular-nums">
                    {parameters.alphaThreshold.toFixed(2)}
                  </span>
                </div>
                <Slider
                  id="alpha-threshold"
                  min={alphaThreshold.min}
                  max={alphaThreshold.max}
                  step={alphaThreshold.step}
                  value={[parameters.alphaThreshold]}
                  onValueChange={([next]) => {
                    if (next !== undefined) {
                      // スライダーの内部計算で 0.30000000000000004 のような値が出るため、
                      // step の桁（0.01）へ丸めてから状態・解析メモの鍵に載せる。
                      onParametersChange({ alphaThreshold: Math.round(next * 100) / 100 });
                    }
                  }}
                />
              </div>

              <NumberField
                id="figure-height"
                label={t('leftPanel.figureHeight')}
                unit="mm"
                value={parameters.figureHeightMm}
                constraint={PARAMETER_CONSTRAINTS.figureHeightMm}
                onValueChange={(figureHeightMm) => onParametersChange({ figureHeightMm })}
              />
              <PresetNumberField
                id="thickness"
                label={t('leftPanel.thickness')}
                unit="mm"
                value={parameters.thicknessMm}
                presets={PARAMETER_PRESETS.thicknessMm}
                constraint={PARAMETER_CONSTRAINTS.thicknessMm}
                onValueChange={(thicknessMm) => onParametersChange({ thicknessMm })}
              />
              <NumberField
                id="cutline-margin"
                label={t('leftPanel.cutLineMargin')}
                unit="mm"
                value={parameters.cutLineMarginMm}
                constraint={PARAMETER_CONSTRAINTS.cutLineMarginMm}
                onValueChange={(cutLineMarginMm) => onParametersChange({ cutLineMarginMm })}
              />

              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="cutline-smoothing">{t('leftPanel.cutLineSmoothing')}</Label>
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
                label={t('leftPanel.gapFillThreshold')}
                unit="mm"
                value={parameters.gapFillThresholdMm}
                constraint={PARAMETER_CONSTRAINTS.gapFillThresholdMm}
                onValueChange={(gapFillThresholdMm) => onParametersChange({ gapFillThresholdMm })}
              />

              <NumberField
                id="min-bridge-width"
                label={t('leftPanel.minBridgeWidth')}
                unit="mm"
                value={parameters.minBridgeWidthMm}
                constraint={PARAMETER_CONSTRAINTS.minBridgeWidthMm}
                onValueChange={(minBridgeWidthMm) => onParametersChange({ minBridgeWidthMm })}
              />
            </ParameterSection>

            {/* 差込口：台座スリットへ挿す「ツメ」の寸法と位置。 */}
            <ParameterSection value="slot" title={t('leftPanel.section.slot')}>
              <NumberField
                id="slot-width"
                label={t('leftPanel.slotWidth')}
                unit="mm"
                value={parameters.slotWidthMm}
                constraint={PARAMETER_CONSTRAINTS.slotWidthMm}
                onValueChange={(slotWidthMm) => onParametersChange({ slotWidthMm })}
              />
              <NumberField
                id="slot-offset"
                label={t('leftPanel.slotOffset')}
                unit="mm"
                value={parameters.slotOffsetMm}
                constraint={PARAMETER_CONSTRAINTS.slotOffsetMm}
                onValueChange={(slotOffsetMm) => onParametersChange({ slotOffsetMm })}
              />
              <NumberField
                id="slot-depth-offset"
                label={t('leftPanel.slotDepthOffset')}
                unit="mm"
                value={parameters.slotDepthOffsetMm}
                constraint={PARAMETER_CONSTRAINTS.slotDepthOffsetMm}
                onValueChange={(slotDepthOffsetMm) => onParametersChange({ slotDepthOffsetMm })}
              />
            </ParameterSection>

            {/* 首部：板と台座上面の間を埋める段。持ち上げ量は板の浮き＝首部の高さそのものなので
                （台座上面 Y = カットライン最下端 + 持ち上げ量）、アクリル板ではなくここに置く。 */}
            <ParameterSection value="neck" title={t('leftPanel.section.neck')}>
              <NumberField
                id="neck-width"
                label={t('leftPanel.neckWidth', { min: neckWidth.min })}
                unit="mm"
                value={parameters.neckWidthMm}
                constraint={neckWidth}
                onValueChange={(neckWidthMm) => onParametersChange({ neckWidthMm })}
              />
              <NumberField
                id="plate-lift"
                label={t('leftPanel.plateLift')}
                unit="mm"
                value={parameters.plateLiftMm}
                constraint={PARAMETER_CONSTRAINTS.plateLiftMm}
                onValueChange={(plateLiftMm) => onParametersChange({ plateLiftMm })}
              />
            </ParameterSection>

            {/* 台座：形状とその寸法。 */}
            <ParameterSection value="base" title={t('leftPanel.section.base')}>
              {/* 台座形状。表示のみの切替ではなく解析パラメータであり、成立検査・転倒角・
                  プレビュー・3D・エクスポートのすべてが選んだ形状に追従する（SPEC「台座形状」）。 */}
              <div className="grid gap-1.5">
                <Label htmlFor="base-shape">{t('leftPanel.baseShape')}</Label>
                <Select
                  value={shape}
                  onValueChange={(next) => onParametersChange({ baseShape: next as BaseShape })}
                >
                  <SelectTrigger id="base-shape" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {baseShapeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* 任意形状のソース。プレビューへのドラッグ＆ドロップはフィギュア画像に予約済みなので、
                  ここではファイル選択のみを提供する（SPEC「台座形状ソース」）。 */}
              {shape === 'custom' && (
                <div className="grid gap-1.5">
                  <Label>{t('leftPanel.baseShapeSource')}</Label>
                  <input
                    ref={baseShapeFileRef}
                    type="file"
                    accept="image/png,image/svg+xml,.png,.svg"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        onBaseShapeFile?.(file);
                      }
                      // 同じファイルを選び直しても change が発火するよう選択状態を空へ戻す。
                      event.target.value = '';
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!onBaseShapeFile}
                    onClick={() => baseShapeFileRef.current?.click()}
                  >
                    <Shapes />
                    {t('leftPanel.loadBaseShapeSource')}
                  </Button>
                  <p className="text-muted-foreground truncate text-xs">
                    {baseShapeSource ? baseShapeSource.fileName : t('leftPanel.baseShapeNotLoaded')}
                  </p>
                </div>
              )}

              {usesWidthDepth && (
                <NumberField
                  id="base-width"
                  label={t(
                    shape === 'ellipse' ? 'leftPanel.baseWidthEllipse' : 'leftPanel.baseWidth',
                  )}
                  unit="mm"
                  value={parameters.baseWidthMm}
                  constraint={PARAMETER_CONSTRAINTS.baseWidthMm}
                  onValueChange={(baseWidthMm) => onParametersChange({ baseWidthMm })}
                />
              )}
              {usesWidthDepth && (
                <NumberField
                  id="base-depth"
                  label={t(
                    shape === 'ellipse' ? 'leftPanel.baseDepthEllipse' : 'leftPanel.baseDepth',
                  )}
                  unit="mm"
                  value={parameters.baseDepthMm}
                  constraint={PARAMETER_CONSTRAINTS.baseDepthMm}
                  onValueChange={(baseDepthMm) => onParametersChange({ baseDepthMm })}
                />
              )}
              {shape === 'roundedRect' && (
                <NumberField
                  id="base-corner-radius"
                  label={t('leftPanel.cornerRadius', { max: cornerRadius.max ?? 0 })}
                  unit="mm"
                  value={parameters.baseCornerRadiusMm}
                  constraint={cornerRadius}
                  onValueChange={(baseCornerRadiusMm) => onParametersChange({ baseCornerRadiusMm })}
                />
              )}
              {usesDiameter && (
                <NumberField
                  id="base-diameter"
                  label={t(
                    shape === 'polygon'
                      ? 'leftPanel.baseDiameterPolygon'
                      : 'leftPanel.baseDiameter',
                  )}
                  unit="mm"
                  value={parameters.baseDiameterMm}
                  constraint={PARAMETER_CONSTRAINTS.baseDiameterMm}
                  onValueChange={(baseDiameterMm) => onParametersChange({ baseDiameterMm })}
                />
              )}
              {shape === 'polygon' && (
                <NumberField
                  id="base-polygon-sides"
                  label={t('leftPanel.polygonSides')}
                  unit=""
                  value={parameters.basePolygonSides}
                  constraint={PARAMETER_CONSTRAINTS.basePolygonSides}
                  onValueChange={(basePolygonSides) => onParametersChange({ basePolygonSides })}
                />
              )}
              {shape === 'polygon' && (
                <NumberField
                  id="base-polygon-rotation"
                  label={t('leftPanel.polygonRotation')}
                  unit="°"
                  value={parameters.basePolygonRotationDeg}
                  constraint={PARAMETER_CONSTRAINTS.basePolygonRotationDeg}
                  onValueChange={(basePolygonRotationDeg) =>
                    onParametersChange({ basePolygonRotationDeg })
                  }
                />
              )}
            </ParameterSection>
          </Accordion>
        </CardContent>
      </Card>
    </div>
  );
}
