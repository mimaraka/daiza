// 3D プレビューモードのルート（dynamic import で読み込まれるチャンクの入口）。
//
// three / R3F / drei への import はこのファイル以下だけに閉じる。Preview.tsx は本
// コンポーネントを React.lazy で読み込むため、2D しか使わないユーザーには 3D 一式が
// 一切ダウンロードされない（SPEC「初期バンドル・2D 利用時のロードには影響させない」）。
//
// 役割は (1) 解析結果 → シーン幾何・テクスチャの変換、(2) 表示専用の操作状態（傾け・分解・
// 台座の半透明・床のグリッド／テクスチャ・視点リセット）の保持、(3) Canvas と操作 UI の配置。
// 解析結果・パラメータは読むだけで、ここから書き換えることはない（表示のみの切替。SPEC）。
//
// 床テクスチャのアップロード UI も含め、3D の操作はすべてこのビューポート内で完結させる
// （左のパラメータパネルは解析に効く値だけを持ち、見た目の設定は持ち込まない）。

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { Canvas } from '@react-three/fiber';
import { Blend, Crosshair, Grid3x3, Layers2, Loader2 } from 'lucide-react';

import { FigureScene } from '@/components/preview3d/FigureScene';
import { KeychainScene } from '@/components/preview3d/KeychainScene';
import { useFloorTexture } from '@/components/preview3d/useFloorTexture';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { useTranslation } from '@/locales';
import { cn } from '@/lib/utils';
import type { AnalysisResult, FigureImage } from '@/model/types';
import {
  CAMERA_FOV_DEG,
  buildKeychainScene3d,
  buildScene3d,
  type KeychainScene3dGeometry,
  type Scene3dGeometry,
} from '@/render/scene3d';
import { buildArtworkTextures, buildBackTexture, inkAlphaTest } from '@/render/texture3d';
import { tiltLimitDeg } from '@/render/tilt3d';
import { formatAzimuth, normalizeAzimuth } from '@/utils/azimuth';
import { clamp } from '@/utils/geometry';

/**
 * 傾けスライダーの可動域に足す余裕(度)。転倒角ちょうどで頭打ちだと「倒れる瞬間」しか
 * 見られないため、少し超えて倒れ込むところまで動かせるようにする（SPEC「転倒角 + 余裕」）。
 */
const TILT_MARGIN_DEG = 10;

/** 方向スライダーが吸着する角度の許容差(度)。この範囲に入ったら候補角へスナップする。 */
const AZIMUTH_SNAP_TOLERANCE_DEG = 3;

/** スナップ先の基本方位（45° 刻みの 8 方位）。ここに最悪方位を足したものが候補になる。 */
const AZIMUTH_SNAP_TARGETS = [0, 45, 90, 135, 180, 225, 270, 315];

/** カメラのクリップ面(mm)。板厚(数 mm)へ寄っても破綻せず、床の端まで映る範囲。 */
const CAMERA_NEAR_MM = 1;
const CAMERA_FAR_MM = 20000;

export interface Preview3dProps {
  /** 解析結果。3D モードは結果があるときのみ有効なので必須。 */
  result: AnalysisResult;
  /** 読み込み済み画像。絵柄・白版テクスチャの素材にする。 */
  image: FigureImage;
  /** 不透明領域のしきい値。白版の 2 値化に解析と同じ判定を使うため受け取る。 */
  alphaThreshold: number;
  /** 3D プレビューで背面のアクリル板を表示するか。 */
  showBackPlate: boolean;
  /** 背面アクリル板に貼る画像。null なら無地のクリア板。 */
  backImage: FigureImage | null;
  /** アクリル板の板厚(mm)。 */
  thicknessMm: number;
}

