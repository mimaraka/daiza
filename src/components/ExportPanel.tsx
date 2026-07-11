// エクスポート操作パネル。
//
// 解析結果を成果物（実寸座標系の SVG）として書き出すための操作だけを持つ。
// 解析結果があって初めて意味を持つ操作なので、右列の解析結果パネルの直下に置く。
// 状態は保持せず、生成・ダウンロードは上位（App）に委ねる presentational コンポーネント。

import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface ExportPanelProps {
  /** SVG エクスポートを要求する。結果が無い場合は未指定で無効化される。 */
  onExportSvg?: () => void;
}

export function ExportPanel({ onExportSvg }: ExportPanelProps) {
  return (
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
  );
}
