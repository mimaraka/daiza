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
//
// ドロップテストは @react-three/rapier で剛体シミュレーションを行う。落下開始時の傾き・方向を
// そのまま初期姿勢とし、世界の重力（mm/s²）で床へ落下・着地後のバランスを物理的に再現する。

import { useEffect, useMemo, useRef, type ComponentRef, type ReactNode } from 'react';

import { ContactShadows, Environment, Lightformer, Line, OrbitControls } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { RigidBodyType } from '@dimforge/rapier3d-compat';
import {
  Physics,
  RigidBody,
  ConvexHullCollider,
  CuboidCollider,
  type RapierRigidBody,
} from '@react-three/rapier';
import {
  BufferGeometry,
  DoubleSide,
  FrontSide,
  Quaternion,
  Vector3,
  type Group,
} from 'three';

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

/** 重力（mm/s²）。実世界の 9.8 m/s² を mm 単位へ換算。 */
const GRAVITY_MM_PER_SEC2 = 9800;

/** 静止判定：並進速度閾値(mm/s)。 */
const REST_SPEED_THRESHOLD = 1;

/** 静止判定：角速度閾値(rad/s)。 */
const REST_ANGULAR_SPEED_THRESHOLD = 0.05;

/** 静止判定：連続して閾値以下だったフレーム数。 */
const REST_FRAMES = 10;

/** 安定とみなす「上向き」成分の閾値（local +Y の world Y）。cos(45°) ≈ 0.707。 */
const STABLE_UP_Y_THRESHOLD = 0.7;

/** ドロップテストの最大継続時間(秒)。経過しても静止検出が出ない場合は強制終了する。 */
const MAX_DROP_TIME_SEC = 2;

export interface FigureSceneProps {
  /** 解析結果。3D モードは結果があるときのみ有効なので必須。 */
  geometry: Scene3dGeometry;
  /** 読み込み済み画像。絵柄・白版テクスチャの素材にする。 */
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
  /** ドロップアニメーションが完了したときに呼ばれる。stable は物理結果から判定する。 */
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
  const pose = useMemo(
    () => tiltPose(tilt, tiltAzimuthDeg, tiltDeg),
    [tilt, tiltAzimuthDeg, tiltDeg],
  );

  // RigidBody のローカル原点は「回転前の台座中心（＝世界原点）」に合わせている。
  // 支点 pivot を軸に回すのと等価な RigidBody 姿勢は：
  //   rbPos = pivot - quaternion * pivot
  //   rbRot = quaternion
  // これにより子メッシュを世界座標のまま RigidBody へ入れても正しい位置になる。
  const { rbPosition, rbRotation } = useMemo(() => {
    const pivot = new Vector3(...pose.pivot);
    const axis = new Vector3(...pose.axis);
    const quaternion = new Quaternion().setFromAxisAngle(axis, pose.angleRad);
    const rotatedPivot = pivot.clone().applyQuaternion(quaternion);
    const position = new Vector3().subVectors(pivot, rotatedPivot);
    return { rbPosition: position, rbRotation: quaternion };
  }, [pose]);

  const shadowScaleMm = Math.max(base.widthMm, base.depthMm) * 2.6;

  // ConvexHullCollider の args は Float32Array を新規作成する。レンダーごとに作り直すと
  // コライダーが毎フレーム再生成されて重く・不安定になるため、ジオメトリが変わったときだけ
  // 作り直す。
  const baseHullArgs = useMemo(() => hullArgs(baseGeometry), [baseGeometry]);
  const plateHullArgs = useMemo(() => hullArgs(plateGeometry), [plateGeometry]);

  // R3F の props として配列を渡すとき、レンダーごとに新しい配列を作らないよう固定する。
  // これによりメッシュ・コライダーの不要な更新を防ぐ。
  const gravity = useMemo(() => [0, -GRAVITY_MM_PER_SEC2, 0] as [number, number, number], []);
  const baseMeshRotation = useMemo(() => [-Math.PI / 2, 0, 0] as [number, number, number], []);
  const plateMeshPosition = useMemo(() => [0, 0, plateBackZ] as [number, number, number], [plateBackZ]);
  // 白版・背面板・背面画像が同じ深度を夺い合わないよう、INK_GAP 刻みで奥へずらす。
  const backPlatePosition = useMemo(
    () => [0, 0, plateBackZ - INK_GAP_MM * 3 - plate.thicknessMm] as [number, number, number],
    [plateBackZ, plate.thicknessMm],
  );
  const floorColliderArgs = useMemo(() => [1000, 0.1, 1000] as [number, number, number], []);
  const floorColliderPosition = useMemo(() => [0, -0.1, 0] as [number, number, number], []);

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