export default function Preview3d({ result, image, alphaThreshold, showBackPlate, backImage, thicknessMm }: Preview3dProps) {
  const { t } = useTranslation();
  const isKeychain = result.keychain != null;

  // 解析結果・画像が変わったときだけ作り直す（パラメータ変更のたびの再構築は避ける）。
  const geometry = useMemo(
    () => (isKeychain ? buildKeychainScene3d(result, thicknessMm) : buildScene3d(result)),
    [result, isKeychain, thicknessMm],
  );
  const keychainHole = result.keychain;
  const textures = useMemo(
    () =>
      buildArtworkTextures(
        image.bitmap,
        alphaThreshold,
        keychainHole
          ? {
              center: keychainHole.holeCenterPixel,
              radiusMm: keychainHole.holeRadiusMm,
              mmPerPixel: result.mmPerPixel,
            }
          : undefined,
      ),
    [image.bitmap, alphaThreshold, keychainHole, result.mmPerPixel],
  );
  const backTextureCanvas = useMemo(
    () => (backImage ? buildBackTexture(backImage.bitmap) : null),
    [backImage],
  );
  const backImageSizeMm = useMemo(
    () =>
      backImage
        ? { width: backImage.width * result.mmPerPixel, height: backImage.height * result.mmPerPixel }
        : null,
    [backImage, result.mmPerPixel],
  );

  // キーホルダー固有の表示状態：自動回転と振り子のトリガー。
  const [autoRotate, setAutoRotate] = useState(true);
  const [swingToken, setSwingToken] = useState(0);

  // 傾けは「どちらへ（方位角）」「どれだけ（傾き量）」の 2 値で持つ。斜め方向でも支点と
  // 転倒角が一意に決まる表現であり、最悪方位（最小転倒角）もそのまま再現できる。
  const [tiltAzimuthDeg, setTiltAzimuthDeg] = useState(0);
  const [tiltDeg, setTiltDeg] = useState(0);
  const [exploded, setExploded] = useState(false);
  const [translucentBase, setTranslucentBase] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  // 床。グリッドは既定で表示、テクスチャは既定でなし（＝無地）。
  const [floorGrid, setFloorGrid] = useState(true);
  const floor = useFloorTexture();
  const floorFileRef = useRef<HTMLInputElement>(null);

  // Rapier WASM を先に初期化してから <Canvas> を生成する。これにより <Physics> の
  // suspend が Canvas 生成後に発生し、プレビューがアンマウントされるのを防ぐ。
  const [canvasReady, setCanvasReady] = useState(false);
  useEffect(() => {
    let canceled = false;
    void (async () => {
      const r = await import('@dimforge/rapier3d-compat');
      await r.init();
      if (!canceled) {
        setCanvasReady(true);
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  // ドロップテストの状態。高さ 0–50mm、既定 10mm。着地後は安定/転倒を表示する。
  const [dropHeightMm, setDropHeightMm] = useState(10);
  const [dropPhase, setDropPhase] = useState<'idle' | 'dropping' | 'landed'>('idle');
  const [dropStable, setDropStable] = useState<boolean | null>(null);

  const resetDrop = () => {
    if (dropPhase !== 'idle') {
      setDropPhase('idle');
      setDropStable(null);
    }
  };
  const startDrop = () => {
    // 現在の傾き・方向を初期姿勢として物理シミュレーションを開始。
    // 安定性は着地後の剛体状態から判定する。
    setExploded(false);
    setDropPhase('dropping');
    setDropStable(null);
  };

  // 台座設計モードでのみ使う傾け・転倒角関連の値。keychain モードでは null。
  const baseTilt = useMemo(() => {
    if (isKeychain) return null;
    const g = geometry as Scene3dGeometry;
    const limitDeg = tiltLimitDeg(g.tilt, tiltAzimuthDeg);
    const tiltMaxDeg = limitDeg + TILT_MARGIN_DEG;
    const tiltAmountDeg = clamp(tiltDeg, 0, tiltMaxDeg);
    return {
      tilt: g.tilt,
      limitDeg,
      tiltMaxDeg,
      tiltAmountDeg,
      tilted: tiltAmountDeg !== 0,
    };
  }, [isKeychain, geometry, tiltAzimuthDeg, tiltDeg]);

  // 方向スライダーのスナップ先。8 方位に加えて最悪方位（最小転倒角の向き）へも吸着させる。
  const snapTargets = useMemo(
    () => [...AZIMUTH_SNAP_TARGETS, normalizeAzimuth(baseTilt?.tilt.worstAzimuthDeg ?? 0)],
    [baseTilt],
  );

  const changeAzimuth = (next: number) => {
    resetDrop();
    setTiltAzimuthDeg(snapAzimuth(next, snapTargets));
  };

  // 分解／組立は「傾き 0」の姿勢で再生する（合成姿勢を作らない。SPEC）。
  const toggleExploded = () => {
    resetDrop();
    setTiltDeg(0);
    setExploded((v) => !v);
  };

  // 方向は保持したまま量だけ 0 へ戻す（同じ方位で倒し直せるようにする）。
  const resetTilt = () => {
    resetDrop();
    setTiltDeg(0);
  };

  return (
    <div className="absolute inset-0">
      {!canvasReady ? (
        <div
          role="status"
          aria-live="polite"
          className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-2"
        >
          <Loader2 className="size-8 animate-spin" />
          <p className="text-sm font-medium">{t('preview.loading3d')}</p>
        </div>
      ) : (
        <Canvas
          frameloop="demand"
          dpr={[1, 2]}
          gl={{ antialias: true }}
          camera={{
            fov: CAMERA_FOV_DEG,
            near: CAMERA_NEAR_MM,
            far: CAMERA_FAR_MM,
            position: [...geometry.camera.position],
          }}
        >
          {/* <Physics> が Rapier WASM を suspend しても Canvas ごとアンマウントしないよう、
              Canvas 内部に Suspense を置く。外側の Suspense はチャンク読み込み専用。 */}
          <Suspense fallback={null}>
            {isKeychain ? (
              <KeychainScene
                geometry={geometry as KeychainScene3dGeometry}
                textures={textures}
                inkAlphaTest={inkAlphaTest(alphaThreshold)}
                autoRotate={autoRotate}
                swingToken={swingToken}
                resetToken={resetToken}
                showBackPlate={showBackPlate}
                backTextureCanvas={backTextureCanvas}
                backImageSizeMm={backImageSizeMm}
              />
            ) : (
              <FigureScene
                geometry={geometry as Scene3dGeometry}
                textures={textures}
                inkAlphaTest={inkAlphaTest(alphaThreshold)}
                tiltAzimuthDeg={tiltAzimuthDeg}
                tiltDeg={baseTilt?.tiltAmountDeg ?? 0}
                exploded={exploded}
                translucentBase={translucentBase}
                showBackPlate={showBackPlate}
                backTextureCanvas={backTextureCanvas}
                backImageSizeMm={backImageSizeMm}
                floorImage={floor.image}
                floorGrid={floorGrid}
                resetToken={resetToken}
                dropPhase={dropPhase}
                dropHeightMm={dropHeightMm}
                onDropLanded={(stable) => {
                  setDropPhase('landed');
                  setDropStable(stable);
                }}
              />
            )}
          </Suspense>
        </Canvas>
      )}

      {/* 3D 操作パネル。プレビュー右下の表示操作コントロールと重ならないよう左下へ置く。 */}
      <div className="bg-background/80 absolute bottom-2 left-2 w-72 rounded-md border p-2 shadow-sm backdrop-blur">
        {isKeychain ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setResetToken((v) => v + 1)}
              title={t('preview3d.resetView')}
              aria-label={t('preview3d.resetView')}
            >
              <Crosshair />
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSwingToken((v) => v + 1)}>
              {t('preview3d.swing')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn('ml-auto', autoRotate && 'text-primary bg-primary/10')}
              onClick={() => setAutoRotate((v) => !v)}
            >
              {t('preview3d.autoRotate')}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  resetDrop();
                  setResetToken((v) => v + 1);
                }}
                title={t('preview3d.resetView')}
                aria-label={t('preview3d.resetView')}
              >
                <Crosshair />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleExploded}
                className={cn(exploded && 'text-primary bg-primary/10')}
                title={exploded ? t('preview3d.assemble') : t('preview3d.explode')}
                aria-label={exploded ? t('preview3d.assemble') : t('preview3d.explode')}
                aria-pressed={exploded}
              >
                <Layers2 />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setTranslucentBase((v) => !v)}
                className={cn(translucentBase && 'text-primary bg-primary/10')}
                title={t('preview3d.translucentBase')}
                aria-label={t('preview3d.translucentBase')}
                aria-pressed={translucentBase}
              >
                <Blend />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={resetTilt}
                disabled={!baseTilt?.tilted}
              >
                {t('preview3d.resetTilt')}
              </Button>
            </div>

            <div className="mt-2 space-y-2">
              {/* 傾ける方向（方位角）。倒す向きを 1 本で指定するので、斜め方向でも支点と転倒角が
                  一意に決まる。8 方位と最悪方位へスナップする。 */}
              <div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium">
                    {t('preview3d.direction')}
                    <span className="text-muted-foreground ml-1 font-normal">
                      {t('preview3d.directionHint')}
                    </span>
                  </span>
                  <span className="tabular-nums">{formatAzimuth(tiltAzimuthDeg)}</span>
                </div>
                <Slider
                  value={[tiltAzimuthDeg]}
                  min={0}
                  max={360}
                  step={1}
                  onValueChange={([next]) => changeAzimuth(next ?? 0)}
                  aria-label="傾ける方向（方位角）"
                  className="mt-1"
                />
                <div className="mt-1 flex items-baseline justify-between">
                  <p className="text-muted-foreground text-[11px] tabular-nums">
                    {t('preview3d.minTippingAngle', {
                      angle: (baseTilt?.tilt.minTippingDeg ?? 0).toFixed(1),
                      azimuth: formatAzimuth(baseTilt?.tilt.worstAzimuthDeg ?? 0),
                    })}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setTiltAzimuthDeg(normalizeAzimuth(baseTilt?.tilt.worstAzimuthDeg ?? 0))}
                  >
                    {t('preview3d.worstAzimuth')}
                  </Button>
                </div>
              </div>

              {/* 倒す量。可動域はその方位の転倒角 + 余裕（SPEC）。 */}
              <TiltControl
                value={baseTilt?.tiltAmountDeg ?? 0}
                max={baseTilt?.tiltMaxDeg ?? 0}
                limitDeg={baseTilt?.limitDeg ?? 0}
                onChange={setTiltDeg}
              />
            </div>

            {/* 床の設定。グリッド（10mm マス・50mm ごとに強調線）と、床へ貼るテクスチャの出所。 */}
            <div className="mt-2 border-t pt-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setFloorGrid((v) => !v)}
                  className={cn(floorGrid && 'text-primary bg-primary/10')}
                  title="床にグリッドを表示（10mmマス）"
                  aria-label="床にグリッドを表示"
                  aria-pressed={floorGrid}
                >
                  <Grid3x3 />
                </Button>
                <span className="text-muted-foreground text-xs">{t('preview3d.floor')}</span>

                {/* テクスチャの出所（既定は「なし」）。「画像…」はファイル選択ダイアログを開く
                    （読み込みは createImageBitmap でブラウザ内完結。外部へは送信しない）。 */}
                <div className="ml-auto flex items-center gap-1">
                  <FloorSourceButton
                    active={floor.source === 'none'}
                    onClick={floor.clear}
                    title={t('preview3d.floorNoneTitle')}
                  >
                    {t('preview3d.floorNone')}
                  </FloorSourceButton>
                  <FloorSourceButton
                    active={floor.source === 'wood'}
                    onClick={floor.selectWood}
                    title={t('preview3d.floorWoodTitle')}
                  >
                    {t('preview3d.floorWood')}
                  </FloorSourceButton>
                  <FloorSourceButton
                    active={floor.source === 'custom'}
                    onClick={() => floorFileRef.current?.click()}
                    title={t('preview3d.floorCustomTitle')}
                  >
                    {t('preview3d.floorCustom')}
                  </FloorSourceButton>
                </div>
              </div>

              <FloorStatus
                error={floor.error}
                loading={floor.loading}
                name={floor.source === 'custom' ? floor.name : null}
              />

              <input
                ref={floorFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    floor.selectFile(file);
                  }
                  // 同じファイルを選び直しても change が発火するよう、選択状態を空へ戻す。
                  event.target.value = '';
                }}
              />
            </div>

            {/* ドロップテスト：figure を指定高さから落下させ、床に着いた後の安定を見る。 */}
            <div className="mt-2 border-t pt-2">
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-medium">{t('preview3d.dropTest')}</span>
                <span className="tabular-nums">{dropHeightMm} mm</span>
              </div>
              <Slider
                value={[dropHeightMm]}
                min={0}
                max={50}
                step={1}
                disabled={dropPhase === 'dropping' || dropPhase === 'landed'}
                onValueChange={([next]) => {
                  if (next !== undefined) {
                    setDropHeightMm(next);
                  }
                }}
                aria-label={t('preview3d.dropHeight')}
                className="mt-1"
              />
              <div className="mt-2 flex items-center gap-2">
                {dropPhase === 'landed' ? (
                  <Button variant="secondary" size="sm" className="flex-1" onClick={resetDrop}>
                    {t('preview3d.resetDrop')}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    disabled={dropPhase === 'dropping'}
                    onClick={startDrop}
                  >
                    {t('preview3d.drop')}
                  </Button>
                )}
                {dropPhase === 'landed' && dropStable != null && (
                  <span
                    className={cn(
                      'text-xs font-medium',
                      dropStable ? 'text-green-600' : 'text-destructive',
                    )}
                  >
                    {dropStable ? t('preview3d.dropStable') : t('preview3d.dropUnstable')}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 床テクスチャの出所を選ぶ小さなトグルボタン（木目 / 画像… / なし）。 */
function FloorSourceButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn('h-7 px-2 text-xs', active && 'text-primary bg-primary/10')}
    >
      {children}
    </Button>
  );
}

