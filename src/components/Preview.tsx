// 画像プレビュー領域。
//
// 役割は 6 つ：(1) 読み込み済み画像を Canvas に等倍で描く、(2) 解析結果があれば
// SVG オーバーレイ（外形・重心・差込部・台座・支持範囲・鉛直線）を画像へ重ねる、
// (3) 転倒シミュレーション（左右の限界姿勢）をトグルで重ね描く、(4) PNG のドラッグ
// ＆ドロップを受け付ける、(5) ホイールズーム・ドラッグパン・Fit・100% の表示操作を
// 提供する（TODO 9）、(6) 上端・左端に実寸(mm)ルーラーを重ねる（TODO 20-1）。
//
// 図形の幾何は render/overlay.ts・render/simulation.ts（いずれも純粋ロジック）が
// 画像ピクセル座標で算出し、本コンポーネントは role ごとの見た目（色・線種）を与えて
// SVG 化する。ズーム/パンの座標変換は useViewport が持つ 1 つのアフィン変換に集約し、
// Canvas と SVG を内包する stage 要素へまとめて適用する。これにより画像とオーバーレイ
// は常に一致して拡縮・移動する。オーバーレイの線幅・マーカー半径だけは scale で割って、
// ズームしても画面上で一定サイズに保つ。

import { useEffect, useMemo, useRef, useState } from 'react';

import { ImageOff, Loader2, Maximize2, Minus, PersonStanding, Plus, Scan } from 'lucide-react';

import { Ruler } from '@/components/Ruler';
import { Button } from '@/components/ui/button';
import { buildOverlayShapes } from '@/render/overlay';
import { buildSimulationShapes } from '@/render/simulation';
import { useViewport, type ContentBox } from '@/hooks/useViewport';
import type { AnalysisStatus } from '@/model/state';
import type { AnalysisResult, FigureImage } from '@/model/types';
import { cn } from '@/lib/utils';
import { closedCurvePathData } from '@/utils/curve';
import { radToDeg } from '@/utils/geometry';

export interface PreviewProps {
  /** 読み込み済み画像。未読み込みなら null。 */
  image: FigureImage | null;
  /** 直近の解析結果。あればオーバーレイを描画する。未解析・失敗時は null。 */
  result?: AnalysisResult | null;
  /**
   * スケール換算係数(mm/px)。ルーラーの実寸目盛りに使う。解析結果を待たずに
   * （フィギュア高さと画像高さから）決まる値なので、result とは別に受け取る。
   */
  mmPerPixel?: number | null;
  /** 解析の進行状態。'analyzing' の間は解析中インジケータを重ねる。 */
  status?: AnalysisStatus;
  /** ドロップされた PNG ファイルを通知する。未指定ならドロップは受け付けない。 */
  onImageFile?: (file: File) => void;
}