      <Physics
        gravity={gravity}
        lengthUnit={1000}
        updateLoop="independent"
        key={`${plateGeometry.uuid}-${baseGeometry.uuid}`}
      >
        {/* ドロップテスト：剛体で落下させる。通常時は kinematicPosition でスライダーの姿勢を再現。 */}
        <PhysicsFigure
          rbPosition={rbPosition}
          rbRotation={rbRotation}
          dropPhase={dropPhase}
          dropHeightMm={dropHeightMm}
          onDropLanded={onDropLanded}
        >
          {/* 台座。半透明トグル時のみ transmission をやめた素直なアルファ合成にして、
              スリット内のツメが背後に透けて見えるようにする。 */}
          <mesh geometry={baseGeometry} rotation={baseMeshRotation}>
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
            <mesh geometry={plateGeometry} position={plateMeshPosition}>
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

            {/* 背面保護アクリル板。白版のすぐ後ろに、同じカットライン・同じ向きで配置する。
                前から見たとき輪郭が前面板と重なるよう、回転せず奥へずらす。 */}
            {showBackPlate && (
              <mesh geometry={plateGeometry} position={backPlatePosition}>
                <AcrylicMaterial thicknessMm={plate.thicknessMm} side={DoubleSide} />
              </mesh>
            )}