/**
 * 床テクスチャの状態表示（読み込み中・失敗・適用中のファイル名）。
 * 失敗しても床は直前のまま残るので、クラッシュさせずメッセージだけを添える（SPEC）。
 */
function FloorStatus({
  error,
  loading,
  name,
}: {
  error: string | null;
  loading: boolean;
  name: string | null;
}) {
  const { t } = useTranslation();
  if (error) {
    return <p className="text-destructive mt-1 text-[11px]">{error}</p>;
  }
  if (loading) {
    return (
      <p className="text-muted-foreground mt-1 text-[11px]">{t('preview3d.loadingTexture')}</p>
    );
  }
  if (name) {
    return <p className="text-muted-foreground mt-1 truncate text-[11px]">{name}</p>;
  }
  return null;
}

/**
 * 方位角を候補（8 方位・最悪方位）へ吸着させる。
 * 候補ちょうどの角度はスライダーの刻み（1°）では踏みにくく、また 359° と 0° は同じ向きなので、
 * 360° をまたぐ距離で最近傍を測る。
 */
function snapAzimuth(azimuthDeg: number, targets: readonly number[]): number {
  const value = normalizeAzimuth(azimuthDeg);
  let best = value;
  let bestDistance = AZIMUTH_SNAP_TOLERANCE_DEG;
  for (const target of targets) {
    const diff = Math.abs(normalizeAzimuth(value - target + 180) - 180);
    if (diff <= bestDistance) {
      bestDistance = diff;
      best = target;
    }
  }
  return best;
}

/**
 * 傾き量のスライダー。現在の傾きと、その方位の転倒角までの余裕を併記する。
 * 転倒角を超えたら「転倒」を警告色で示す（3D 側では支点のハイライトも警告色になる）。
 */
function TiltControl({
  value,
  max,
  limitDeg,
  onChange,
}: {
  value: number;
  max: number;
  limitDeg: number;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation();
  const marginDeg = limitDeg - value;
  const falling = marginDeg < 0;

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{t('preview3d.tilt')}</span>
        <span className="tabular-nums">{value.toFixed(1)}°</span>
      </div>
      <Slider
        value={[value]}
        min={0}
        max={max}
        step={0.1}
        onValueChange={([next]) => onChange(next ?? 0)}
        aria-label={t('preview3d.tilt')}
        className="mt-1"
      />
      <p
        className={cn(
          'text-muted-foreground mt-1 text-[11px] tabular-nums',
          falling && 'text-destructive font-medium',
        )}
      >
        {falling
          ? t('preview3d.tiltFalling', { limit: limitDeg.toFixed(1) })
          : t('preview3d.tiltMargin', {
              limit: limitDeg.toFixed(1),
              margin: marginDeg.toFixed(1),
            })}
      </p>
    </div>
  );
}
