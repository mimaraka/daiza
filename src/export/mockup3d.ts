// 3D 広告用モックアップ画像の生成（DOM / three 依存のアダプタ層）。
//
// 解析結果と元画像から、既定の 3D 視点で撮影した透過 PNG 商品写真を作る。
// 背景・床・グリッド・UI を一切含まず、アクリル板＋台座＋印刷絵柄だけを描画する。
//
// three はこのモジュールを dynamic import したときだけ読み込まれるため、
// 2D 利用時の初期バンドルに影響しない（SPEC「初期バンドル・2D 利用時のロードには影響させない」）。

import type { AnalysisResult, FigureImage, Point, Size } from '@/model/types';
import {
  CAMERA_FOV_DEG,
  buildKeychainScene3d,
  buildScene3d,
  type KeychainScene3dGeometry,
  type Scene3dGeometry,
} from '@/render/scene3d';
import { buildArtworkTextures, buildBackTexture, inkAlphaTest } from '@/render/texture3d';

/** 3D モックアップの出力サイズを調整するオプション。 */
export interface Mockup3dOptions {
  /** 出力画像の一辺（px）。既定 2048。 */
  size?: number;
}

/**
 * 既定の 3D 視点で撮影した商品モックアップを PNG の data URL として生成する。
 *
 * 背景は完全に透明（α=0）なので、広告デザインへそのまま合成できる。
 */