            {/* 背面画像：背面板の外側（奥面）に貼る。 */}
            {showBackPlate && backTexture && backImageSizeMm && (
              <mesh
                position={[
                  artwork.centerX,
                  artwork.centerY,
                  plateBackZ - INK_GAP_MM * 4 - plate.thicknessMm,
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
              ときだけ見せる（完成プレビューと同じ「素の見た目を邪魔しない」思想。SPEC）。
              ドロップ中は支点概念が成り立たないため非表示。 */}
          {tiltDeg !== 0 && dropPhase !== 'dropping' && (
            <Line
              points={[[...pose.edge[0]], [...pose.edge[1]]]}
              color={pose.falling ? PIVOT_FALLING_COLOR : PIVOT_SAFE_COLOR}
              lineWidth={3}
            />
          )}

          {/* 衝突判定：台座（convex hull。trimesh より軽く、スリットは埋まるが落下挙動には十分）。 */}
          <ConvexHullCollider
            args={baseHullArgs}
            rotation={baseMeshRotation}
            restitution={0.2}
            friction={0.5}
          />
          {/* 衝突判定：アクリル板本体。 */}
          <ConvexHullCollider
            args={plateHullArgs}
            position={plateMeshPosition}
            restitution={0.2}
            friction={0.5}
          />
          {/* 衝突判定：背面保護板（表示時）。 */}
          {showBackPlate && (
            <ConvexHullCollider
              args={plateHullArgs}
              position={backPlatePosition}
              restitution={0.2}
              friction={0.5}
            />
          )}
        </PhysicsFigure>

        {/* 床の衝突判定。見た目の床と同じ高さ（y=0）に上面を合わせる。 */}
        <RigidBody type="fixed" colliders={false}>
          <CuboidCollider
            args={floorColliderArgs}
            position={floorColliderPosition}
            restitution={0.2}
            friction={0.5}
          />
        </RigidBody>
      </Physics>

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

/**
 * ドロップテスト：figure 全体を Rapier の剛体として扱い、高さ方向に落下させる。
 *
 * idle / landed 時は kinematicPosition でスライダーまたは最終姿勢を再現。
 * dropping 時は dynamic に切り替え、重力で自由落下・着地後のバランスを物理的に解く。
 * 静止が検出されたら最終姿勢から安定判定を行い、親へ通知する。
 */
function PhysicsFigure({
  rbPosition,
  rbRotation,
  dropPhase,
  dropHeightMm,
  onDropLanded,
  children,
}: {
  rbPosition: Vector3;
  rbRotation: Quaternion;
  dropPhase: 'idle' | 'dropping' | 'landed';
  dropHeightMm: number;
  onDropLanded: (stable: boolean) => void;
  children: ReactNode;
}) {
  const rbRef = useRef<RapierRigidBody>(null);
  const invalidate = useThree((state) => state.invalidate);

  // 最新の pose/transform を effects から参照できるよう ref で保持（レンダー後に更新）。
  const targetRef = useRef({ rbPosition, rbRotation, dropHeightMm });
  useEffect(() => {
    targetRef.current = { rbPosition, rbRotation, dropHeightMm };
  });

  // 着地後の最終姿勢を保持（landed 時の kinematic ターゲットに使う）。
  const finalPoseRef = useRef<{ position: Vector3; rotation: Quaternion } | null>(null);
  const landedReportedRef = useRef(false);
  const restFramesRef = useRef(0);
  const dropTimeRef = useRef(0);

  // dropPhase が変わったときのモード切替・初期化。
  useEffect(() => {
    const body = rbRef.current;
    if (!body) return;

    if (dropPhase === 'dropping') {
      landedReportedRef.current = false;
      restFramesRef.current = 0;
      dropTimeRef.current = 0;
      finalPoseRef.current = null;

      const start = targetRef.current;
      const startPos = start.rbPosition.clone().add(new Vector3(0, start.dropHeightMm, 0));
      body.setBodyType(RigidBodyType.Dynamic, true);
      body.setTranslation(startPos, true);
      body.setRotation(start.rbRotation, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      body.wakeUp();
    } else {
      body.setBodyType(RigidBodyType.KinematicPositionBased, true);
    }
    invalidate();
  }, [dropPhase, invalidate]);

  // idle / landed 時は kinematic ターゲットを最新の姿勢へ更新。
  useEffect(() => {
    const body = rbRef.current;
    if (!body || dropPhase === 'dropping') return;

    const pos =
      dropPhase === 'landed' && finalPoseRef.current
        ? finalPoseRef.current.position
        : targetRef.current.rbPosition;
    const rot =
      dropPhase === 'landed' && finalPoseRef.current
        ? finalPoseRef.current.rotation
        : targetRef.current.rbRotation;

    body.setNextKinematicTranslation(pos);
    body.setNextKinematicRotation(rot);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    invalidate();
  }, [rbPosition, rbRotation, dropPhase, invalidate]);

  // dropping 中は毎フレーム物理状態を監視し、静止または時間切れで強制終了する。
  useFrame((_, delta) => {
    if (dropPhase !== 'dropping') return;
    const body = rbRef.current;
    if (!body) return;

    dropTimeRef.current += Math.min(delta, MAX_FRAME_DELTA_SEC);

    if (!landedReportedRef.current) {
      const vel = body.linvel();
      const angVel = body.angvel();
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      const angSpeed = Math.hypot(angVel.x, angVel.y, angVel.z);

      const shouldFreeze =
        dropTimeRef.current >= MAX_DROP_TIME_SEC ||
        (speed < REST_SPEED_THRESHOLD && angSpeed < REST_ANGULAR_SPEED_THRESHOLD && restFramesRef.current + 1 >= REST_FRAMES);

      if (shouldFreeze) {
        landedReportedRef.current = true;
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        const t = body.translation();
        const r = body.rotation();
        finalPoseRef.current = {
          position: new Vector3(t.x, t.y, t.z),
          rotation: new Quaternion(r.x, r.y, r.z, r.w),
        };
        const upWorld = new Vector3(0, 1, 0).applyQuaternion(finalPoseRef.current.rotation);
        onDropLanded(upWorld.y > STABLE_UP_Y_THRESHOLD);
      } else if (speed < REST_SPEED_THRESHOLD && angSpeed < REST_ANGULAR_SPEED_THRESHOLD) {
        restFramesRef.current++;
      } else {
        restFramesRef.current = 0;
      }
    }

    invalidate();
  });

  return (
    <RigidBody
      ref={rbRef}
      type="kinematicPosition"
      position={rbPosition}
      quaternion={rbRotation}
      colliders={false}
      ccd
      linearDamping={0.1}
      angularDamping={0.3}
    >
      {children}
    </RigidBody>
  );
}

/**
 * BufferGeometry から ConvexHullCollider 用の頂点配列を取り出す。
 * ExtrudeGeometry は輪郭／上面／下面で頂点が重複するため、座標で重複除去して
 * convex hull の計算を軽く・安定させる。
 */
function hullArgs(geometry: BufferGeometry): [Float32Array] {
  const position = geometry.attributes.position;
  if (!position) {
    throw new Error('Convex hull collider requires geometry with position attribute');
  }
  const array = position.array as Float32Array;
  const seen = new Set<string>();
  const unique: number[] = [];
  for (let i = 0; i < array.length; i += 3) {
    const x = array[i] ?? 0;
    const y = array[i + 1] ?? 0;
    const z = array[i + 2] ?? 0;
    const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(x, y, z);
    }
  }
  return [new Float32Array(unique)];
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
