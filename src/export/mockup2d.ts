// 2D 広告用モックアップ画像の生成（DOM 依存のアダプタ層）。
//
// 解析結果と元画像から、透過 PNG の「商品写真風」平面モックアップを作る。
// 前面図（2D プレビューと同じ視点）で、アクリル板の輪郭に画像をクリップし、
// 柔らかい影とアクリル縁の演出を加える。背景は透明なので、広告素材として
// そのまま合成できる。

import { slotJunctionCorners } from '@/analysis/slot';
import type { AnalysisResult, FigureImage, Point } from '@/model/types';
import { closedCurvePolyline } from '@/utils/curve';

/** 2D モックアップの見た目を調整するオプション。 */
export interface Mockup2dOptions {
  /** 画像周りの余白（px）。既定 40。 */
  padding?: number;
  /** 影のぼかし半径（px）。既定 28。 */
  shadowBlur?: number;
  /** 影のオフセット（px）。既定はやや右下。 */
  shadowOffset?: { x: number; y: number };
  /** アクリル縁の線幅（px）。既定 2。 */
  outlineWidth?: number;
  /** 台座を描くか。既定 true。 */
  showBase?: boolean;
}

/**
 * 2D 広告用モックアップを PNG の data URL として生成する。
 *
 * 出力は α 保持の PNG（背景透明）。元画像の解像度をそのまま使うため、
 * 印刷用データとしても利用できる。
 */
export function generateMockup2dPng(
  result: AnalysisResult,
  image: FigureImage,
  options: Mockup2dOptions = {},
): string {
  const {
    padding = 40,
    shadowBlur = 28,
    shadowOffset = { x: 10, y: 16 },
    outlineWidth = 2,
    showBase = true,
  } = options;

  const { mmPerPixel, contour, slot, base, keychain } = result;

  // 滑らかなカットライン（2D プレビューと同じ曲線補完）。
  const smoothContour = closedCurvePolyline(contour, 0.5, {
    sharpCorners: slot ? slotJunctionCorners(slot) : [],
  });

  // 輪郭と台座を含む描画範囲を求める。
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of smoothContour) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  // キーホルダー穴の外接矩形も描画範囲に加える。
  let holeCenterPixel: { x: number; y: number } | null = null;
  let holeRadiusPixel = 0;
  if (keychain) {
    holeCenterPixel = keychain.holeCenterPixel;
    holeRadiusPixel = keychain.holeRadiusMm / mmPerPixel;
    minX = Math.min(minX, holeCenterPixel.x - holeRadiusPixel);
    minY = Math.min(minY, holeCenterPixel.y - holeRadiusPixel);
    maxX = Math.max(maxX, holeCenterPixel.x + holeRadiusPixel);
    maxY = Math.max(maxY, holeCenterPixel.y + holeRadiusPixel);
  }

  const baseWidthPixel = base ? base.widthMm / mmPerPixel : 0;
  const baseHeightPixel = slot ? slot.tab.heightPixel : 0;
  const baseLeft = slot ? slot.centerXPixel - baseWidthPixel / 2 : 0;
  const baseTop = slot ? slot.baseTopYPixel : 0;
  const baseRight = baseLeft + baseWidthPixel;
  const baseBottom = baseTop + baseHeightPixel;

  if (showBase && base && slot) {
    minX = Math.min(minX, baseLeft);
    minY = Math.min(minY, baseTop);
    maxX = Math.max(maxX, baseRight);
    maxY = Math.max(maxY, baseBottom);
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(maxX - minX + padding * 2);
  canvas.height = Math.ceil(maxY - minY + padding * 2);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('canvas の 2D コンテキストを取得できませんでした。');
  }

  // 背景を透明にしておく。
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const originX = -minX + padding;
  const originY = -minY + padding;

  // 影は輪郭＋台座のシルエットに対して一括で落とす。キーホルダー穴も抜く。
  const silhouette = new Path2D();
  buildPath(silhouette, smoothContour, originX, originY);
  if (showBase && base && slot) {
    silhouette.rect(baseLeft + originX, baseTop + originY, baseWidthPixel, baseHeightPixel);
  }
  if (holeCenterPixel) {
    const hx = holeCenterPixel.x + originX;
    const hy = holeCenterPixel.y + originY;
    // 既存の輪郭パスから線を引かないよう、穴は新しいサブパスとして始める。
    silhouette.moveTo(hx + holeRadiusPixel, hy);
    silhouette.arc(hx, hy, holeRadiusPixel, 0, Math.PI * 2);
  }

  ctx.save();
  ctx.translate(shadowOffset.x, shadowOffset.y);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
  ctx.shadowBlur = shadowBlur;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.01)';
  ctx.fill(silhouette, 'evenodd');
  ctx.restore();

  // 台座：クリアアクリル風のグラデーション矩形。
  if (showBase && base && slot) {
    const bx = baseLeft + originX;
    const by = baseTop + originY;
    const bw = baseWidthPixel;
    const bh = baseHeightPixel;

    const grad = ctx.createLinearGradient(bx, by, bx, by + bh);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
    grad.addColorStop(0.5, 'rgba(230, 240, 247, 0.45)');
    grad.addColorStop(1, 'rgba(200, 220, 232, 0.35)');

    ctx.fillStyle = grad;
    ctx.fillRect(bx, by, bw, bh);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  }

  // アクリル板：輪郭でクリップして画像を描く。キーホルダーは穴も抜く。
  const platePath = new Path2D();
  buildPath(platePath, smoothContour, originX, originY);
  if (holeCenterPixel) {
    const hx = holeCenterPixel.x + originX;
    const hy = holeCenterPixel.y + originY;
    platePath.moveTo(hx + holeRadiusPixel, hy);
    platePath.arc(hx, hy, holeRadiusPixel, 0, Math.PI * 2);
  }

  ctx.save();
  ctx.clip(platePath, 'evenodd');
  ctx.drawImage(image.bitmap, originX, originY);
  ctx.restore();

  // アクリル縁：輪郭に沿った白い細線。
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = outlineWidth;
  ctx.lineJoin = 'round';
  ctx.stroke(platePath);
  ctx.restore();

  // 縁の内側に薄い影を重ねて、板の厚みをほのかに示す。
  ctx.save();
  ctx.clip(platePath, 'evenodd');
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.lineWidth = outlineWidth * 3;
  ctx.lineJoin = 'round';
  ctx.stroke(platePath);
  ctx.restore();

  return canvas.toDataURL('image/png');
}

function buildPath(path: Path2D, points: readonly Point[], offsetX: number, offsetY: number): void {
  const first = points[0];
  if (!first) {
    return;
  }
  path.moveTo(first.x + offsetX, first.y + offsetY);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p) {
      path.lineTo(p.x + offsetX, p.y + offsetY);
    }
  }
  path.closePath();
}
