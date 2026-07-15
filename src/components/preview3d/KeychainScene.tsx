// キーホルダーモードの 3D シーングラフ。
//
// 板は穴中心を支点にして吊り下がり、リング・チェーン・クラスプを経て固定端に繋がる。
// 「振り子ボタン」で小さな角運動量を与えると、実際に振子のように揺れる（視覚確認用）。
// 床は不要：キーホルダーはクラスプから吊るされているため、接地面との関係は考慮しない。

import { useEffect, useMemo, useRef, type ComponentRef } from 'react';

import { Environment, Lightformer, OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import {
  DoubleSide,
  FrontSide,
  MeshPhysicalMaterial,
  type Group,
} from 'three';

import { buildTexture, buildKeychainPlateGeometry } from '@/components/preview3d/geometry3d';
import type { KeychainScene3dGeometry, Vec3 } from '@/render/scene3d';
import type { ArtworkTextures } from '@/render/texture3d';
import type { Size } from '@/model/types';

const BACKGROUND_COLOR = '#e8ecf1';

/** 板の裏面（奥面）の Z。押し出しは Z=0〜板厚に生成される。 */
const INK_GAP_MM = 0.15;

/** 振り子の重力項（rad/s²）。 */
const SWING_GRAVITY = 14;
/** 振り子の減衰。 */
const SWING_DAMPING = 1.4;
/** ボタン 1 回あたり与える角速度(rad/s)。 */
const SWING_IMPULSE = 1.6;
/** 自動回転速度(rad/s)。 */
const AUTO_ROTATE_SPEED = 0.35;

/** 1 フレームで進める時間の上限(秒)。 */
const MAX_FRAME_DELTA_SEC = 0.1;

/** 床より下へ回り込ませないための仰角の上限（真横よりわずかに上まで）。 */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.02;

export interface KeychainSceneProps {
  /** キーホルダーモードのシーン幾何。 */
  geometry: KeychainScene3dGeometry;
  /** 絵柄・白版テクスチャ。 */
  textures: ArtworkTextures;
  /** 印刷レイヤを切り抜く alphaTest。 */
  inkAlphaTest: number;
  /** 自動回転。 */
  autoRotate: boolean;
  /** 振り子のトリガー。値が変わるたびに新しい角運動量を与える。 */
  swingToken: number;
  /** 視点リセットのトリガー。 */
  resetToken?: number;
  /** 背面に保護用アクリル板を表示するか。 */
  showBackPlate?: boolean;
  /** 背面アクリル板に貼る画像の canvas。null なら無地。 */
  backTextureCanvas?: HTMLCanvasElement | null;
  /** 背面画像の実寸(mm)。null なら画像を貼らない。 */
  backImageSizeMm?: Size | null;
}

export function KeychainScene({
  geometry,
  textures,
  inkAlphaTest,
  autoRotate,
  swingToken,
  resetToken = 0,
  showBackPlate = false,
  backTextureCanvas = null,
  backImageSizeMm = null,
}: KeychainSceneProps) {
  const { plate, artwork, holeRadiusMm, chainLengthMm, ringRadiusMm, claspLengthMm, camera } =
    geometry;

  const plateGeometry = useMemo(
    () => buildKeychainPlateGeometry({ ...plate, holeRadiusMm }),
    [plate, holeRadiusMm],
  );
  const artworkTexture = useMemo(() => buildTexture(textures.artwork), [textures.artwork]);
  const whiteTexture = useMemo(() => buildTexture(textures.white), [textures.white]);
  const backTexture = useMemo(
    () => (backTextureCanvas ? buildTexture(backTextureCanvas) : null),
    [backTextureCanvas],
  );
  const metalMaterial = useMemo(
    () =>
      new MeshPhysicalMaterial({
        color: '#c0c5ce',
        metalness: 0.85,
        roughness: 0.25,
        clearcoat: 0.4,
        clearcoatRoughness: 0.2,
      }),
    [],
  );

  useEffect(() => () => plateGeometry.dispose(), [plateGeometry]);
  useEffect(() => () => artworkTexture.dispose(), [artworkTexture]);
  useEffect(() => () => whiteTexture.dispose(), [whiteTexture]);
  useEffect(() => () => backTexture?.dispose(), [backTexture]);
  useEffect(() => () => metalMaterial.dispose(), [metalMaterial]);

  const backPlateZ = -INK_GAP_MM * 2;
  // 白版・背面板・背面画像が同じ深度を夺い合わないよう、INK_GAP 刻みで奥へずらす。
  const backPlatePositionZ = backPlateZ - INK_GAP_MM - plate.thicknessMm;
  const backImageZ = backPlateZ - INK_GAP_MM * 2 - plate.thicknessMm;

  const controlsRef = useRef<ComponentRef<typeof OrbitControls> | null>(null);

  const turntableRef = useRef<Group>(null);
  const pendulumRef = useRef<Group>(null);
  const angleRef = useRef(0);
  const velocityRef = useRef(0);
  const lastSwingTokenRef = useRef(swingToken);

  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    if (swingToken !== lastSwingTokenRef.current) {
      lastSwingTokenRef.current = swingToken;
      velocityRef.current += SWING_IMPULSE * (Math.random() > 0.5 ? 1 : -1);
      invalidate();
    }
  }, [swingToken, invalidate]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, MAX_FRAME_DELTA_SEC);
    let needsFrame = autoRotate;

    if (autoRotate && turntableRef.current) {
      turntableRef.current.rotation.y += AUTO_ROTATE_SPEED * dt;
    }

    // 振り子積分。
    velocityRef.current +=
      (-SWING_GRAVITY * Math.sin(angleRef.current) - SWING_DAMPING * velocityRef.current) * dt;
    angleRef.current += velocityRef.current * dt;

    if (pendulumRef.current) {
      pendulumRef.current.rotation.z = angleRef.current;
    }

    const still = Math.abs(angleRef.current) < 0.002 && Math.abs(velocityRef.current) < 0.002;
    if (still) {
      angleRef.current = 0;
      velocityRef.current = 0;
    } else {
      needsFrame = true;
    }

    if (needsFrame) {
      invalidate();
    }
  });

  const ringCenterY = -(claspLengthMm + chainLengthMm);
  const linkCount = 5;
  const linkRadius = 1.8;
  const linkTube = 0.45;

  return (
    <>
      <color attach="background" args={[BACKGROUND_COLOR]} />

      <ambientLight intensity={1.1} />
      <directionalLight position={[300, 500, 400]} intensity={1.5} />
      <Environment resolution={256}>
        <Lightformer intensity={2.4} position={[0, 300, 300]} scale={[400, 200, 1]} />
        <Lightformer intensity={1.2} position={[-350, 150, 150]} scale={[200, 300, 1]} />
        <Lightformer intensity={1.2} position={[350, 150, 150]} scale={[200, 300, 1]} />
        <Lightformer intensity={0.6} position={[0, -200, -300]} scale={[400, 200, 1]} />
      </Environment>

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={MAX_POLAR_ANGLE}
        minDistance={Math.max(2, -ringCenterY * 0.1)}
        maxDistance={Math.max(500, -ringCenterY * 8)}
      />
      <CameraRig frame={camera} resetToken={resetToken} controlsRef={controlsRef} />

      {/* 自動回転台：Y 軸まわりにゆっくり回転する外殻。 */}
      <group ref={turntableRef}>
        {/* 振り子：クラスプ先端を原点に、Z 軸まわりに揺れる。 */}
        <group ref={pendulumRef}>
          {/* クラスプ（固定端）。 */}
          <group>
            {/* 取り付けリング。 */}
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[2.5, 0.6, 10, 32]} />
              <primitive object={metalMaterial} attach="material" />
            </mesh>
            {/* 本体。 */}
            <mesh position={[0, -claspLengthMm / 2 - 1, 0]}>
              <boxGeometry args={[4.5, claspLengthMm, 1.6]} />
              <primitive object={metalMaterial} attach="material" />
            </mesh>
          </group>

          {/* チェーン。 */}
          {Array.from({ length: linkCount }, (_, i) => {
            const t = (i + 1) / (linkCount + 1);
            const y = -claspLengthMm - chainLengthMm * t;
            return (
              <mesh
                key={i}
                position={[0, y, 0]}
                rotation={i % 2 === 0 ? [Math.PI / 2, 0, 0] : [0, Math.PI / 2, 0]}
              >
                <torusGeometry args={[linkRadius, linkTube, 8, 24]} />
                <primitive object={metalMaterial} attach="material" />
              </mesh>
            );
          })}

          {/* キーリング（板の穴に通る）。 */}
          <mesh position={[0, ringCenterY, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[ringRadiusMm, 0.5, 10, 32]} />
            <primitive object={metalMaterial} attach="material" />
          </mesh>

          {/* アクリル板＋印刷レイヤ。板の裏面を Z=0、表面を Z=板厚とする。 */}
          <group position={[0, ringCenterY, 0]}>
            <mesh geometry={plateGeometry}>
              <AcrylicMaterial thicknessMm={plate.thicknessMm} />
            </mesh>

            <mesh position={[artwork.centerX, artwork.centerY, -INK_GAP_MM]}>
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

            <mesh position={[artwork.centerX, artwork.centerY, -INK_GAP_MM * 2]}>
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

            {/* 背面保護アクリル板。白版のすぐ後ろに同じカットライン・同じ向きで配置し、
                前から見たとき輪郭が前面板と重なるようにする（リング穴も一直線に通る）。 */}
            {showBackPlate && (
              <mesh geometry={plateGeometry} position={[0, 0, backPlatePositionZ]}>
                <AcrylicMaterial thicknessMm={plate.thicknessMm} side={DoubleSide} />
              </mesh>
            )}

            {/* 背面画像：背面板の外側（奥面）に貼る。 */}
            {showBackPlate && backTexture && backImageSizeMm && (
              <mesh position={[artwork.centerX, artwork.centerY, backImageZ]}>
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
          </group>
        </group>
      </group>
    </>
  );
}

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

function CameraRig({
  frame,
  resetToken,
  controlsRef,
}: {
  frame: { position: Vec3; target: Vec3 };
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
