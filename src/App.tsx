// アプリのルート。左右2ペイン構成のレイアウトを組み、状態（useAppState）と
// 各パネルを配線する。PNG 読み込み（TODO 4）・解析パイプライン（TODO 13）・
// SVG エクスポート（TODO 15）を配線済み。

import { useCallback, useMemo, useState, type CSSProperties } from 'react';

import { loadPngFile } from '@/analysis/imageLoader';
import { computeMmPerPixel } from '@/analysis/scale';
import { ExportPanel } from '@/components/ExportPanel';
import { LeftPanel } from '@/components/LeftPanel';
import { PaneResizer } from '@/components/PaneResizer';
import { Preview } from '@/components/Preview';
import { ResultPanel } from '@/components/ResultPanel';
import { generateSvg } from '@/export/svg';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useAppState } from '@/hooks/useAppState';
import { toUnexpectedError } from '@/model/errors';

/**
 * 生成した SVG 文字列をファイルとしてダウンロードさせる。
 * DOM 依存の副作用のため export/svg（純粋）から切り離し、UI 層に置く。
 * 一時的な Blob URL は生成した a 要素のクリック後に必ず解放し、リークを防ぐ。
 */
function downloadSvg(svg: string, fileName: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 画像ファイル名（例 figure.png）から SVG 用のダウンロード名を導く。 */
function svgFileName(imageFileName: string): string {
  const base = imageFileName.replace(/\.[^./\\]+$/, '');
  return `${base || 'daiza'}.svg`;
}

/**
 * 左右パネルの幅(px)の初期値と可動範囲。上限は「プレビューが主役の列であり続ける」ための
 * 歯止め、下限は入力欄・数値がまともに読める最小幅として決めた実用値。
 */
const LEFT_PANE = { initial: 384, min: 280, max: 560 } as const;
const RIGHT_PANE = { initial: 320, min: 240, max: 480 } as const;

function App() {
  const { state, actions } = useAppState();

  // ペイン幅（広幅レイアウト時のみ有効）。CSS 変数として main へ渡し、Tailwind の
  // lg: 修飾子と組み合わせることで、縦積みになる狭幅では幅指定自体を効かせない。
  const [leftWidth, setLeftWidth] = useState<number>(LEFT_PANE.initial);
  const [rightWidth, setRightWidth] = useState<number>(RIGHT_PANE.initial);

  // 画像・パラメータの変化を監視し「解析 → 状態更新 → 再描画」を即時駆動する。
  // 結果は state.result / state.error に載り、Preview・ResultPanel が自動で反映する。
  useAnalysis(state, actions);

  // ファイル選択・ドラッグ＆ドロップ共通の読み込み口。デコード結果を状態へ反映する。
  // 失敗しても例外で落とさず、型付きエラーを state に載せて UI へ表示する。
  // 読み込みは非同期だがハンドラの戻り値は同期(void)。内部で await し void で発火させる。
  const handleImageFile = useCallback(
    (file: File): void => {
      void (async () => {
        try {
          const result = await loadPngFile(file);
          if (result.ok) {
            actions.setImage(result.image);
          } else {
            actions.failAnalysis(result.error);
          }
        } catch (cause) {
          // loadPngFile は内部で例外を型付きエラーへ畳むが、その想定を外れた
          // 失敗（環境依存等）でも未処理の Promise 拒否で終わらせず UI へ出す。
          actions.failAnalysis(toUnexpectedError(cause));
        }
      })();
    },
    [actions],
  );

  // SVG エクスポート：解析結果がある時のみ有効。undefined を渡すと LeftPanel の
  // ボタンが自動で無効化されるため、結果の有無で export ハンドラを出し分ける。
  const result = state.result;

  // プレビューのルーラーは実寸(mm)目盛りのためスケールを要する。スケールは絵柄（不透明
  // 領域）の高さを基準にするため解析（第 1 相）を経ないと確定しないが、解析中・失敗中でも
  // ルーラーを消さないよう、結果が無い間は「絵柄が画像いっぱいに広がっている」と仮定した
  // 暫定スケールで代用する（原点も解析前は画像左下の仮置き。SPEC「ルーラー」）。
  const image = state.image;
  const parameters = state.parameters;
  const mmPerPixel = useMemo(() => {
    if (result) {
      return result.mmPerPixel;
    }
    return image ? computeMmPerPixel(parameters, image.height) : null;
  }, [result, image, parameters]);
  const handleExportSvg = useCallback(() => {
    if (!result) {
      return;
    }
    const svg = generateSvg(result);
    downloadSvg(svg, svgFileName(state.image?.fileName ?? 'daiza.png'));
  }, [result, state.image]);

  return (
    <div className="bg-background flex h-svh flex-col">
      <header className="flex shrink-0 items-baseline gap-3 border-b px-4 py-3">
        <h1 className="text-lg font-bold">Daiza</h1>
        <p className="text-muted-foreground text-sm">アクリルフィギュア台座設計ツール</p>
      </header>

      {/* 画面が広ければ3ペイン（左パネル／プレビュー／結果パネル）、狭ければ上下配置へ
          切り替える（レスポンシブ）。結果をプレビューの下ではなく右列へ置くのは、16:9 等の
          横長ウィンドウでプレビューの縦幅が圧迫されるのを避けるため（SPEC「解析結果パネルの配置」）。
          左右パネルの幅は CSS 変数で渡し、間の PaneResizer から可変にする。狭幅（縦積み）では
          lg: 修飾子が外れるため幅指定は効かず、ハンドルも表示されない。 */}
      <main
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 lg:flex-row lg:overflow-hidden"
        style={
          {
            '--left-pane-width': `${leftWidth}px`,
            '--right-pane-width': `${rightWidth}px`,
          } as CSSProperties
        }
      >
        {/* 左パネル：狭幅では先頭に積み、広幅では可変幅の縦スクロール列にする。 */}
        <aside className="shrink-0 lg:w-[var(--left-pane-width)] lg:overflow-y-auto">
          <LeftPanel
            parameters={state.parameters}
            onParametersChange={actions.updateParameters}
            onImageFile={handleImageFile}
          />
        </aside>

        <PaneResizer
          width={leftWidth}
          min={LEFT_PANE.min}
          max={LEFT_PANE.max}
          sign={1}
          onWidthChange={setLeftWidth}
          label="左パネルの幅"
        />

        {/* 中央：プレビュー。残りの幅・高さを使い切る主役の列。エラー表示はプレビューの
            操作（読み込み・パラメータ変更）に対する応答なので、この列の上部に置く。
            狭幅で縦積みになったときにプレビューが潰れないよう最低高さを与える。 */}
        <section className="flex min-h-[60vh] min-w-0 flex-1 flex-col gap-4 lg:min-h-0 lg:overflow-hidden">
          {state.error && (
            <div
              role="alert"
              className="border-destructive/50 bg-destructive/10 text-destructive rounded-lg border px-4 py-2 text-sm"
            >
              {state.error.message}
            </div>
          )}
          <Preview
            image={state.image}
            result={state.result}
            mmPerPixel={mmPerPixel}
            status={state.status}
            onImageFile={handleImageFile}
          />
        </section>

        {/* ハンドルの右にあるペインを操作するため、ポインタの右移動は幅の減少になる（sign=-1）。 */}
        <PaneResizer
          width={rightWidth}
          min={RIGHT_PANE.min}
          max={RIGHT_PANE.max}
          sign={-1}
          onWidthChange={setRightWidth}
          label="解析結果パネルの幅"
        />

        {/* 右パネル：解析結果と、それを書き出すエクスポート操作。左パネルと同じく
            可変幅・列内スクロール。 */}
        <aside className="flex shrink-0 flex-col gap-4 lg:w-[var(--right-pane-width)] lg:overflow-y-auto">
          <ResultPanel result={state.result} />
          {/* 結果がある時だけ onExportSvg を渡し、無ければ prop 自体を省いてボタンを無効化する
              （exactOptionalPropertyTypes 下では undefined の明示代入を避け、条件スプレッドで出し分ける）。 */}
          <ExportPanel {...(result ? { onExportSvg: handleExportSvg } : {})} />
        </aside>
      </main>
    </div>
  );
}

export default App;
