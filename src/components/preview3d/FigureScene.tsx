// 3D プレビューのシーングラフ（React Three Fiber）。
//
// 実寸(mm)のシーン座標系（原点 = 接地面上の台座中心・Y 上正・Z 前正。render/scene3d 参照）で
// 以下を組み立てる：
//
//   アクリル板 …… 統合カットラインを板厚ぶん押し出したソリッド（透明アクリル素材）
//   印刷レイヤ …… 板の裏面へ「絵柄 → 白版」の順に重ねた 2 枚の平面（実物の UV 印刷の再現）
//   台座 …… 貫通スリットを開けた同じ厚みのアクリル板
//   環境 …… 床（テクスチャ・実寸グリッド。components/preview3d/Floor）+ 接地影
//            + ソフトな環境光（スタジオ風）
//
// 傾け（転倒シミュレーション）は、台座 footprint 凸包の支持直線（＝床に触れている接触辺・接触点）を
// 軸にした 1 段の group 回転で表す（姿勢の計算は render/tilt3d）。分解アニメーションは板だけを
// +Y へ動かす group で表す。どちらも解析結果には触れない表示専用の変形であり、ジオメトリは
// 作り直さない。

import { useEffect, useMemo, useRef, type ComponentRef, type ReactNode } from 'react';

