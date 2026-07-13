// プレビューのビュー操作（ホイールズーム・ドラッグパン・ピンチ拡縮・Fit・100%）を司る hook。
//
// ここで扱うのは「画像をどう見せるか」という純粋な表示状態だけで、解析結果や
// アプリ状態（model/state）とは独立している。オーバーレイの幾何は画像ピクセル
// 座標のまま（render/overlay）で、本 hook が与える平行移動 + 拡大の 1 つの
// アフィン変換を stage 要素へ適用することで、画像とオーバーレイをまとめて拡縮・
// 移動させる。座標系を 1 か所（この変換）に集約することで、解析ロジックは表示
// 操作の影響を一切受けない。
//
// 変換は screen = scale * content + (tx, ty) の相似変換。transformOrigin を左上
// (0,0) に固定し、CSS の `translate(tx,ty) scale(scale)` として stage に渡す。
//
// ポインタ操作は Pointer Events で一本化する。マウスのドラッグも、指 1 本のスワイプも、
// 指 2 本のピンチも「接触点の重心の移動＝平行移動」「接触点の広がりの変化＝拡縮」という
// 同一のジェスチャモデルで扱えるため、タッチ専用の分岐を持たずに済む。

import { useCallback, useEffect, useRef, useState } from 'react';

import { clamp } from '@/utils/geometry';

/** 拡大率の下限・上限。極端な値で操作不能になるのを防ぐ安全域。 */
const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

/**
 * ホイール 1 ノッチあたりの拡大係数の基数。deltaY に対して指数を取ることで、
 * 拡大・縮小の見た目の速さを対称にする（×k と ÷k が同じ操作量になる）。
 */
const WHEEL_ZOOM_BASE = 1.0015;

/** ズームボタン 1 クリックあたりの倍率。 */
const BUTTON_ZOOM_FACTOR = 1.25;

/**
 * ピンチとみなす接触点の最小の広がり(px)。ほぼ重なった 2 本指では広がりの比が発散し、
 * わずかな指の震えが暴走した拡縮になるため、この値未満のときは拡縮せず平行移動のみ行う。
 * 実際の 2 本指がこれより近づくことはまずないので、操作感を損なわない。
 */
const MIN_PINCH_SPREAD_PX = 4;

/** stage に適用する相似変換。scale は拡大率、(tx, ty) は画面座標での平行移動。 */
export interface ViewportTransform {
  readonly scale: number;
  readonly tx: number;
  readonly ty: number;
}

/** ビューポート（表示領域）の実サイズ(px)。ルーラーの描画範囲にも使う。 */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Fit/100% が収めるべき内容範囲（画像ピクセル座標の外接矩形）。
 * 画像だけでなくカットライン（余白で画像枠外へ広がり得る）を含むため、原点は必ずしも
 * (0,0) ではなく負にもなる。stage の座標系（画像左上原点）に対する矩形として与える。
 */
export interface ContentBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const IDENTITY: ViewportTransform = { scale: 1, tx: 0, ty: 0 };

export interface UseViewportResult {
  /** 表示領域（overflow-hidden なビューポート）の ref。サイズ計測とイベント基準に使う。 */
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * 計測済みの表示領域サイズ（未計測なら null）。ルーラーのように「ビューポート座標で
   * 固定表示する」オーバーレイが描画範囲を知るために公開する。
   */
  readonly containerSize: ViewportSize | null;
  /** 現在の変換。stage の CSS transform に反映する。 */
  readonly transform: ViewportTransform;
  /** ポインタ操作中（ドラッグパン／ピンチ）フラグ。カーソル表示の切り替えに使う。 */
  readonly isPanning: boolean;
  /**
   * ポインタジェスチャのハンドラ。onPointerUp は pointercancel にも繋ぐこと（接触点の
   * 取りこぼしを防ぐ）。要素側には touch-action: none が要る（タッチをスクロール・
   * ページズームに奪われるとイベントが届かないため）。
   */
  readonly onPointerDown: (event: React.PointerEvent) => void;
  readonly onPointerMove: (event: React.PointerEvent) => void;
  readonly onPointerUp: (event: React.PointerEvent) => void;
  /** コンテンツ全体が収まるよう中央寄せでフィットさせる。 */
  readonly fit: () => void;
  /** 等倍（1 コンテンツ px = 1 画面 px）で中央寄せ表示する。 */
  readonly actualSize: () => void;
  /** ビューポート中心を基準に拡大／縮小する（ズームボタン用）。 */
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
}

/**
 * 内容範囲 box をビューポートへ収める変換（縦横比維持・中央寄せ）。
 *
 * stage の座標系（画像左上原点）で box を中央寄せするため、box.x/box.y ぶんの原点ずれを
 * 平行移動へ織り込む。box.x=box.y=0（画像そのもの）なら従来どおり単純な中央寄せになる。
 * カットラインが画像枠外（負座標）へ広がっても box がそれを含むため、Fit で見切れない。
 */
