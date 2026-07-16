// エクスポート操作パネル。
//
// 解析結果を成果物（実寸座標系の SVG / Adobe Illustrator ドキュメント）として書き出す
// 操作だけを持つ。解析結果があって初めて意味を持つ操作なので、右列の解析結果パネルの
// 直下に置く。状態は保持せず、生成・ダウンロードは上位（App）に委ねる presentational
// コンポーネント。

import { Box, Download, Image } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useTranslation } from '@/locales';

export interface ExportPanelProps {
  /** SVG エクスポートを要求する。結果が無い場合は未指定で無効化される。 */
  onExportSvg?: () => void;
  /** Illustrator（.ai）エクスポートを要求する。結果が無い場合は未指定で無効化される。 */
  onExportAi?: () => void;
  /** 2D 広告用モックアップ PNG をエクスポートする。結果が無い場合は未指定で無効化される。 */
  onExportMockup2d?: () => void;
  /** 3D 広告用モックアップ PNG をエクスポートする。結果が無い場合は未指定で無効化される。 */
  onExportMockup3d?: () => void;
  /** SVG に絵柄画像を埋め込むか（.ai は常に埋め込むため対象外）。 */
  embedImageInSvg: boolean;
  onEmbedImageInSvgChange: (value: boolean) => void;
  /** 生成中。大きな画像では PNG 化に時間がかかるため、その間は操作を止める。 */
  exporting?: boolean;
}

export function ExportPanel({
  onExportSvg,
  onExportAi,
  onExportMockup2d,
  onExportMockup3d,
  embedImageInSvg,
  onEmbedImageInSvgChange,
  exporting = false,
}: ExportPanelProps) {
  const { t } = useTranslation();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('exportPanel.title')}</CardTitle>
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
          {t('exportPanel.exportSvg')}
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
            {t('exportPanel.embedImage')}
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
          {t('exportPanel.exportAi')}
        </Button>

        {/* 広告用モックアップ PNG（2D / 3D）。背景透過でそのまま合成できる。 */}
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!onExportMockup2d || exporting}
          onClick={onExportMockup2d}
        >
          <Image />
          {t('exportPanel.exportMockup2d')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={!onExportMockup3d || exporting}
          onClick={onExportMockup3d}
        >
          <Box />
          {t('exportPanel.exportMockup3d')}
        </Button>
      </CardContent>
    </Card>
  );
}
