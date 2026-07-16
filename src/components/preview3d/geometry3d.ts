// シーン幾何（render/scene3d）→ three のジオメトリ／テクスチャへの変換。
//
// React には依存しないが three には依存するため、3D モジュール（＝dynamic import される
// チャンク）側に置く。純粋な幾何の決定は render/scene3d が済ませているので、ここは
// 「mm 座標の形 → three のオブジェクト」の機械的な写像だけを担う。
//
// 押し出しの向き（ExtrudeGeometry は shape の XY 平面から +Z 方向へ押し出す）と、
// シーン座標系（Y 上・Z 前）の対応づけがこのモジュールの主題である。

import {
  CanvasTexture,
  ExtrudeGeometry,
  Path,
  RepeatWrapping,
  SRGBColorSpace,
  Shape,
  Vector2,
} from 'three';

import type { Point } from '@/model/types';
import type { Scene3dBase, Scene3dPlate } from '@/render/scene3d';

/** 押し出しの共通設定。面取りは付けず（切断面はシャープなアクリル小口）、頂点列は直線分。 */
const EXTRUDE_OPTIONS = { bevelEnabled: false, steps: 1, curveSegments: 1 } as const;

/** テクスチャの異方性フィルタ強度。斜めから見たときの絵柄のボケを抑える。 */
const TEXTURE_ANISOTROPY = 4;

/**
 * アクリル板（フィギュア本体）の押し出しジオメトリ。
 *
 * 外形はシーンの XY 平面（Y 上正）にそのまま乗るため、板厚ぶんを +Z へ押し出すだけでよい。
 * 押し出しは Z=0〜板厚 に生成されるので、板の奥行中心へ合わせる平行移動は呼び出し側
 * （mesh の position.z = 中心Z − 板厚/2）が行う。
 */
export function buildPlateGeometry(plate: Scene3dPlate): ExtrudeGeometry {
  const shape = new Shape(plate.outline.map((p) => new Vector2(p.x, p.y)));
  return new ExtrudeGeometry(shape, { ...EXTRUDE_OPTIONS, depth: plate.thicknessMm });
}

/**
 * 台座の押し出しジオメトリ（footprint を押し出し、スリットを貫通穴として持つ）。
 *
 * 台座は水平な板なので、上面図（真上から見た平面）を shape に取り、厚みぶん押し出してから
 * 寝かせる（呼び出し側で rotation.x = −90°）。この回転は (x, y, z) → (x, z, −y) の写像なので、
 * shape の y は**世界の −Z**（＝奥）に対応する。したがって奥行方向の座標は符号を反転して
 * 置く必要がある（footprint のローカル y は「前が正」なので shape 上では −y、スリット中心
 * Z = cz は y = −cz）。押し出し（Z=0〜厚み）は回転後に世界 Y の 0〜厚みへ移り、台座が接地面に
 * ちょうど乗る。外形は解析が確定した footprint（矩形はその特殊形）の折れ線をそのまま使うため、
 * 2D プレビュー・エクスポートと同じ形が立体になる。
 */
export function buildBaseGeometry(base: Scene3dBase): ExtrudeGeometry {
  const shape = new Shape(counterClockwise(base.outline.map((p) => new Vector2(p.x, -p.y))));

  // スリット：幅 = 差込口幅、奥行方向の開口 = 板厚。中心は奥行原点 + 前後オフセット
  // （shape 上は符号反転）。台座計算（analysis/base）が内包を検査済みなので必ず内側に収まる。
  const halfSlotWidth = base.slot.widthMm / 2;
  const halfOpening = base.slot.openingMm / 2;
  const slotY = -base.slot.centerZMm;
  shape.holes.push(
    new Path([
      new Vector2(-halfSlotWidth, slotY - halfOpening),
      new Vector2(-halfSlotWidth, slotY + halfOpening),
      new Vector2(halfSlotWidth, slotY + halfOpening),
      new Vector2(halfSlotWidth, slotY - halfOpening),
    ]),
  );

  return new ExtrudeGeometry(shape, { ...EXTRUDE_OPTIONS, depth: base.thicknessMm });
}

/**
 * キーホルダー用アクリル板（穴付き）の押し出しジオメトリ。
 *
 * 外形は穴中心を原点としたシーン座標（XY 平面）で与え、板厚ぶんを +Z へ押し出す。
 * リング穴は円形の貫通穴として追加する。
 */
export function buildKeychainPlateGeometry(plate: {
  readonly outline: readonly Point[];
  readonly thicknessMm: number;
  readonly holeRadiusMm: number;
}): ExtrudeGeometry {
  const shape = new Shape(counterClockwise(plate.outline.map((p) => new Vector2(p.x, p.y))));

  const r = plate.holeRadiusMm;
  const segments = 32;
  const holePoints: Vector2[] = [];
  for (let i = 0; i < segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    holePoints.push(new Vector2(Math.cos(theta) * r, Math.sin(theta) * r));
  }
  shape.holes.push(new Path(holePoints));

  return new ExtrudeGeometry(shape, { ...EXTRUDE_OPTIONS, depth: plate.thicknessMm });
}

/**
 * 頂点列を反時計回り（符号付き面積が正）へそろえる。
 *
 * ExtrudeGeometry は外形が反時計回りのときだけ穴の巻き方向を正規化する（外形を時計回りへ
 * 反転し、そのとき同じ向きの穴を逆向きへ直す）。外形が最初から時計回りだとこの正規化が走らず、
 * 穴の側壁（＝スリットの内壁）の面が裏返り、片面描画のマテリアルでは内壁が消えてしまう。
 * footprint の巻き方向は形状ソース次第で決まらない（y の符号反転でも反転する）ため、ここで
 * 反時計回りへそろえて three の正規化経路に必ず乗せる。
 */
function counterClockwise(points: Vector2[]): Vector2[] {
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (!a || !b) continue;
    area2 += a.x * b.y - b.x * a.y;
  }
  return area2 < 0 ? points.reverse() : points;
}

/**
 * canvas（絵柄／白版）を three のテクスチャにする。
 * 色は sRGB として解釈させ、PNG の見た目どおりの色で板の裏へ載せる。
 */
export function buildTexture(source: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(source);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = TEXTURE_ANISOTROPY;
  return texture;
}

/**
 * 床タイル（render/texture3d の [[buildFloorTexture]]）を敷き詰めるテクスチャにする。
 *
 * repeat は「床の一辺 ÷ タイルの一辺」。床の平面は原点中心・UV は角基準なので、repeat が整数で
 * ある限りタイルの継ぎ目は原点を通る格子に揃う。床は視線が浅く入る面なので、異方性フィルタは
 * デバイスの上限まで引き上げてよい（奥のグリッド線が潰れるのを防ぐ）。
 */
export function buildTiledTexture(
  source: HTMLCanvasElement,
  repeat: number,
  anisotropy: number,
): CanvasTexture {
  const texture = new CanvasTexture(source);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = anisotropy;
  return texture;
}
