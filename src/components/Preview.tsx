// 画像プレビュー領域。
//
// 役割は 9 つ：(1) 読み込み済み画像を Canvas に等倍で描く、(2) 解析結果があれば
// SVG オーバーレイ（外形・重心・差込部・台座・支持範囲・鉛直線）を画像へ重ねる、
// (3) 転倒シミュレーション（左右の限界姿勢）をトグルで重ね描く、(4) PNG のドラッグ
// ＆ドロップを受け付ける、(5) ホイールズーム・ドラッグパン・ピンチ拡縮・Fit・100% の
// 表示操作を提供する（TODO 9）、(6) 上端・左端に実寸(mm)ルーラーを重ね、同じ目盛りの実寸グリッドを
// トグルで背面へ敷く（TODO 20-1 / 28）、(7) 仕上がりを確認する完成プレビューモードへ
// 切り替える（TODO 22-2）、(8) 立体で確認する 3D プレビューモードへ切り替える（TODO 26）、
// (9) 解析エラー・解析中インジケータをビューワー前面へオーバーレイする。
//
// 図形の幾何は render/overlay.ts・render/simulation.ts（いずれも純粋ロジック）が
// 画像ピクセル座標で算出し、本コンポーネントは role ごとの見た目（色・線種）を与えて
// SVG 化する。ズーム/パンの座標変換は useViewport が持つ 1 つのアフィン変換に集約し、
// Canvas と SVG を内包する stage 要素へまとめて適用する。これにより画像とオーバーレイ
// は常に一致して拡縮・移動する。オーバーレイの線幅・マーカー半径だけは scale で割って、
// ズームしても画面上で一定サイズに保つ。
//
// 3D プレビューは three.js 一式（数百 KB）を要するため、React.lazy で分離チャンクに置き、
// 3D モードへ初めて切り替えたときにだけ読み込む（SPEC「技術・読み込み」）。3 つのモードは
// いずれも**表示のみの切替**で、解析結果・パラメータには一切触れない。

import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  Box,
  Eye,
  Grid3x3,
  ImageOff,
  Loader2,
  Maximize2,
  Minus,
  PersonStanding,
  Plus,
  RectangleHorizontal,
} from 'lucide-react';

import { Grid } from '@/components/Grid';
import { RULER_SIZE_PX, Ruler } from '@/components/Ruler';
import { TopView } from '@/components/TopView';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/locales';
import { buildOverlayShapes } from '@/render/overlay';
import { buildSimulationShapes } from '@/render/simulation';
import { buildTopViewShapes } from '@/render/topView';
import { useViewport, type ContentBox } from '@/hooks/useViewport';
import type { AnalysisStatus } from '@/model/state';
import type { AnalysisError, AnalysisResult, FigureImage, Point } from '@/model/types';
import { cn } from '@/lib/utils';
import { closedCurvePathData } from '@/utils/curve';
import { radToDeg } from '@/utils/geometry';

/** 3D プレビュー（three.js / R3F を含むチャンク）。3D へ切り替えるまで読み込まない。 */
const Preview3d = lazy(() => import('@/components/preview3d/Preview3d'));

/**
 * 外形（カットライン）の塗り・線の色。完成プレビューモードでは台座もこの色で描き、
 * アクリル板と台座が同じ素材の一体物に見えるようにする（SPEC「完成プレビューモード」）。
 */
const CONTOUR_FILL = 'rgba(148, 163, 184, 0.25)';
const CONTOUR_STROKE = 'rgba(100, 116, 139, 0.8)';

/**
 * 重心マーカー（赤丸）の半径。線幅と同じく**画面上の px** で与え、描画時に scale で割ることで、
 * 画像解像度にもズーム率にも依らず常に同じ大きさに見せる（画像 px 基準にすると、同じフィギュアでも
 * 3000px の画像と 500px の画像とで見かけの大きさが変わってしまう）。大きすぎると形状が隠れるため
 * 小さめにとる（SPEC「重心マーカーの大きさ」）。
 */