export async function generateMockup3dPng(
  result: AnalysisResult,
  image: FigureImage,
  alphaThreshold: number,
  thicknessMm: number,
  showBackPlate: boolean = false,
  backImage: FigureImage | null = null,
  options: Mockup3dOptions = {},
): Promise<string> {
  const size = options.size ?? 2048;
  const isKeychain = result.keychain != null;

  // three は必要になったときだけ読み込む（dynamic import）。
  const THREE = await import('three');
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');

  const geometry: Scene3dGeometry | KeychainScene3dGeometry = isKeychain
    ? buildKeychainScene3d(result, thicknessMm)
    : buildScene3d(result);
  const textures = buildArtworkTextures(
    image.bitmap,
    alphaThreshold,
    isKeychain
      ? {
          center: result.keychain!.holeCenterPixel,
          radiusMm: result.keychain!.holeRadiusMm,
          mmPerPixel: result.mmPerPixel,
        }
      : undefined,
  );
  const backTextureCanvas = backImage ? buildBackTexture(backImage.bitmap) : null;
  const backImageSizeMm: Size | null = backImage
    ? { width: backImage.width * result.mmPerPixel, height: backImage.height * result.mmPerPixel }
    : null;
  const alphaTest = inkAlphaTest(alphaThreshold);

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  renderer.setClearAlpha(0);

  const scene = new THREE.Scene();

  // 透明アクリルの映り込み用に簡易スタジオ環境マップを生成する。
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 1, 20000);
  camera.position.set(...geometry.camera.position);
  camera.lookAt(...geometry.camera.target);

  // 照明：アクリルの透明感を引き出しつつ、絵柄の色が褪せないよう控えめに。
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  keyLight.position.set(300, 500, 400);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xe8f4ff, 0.35);
  rimLight.position.set(-300, 200, -400);
  scene.add(rimLight);

  const plateHole = isKeychain
    ? { center: { x: 0, y: 0 }, radiusMm: result.keychain!.holeRadiusMm }
    : undefined;
  const plateGeometry = buildPlateGeometry(geometry.plate, THREE, plateHole);

  const plateBackZ =
    'centerZMm' in geometry.plate
      ? geometry.plate.centerZMm - geometry.plate.thicknessMm / 2
      : -geometry.plate.thicknessMm / 2;
  const inkGap = 0.15;

  const plateMesh = new THREE.Mesh(
    plateGeometry,
    acrylicMaterial(geometry.plate.thicknessMm, THREE),
  );
  plateMesh.position.z = plateBackZ;
  scene.add(plateMesh);

  // 絵柄部分を覆う白版（実物の UV 印刷と同じ「白版 → 絵柄」の順）。
  // 絵柄は照明で色が変わらないよう MeshBasicMaterial（無陰影）で描く。
  const artworkTexture = buildTexture(textures.artwork, THREE);
  const artworkPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(geometry.artwork.width, geometry.artwork.height),
    new THREE.MeshBasicMaterial({
      map: artworkTexture,
      alphaTest,
      alphaToCoverage: true,
      side: THREE.FrontSide,
      transparent: false,
    }),
  );
  artworkPlane.position.set(
    geometry.artwork.centerX,
    geometry.artwork.centerY,
    plateBackZ - inkGap,
  );
  scene.add(artworkPlane);

  const whiteTexture = buildTexture(textures.white, THREE);
  const whitePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(geometry.artwork.width, geometry.artwork.height),
    new THREE.MeshBasicMaterial({
      map: whiteTexture,
      alphaTest,
      alphaToCoverage: true,
      side: THREE.DoubleSide,
      transparent: false,
    }),
  );
  whitePlane.position.set(
    geometry.artwork.centerX,
    geometry.artwork.centerY,
    plateBackZ - inkGap * 2,
  );
  scene.add(whitePlane);

  // 両面アクリル時は背面保護板を追加する。前から見たとき輪郭が前面板と重なるよう、
  // 回転せずに奥へずらして配置する。
  let backPlateMesh: import('three').Mesh | null = null;
  let backImagePlane: import('three').Mesh | null = null;
  let backTexture: import('three').CanvasTexture | null = null;
  if (showBackPlate) {
    // 白版・背面板・背面画像が同じ深度を夺い合わないよう、inkGap 刻みで奥へずらす。
    const backPlate = new THREE.Mesh(
      plateGeometry,
      acrylicMaterial(geometry.plate.thicknessMm, THREE),
    );
    backPlate.position.z = plateBackZ - inkGap * 3 - geometry.plate.thicknessMm;
    backPlateMesh = backPlate;
    scene.add(backPlate);

    if (backTextureCanvas && backImageSizeMm) {
      backTexture = buildTexture(backTextureCanvas, THREE);
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(backImageSizeMm.width, backImageSizeMm.height),
        new THREE.MeshBasicMaterial({
          map: backTexture,
          alphaTest,
          alphaToCoverage: true,
          side: THREE.DoubleSide,
          transparent: false,
        }),
      );
      plane.position.set(
        geometry.artwork.centerX,
        geometry.artwork.centerY,
        plateBackZ - inkGap * 4 - geometry.plate.thicknessMm,
      );
      backImagePlane = plane;
      scene.add(plane);
    }
  } else {
    // 片面アクリル時：アクリル板の外形いっぱいに白を敷くことで、絵柄周りの透明部分を
    // 「白版裏打ち」に見せ、広告用モックアップとして全体がソリッドに映るようにする。
    const backingGeometry = buildPlateBackingGeometry(geometry.plate, THREE, plateHole);
    const backingMaterial = new THREE.MeshBasicMaterial({
      color: 0xf5f5f5,
      side: THREE.DoubleSide,
    });
    const backingPlane = new THREE.Mesh(backingGeometry, backingMaterial);
    backingPlane.position.z = plateBackZ - inkGap * 3;
    scene.add(backingPlane);
    backingGeometry.dispose();
    backingMaterial.dispose();
  }

  if (!isKeychain) {
    const baseGeometry = buildBaseGeometry((geometry as Scene3dGeometry).base, THREE);
    const baseMesh = new THREE.Mesh(
      baseGeometry,
      acrylicMaterial((geometry as Scene3dGeometry).base.thicknessMm, THREE),
    );
    baseMesh.rotation.x = -Math.PI / 2;
    scene.add(baseMesh);
    baseGeometry.dispose();
    baseMesh.material.dispose();
  }

  renderer.render(scene, camera);

  const dataUrl = renderer.domElement.toDataURL('image/png');

  // リソース解放。
  plateGeometry.dispose();
  artworkTexture.dispose();
  whiteTexture.dispose();
  plateMesh.material.dispose();
  artworkPlane.geometry.dispose();
  (artworkPlane.material as { dispose(): void }).dispose();
  whitePlane.geometry.dispose();
  (whitePlane.material as { dispose(): void }).dispose();
  if (backPlateMesh) {
    (backPlateMesh.material as { dispose(): void }).dispose();
  }
  if (backImagePlane) {
    backImagePlane.geometry.dispose();
    (backImagePlane.material as { dispose(): void }).dispose();
  }
  backTexture?.dispose();
  renderer.dispose();

  return dataUrl;
}