export function Preview({ image, result, mmPerPixel, status, onImageFile }: PreviewProps) {
  // ドラッグ中はドロップ可能であることを視覚的に示すためのフラグ。
  const [isDragOver, setIsDragOver] = useState(false);
  // 転倒シミュレーション（左右の限界姿勢）の表示切替。常時重ねると主オーバーレイが
  // 埋もれるため、必要な時だけ見せられるようトグルにする（初期は非表示）。
  const [showSimulation, setShowSimulation] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 読み込みハンドラが無ければ D&D は無効。ハンドラの有無で振る舞いを分ける。
  const dropEnabled = Boolean(onImageFile);

  // オーバーレイ図形は解析結果が変わったときだけ再構築する（不要な再計算の抑制）。
  const overlay = useMemo(() => (result ? buildOverlayShapes(result) : null), [result]);

  // 転倒姿勢も同様に結果が変わったときだけ再構築する。トグル OFF でも構築コストは
  // 軽い（支点 2 点の算出のみ）ため result を唯一の依存とし、描画側で表示を出し分ける。
  const simulation = useMemo(() => (result ? buildSimulationShapes(result) : null), [result]);

  // Fit/100% が収める内容範囲。画像だけでなくカットライン（余白で画像枠外へ広がり得る）や
  // 差込口・台座・支持範囲を含む外接矩形にすることで、余白を増やしても見切れないようにする
  // （SPEC「表示範囲（見切れ防止）」）。解析前は画像そのものを範囲とする。
  const contentBox = useMemo<ContentBox | null>(() => {
    if (!image) {
      return null;
    }
    if (!overlay) {
      return { x: 0, y: 0, width: image.width, height: image.height };
    }
    // 画像枠を初期範囲とし、各オーバーレイ要素の外接点で広げる。
    let minX = 0;
    let minY = 0;
    let maxX = image.width;
    let maxY = image.height;
    const include = (x: number, y: number): void => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };
    for (const p of overlay.contour.points) {
      include(p.x, p.y);
    }
    for (const rect of [overlay.neck, overlay.tab, overlay.base]) {
      include(rect.x, rect.y);
      include(rect.x + rect.width, rect.y + rect.height);
    }
    include(overlay.support.from.x, overlay.support.from.y);
    include(overlay.support.to.x, overlay.support.to.y);
    include(overlay.plumb.from.x, overlay.plumb.from.y);
    include(overlay.plumb.to.x, overlay.plumb.to.y);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [image, overlay]);

  // 表示操作（ズーム/パン/Fit/100%）。自動フィットは画像の同一性（id）で制御し、
  // パラメータ変更（box の変化）ではユーザーのズーム/パンを保つ。
  const {
    containerRef,
    containerSize,
    transform,
    isPanning,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fit,
    actualSize,
    zoomIn,
    zoomOut,
  } = useViewport(contentBox, image?.id ?? null);

  // 画像が変わったときだけ Canvas へ等倍で描き直す。Canvas 要素は自然解像度で持ち、
  // 拡縮は stage の transform に委ねる。描画元はデコード済み ImageBitmap
  // （drawImage は GPU 経由で速く、ImageData と違い React の state に安全に置ける）。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) {
      return;
    }
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.drawImage(image.bitmap, 0, 0);
  }, [image]);

  // 外形カットラインの曲線パス（d 属性）。折れ線ではなく Catmull-Rom で曲線補完して
  // 描く（SPEC「曲線補完」）。ズーム/パンのたびに再レンダーされるため、JSX から切り出して
  // overlay 変化時のみ再計算する。主外形・転倒シミュレーション（2 姿勢）で同じパスを共有する。
  const contourPathD = useMemo(
    () => (overlay ? closedCurvePathData(overlay.contour.points) : ''),
    [overlay],
  );

  // 線幅・半径・破線は「画像 px を stage の scale で割った値」で指定することで、
  // 拡縮後の画面上サイズを一定に保つ（stage 側で scale 倍されるため相殺される）。
  const s = transform.scale;

  return (
    <div
      ref={containerRef}
      className={cn(
        'bg-muted/30 relative flex flex-1 touch-none items-center justify-center overflow-hidden rounded-lg border',
        // ドラッグ中は境界を強調してドロップ対象であることを明示する。
        isDragOver && 'border-primary bg-primary/10',
        // パン操作のためのカーソル表現（画像がある時のみ）。
        image && (isPanning ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      onPointerDown={image ? onPointerDown : undefined}
      onPointerMove={image ? onPointerMove : undefined}
      onPointerUp={image ? onPointerUp : undefined}
      onPointerCancel={image ? onPointerUp : undefined}
      onDragOver={
        dropEnabled
          ? (event) => {
              // preventDefault しないとブラウザがファイルを開いてしまい drop が発火しない。
              event.preventDefault();
              setIsDragOver(true);
            }
          : undefined
      }
      onDragLeave={dropEnabled ? () => setIsDragOver(false) : undefined}
      onDrop={
        dropEnabled
          ? (event) => {
              event.preventDefault();
              setIsDragOver(false);
              // 複数ドロップされても先頭のみ扱う（単一画像前提）。
              const file = event.dataTransfer.files?.[0];
              if (file) {
                onImageFile?.(file);
              }
            }
          : undefined
      }
    >
      {image ? (
        <>
          {/* stage：画像の自然サイズを持つ箱。左上原点で transform を適用し、内包する
              Canvas と SVG をまとめて拡縮・移動する。両者は同一の箱を満たすため常に重なる。 */}
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{
              width: image.width,
              height: image.height,
              transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${s})`,
            }}
          >
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
            {overlay && (
              <svg
                // overflow-visible：カットラインが画像枠（viewBox）外へ広がっても
                // 見切れさせない（SPEC「見切れ防止」）。stage 外は外周コンテナが切り取る。
                className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                viewBox={`0 0 ${image.width} ${image.height}`}
              >
                {/* 転倒シミュレーション（限界姿勢）。主オーバーレイに埋もれないよう
                    最背面へ薄く描く。各方向とも支点まわりに外形を転倒角ぶん傾け、
                    重心が支点の真上に載る「倒れる直前」の姿を示す。 */}
                {showSimulation &&
                  simulation &&
                  [simulation.left, simulation.right].map((pose) => (
                    <g
                      key={pose.role}
                      // 符号付き回転量はラジアンで持つため度へ直して rotate に渡す。
                      transform={`rotate(${radToDeg(pose.angleRad)} ${pose.pivot.x} ${pose.pivot.y})`}
                    >
                      <path
                        d={contourPathD}
                        fill="rgba(249, 115, 22, 0.08)"
                        stroke="rgba(249, 115, 22, 0.5)"
                        strokeWidth={1 / s}
                        strokeDasharray={`${4 / s} ${3 / s}`}
                      />
                      {/* 重心→支点の線。回転後は鉛直になり、重心が支点の真上へ載る
                          （＝その方向の転倒限界）ことを可視化する。 */}
                      <line
                        x1={overlay.centroid.center.x}
                        y1={overlay.centroid.center.y}
                        x2={pose.pivot.x}
                        y2={pose.pivot.y}
                        stroke="rgba(249, 115, 22, 0.7)"
                        strokeWidth={1 / s}
                      />
                      <circle
                        cx={overlay.centroid.center.x}
                        cy={overlay.centroid.center.y}
                        r={overlay.centroid.radius / s}
                        fill="rgba(249, 115, 22, 0.85)"
                      />
                    </g>
                  ))}

                {/* 外形（半透明）。塗りで領域を、細線で曲線カットラインを示す。 */}
                <path
                  d={contourPathD}
                  fill="rgba(148, 163, 184, 0.25)"
                  stroke="rgba(100, 116, 139, 0.8)"
                  strokeWidth={1 / s}
                />

                {/* 台座（緑矩形）。上辺が台座上面。差込部・支持範囲より背面に置くため先に描く。 */}
                <rect
                  x={overlay.base.x}
                  y={overlay.base.y}
                  width={overlay.base.width}
                  height={overlay.base.height}
                  fill="rgba(34, 197, 94, 0.25)"
                  stroke="rgb(22, 163, 74)"
                  strokeWidth={1.5 / s}
                />

                {/* 差込部（青矩形 2 つ）。首部＝板と台座の隙間を埋める広い矩形、ツメ＝台座上面
                    より下へ挿さる狭い矩形。幅の差でできる肩が台座上面に乗って止まる。 */}
                {[overlay.neck, overlay.tab].map((rect) => (
                  <rect
                    key={rect.role}
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    fill="rgba(37, 99, 235, 0.25)"
                    stroke="rgb(37, 99, 235)"
                    strokeWidth={1.5 / s}
                  />
                ))}

                {/* 支持範囲（オレンジ線）。 */}
                <line
                  x1={overlay.support.from.x}
                  y1={overlay.support.from.y}
                  x2={overlay.support.to.x}
                  y2={overlay.support.to.y}
                  stroke="rgb(249, 115, 22)"
                  strokeWidth={3 / s}
                  strokeLinecap="round"
                />

                {/* 重心からの鉛直線（点線）。支持範囲と対比させて転倒余裕を目視する。 */}
                <line
                  x1={overlay.plumb.from.x}
                  y1={overlay.plumb.from.y}
                  x2={overlay.plumb.to.x}
                  y2={overlay.plumb.to.y}
                  stroke="rgba(239, 68, 68, 0.9)"
                  strokeWidth={1.5 / s}
                  strokeDasharray={`${6 / s} ${4 / s}`}
                />

                {/* 重心（赤丸）。最前面へ置いて他図形に埋もれないようにする。 */}
                <circle
                  cx={overlay.centroid.center.x}
                  cy={overlay.centroid.center.y}
                  r={overlay.centroid.radius / s}
                  fill="rgb(239, 68, 68)"
                  stroke="white"
                  strokeWidth={1.5 / s}
                />
              </svg>
            )}
          </div>

          {/* ルーラー（上端・左端、実寸 mm）。stage ではなくビューポートに固定表示し、
              transform から目盛り位置を算出してズーム・パンへ追従させる。pointer-events は
              持たないため、下のプレビューのドラッグパン・ホイールズームを妨げない。 */}
          {containerSize && mmPerPixel != null && (
            <Ruler
              width={containerSize.width}
              height={containerSize.height}
              transform={transform}
              mmPerPixel={mmPerPixel}
            />
          )}

          {/* 表示操作コントロール。stage の上（右下）へ重ねる。ボタン操作でパンが
              誤発火しないよう、ここでの pointerdown はコンテナへ伝播させない。 */}
          <div
            className="absolute right-2 bottom-2 flex items-center gap-1 rounded-md border bg-background/80 p-1 shadow-sm backdrop-blur"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {/* 転倒シミュレーション表示切替。解析結果が無い間は対象が無いので無効化。 */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowSimulation((v) => !v)}
              disabled={!simulation}
              className={cn(showSimulation && 'text-primary bg-primary/10')}
              title="転倒シミュレーション"
              aria-label="転倒シミュレーション"
              aria-pressed={showSimulation}
            >
              <PersonStanding />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={zoomOut} title="縮小" aria-label="縮小">
              <Minus />
            </Button>
            {/* 現在の拡大率。クリックで 100% 表示に合わせる。 */}
            <Button
              variant="ghost"
              size="sm"
              className="min-w-14 tabular-nums"
              onClick={actualSize}
              title="100%表示"
            >
              {Math.round(s * 100)}%
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={zoomIn} title="拡大" aria-label="拡大">
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={actualSize}
              title="100%表示"
              aria-label="100%表示"
            >
              <Scan />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={fit}
              title="全体表示（Fit）"
              aria-label="全体表示"
            >
              <Maximize2 />
            </Button>
          </div>

          {/* 解析中インジケータ。解析は Web Worker で走るため UI は固まらないが、
              結果が出るまで待ちであることを明示する（SPEC「解析中であることを表示する」）。
              まだ見せる結果が無い初回解析は全面オーバーレイで、結果を表示したままの
              再計算（パラメータ変更）は前回オーバーレイを隠さない小さなバッジで示す。 */}
          {status === 'analyzing' &&
            (result ? (
              <div
                role="status"
                aria-live="polite"
                className="bg-background/80 text-muted-foreground pointer-events-none absolute top-2 right-2 flex items-center gap-1.5 rounded-md border px-2 py-1 shadow-sm backdrop-blur"
              >
                <Loader2 className="size-3.5 animate-spin" />
                <span className="text-xs font-medium">更新中…</span>
              </div>
            ) : (
              <div
                role="status"
                aria-live="polite"
                className="text-muted-foreground bg-background/70 pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 backdrop-blur-sm"
              >
                <Loader2 className="size-8 animate-spin" />
                <p className="text-sm font-medium">解析中…</p>
              </div>
            ))}
        </>
      ) : (
        <div className="text-muted-foreground flex flex-col items-center gap-2 text-center">
          <ImageOff className="size-10 opacity-50" />
          <p className="text-sm">
            {isDragOver
              ? 'ここにドロップ'
              : 'PNG画像をドラッグ＆ドロップ、または読み込んでください'}
          </p>
        </div>
      )}
    </div>
  );
}