function computeFit(container: ViewportSize, box: ContentBox): ViewportTransform {
  const scale = clamp(
    Math.min(container.width / box.width, container.height / box.height),
    MIN_SCALE,
    MAX_SCALE,
  );
  return {
    scale,
    tx: (container.width - box.width * scale) / 2 - box.x * scale,
    ty: (container.height - box.height * scale) / 2 - box.y * scale,
  };
}

/** 等倍（scale=1）で内容範囲 box を中央寄せする変換。 */
function computeActual(container: ViewportSize, box: ContentBox): ViewportTransform {
  return {
    scale: 1,
    tx: (container.width - box.width) / 2 - box.x,
    ty: (container.height - box.height) / 2 - box.y,
  };
}

/**
 * ビューポート内の固定点 (px, py) を保ったまま拡大率を nextScale へ変える。
 * ホイールズームでカーソル直下の画像点が動かないようにするための基本演算。
 */
function zoomAround(
  prev: ViewportTransform,
  px: number,
  py: number,
  nextScale: number,
): ViewportTransform {
  const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE);
  const ratio = clamped / prev.scale;
  return {
    scale: clamped,
    tx: px - (px - prev.tx) * ratio,
    ty: py - (py - prev.ty) * ratio,
  };
}

/** 接触点（ビューポート座標）。 */
interface Contact {
  readonly x: number;
  readonly y: number;
}

/** 接触点の重心。これがジェスチャの「つかんでいる点」であり、その移動が平行移動になる。 */
function contactCenter(contacts: readonly Contact[]): Contact {
  let sumX = 0;
  let sumY = 0;
  for (const c of contacts) {
    sumX += c.x;
    sumY += c.y;
  }
  return { x: sumX / contacts.length, y: sumY / contacts.length };
}

/**
 * 接触点の「広がり」＝重心からの平均距離。ピンチの拡縮率はこの値の比で決める。
 *
 * 2 点なら指の間隔の半分になるため、比を取れば一般的なピンチ（2 点間距離の比）と一致する。
 * 3 点以上でも同じ式がそのまま意味を持ち、1 点なら 0 になって拡縮が自然に無効化されるので、
 * 接触点の本数で場合分けする必要がない。
 */
function contactSpread(contacts: readonly Contact[], center: Contact): number {
  if (contacts.length < 2) {
    return 0;
  }
  let sum = 0;
  for (const c of contacts) {
    sum += Math.hypot(c.x - center.x, c.y - center.y);
  }
  return sum / contacts.length;
}

/**
 * ジェスチャ開始時点のスナップショット。move のたびに「開始時からの累積」で変換を作り直すため、
 * 差分の積み上げにならず誤差が溜まらない。接触点が増減した瞬間にこれを取り直す（＝基準を張り直す）
 * ことで、2 本目を置いた瞬間・1 本を離した瞬間に画像が飛ぶのを防ぐ。
 */
interface GestureAnchor {
  /** ビューポート左上の画面座標。clientX/Y をビューポート座標へ直すために控える。 */
  readonly originX: number;
  readonly originY: number;
  readonly center: Contact;
  readonly spread: number;
  readonly transform: ViewportTransform;
}

/**
 * プレビューのズーム/パン状態を管理する。
 *
 * 自動フィットは fitKey（画像の同一性）が変わったとき（＝新規画像の読み込み）だけ行う。
 * 内容範囲 box はパラメータ変更（カットライン余白など）でも変わるが、その都度フィットし直すと
 * ユーザーのズーム/パンを勝手に破棄してしまうため、box の変化では再フィットせず「手動 Fit の
 * 対象範囲」を更新するだけに留める。ホイールイベントはページスクロール抑止のため非 passive の
 * ネイティブリスナで購読する。
 *
 * enabled = false の間はホイールズームと iOS のジェスチャ抑止を購読しない。3D プレビュー
 * モードでは同じ表示領域に 3D キャンバスが載り、そのオービット操作（ホイールズーム・ピンチ）と
 * イベントを奪い合ってしまうためである。変換の state はそのまま保持されるので、2D へ戻せば
 * ズーム・パンは元のまま復帰する（SPEC「2D へ戻したとき、2D 側の表示状態は維持されていること」）。
 */
