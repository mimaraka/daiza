// エクスポート操作パネル。
//
// 解析結果を成果物（実寸座標系の SVG / Adobe Illustrator ドキュメント）として書き出す
// 操作だけを持つ。解析結果があって初めて意味を持つ操作なので、右列の解析結果パネルの
// 直下に置く。状態は保持せず、生成・ダウンロードは上位（App）に委ねる presentational
// コンポーネント。

import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export interface ExportPanelProps {
  /** SVG エクスポートを要求する。結果が無い場合は未指定で無効化される。 */
  onExportSvg?: () => void;
  /** Illustrator（.ai）エクスポートを要求する。結果が無い場合は未指定で無効化される。 */
  onExportAi?: () => void;
  /** SVG に絵柄画像を埋め込むか（.ai は常に埋め込むため対象外）。 */
  embedImageInSvg: boolean;
  onEmbedImageInSvgChange: (value: boolean) => void;
  /** 生成中。大きな画像では PNG 化に時間がかかるため、その間は操作を止める。 */
  exporting?: boolean;
}

export function ExportPanel({
  onExportSvg,
  onExportAi,
  embedImageInSvg,
  onEmbedImageInSvgChange,
  exporting = false,
}: ExportPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>エクスポート</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* SVG 生成（実寸座標系）は onExportSvg に委ねる。解析結果が無ければ無効。 */}
        <Button
          type="button"
          className="w-full"
          disabled={!onExportSvg || exporting}
          onClick={onExportSvg}
        >
          <Download />
          SVGをエクスポート
        </Button>

        {/* SVG は線データのみが既定。絵柄が要る場合だけ画像を埋め込む（ファイルは重くなる）。 */}
        <div className="flex items-center gap-2">
          <Checkbox
            id="embed-image-in-svg"
            checked={embedImageInSvg}
            onCheckedChange={(checked) => onEmbedImageInSvgChange(checked === true)}
            disabled={exporting}
          />
          <Label htmlFor="embed-image-in-svg" className="text-muted-foreground text-sm font-normal">
            SVGに絵柄画像を含める
          </Label>
        </div>

        {/* .ai は「絵柄付きのアウトライン」を得るための出力なので、画像を常に含める。 */}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!onExportAi || exporting}
          onClick={onExportAi}
        >
          <Download />
          Illustrator (.ai) をエクスポート
        </Button>
      </CardContent>
    </Card>
  );
}