import { ContactShadows, Environment, Lightformer, Line, OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { DoubleSide, FrontSide, Quaternion, Vector3, type Group } from 'three';

import { Floor } from '@/components/preview3d/Floor';
import {
  buildBaseGeometry,
  buildPlateGeometry,
  buildTexture,
} from '@/components/preview3d/geometry3d';
import type { Scene3dCamera, Scene3dGeometry } from '@/render/scene3d';
import type { ArtworkTextures } from '@/render/texture3d';
import type { Size } from '@/model/types';
import { tiltPose } from '@/render/tilt3d';

/** 背景の色。商品写真のスタジオを模した無彩色（SPEC「背景は単色」）。 */
const BACKGROUND_COLOR = '#e8ecf1';

/**
 * 印刷レイヤの間隔(mm)。実物のインクは板の裏面に載る（＝アクリルの外側）ため、板の裏面より
 * わずかに奥へ置く。深度バッファの分解能より十分大きく、かつ実寸としては無視できる厚み。
 */
const INK_GAP_MM = 0.15;

/** 分解／組立アニメーションの所要時間(秒)。 */
const EXPLODE_DURATION_SEC = 0.6;

/** 1 フレームで進める時間の上限(秒)。タブ復帰直後の巨大な delta で一気に飛ぶのを防ぐ。 */
const MAX_FRAME_DELTA_SEC = 0.1;

/** 支点エッジのハイライト色。転倒角の内側（安全）／超過（警告）。 */
const PIVOT_SAFE_COLOR = '#f97316';
const PIVOT_FALLING_COLOR = '#ef4444';

/** 床より下へ回り込ませないための仰角の上限（真横よりわずかに上まで）。 */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.02;

export interface FigureSceneProps {
  geometry: Scene3dGeometry;
  textures: ArtworkTextures;
  /** 印刷レイヤを切り抜く alphaTest のしきい値（render/texture3d の inkAlphaTest）。 */
  inkAlphaTest: number;
  /** 傾ける方向の方位角(度)。右 0°・前 90°・左 180°・後 270°。 */
  tiltAzimuthDeg: number;
  /** その方位へ倒す量(度)。0 で直立。 */
  tiltDeg: number;
  /** 分解（板を持ち上げて台座から抜く）状態か。 */
  exploded: boolean;
  /** 台座を強めの半透明にするか（スリット内のツメの収まりを透かして見る）。 */
  translucentBase: boolean;
  /** 背面に保護用アクリル板を表示するか。 */
  showBackPlate: boolean;
  /** 背面アクリル板に貼る画像の canvas。null なら無地。 */
  backTextureCanvas: HTMLCanvasElement | null;
  /** 背面画像の実寸(mm)。null なら画像を貼らない。 */
  backImageSizeMm: Size | null;
  /** 床へ貼るテクスチャ画像。null なら無地の床。 */
  floorImage: ImageBitmap | null;
  /** 床に実寸グリッドを表示するか。 */
  floorGrid: boolean;
  /** インクリメントすると初期構図へ戻る（視点リセット）。 */
  resetToken: number;
  /** ドロップテストの進行状態。 */
  dropPhase: 'idle' | 'dropping' | 'landed';
  /** ドロップテストの高さ(mm)。 */
  dropHeightMm: number;
  /** ドロップ後の安定判定。未着陸なら null。 */
  dropStable: boolean | null;
  /** ドロップアニメーションが完了したときに呼ばれる。 */
  onDropLanded: (stable: boolean) => void;
}

export function FigureScene({
  geometry,
  textures,
  inkAlphaTest,
  tiltAzimuthDeg,
  tiltDeg,
  exploded,
  translucentBase,
  showBackPlate,
  backTextureCanvas,
  backImageSizeMm,
  floorImage,
  floorGrid,
  resetToken,
  dropPhase,
  dropHeightMm,
  dropStable,
  onDropLanded,
}: FigureSceneProps) {
  const { plate, base, artwork, tilt, explodeLiftMm, camera } = geometry;
  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);

  // ジオメトリ・テクスチャは解析結果／画像が変わったときだけ作り直す（SPEC の性能要件）。
  // R3F は props で渡したオブジェクトを破棄しないため、差し替え時の解放は自分で行う。
  const plateGeometry = useMemo(() => buildPlateGeometry(plate), [plate]);
  const baseGeometry = useMemo(() => buildBaseGeometry(base), [base]);
  const artworkTexture = useMemo(() => buildTexture(textures.artwork), [textures.artwork]);
  const whiteTexture = useMemo(() => buildTexture(textures.white), [textures.white]);
  const backTexture = useMemo(
    () => (backTextureCanvas ? buildTexture(backTextureCanvas) : null),
    [backTextureCanvas],
  );
  useEffect(() => () => plateGeometry.dispose(), [plateGeometry]);
  useEffect(() => () => baseGeometry.dispose(), [baseGeometry]);
  useEffect(() => () => artworkTexture.dispose(), [artworkTexture]);
  useEffect(() => () => whiteTexture.dispose(), [whiteTexture]);
  useEffect(() => () => backTexture?.dispose(), [backTexture]);

  // 板の裏面（奥）の Z。印刷レイヤはここからさらに奥へ 2 枚重ねる。
  const plateBackZ = plate.centerZMm - plate.thicknessMm / 2;

  // 傾けの姿勢（支点・回転軸・その方位の転倒角）。支点は凸包の支持直線＝実際に床へ触れている
  // 接触辺・接触点なので、円・楕円を斜めへ倒しても台座が浮かない（render/tilt3d）。
  // ドロップテストが着地後に不安定だった場合は、最悪方位の支持辺を軸に 90° 倒れた姿勢へ切り替える。
  const pose = useMemo(
    () =>
      dropPhase === 'landed' && dropStable === false
        ? tiltPose(tilt, tiltAzimuthDeg, 90)
        : tiltPose(tilt, tiltAzimuthDeg, tiltDeg),
    [dropPhase, dropStable, tilt, tiltAzimuthDeg, tiltDeg],
  );
  const quaternion = useMemo(
    () => new Quaternion().setFromAxisAngle(new Vector3(...pose.axis), pose.angleRad),
    [pose],
  );

  const shadowScaleMm = Math.max(base.widthMm, base.depthMm) * 2.6;

  return (
    <>
      <color attach="background" args={[BACKGROUND_COLOR]} />

      {/* ソフトな環境光。外部 HDRI は取得しない（完全クライアントサイドの制約）ため、
          面光源（Lightformer）から環境マップをその場で焼き、透明素材の映り込みに使う。 */}
      <ambientLight intensity={1.1} />
      <directionalLight position={[300, 500, 400]} intensity={1.5} />
      <Environment resolution={256}>
        <Lightformer intensity={2.4} position={[0, 300, 300]} scale={[400, 200, 1]} />
        <Lightformer intensity={1.2} position={[-350, 150, 150]} scale={[200, 300, 1]} />
        <Lightformer intensity={1.2} position={[350, 150, 150]} scale={[200, 300, 1]} />
        <Lightformer intensity={0.6} position={[0, -200, -300]} scale={[400, 200, 1]} />
      </Environment>

      {/* 床（テクスチャ + 実寸グリッド）と接地影。影は被写体を真下から撮った深度で作るため、
          傾けても追従する。 */}
      <Floor image={floorImage} grid={floorGrid} />
      <ContactShadows
        position={[0, 0, 0]}
        scale={shadowScaleMm}
        far={Math.max(plate.topYMm, 1)}
        resolution={512}
        blur={2.5}
        opacity={0.45}
        color="#1e293b"
      />

      {/* 傾け：支持直線（支点）へ原点を移してから、その直線を軸に回し、元へ戻す。軸は方位に
          応じて斜めを向くためオイラー角では表せず、軸角からクォータニオンを作る。
          ドロップテストはこのグループ全体を高さ方向に動かし、不安定なら倒れた姿勢へ切り替える。 */}
      <DropTestGroup
        phase={dropPhase}
        heightMm={dropHeightMm}
        stable={dropStable ?? true}
        onLanded={onDropLanded}
      >
        <group position={[...pose.pivot]} quaternion={quaternion}>
          <group position={[-pose.pivot[0], 0, -pose.pivot[2]]}>
            {/* 台座。半透明トグル時のみ transmission をやめた素直なアルファ合成にして、
                スリット内のツメが背後に透けて見えるようにする。 */}
            <mesh geometry={baseGeometry} rotation={[-Math.PI / 2, 0, 0]}>
            {translucentBase ? (
              <meshPhysicalMaterial
                color="#cfe3f5"
                transparent
                opacity={0.28}
                depthWrite={false}
                roughness={0.12}
                metalness={0}
                ior={1.49}
                envMapIntensity={0.8}
              />
            ) : (
              <AcrylicMaterial thicknessMm={base.thicknessMm} />
            )}
          </mesh>

          {/* アクリル板 + 印刷レイヤ。分解時はこの group ごと上へ抜ける。 */}
          <ExplodeGroup liftMm={explodeLiftMm} exploded={exploded}>
            <mesh geometry={plateGeometry} position={[0, 0, plateBackZ]}>
              <AcrylicMaterial thicknessMm={plate.thicknessMm} />
            </mesh>

            {/* 絵柄（白版と合成済み）：板の裏面のすぐ奥。前から見るとアクリル越しに
                見え、後ろからは白版に隠れる（＝表面のみ描画）。
                半透明ではなく alphaTest で切り抜くのは、アクリルの透過（transmission）が
                背景バッファへ不透明オブジェクトしか描かないため（render/texture3d 参照）。 */}
            <mesh position={[artwork.centerX, artwork.centerY, plateBackZ - INK_GAP_MM]}>
              <planeGeometry args={[artwork.width, artwork.height]} />
              <meshStandardMaterial
                map={artworkTexture}
                alphaTest={inkAlphaTest}
                alphaToCoverage
                side={FrontSide}
                roughness={0.9}
                metalness={0}
              />
            </mesh>

            {/* 白版：絵柄のさらに奥。不透明領域だけを白で覆い、後ろから見ると
                これが直接見える（絵柄は表面のみなので裏からは映らない）。 */}
            <mesh position={[artwork.centerX, artwork.centerY, plateBackZ - INK_GAP_MM * 2]}>
              <planeGeometry args={[artwork.width, artwork.height]} />
              <meshStandardMaterial
                map={whiteTexture}
                alphaTest={inkAlphaTest}
                alphaToCoverage
                side={DoubleSide}
                color="#ffffff"
                roughness={0.9}
                metalness={0}
              />
            </mesh>

            {/* 背面保護アクリル板。白版のすぐ後ろに、同じカットラインで板厚分奥へ向けて
                配置する。解析には影響せず、視覚確認用の表示オプション。両面描画にして
                後ろからも見えるようにする。 */}
            {showBackPlate && (
              <mesh
                geometry={plateGeometry}
                position={[0, 0, plateBackZ - INK_GAP_MM * 2]}
                rotation={[0, Math.PI, 0]}
              >
                <AcrylicMaterial thicknessMm={plate.thicknessMm} side={DoubleSide} />
              </mesh>
            )}

            {/* 背面画像：背面板の外側（奥面）に貼る。 */}
            {showBackPlate && backTexture && backImageSizeMm && (
              <mesh
                position={[
                  artwork.centerX,
                  artwork.centerY,
                  plateBackZ - INK_GAP_MM * 2 - plate.thicknessMm,
                ]}
              >
                <planeGeometry args={[backImageSizeMm.width, backImageSizeMm.height]} />
                <meshStandardMaterial
                  map={backTexture}
                  alphaTest={inkAlphaTest}
                  alphaToCoverage
                  side={DoubleSide}
                  roughness={0.9}
                  metalness={0}
                />
              </mesh>
            )}
          </ExplodeGroup>

          {/* 支点のハイライト（接触辺、または接触点での接線）。ガイドは常時出さず、傾けている
              ときだけ見せる（完成プレビューと同じ「素の見た目を邪魔しない」思想。SPEC）。 */}
          {tiltDeg !== 0 && (
            <Line
              points={[[...pose.edge[0]], [...pose.edge[1]]]}
              color={pose.falling ? PIVOT_FALLING_COLOR : PIVOT_SAFE_COLOR}
              lineWidth={3}
            />
          )}
        </group>
      </group>
      </DropTestGroup>

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={MAX_POLAR_ANGLE}
        minDistance={Math.max(2, plate.topYMm * 0.05)}
        maxDistance={Math.max(500, plate.topYMm * 8)}
      />
      <CameraRig frame={camera} resetToken={resetToken} controlsRef={controlsRef} />
    </>
  );
}

