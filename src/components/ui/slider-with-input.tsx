'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';

/** スライダー内部の浮動小数を step の桁に丸め、min/max の範囲に収める。 */
function snapToStep(
  value: number,
  constraint: { min: number; max?: number; step: number },
): number {
  const { min, max = Number.POSITIVE_INFINITY, step } = constraint;
  const decimals = step.toString().split('.')[1]?.length ?? 0;
  const snapped = Math.round(value / step) * step;
  const rounded = Number(snapped.toFixed(decimals));
  return Math.min(Math.max(rounded, min), max);
}

/** 入力欄・現在値表示用。step に応じた桁数で、不要な末尾 0 は省く。 */
function formatSliderValue(value: number, step: number): string {
  const decimals = step.toString().split('.')[1]?.length ?? 0;
  return Number(value.toFixed(decimals)).toString();
}

interface SliderWithInputProps {
  id: string;
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

/**
 * スライダーと同期する小型数値入力欄を 1 つのコンポーネントにまとめる。
 * 入力欄はスライダーの左に配置し、どちらから操作しても双方向に反映する。
 */
function SliderWithInput({
  id,
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: SliderWithInputProps) {
  const displayValue = formatSliderValue(value, step);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.valueAsNumber;
    if (!Number.isNaN(next)) {
      onChange(snapToStep(next, { min, max, step }));
    }
  };

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={displayValue}
          onChange={handleInputChange}
          className="h-8 w-20 shrink-0"
        />
        {unit && <span className="text-muted-foreground w-5 shrink-0 text-sm">{unit}</span>}
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={([next]) => {
            if (next !== undefined) {
              onChange(snapToStep(next, { min, max, step }));
            }
          }}
          className="flex-1"
        />
      </div>
    </div>
  );
}

export { SliderWithInput };