export function useViewport(
  box: ContentBox | null,
  fitKey: unknown,
  enabled = true,
): UseViewportResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [transform, setTransformState] = useState<ViewportTransform>(IDENTITY);
  const [isPanning, setIsPanning] = useState(false);
  // ルーラー描画のために表示領域サイズを state としても公開する（ref だけでは再描画が
  // 走らずリサイズに追従できない）。更新はリサイズ時のみで、頻繁な再レンダーにはならない。
  const [containerSize, setContainerSize] = useState<ViewportSize | null>(null);

  // イベントハンドラ（安定参照）から最新値を参照するための ref 群。これらを ref に
  // 逃がすことで、リスナを張り直さずに済ませる。
  const transformRef = useRef(transform);
  const containerSizeRef = useRef<ViewportSize | null>(null);
  const contentRef = useRef<ContentBox | null>(null);

  /**
   * 変換の更新口。state と ref を同時に書く。
   *
   * ref を state の描画後（effect）ではなく更新と同時に進めるのは、ジェスチャの基準を
   * 張り直すタイミング（2 本目の指を置く／離す）で「その瞬間の変換」が要るため。React の
   * state 反映はイベントに対して 1 フレーム遅れうるので、effect 同期だと直前のピンチ移動が
   * 取りこぼされて画像が飛ぶ。呼び出しはすべてイベントハンドラ・コールバック内（＝描画中
   * ではない）なので、ここで ref を書いても描画の一貫性は壊れない。
   */
  const setTransform = useCallback(
    (next: ViewportTransform | ((prev: ViewportTransform) => ViewportTransform)) => {
      const value = typeof next === 'function' ? next(transformRef.current) : next;
      transformRef.current = value;
      setTransformState(value);
    },
    [],
  );

  // fitKey ごとに一度だけ自動フィットしたかを記録する。ウィンドウリサイズや box の
  // 変化（パラメータ調整）で再フィットしてユーザーのズームを破棄しないための番人。
  const fittedRef = useRef(false);
  // 直近に自動フィットした fitKey。これが変わったときだけ新規画像として再フィットする。
  const fitKeyRef = useRef<unknown>(undefined);

  const applyFit = useCallback(() => {
    const container = containerSizeRef.current;
    const content = contentRef.current;
    if (!container || !content) {
      return;
    }
    setTransform(computeFit(container, content));
  }, [setTransform]);

  const applyActual = useCallback(() => {
    const container = containerSizeRef.current;
    const content = contentRef.current;
    if (!container || !content) {
      return;
    }
    setTransform(computeActual(container, content));
  }, [setTransform]);

  const zoomAtCenter = useCallback(
    (factor: number) => {
      const container = containerSizeRef.current;
      if (!container || !contentRef.current) {
        return;
      }
      setTransform((prev) =>
        zoomAround(prev, container.width / 2, container.height / 2, prev.scale * factor),
      );
    },
    [setTransform],
  );

  const zoomIn = useCallback(() => zoomAtCenter(BUTTON_ZOOM_FACTOR), [zoomAtCenter]);
  const zoomOut = useCallback(() => zoomAtCenter(1 / BUTTON_ZOOM_FACTOR), [zoomAtCenter]);

  // box（内容範囲）が変わったら最新値を ref へ反映する。手動 Fit / 100% はこの ref を使う。
  // 自動フィットは fitKey が変わったとき（＝新規画像）だけ。パラメータ変更に伴う box の
  // 変化ではユーザーのズーム/パンを保つため再フィットしない。
  useEffect(() => {
    contentRef.current = box;
    if (fitKeyRef.current !== fitKey) {
      fitKeyRef.current = fitKey;
      fittedRef.current = false;
      if (containerSizeRef.current && contentRef.current) {
        applyFit();
        fittedRef.current = true;
      }
    }
  }, [box, fitKey, applyFit]);

  // ビューポートのサイズを追跡し、初回計測時に（まだなら）自動フィットする。
  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) {
        return;
      }
      const size: ViewportSize = { width: rect.width, height: rect.height };
      containerSizeRef.current = size;
      setContainerSize(size);
      if (!fittedRef.current && contentRef.current) {
        applyFit();
        fittedRef.current = true;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyFit]);

  // ホイールズーム：カーソル直下の点を固定して拡縮する。ページスクロールを
  // 止める必要があるため非 passive のネイティブリスナで購読する。
  useEffect(() => {
    const element = containerRef.current;
    if (!element || !enabled) {
      return;
    }
    const handleWheel = (event: WheelEvent) => {
      if (!contentRef.current) {
        return;
      }
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const factor = Math.pow(WHEEL_ZOOM_BASE, -event.deltaY);
      setTransform((prev) => zoomAround(prev, cursorX, cursorY, prev.scale * factor));
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [enabled, setTransform]);

  // iOS Safari はビューポート側のピンチズーム（ページ全体の拡大）を touch-action: none だけでは
  // 手放さず、独自の gesture イベントとして拾ってしまう。プレビュー上のピンチはあくまで画像の
  // 拡縮なので、ページごと拡大されないようここで打ち消す。他ブラウザでは発火しない。
  useEffect(() => {
    const element = containerRef.current;
    if (!element || !enabled) {
      return;
    }
    const preventPageZoom = (event: Event) => event.preventDefault();
    element.addEventListener('gesturestart', preventPageZoom);
    element.addEventListener('gesturechange', preventPageZoom);
    return () => {
      element.removeEventListener('gesturestart', preventPageZoom);
      element.removeEventListener('gesturechange', preventPageZoom);
    };
  }, [enabled]);

  // ポインタジェスチャ（ドラッグパン・ピンチ拡縮）。接触中のポインタを id で持ち、その
  // 重心の移動を平行移動、広がりの比を拡縮として扱う。1 本なら広がりが 0 で拡縮は効かず、
  // 従来どおりのドラッグパンになる。
  const contactsRef = useRef(new Map<number, Contact>());
  const anchorRef = useRef<GestureAnchor | null>(null);

  /**
   * 現在の接触点と変換で、ジェスチャの基準を張り直す。
   * 接触点が増減するたびに呼ぶことで、指を足した／離した瞬間に画像が飛ばない。
   */
  const rebaseGesture = useCallback(() => {
    const element = containerRef.current;
    const contacts = [...contactsRef.current.values()];
    if (!element || contacts.length === 0) {
      anchorRef.current = null;
      return;
    }
    const rect = element.getBoundingClientRect();
    const center = contactCenter(contacts);
    anchorRef.current = {
      originX: rect.left,
      originY: rect.top,
      center,
      spread: contactSpread(contacts, center),
      transform: transformRef.current,
    };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      // マウスは主ボタンのみ（右クリックでパンを始めない）。タッチ・ペンの第 1 接触も button=0。
      // コンテンツ未読み込み時は操作対象が無いので無効。
      if (event.button !== 0 || !contentRef.current) {
        return;
      }
      const element = containerRef.current;
      if (!element) {
        return;
      }
      // ポインタキャプチャで、ビューポート外へドラッグしても move/up を取りこぼさない。
      element.setPointerCapture(event.pointerId);
      contactsRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      rebaseGesture();
      setIsPanning(true);
    },
    [rebaseGesture],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const contacts = contactsRef.current;
      // 接触として記録していないポインタ（キャプチャ外のホバー等）は無視する。
      if (!contacts.has(event.pointerId)) {
        return;
      }
      contacts.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const anchor = anchorRef.current;
      if (!anchor) {
        return;
      }
      const points = [...contacts.values()];
      const center = contactCenter(points);
      const spread = contactSpread(points, center);

      // 拡縮率は「広がりの比」。ただし clamp 後の実効倍率で平行移動を組み立てないと、
      // 拡大率が上限・下限へ張り付いた瞬間に画像が滑ってしまう。
      const pinch =
        anchor.spread >= MIN_PINCH_SPREAD_PX && spread >= MIN_PINCH_SPREAD_PX
          ? spread / anchor.spread
          : 1;
      const scale = clamp(anchor.transform.scale * pinch, MIN_SCALE, MAX_SCALE);
      const ratio = scale / anchor.transform.scale;

      // ジェスチャ開始時に重心が指していたコンテンツ上の点を、現在の重心へ据え置く。
      // ratio=1（1 本指）なら単なる平行移動に退化するので、パンとピンチが同じ式で書ける。
      // 重心は client 座標なので、変換 (tx, ty) と同じビューポート座標へ直してから使う。
      const centerX = center.x - anchor.originX;
      const centerY = center.y - anchor.originY;
      const anchorX = anchor.center.x - anchor.originX;
      const anchorY = anchor.center.y - anchor.originY;
      setTransform({
        scale,
        tx: centerX - (anchorX - anchor.transform.tx) * ratio,
        ty: centerY - (anchorY - anchor.transform.ty) * ratio,
      });
    },
    [setTransform],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      if (!contactsRef.current.delete(event.pointerId)) {
        return;
      }
      const element = containerRef.current;
      if (element?.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      // 指が残っていれば（ピンチ → 1 本指パンへの移行）、残りの接触点で基準を張り直して継続する。
      rebaseGesture();
      if (contactsRef.current.size === 0) {
        setIsPanning(false);
      }
    },
    [rebaseGesture],
  );

  // 3D への切替などで操作が無効化されたら、掴んだままの接触点を捨てる。2D へ戻ったときに
  // 古い接触点が残っていると、次のジェスチャが存在しない指を含んだ重心で始まってしまう。
  // isPanning は setState せず enabled で導出する（下の return）。
  useEffect(() => {
    if (enabled) {
      return;
    }
    contactsRef.current.clear();
    anchorRef.current = null;
  }, [enabled]);

  return {
    containerRef,
    containerSize,
    transform,
    // 操作が無効な間（3D 中）は掴んでいる状態にならないので、掴み中カーソルも出さない。
    isPanning: isPanning && enabled,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    fit: applyFit,
    actualSize: applyActual,
    zoomIn,
    zoomOut,
  };
}