/** ドロップテストアニメーションの所要時間(秒)。 */
const DROP_DURATION_SEC = 0.5;

/**
 * ドロップテスト：figure 全体を高さ方向に下げ、床に着いたら安定判定を親へ通知する。
 *
 * 不安定な構成では着地後に倒れた姿勢へ切り替わるが、その判定は静的転倒角
 * （geometry.tilt.minTippingDeg）を使う。アニメーション中は on-demand 描画を
 * invalidate() で自走させ、静止後は GPU を使わない。
 */
function DropTestGroup({
  phase,
  heightMm,
  stable,
  onLanded,
  children,
}: {
  phase: 'idle' | 'dropping' | 'landed';
  heightMm: number;
  stable: boolean;
  onLanded: (stable: boolean) => void;
  children: ReactNode;
}) {
  const groupRef = useRef<Group>(null);
  const progressRef = useRef(0);
  const landedRef = useRef(false);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (phase === 'dropping') {
      progressRef.current = 0;
      landedRef.current = false;
      invalidate();
    } else {
      const group = groupRef.current;
      if (group && group.position.y !== 0) {
        group.position.y = 0;
        invalidate();
      }
    }
  }, [phase, heightMm, invalidate]);

  useFrame((_, delta) => {
    if (phase !== 'dropping') {
      return;
    }
    const step = Math.min(delta, MAX_FRAME_DELTA_SEC) / DROP_DURATION_SEC;
    const next = Math.min(1, progressRef.current + step);
    progressRef.current = next;
    const group = groupRef.current;
    if (group) {
      group.position.y = heightMm * (1 - easeInOutCubic(next));
    }
    if (next === 1) {
      if (!landedRef.current) {
        landedRef.current = true;
        onLanded(stable);
      }
    } else {
      invalidate();
    }
  });

  return <group ref={groupRef}>{children}</group>;
}