const CENTROID_RADIUS_PX = 5;

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
  /**
   * 不透明領域のしきい値（0〜1）。3D プレビューが白版（絵柄のシルエット）を作る際に、
   * 解析と同一の判定でα を 2 値化するために要る。
   */
  alphaThreshold?: number;
  /**
   * 3D プレビューで背面のアクリル板を表示するか。表示のみのパラメータ。
   * 省略時は false。
   */
  showBackPlate?: boolean;
  /**
   * 背面アクリル板に貼る画像。3D プレビューのみ使用する表示アセット。
   * 省略時は null。
   */
  backImage?: FigureImage | null;
  /** 解析の進行状態。'analyzing' の間は解析中インジケータを重ねる。 */
  status?: AnalysisStatus;
  /**
   * 直近の解析エラー。あればビューワー前面へオーバーレイ表示する。正常時は null。
   * プレビューの外（列の上部）へ積むとエラーの出入りでビューワーの寸法が変わってしまうため、
   * 表示・非表示がレイアウトへ波及しないこの位置で受け取る。
   */
  error?: AnalysisError | null;
  /** ドロップされた PNG ファイルを通知する。未指定ならドロップは受け付けない。 */
  onImageFile?: (file: File) => void;
}

export function Preview({
  image,
  result,
  mmPerPixel,
  alphaThreshold = 0,
  showBackPlate = false,
  backImage = null,
  status,
  error,
  onImageFile,
}: PreviewProps) {
  const { t } = useTranslation();

  // ドラッグ中はドロップ可能であることを視覚的に示すためのフラグ。
  const [isDragOver, setIsDragOver] = useState(false);
  // 転倒シミュレーション（左右の限界姿勢）の表示切替。常時重ねると主オーバーレイが
  // 埋もれるため、必要な時だけ見せられるようトグルにする（初期は非表示）。
  const [showSimulation, setShowSimulation] = useState(false);
  // 実寸(mm)グリッドの表示切替。ルーラーだけでは端の目盛りから位置を目で追う必要があるため、
  // 方眼として画面全体へ敷けるようにする。既定は非表示（絵柄・オーバーレイの読みやすさを優先。
  // 3D の床グリッドが既定 ON なのは、床が絵柄と重ならず寸法の手掛かりが他に無いため）。
  const [showGrid, setShowGrid] = useState(false);
  // 上面図インセットの表示切替。既定は「台座形状が矩形なら OFF、それ以外なら ON」（矩形は
  // 前面図だけで形状が分かるため）。null = 既定に従う、true/false = ユーザーのトグル操作を優先。
  const [topViewOverride, setTopViewOverride] = useState<boolean | null>(null);
  // 完成プレビューモード（仕上がり確認）の表示切替。表示だけの切替であり、解析・パラメータ・
  // SVG エクスポートには一切影響しない（＝この state は描画分岐にのみ使う）。
  const [finishView, setFinishView] = useState(false);
  // 3D プレビューモードの表示切替。こちらも表示のみの切替。
  const [view3d, setView3d] = useState(false);
  // 一度でも 3D ボタンを押したら true にし、3D プレビューをアンマウントせず保持する。
  const [hasActivated3d, setHasActivated3d] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 3D チャンクは初回切替時に動的読み込みするが、解析結果が出そうな段階で先に読み込みを
  // 開始しておく。これにより「3D ボタンを押してから読み込み」による遅延・再マウントを減らす。
  useEffect(() => {
    if (result) {
      void import('@/components/preview3d/Preview3d');
    }
  }, [result]);

  // 3D は解析結果が要る（立体を組み立てられない）。解析エラーで結果が消えた場合は
  // 自動的に 2D へ戻し、エラー表示が読める状態にする（SPEC「解析結果があるときのみ有効」）。
  const show3d = view3d && result != null && image != null;

  // 読み込みハンドラが無ければ D&D は無効。ハンドラの有無で振る舞いを分ける。
  const dropEnabled = Boolean(onImageFile);

  // オーバーレイ図形は解析結果が変わったときだけ再構築する（不要な再計算の抑制）。
  const overlay = useMemo(() => (result ? buildOverlayShapes(result) : null), [result]);

  // 転倒姿勢も同様に結果が変わったときだけ再構築する。トグル OFF でも構築コストは
  // 軽い（支点 2 点の算出のみ）ため result を唯一の依存とし、描画側で表示を出し分ける。
  const simulation = useMemo(() => (result ? buildSimulationShapes(result) : null), [result]);

  // 上面図（footprint・スリット・重心投影・最悪方位）。こちらも軽いので result 依存で作る。
  const topView = useMemo(() => (result ? buildTopViewShapes(result) : null), [result]);

  // 既定は矩形以外で ON（矩形は前面図だけで形状が分かる）。ユーザーが一度でも切り替えたら
  // その選択を優先する（SPEC「ユーザーのトグル操作を優先する」）。3D 中は出さない。
  const topViewDefault = result != null && result.base.shape !== 'rect';
  const showTopView = (topViewOverride ?? topViewDefault) && topView != null && !show3d;

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

  // ルーラーの原点（画像ピクセル座標）。実寸座標系は「重心の真下・台座の底面（＝接地面）」を
  // 原点にとるため、X は重心、Y は台座矩形の下辺に合わせる（SPEC「ルーラー」）。解析前は
  // まだ台座も重心も定まらないので、接地面に相当する画像下端・画像左端を仮の原点として
  // 目盛り自体は出しておく（スケール mm/px は解析を待たずに決まる）。
  const rulerOrigin = useMemo<Point>(() => {
    if (!overlay) {
      return { x: 0, y: image?.height ?? 0 };
    }
    return { x: overlay.centroid.center.x, y: overlay.base.y + overlay.base.height };
  }, [overlay, image]);

  // 表示操作（ズーム/パン/Fit/100%）。自動フィットは画像の同一性（id）で制御し、
  // パラメータ変更（box の変化）ではユーザーのズーム/パンを保つ。3D 中は 2D の
  // ホイールズームを止め、3D のオービット操作とイベントを奪い合わないようにする
  // （state は保持されるので 2D へ戻ればズーム・パンはそのまま復帰する）。
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
  } = useViewport(contentBox, image?.id ?? null, !show3d);

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

  // 外形カットラインの曲線パス（d 属性）。折れ線ではなくコーナーカットで曲線補完して描く
  // （SPEC「曲線補完」）。差込部の肩（首部とツメの接合部）だけは加工寸法に直結する直角なので
  // 丸めない。ズーム/パンのたびに再レンダーされるため、JSX から切り出して overlay 変化時のみ
  // 再計算する。主外形・転倒シミュレーション（2 姿勢）で同じパスを共有する。
  const contourPathD = useMemo(
    () =>
      overlay
        ? closedCurvePathData(overlay.contour.points, undefined, {
            sharpCorners: overlay.contour.sharpCorners,
          })
        : '',
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
        // パン操作のためのカーソル表現（2D で画像がある時のみ。3D はキャンバス側が持つ）。
        image && !show3d && (isPanning ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      onPointerDown={image && !show3d ? onPointerDown : undefined}
      onPointerMove={image && !show3d ? onPointerMove : undefined}
      onPointerUp={image && !show3d ? onPointerUp : undefined}
      onPointerCancel={image && !show3d ? onPointerUp : undefined}
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
          {/* 実寸グリッド。ルーラーと同じ目盛り位置に引くので、格子とルーラーは常に一致する。
              stage より先に置いて背面へ敷くため、絵柄・オーバーレイを覆わず、透明 PNG の
              抜けた部分に方眼紙のように透けて見える。2D 前提の UI なので 3D では出さない。 */}
          {showGrid && !show3d && containerSize && mmPerPixel != null && (
            <Grid
              width={containerSize.width}
              height={containerSize.height}
              transform={transform}
              mmPerPixel={mmPerPixel}
              origin={rulerOrigin}
            />
          )}

          {/* 3D プレビュー：初回読み込み後はアンマウントせず `display` で出し分ける。
              これにより WebGL コンテキスト・Rapier ワールドの再作成を防ぎ、
              2D ↔ 3D の切り替えが安定する（SPEC「3D 切替は表示のみ」）。
              チャンクの読み込み中はインジケータを出す（初回切替時のみ）。 */}
          {result && hasActivated3d && (
            <KeepAlive3d active={show3d}>
              <Suspense
                fallback={
                  <div
                    role="status"
                    aria-live="polite"
                    className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2"
                  >
                    <Loader2 className="size-8 animate-spin" />
                    <p className="text-sm font-medium">{t('preview.loading3d')}</p>
                  </div>
                }
              >
                <Preview3d
                  result={result}
                  image={image}
                  alphaThreshold={alphaThreshold}
                  showBackPlate={showBackPlate}
                  backImage={backImage}
                />
              </Suspense>
            </KeepAlive3d>
          )}

          {/* stage：画像の自然サイズを持つ箱。左上原点で transform を適用し、内包する
              Canvas と SVG をまとめて拡縮・移動する。両者は同一の箱を満たすため常に重なる。
              3D 中はアンマウントせず display:none で隠す：Canvas への描画は画像が変わったときの
              effect でしか行わないため、アンマウントすると 2D へ戻ったとき白紙になる。 */}
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{
              display: show3d ? 'none' : 'block',
              width: image.width,
              height: image.height,
              transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${s})`,
            }}
          >
            {/* 完成プレビューモードでは画像をオーバーレイより前面へ出す。外形の半透明塗りは
                そのまま描いたうえで不透明な絵柄がその上に載るため、塗りの見える範囲が
                「カットライン領域 − 不透明領域」になる（SPEC「絵柄の上のオーバーレイを
                無効化する」）。α をマスク化するより安く、半透明画素も素直に合成される。 */}
            <canvas
              ref={canvasRef}
              className={cn('absolute inset-0 h-full w-full', finishView && 'z-10')}
            />
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
                  !finishView &&
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
                        r={CENTROID_RADIUS_PX / s}
                        fill="rgba(249, 115, 22, 0.85)"
                      />
                    </g>
                  ))}

                {/* 外形（半透明）。塗りで領域を、細線で曲線カットラインを示す。板本体・首部・
                    ツメを統合した 1 本のカットラインであり、完成プレビューモードでもそのまま描く。 */}
                <path
                  d={contourPathD}
                  fill={CONTOUR_FILL}
                  stroke={CONTOUR_STROKE}
                  strokeWidth={1 / s}
                />

                {/* 台座。上辺が台座上面。差込部・支持範囲より背面に置くため先に描く。
                    通常は緑のハイライトだが、完成プレビューモードでは仕上がりを見るため
                    カットラインと同色にそろえる。 */}
                <rect
                  x={overlay.base.x}
                  y={overlay.base.y}
                  width={overlay.base.width}
                  height={overlay.base.height}
                  fill={finishView ? CONTOUR_FILL : 'rgba(34, 197, 94, 0.25)'}
                  stroke={finishView ? CONTOUR_STROKE : 'rgb(22, 163, 74)'}
                  strokeWidth={1.5 / s}
                />

                {/* ここから下は解析表示モード専用のガイド。完成プレビューモードでは
                    絵柄・カットライン・台座だけを見せるため一切描かない。 */}
                {!finishView && (
                  <>
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
                      r={CENTROID_RADIUS_PX / s}
                      fill="rgb(239, 68, 68)"
                      stroke="white"
                      strokeWidth={1.5 / s}
                    />
                  </>
                )}
              </svg>
            )}
          </div>

          {/* ルーラー（上端・左端、実寸 mm）。stage ではなくビューポートに固定表示し、
              transform から目盛り位置を算出してズーム・パンへ追従させる。pointer-events は
              持たないため、下のプレビューのドラッグパン・ホイールズームを妨げない。
              2D 前提の UI なので 3D モードでは出さない（SPEC）。 */}
          {!show3d && containerSize && mmPerPixel != null && (
            <Ruler
              width={containerSize.width}
              height={containerSize.height}
              transform={transform}
              mmPerPixel={mmPerPixel}
              origin={rulerOrigin}
            />
          )}

          {/* 上面図インセット（右下・表示操作コントロールの上）。前面図に現れない台座の奥行・
              形状と、重心投影が支持範囲（凸包）に収まっているかを確認するための表示専用の図。 */}
          {showTopView && topView && <TopView shapes={topView} />}

          {/* 表示操作コントロール。stage の上（右下）へ重ねる。ボタン操作でパンが
              誤発火しないよう、ここでの pointerdown はコンテナへ伝播させない。 */}
          <div
            className="absolute right-2 bottom-2 flex items-center gap-1 rounded-md border bg-background/80 p-1 shadow-sm backdrop-blur"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {/* 3D プレビューモード切替。立体は解析結果が無いと組み立てられないので、
                結果がある時だけ有効。3D 側の操作（オービット・傾け・分解）はチャンク内の
                Preview3d が自前のコントロールで提供する。 */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setView3d((v) => !v);
                setHasActivated3d(true);
              }}
              disabled={!result}
              className={cn(show3d && 'text-primary bg-primary/10')}
              title={t('preview.toolbar.preview3d')}
              aria-label={t('preview.toolbar.preview3d')}
              aria-pressed={show3d}
            >
              <Box />
            </Button>
            {/* 完成プレビューモード切替。オーバーレイの見た目だけを切り替える（解析は再実行
                されない）。オーバーレイが無い＝見せる仕上がりが無い間は無効化。3D 中は
                2D オーバーレイ自体を出さないため無効化する。 */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setFinishView((v) => !v)}
              disabled={!overlay || show3d}
              className={cn(finishView && !show3d && 'text-primary bg-primary/10')}
              title={t('preview.toolbar.finishView')}
              aria-label={t('preview.toolbar.finishView')}
              aria-pressed={finishView && !show3d}
            >
              <Eye />
            </Button>
            {/* 転倒シミュレーション表示切替。解析結果が無い間は対象が無いので無効化。
                完成プレビューモード・3D モードではガイドを一切出さないためトグル自体を
                無効化する（3D の転倒は Preview3d の傾けスライダーで行う）。 */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowSimulation((v) => !v)}
              disabled={!simulation || finishView || show3d}
              className={cn(
                showSimulation && !finishView && !show3d && 'text-primary bg-primary/10',
              )}
              title={t('preview.toolbar.simulation')}
              aria-label={t('preview.toolbar.simulation')}
              aria-pressed={showSimulation && !finishView && !show3d}
            >
              <PersonStanding />
            </Button>

            {/* ここから下は 2D 専用の表示操作。3D ではカメラ操作・3D パネル側のトグルが
                担うため出さない（グリッドは 3D にも床グリッドのトグルがあるので、無効化した
                ボタンを残すと二重に見えてしまう）。 */}
            {!show3d && (
              <>
                {/* 上面図インセットの表示切替。解析結果（footprint）が無い間は描く対象が無い。 */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setTopViewOverride(!(topViewOverride ?? topViewDefault))}
                  disabled={!topView}
                  className={cn(showTopView && 'text-primary bg-primary/10')}
                  title={t('preview.toolbar.topView')}
                  aria-label={t('preview.toolbar.topViewAria')}
                  aria-pressed={showTopView}
                >
                  <RectangleHorizontal />
                </Button>
                {/* 実寸グリッド表示切替。実寸(mm)の格子なのでスケール（mm/px）が要る。 */}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowGrid((v) => !v)}
                  disabled={mmPerPixel == null}
                  className={cn(showGrid && 'text-primary bg-primary/10')}
                  title={t('preview.toolbar.grid')}
                  aria-label={t('preview.toolbar.grid')}
                  aria-pressed={showGrid}
                >
                  <Grid3x3 />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={zoomOut}
                  title={t('preview.toolbar.zoomOut')}
                  aria-label={t('preview.toolbar.zoomOut')}
                >
                  <Minus />
                </Button>
                {/* 現在の拡大率。クリックで 100% 表示に合わせる。 */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-14 tabular-nums"
                  onClick={actualSize}
                  title={t('preview.toolbar.actualSize')}
                >
                  {Math.round(s * 100)}%
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={zoomIn}
                  title={t('preview.toolbar.zoomIn')}
                  aria-label={t('preview.toolbar.zoomIn')}
                >
                  <Plus />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={fit}
                  title={t('preview.toolbar.fit')}
                  aria-label={t('preview.toolbar.fit')}
                >
                  <Maximize2 />
                </Button>
              </>
            )}
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
                // ビューワー中央上部（上端ルーラーの帯 RULER_SIZE_PX より下）へ置く。
                // 中央なら視線の通り道にあって気づきやすく、かつ目盛り・数値ラベルも隠さない。
                style={{ top: RULER_SIZE_PX + 8 }}
                className="bg-background/80 text-muted-foreground pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-md border px-2 py-1 shadow-sm backdrop-blur"
              >
                <Loader2 className="size-3.5 animate-spin" />
                <span className="text-xs font-medium">{t('preview.updating')}</span>
              </div>
            ) : (
              <div
                role="status"
                aria-live="polite"
                className="text-muted-foreground bg-background/70 pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 backdrop-blur-sm"
              >
                <Loader2 className="size-8 animate-spin" />
                <p className="text-sm font-medium">{t('preview.analyzing')}</p>
              </div>
            ))}
        </>
      ) : (
        <div className="text-muted-foreground flex flex-col items-center gap-2 text-center">
          <ImageOff className="size-10 opacity-50" />
          <p className="text-sm">{isDragOver ? t('preview.dropHere') : t('preview.dropPrompt')}</p>
        </div>
      )}

      {/* エラー表示。画像の有無に関わらず（読み込み失敗もあるため）ビューワーの前面へ重ねる。
          プレビューの外に積むと、エラーの出入りのたびにビューワーの寸法が変わって表示が
          跳ねてしまう（SPEC「エラーハンドリング」）。位置は解析中インジケータと同じ中央上部
          （上端ルーラーの帯 RULER_SIZE_PX より下）。エラー時は結果が無く status も 'error' なので、
          解析中インジケータと同時には出ない。pointer-events は持たせず、読み込み失敗の直後に
          同じ場所へ再ドロップ・再パンできる状態を保つ。 */}
      {error && (
        <div
          role="alert"
          style={{ top: RULER_SIZE_PX + 8 }}
          // inset-x-2 + mx-auto + w-fit：内容幅の箱を中央へ置きつつ、長い文面は左右 8px の
          // 余白を残して折り返させる（translate による中央寄せだと折り返し幅を制限できない）。
          className="border-destructive/50 bg-background/90 text-destructive pointer-events-none absolute inset-x-2 z-20 mx-auto w-fit rounded-lg border px-4 py-2 text-sm shadow-sm backdrop-blur"
        >
          {t(`errors.${error.kind}` as const)}
        </div>
      )}
    </div>
  );
}

/**
 * 3D プレビューを切替時にアンマウントしないためのラッパー。
 *
 * 親が `hasActivated3d` を true にしてからは常に子を保持し、
 * それ以降は `display` で表示／非表示を切り替えるだけ。
 * これにより WebGL コンテキストや Rapier ワールドの再作成が起きず、
 * 2D ↔ 3D の往復が安定する。
 */
function KeepAlive3d({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      style={{ display: active ? 'block' : 'none' }}
      className="absolute inset-0"
    >
      {children}
    </div>
  );
}
