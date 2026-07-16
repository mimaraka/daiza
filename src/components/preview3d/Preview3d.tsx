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

import { useMemo, useRef, useState } from 'react';

import { Canvas } from '@react-three/fiber';
import { Blend, Crosshair, Grid3x3, Layers2 } from 'lucide-react';

import { FigureScene } from '@/components/preview3d/FigureScene';
import { useFloorTexture } from '@/components/preview3d/useFloorTexture';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import type { AnalysisResult, FigureImage } from '@/model/types';
import { CAMERA_FOV_DEG, buildScene3d } from '@/render/scene3d';
import { buildArtworkTextures, inkAlphaTest } from '@/render/texture3d';
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
}

export default function Preview3d({ result, image, alphaThreshold }: Preview3dProps) {
  // 解析結果・画像が変わったときだけ作り直す（パラメータ変更のたびの再構築は避ける）。
  const geometry = useMemo(() => buildScene3d(result), [result]);
  const textures = useMemo(
    () => buildArtworkTextures(image.bitmap, alphaThreshold),
    [image.bitmap, alphaThreshold],
  );

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

  const { tilt } = geometry;

  // その方位の転倒角。可動域（転倒角 + 余裕）と警告表示の境界になる。方向を変えると変わる。
  const limitDeg = tiltLimitDeg(tilt, tiltAzimuthDeg);
  // パラメータ変更や方向の変更で転倒角が縮むと現在値が域外になり得るため、描画・スライダーの
  // 双方でクランプ後の値を使う（state 自体は次の操作で上書きされる）。
  const tiltMaxDeg = limitDeg + TILT_MARGIN_DEG;
  const tiltAmountDeg = clamp(tiltDeg, 0, tiltMaxDeg);
  const tilted = tiltAmountDeg !== 0;

  // 方向スライダーのスナップ先。8 方位に加えて最悪方位（最小転倒角の向き）へも吸着させる。
  const snapTargets = useMemo(
    () => [...AZIMUTH_SNAP_TARGETS, normalizeAzimuth(tilt.worstAzimuthDeg)],
    [tilt.worstAzimuthDeg],
  );

  const changeAzimuth = (next: number) => {
    setTiltAzimuthDeg(snapAzimuth(next, snapTargets));
  };

  // 分解／組立は「傾き 0」の姿勢で再生する（合成姿勢を作らない。SPEC）。
  const toggleExploded = () => {
    setTiltDeg(0);
    setExploded((v) => !v);
  };

  // 方向は保持したまま量だけ 0 へ戻す（同じ方位で倒し直せるようにする）。
  const resetTilt = () => {
    setTiltDeg(0);
  };

  return (
    <div className="absolute inset-0">
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
        <FigureScene
          geometry={geometry}
          textures={textures}
          inkAlphaTest={inkAlphaTest(alphaThreshold)}
          tiltAzimuthDeg={tiltAzimuthDeg}
          tiltDeg={tiltAmountDeg}
          exploded={exploded}
          translucentBase={translucentBase}
          floorImage={floor.image}
          floorGrid={floorGrid}
          resetToken={resetToken}
        />
      </Canvas>

      {/* 3D 操作パネル。プレビュー右下の表示操作コントロールと重ならないよう左下へ置く。 */}
      <div className="bg-background/80 absolute bottom-2 left-2 w-72 rounded-md border p-2 shadow-sm backdrop-blur">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setResetToken((v) => v + 1)}
            title="視点リセット"
            aria-label="視点リセット"
          >
            <Crosshair />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleExploded}
            className={cn(exploded && 'text-primary bg-primary/10')}
            title={exploded ? '組立' : '分解'}
            aria-label={exploded ? '組立' : '分解'}
            aria-pressed={exploded}
          >
            <Layers2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setTranslucentBase((v) => !v)}
            className={cn(translucentBase && 'text-primary bg-primary/10')}
            title="台座を半透明にする"
            aria-label="台座を半透明にする"
            aria-pressed={translucentBase}
          >
            <Blend />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={resetTilt}
            disabled={!tilted}
          >
            傾きを0へ
          </Button>
        </div>

        <div className="mt-2 space-y-2">
          {/* 傾ける方向（方位角）。倒す向きを 1 本で指定するので、斜め方向でも支点と転倒角が
              一意に決まる。8 方位と最悪方位へスナップする。 */}
          <div>
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium">
                方向
                <span className="text-muted-foreground ml-1 font-normal">右0° / 前90°</span>
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
                最小転倒角 {tilt.minTippingDeg.toFixed(1)}°（
                {formatAzimuth(tilt.worstAzimuthDeg)}）
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={() => setTiltAzimuthDeg(normalizeAzimuth(tilt.worstAzimuthDeg))}
              >
                最悪方位へ
              </Button>
            </div>
          </div>

          {/* 倒す量。可動域はその方位の転倒角 + 余裕（SPEC）。 */}
          <TiltControl
            label="傾き"
            value={tiltAmountDeg}
            max={tiltMaxDeg}
            limitDeg={limitDeg}
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
            <span className="text-muted-foreground text-xs">床</span>

            {/* テクスチャの出所（既定は「なし」）。「画像…」はファイル選択ダイアログを開く
                （読み込みは createImageBitmap でブラウザ内完結。外部へは送信しない）。 */}
            <div className="ml-auto flex items-center gap-1">
              <FloorSourceButton
                active={floor.source === 'none'}
                onClick={floor.clear}
                title="テクスチャなし（無地の床）"
              >
                なし
              </FloorSourceButton>
              <FloorSourceButton
                active={floor.source === 'wood'}
                onClick={floor.selectWood}
                title="木目のサンプルテクスチャ"
              >
                木目
              </FloorSourceButton>
              <FloorSourceButton
                active={floor.source === 'custom'}
                onClick={() => floorFileRef.current?.click()}
                title="画像ファイルを床に貼る"
              >
                画像…
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
  if (error) {
    return <p className="text-destructive mt-1 text-[11px]">{error}</p>;
  }
  if (loading) {
    return <p className="text-muted-foreground mt-1 text-[11px]">テクスチャを読み込み中…</p>;
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
  label,
  value,
  max,
  limitDeg,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  limitDeg: number;
  onChange: (value: number) => void;
}) {
  const marginDeg = limitDeg - value;
  const falling = marginDeg < 0;

  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{value.toFixed(1)}°</span>
      </div>
      <Slider
        value={[value]}
        min={0}
        max={max}
        step={0.1}
        onValueChange={([next]) => onChange(next ?? 0)}
        aria-label={`${label}の量`}
        className="mt-1"
      />
      <p
        className={cn(
          'text-muted-foreground mt-1 text-[11px] tabular-nums',
          falling && 'text-destructive font-medium',
        )}
      >
        {falling
          ? `転倒（転倒角 ${limitDeg.toFixed(1)}° を超過）`
          : `転倒角 ${limitDeg.toFixed(1)}° まで余裕 ${marginDeg.toFixed(1)}°`}
      </p>
    </div>
  );
}