/**
 * 透明アクリルの素材（板・台座で共有）。
 *
 * transmission（透過）で背後を屈折させ、環境マップの映り込みと弱い減衰色で「厚みのある
 * 透明樹脂」に見せる。thickness は減衰計算に使う実寸の厚み(mm)なので、板厚をそのまま渡す。
 */
function AcrylicMaterial({
  thicknessMm,
  side,
}: {
  thicknessMm: number;
  side?: 0 | 1 | 2;
}) {
  return (
    <meshPhysicalMaterial
      color="#ffffff"
      transmission={1}
      thickness={thicknessMm}
      ior={1.49}
      roughness={0.08}
      metalness={0}
      clearcoat={0.3}
      clearcoatRoughness={0.15}
      attenuationColor="#eaf4f6"
      attenuationDistance={150}
      envMapIntensity={1.1}
      side={side ?? FrontSide}
    />
  );
}

/** 3 次のイーズイン・アウト。分解／組立の加減速に使う。 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * 分解／組立アニメーション。板を +Y へ持ち上げ（分解）／降ろす（組立）。
 *
 * オンデマンド描画（frameloop="demand"）では、状態が変わっても自分でフレームを要求しない
 * 限り useFrame は呼ばれない。そこで目標が変わったら invalidate() で 1 フレーム起こし、
 * 以降は「目標へ届くまで自分で次フレームを要求し続ける」ことで自走させる。到達後は要求を
 * やめるので、静止中は GPU を使わない。
 */