function acrylicMaterial(
  thicknessMm: number,
  THREE: typeof import('three'),
): import('three').MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transmission: 1,
    thickness: thicknessMm,
    ior: 1.49,
    roughness: 0.08,
    metalness: 0,
    clearcoat: 0.3,
    clearcoatRoughness: 0.15,
    attenuationColor: 0xeaf4f6,
    attenuationDistance: 150,
    envMapIntensity: 0.6,
    side: THREE.FrontSide,
  });
}

function buildTexture(
  source: HTMLCanvasElement,
  THREE: typeof import('three'),
): import('three').CanvasTexture {
  const texture = new THREE.CanvasTexture(source);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function buildPlateGeometry(
  plate: { readonly outline: readonly Point[]; readonly thicknessMm: number },
  THREE: typeof import('three'),
  hole?: { readonly center: Point; readonly radiusMm: number },
): import('three').ExtrudeGeometry {
  const shape = new THREE.Shape(plate.outline.map((p) => new THREE.Vector2(p.x, p.y)));
  if (hole) {
    const holePath = new THREE.Path();
    holePath.absarc(hole.center.x, hole.center.y, hole.radiusMm, 0, Math.PI * 2, false);
    shape.holes.push(holePath);
  }
  return new THREE.ExtrudeGeometry(shape, {
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
    depth: plate.thicknessMm,
  });
}

function buildPlateBackingGeometry(
  plate: { readonly outline: readonly Point[] },
  THREE: typeof import('three'),
  hole?: { readonly center: Point; readonly radiusMm: number },
): import('three').ShapeGeometry {
  const shape = new THREE.Shape(plate.outline.map((p) => new THREE.Vector2(p.x, p.y)));
  if (hole) {
    const holePath = new THREE.Path();
    holePath.absarc(hole.center.x, hole.center.y, hole.radiusMm, 0, Math.PI * 2, false);
    shape.holes.push(holePath);
  }
  return new THREE.ShapeGeometry(shape);
}

function buildBaseGeometry(
  base: {
    readonly outline: readonly Point[];
    readonly thicknessMm: number;
    readonly slot: {
      readonly widthMm: number;
      readonly openingMm: number;
      readonly centerZMm: number;
    };
  },
  THREE: typeof import('three'),
): import('three').ExtrudeGeometry {
  const shape = new THREE.Shape(
    counterClockwise(base.outline.map((p) => new THREE.Vector2(p.x, -p.y))),
  );
  const halfSlotWidth = base.slot.widthMm / 2;
  const halfOpening = base.slot.openingMm / 2;
  const slotY = -base.slot.centerZMm;
  shape.holes.push(
    new THREE.Path([
      new THREE.Vector2(-halfSlotWidth, slotY - halfOpening),
      new THREE.Vector2(-halfSlotWidth, slotY + halfOpening),
      new THREE.Vector2(halfSlotWidth, slotY + halfOpening),
      new THREE.Vector2(halfSlotWidth, slotY - halfOpening),
    ]),
  );
  return new THREE.ExtrudeGeometry(shape, {
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
    depth: base.thicknessMm,
  });
}

function counterClockwise(points: import('three').Vector2[]): import('three').Vector2[] {
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    area2 += a.x * b.y - b.x * a.y;
  }
  return area2 < 0 ? points.reverse() : points;
}
