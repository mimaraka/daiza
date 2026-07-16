// Adobe Illustrator (.ai) エクスポート（純粋ロジック、React / DOM 非依存）。
//
// .ai の実体は Illustrator 9 以降 **PDF 互換コンテナ**（PDF に Illustrator 固有の
// private data を付したもの）である。private data はクローズド仕様だが、PDF として
// 妥当なファイルであれば Illustrator は .ai として開き、パスも画像も編集できる。
// そこで「PDF を生成して .ai 拡張子で保存する」方式を採る。
//
// pdf-lib は dynamic import する：PDF 生成はエクスポートを押した時にしか要らない
// 一方でライブラリは小さくないため、初期バンドル（＝ページを開いた瞬間の読み込み）に
// 載せない。Vite が自動で別チャンクへ切り出す。
//
// 図形の座標（mm）は export/geometry に集約済みで、SVG エクスポートと完全に同一の
// 幾何を共有する。本モジュールの責務は「mm → PDF ユーザー空間(pt)」の写像と、
// Illustrator でレイヤーとして見える形（OCG）への組み立てだけ。

import type { PDFName as PDFNameObject } from 'pdf-lib';

import { buildExportGeometry, EXPORT_COLORS, rectPathData, strokeWidthMm } from '@/export/geometry';
import type { ExportGeometry, RectMm } from '@/export/geometry';
import type { AnalysisResult, Point } from '@/model/types';
import { closedCurvePathData, curvePathData, mapCurve } from '@/utils/curve';

/** PDF のユーザー空間は 1pt = 1/72 inch。mm 実寸をそのまま pt へ写す係数。 */
const MM_TO_PT = 72 / 25.4;

/** 埋め込む絵柄画像。α を保った PNG のバイト列（生成は DOM 依存なので export/raster が担う）。 */
export interface EmbeddedPng {
  bytes: Uint8Array;
}

/**
 * Illustrator のレイヤー（＝PDF の OCG）定義。Illustrator は PDF を開くとき
 * Optional Content Group をレイヤーへ対応付けるため、加工用のカットラインと
 * 絵柄を別レイヤーに分け、片方だけ表示／ロックできるようにする。
 */
const LAYERS = [
  { key: 'artwork', name: '絵柄' },
  { key: 'base', name: '差込口・台座' },
  { key: 'cutline', name: 'カットライン' },
] as const;

type LayerKey = (typeof LAYERS)[number]['key'];