function ExplodeGroup({
  liftMm,
  exploded,
  children,
}: {
  liftMm: number;
  exploded: boolean;
  children: ReactNode;
}) {
  const groupRef = useRef<Group>(null);
  const progressRef = useRef(exploded ? 1 : 0);
  const invalidate = useThree((state) => state.invalidate);

  // 目標の変化（ボタン）と持ち上げ量の変化（パラメータ変更）に反応する。後者では
  // アニメーションを走らせず、現在の進捗のまま新しい高さへ即時追従させる。
  useEffect(() => {
    const group = groupRef.current;
    if (group) {
      group.position.y = liftMm * easeInOutCubic(progressRef.current);
    }
    invalidate();
  }, [exploded, liftMm, invalidate]);

  useFrame((_, delta) => {
    const target = exploded ? 1 : 0;
    const current = progressRef.current;
    if (current === target) {
      return;
    }
    const step = Math.min(delta, MAX_FRAME_DELTA_SEC) / EXPLODE_DURATION_SEC;
    const next =
      target > current ? Math.min(target, current + step) : Math.max(target, current - step);
    progressRef.current = next;

    const group = groupRef.current;
    if (group) {
      group.position.y = liftMm * easeInOutCubic(next);
    }
    if (next !== target) {
      invalidate();
    }
  });

  return <group ref={groupRef}>{children}</group>;
}

/**
 * 初期構図の適用と視点リセット。
 *
 * 構図（camera）はパラメータ変更のたびに作り直されるが、そのつどカメラを動かすと
 * ユーザーのオービット操作を勝手に破棄してしまう。そこで最新の構図は ref で参照するに留め、
 * **初回マウントと resetToken の変化**でのみカメラへ適用する。
 */
function CameraRig({
  frame,
  resetToken,
  controlsRef,
}: {
  frame: Scene3dCamera;
  resetToken: number;
  controlsRef: React.RefObject<ComponentRef<typeof OrbitControls> | null>;
}) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const frameRef = useRef(frame);

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  useEffect(() => {
    const target = frameRef.current;
    camera.position.set(...target.position);
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(...target.target);
      controls.update();
    } else {
      camera.lookAt(...target.target);
    }
    invalidate();
  }, [resetToken, camera, controlsRef, invalidate]);

  return null;
}