/** #rrggbb を pdf-lib の rgb()（各成分 0〜1）へ。配色は SVG と共有する。 */
function hexToRgbComponents(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * mm 座標（画像左上原点・下向き +Y）を、viewBox 左上を原点とする pt 座標へ写す。
 *
 * pdf-lib の drawSvgPath は「SVG 流儀（Y 下向き）の d を、指定アンカーに置いて
 * scale(1,-1) で描く」実装なので、アンカーをページ左上に取れば、この写像で作った
 * 点列をそのまま渡すだけで PDF 上の正しい位置に出る。曲線補完（closedCurvePathData）も
 * SVG とそのまま共用できる。
 */
function toPt(point: Point, viewBox: RectMm): Point {
  return { x: (point.x - viewBox.x) * MM_TO_PT, y: (point.y - viewBox.y) * MM_TO_PT };
}

/** 矩形版の toPt。 */
function rectToPt(rect: RectMm, viewBox: RectMm): RectMm {
  const origin = toPt({ x: rect.x, y: rect.y }, viewBox);
  return {
    x: origin.x,
    y: origin.y,
    width: rect.width * MM_TO_PT,
    height: rect.height * MM_TO_PT,
  };
}

/** pt 座標の d 文字列は小数 2 桁で十分（1pt ≒ 0.35mm、2 桁で 3.5μm 相当）。 */
function fmtPt(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/**
 * 解析結果と絵柄 PNG から、Illustrator で開ける PDF（=.ai）のバイト列を生成する。
 *
 * 出力はページ 1 枚。ページサイズは viewBox（余白込みの外接矩形）の実寸そのままなので、
 * Illustrator 上でもアートボードが mm 実寸になる。
 */
export async function generateAi(result: AnalysisResult, png: EmbeddedPng): Promise<Uint8Array> {
  const { PDFDocument, PDFHexString, PDFName, PDFOperator, PDFOperatorNames, rgb } =
    await import('pdf-lib');

  const geometry: ExportGeometry = buildExportGeometry(result, { includeImage: true });
  const { viewBox } = geometry;

  const pageWidth = viewBox.width * MM_TO_PT;
  const pageHeight = viewBox.height * MM_TO_PT;

  const doc = await PDFDocument.create();
  doc.setTitle('Daiza 台座設計図（実寸 mm）');
  const page = doc.addPage([pageWidth, pageHeight]);

  // レイヤー（OCG）を作り、ページのリソースから名前で参照できるようにする。
  // Resources() はページに何か描くまで生えないことがあるため normalize() で確定させる。
  page.node.normalize();
  const resources = page.node.Resources();
  const layerNames = new Map<LayerKey, PDFNameObject>();
  const layerRefs = LAYERS.map((layer, index) => {
    // レイヤー名は日本語なので、Latin-1 しか表せない PDF 文字列ではなく
    // UTF-16BE（BOM 付き）で書ける 16 進文字列にする。
    const ref = doc.context.register(
      doc.context.obj({ Type: 'OCG', Name: PDFHexString.fromText(layer.name) }),
    );
    layerNames.set(layer.key, PDFName.of(`OC${index}`));
    return ref;
  });

  const properties = doc.context.obj({});
  LAYERS.forEach((layer, index) => {
    const ref = layerRefs[index];
    const name = layerNames.get(layer.key);
    if (ref && name) {
      properties.set(name, ref);
    }
  });
  resources?.set(PDFName.of('Properties'), properties);

  // /OCProperties が無いと閲覧側はレイヤーを認識しない。Order がレイヤーパネルの並び。
  doc.catalog.set(
    PDFName.of('OCProperties'),
    doc.context.obj({
      OCGs: layerRefs,
      D: { Order: layerRefs, ON: layerRefs },
    }),
  );

  /** 描画を BDC /OC … EMC で括り、そのレイヤーに属するコンテンツとして印づける。 */
  const inLayer = (key: LayerKey, draw: () => void): void => {
    const name = layerNames.get(key);
    if (!name) {
      draw();
      return;
    }
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), name]),
    );
    draw();
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  };

  // 線幅は SVG と同じ基準（図の対角の 0.3%、下限 0.2mm）で mm から pt へ。
  const borderWidth = strokeWidthMm(viewBox) * MM_TO_PT;
  /** 線のみ（塗りなし）のパスを、ページ左上アンカー・Y 下向きで描く。 */
  const strokePath = (pathData: string, hex: string): void => {
    const [r, g, b] = hexToRgbComponents(hex);
    page.drawSvgPath(pathData, {
      x: 0,
      y: pageHeight,
      borderColor: rgb(r, g, b),
      borderWidth,
    });
  };

  // 絵柄（最背面）。drawImage は PDF 座標（左下原点・Y 上向き）なので、mm の上端 Y を
  // ページ高さから引いて「画像の下辺」の位置へ直す。
  const embedded = await doc.embedPng(png.bytes);
  const imageRect = rectToPt(geometry.image, viewBox);
  inLayer('artwork', () => {
    page.drawImage(embedded, {
      x: imageRect.x,
      y: pageHeight - (imageRect.y + imageRect.height),
      width: imageRect.width,
      height: imageRect.height,
    });
  });

  // baseFigure モード：差込口・台座を別レイヤーに出す。
  const baseGeometry = geometry.base;
  if (baseGeometry) {
    inLayer('base', () => {
      const basePath = mapCurve(baseGeometry.curve, (p) => toPt(p, viewBox));
      strokePath(curvePathData(basePath, fmtPt), EXPORT_COLORS.base);
      strokePath(rectPathData(rectToPt(geometry.neck!, viewBox), fmtPt), EXPORT_COLORS.slot);
      strokePath(rectPathData(rectToPt(geometry.tab!, viewBox), fmtPt), EXPORT_COLORS.slot);
      strokePath(rectPathData(rectToPt(geometry.baseSlot!, viewBox), fmtPt), EXPORT_COLORS.slot);
    });
  }

  // カットライン（最前面）。曲線補完した点列をそのままベジェパスとして出す。
  // keychain モードでは穴も同じレイヤーに出す。
  inLayer('cutline', () => {
    const contourPt = geometry.contour.map((p) => toPt(p, viewBox));
    const sharpPt = geometry.sharpCorners.map((p) => toPt(p, viewBox));
    strokePath(
      closedCurvePathData(contourPt, fmtPt, { sharpCorners: sharpPt }),
      EXPORT_COLORS.contour,
    );
    if (geometry.hole) {
      const c = toPt(geometry.hole.center, viewBox);
      const r = geometry.hole.radius * MM_TO_PT;
      strokePath(
        `M ${fmtPt(c.x + r)} ${fmtPt(c.y)} A ${fmtPt(r)} ${fmtPt(r)} 0 1 0 ${fmtPt(c.x - r)} ${fmtPt(c.y)} A ${fmtPt(r)} ${fmtPt(r)} 0 1 0 ${fmtPt(c.x + r)} ${fmtPt(c.y)} Z`,
        'rgb(239, 68, 68)',
      );
    }
  });

  return doc.save();
}
