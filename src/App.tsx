// アプリのルート。左右2ペイン構成のレイアウトを組み、状態（useAppState）と
// 各パネルを配線する。PNG 読み込み（TODO 4）・解析パイプライン（TODO 13）・
// エクスポート（SVG / Adobe Illustrator）を配線済み。

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

import { loadBaseShapeSource } from '@/analysis/baseShapeSource';
import { loadPngFile } from '@/analysis/imageLoader';
import { computeMmPerPixel } from '@/analysis/scale';
import { ExportPanel } from '@/components/ExportPanel';
import { HeaderActions } from '@/components/HeaderActions';
import { LeftPanel } from '@/components/LeftPanel';
import { PaneResizer } from '@/components/PaneResizer';
import { Preview } from '@/components/Preview';
import { ResultPanel } from '@/components/ResultPanel';
import { generateAi } from '@/export/ai';
import { bitmapToPngBytes, bitmapToPngDataUrl } from '@/export/raster';
import { generateSvg } from '@/export/svg';
import { useAnalysis } from '@/hooks/useAnalysis';
import { useAppState } from '@/hooks/useAppState';
import { useTranslation } from '@/locales';
import { toUnexpectedError } from '@/model/errors';

/**
 * 生成した成果物をファイルとしてダウンロードさせる。
 * DOM 依存の副作用のため export/*（純粋）から切り離し、UI 層に置く。
 * 一時的な Blob URL は生成した a 要素のクリック後に必ず解放し、リークを防ぐ。
 */
function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 画像ファイル名（例 figure.png）から、指定拡張子のダウンロード名を導く。 */
function exportFileName(imageFileName: string, extension: string): string {
  const base = imageFileName.replace(/\.[^./\\]+$/, '');
  return `${base || 'daiza'}.${extension}`;
}

/**
 * 左右パネルの幅(px)の初期値と可動範囲。上限は「プレビューが主役の列であり続ける」ための
 * 歯止め、下限は入力欄・数値がまともに読める最小幅として決めた実用値。
 */
const LEFT_PANE = { initial: 384, min: 280, max: 560 } as const;
const RIGHT_PANE = { initial: 320, min: 240, max: 480 } as const;

function App() {
  const { t } = useTranslation();
  const { state, actions } = useAppState();

  useEffect(() => {
    document.title = t('app.pageTitle');
  }, [t]);

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

  // 台座形状ソース（任意形状）の読み込み口。画像と同じく、失敗は例外にせず型付きエラーを
  // state へ載せて UI（プレビュー前面のオーバーレイ）へ出す。成功時は reducer が台座奥行を
  // ソースのアスペクト比へ合わせ、再解析が走る。
  const handleBaseShapeFile = useCallback(
    (file: File): void => {
      void (async () => {
        try {
          const loaded = await loadBaseShapeSource(file);
          if (loaded.ok) {
            actions.setBaseShapeSource(loaded.source);
          } else {
            actions.failAnalysis(loaded.error);
          }
        } catch (cause) {
          actions.failAnalysis(toUnexpectedError(cause));
        }
      })();
    },
    [actions],
  );

  // 背面アクリル板画像の読み込み口。PNG のみ。失敗は型付きエラーへ。
  const handleBackImageFile = useCallback(
    (file: File): void => {
      void (async () => {
        try {
          const result = await loadPngFile(file);
          if (result.ok) {
            actions.setBackImage(result.image);
          } else {
            actions.failAnalysis(result.error);
          }
        } catch (cause) {
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
  // SVG は線データのみが既定。絵柄が要るときだけ画像を埋め込む（ファイルは重くなる）。
  const [embedImageInSvg, setEmbedImageInSvg] = useState(false);
  // .ai は PDF 生成と画像の PNG 化を伴い、大きな画像では体感できる時間がかかる。
  // 生成中はボタンを止め、二重実行を防ぐ。
  const [exporting, setExporting] = useState(false);

  const handleExportSvg = useCallback(() => {
    if (!result || !image) {
      return;
    }
    try {
      const svg = generateSvg(
        result,
        embedImageInSvg ? { imageHref: bitmapToPngDataUrl(image.bitmap) } : {},
      );
      downloadBlob(
        new Blob([svg], { type: 'image/svg+xml' }),
        exportFileName(image.fileName, 'svg'),
      );
    } catch (cause) {
      // エクスポート失敗でアプリを落とさず、エラー表示へ畳む（SPEC のエラーハンドリング）。
      actions.failAnalysis(toUnexpectedError(cause));
    }
  }, [result, image, embedImageInSvg, actions]);

  // .ai は絵柄画像を必ず含む「絵柄付きアウトライン」。実体は PDF 互換のドキュメントで、
  // pdf-lib を dynamic import するため生成が非同期になる。
  const handleExportAi = useCallback(() => {
    if (!result || !image) {
      return;
    }
    setExporting(true);
    void (async () => {
      try {
        const bytes = await generateAi(result, { bytes: await bitmapToPngBytes(image.bitmap) });
        downloadBlob(
          // .ai の中身は PDF なので MIME も PDF とする（保存名の拡張子が .ai であることが本質）。
          new Blob([bytes as BlobPart], { type: 'application/pdf' }),
          exportFileName(image.fileName, 'ai'),
        );
      } catch (cause) {
        actions.failAnalysis(toUnexpectedError(cause));
      } finally {
        setExporting(false);
      }
    })();
  }, [result, image, actions]);

  return (
    <div className="bg-background flex h-svh flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <h1 className="text-lg font-bold">{t('app.title')}</h1>
        <p className="text-muted-foreground hidden text-sm sm:block">{t('app.subtitle')}</p>
        {/* 右端にプライバシー表明・GitHub リポジトリへの導線・言語切替を常設する。 */}
        <HeaderActions />
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
            backImage={state.backImage}
            onBackImageFile={handleBackImageFile}
            baseShapeSource={state.baseShapeSource}
            onBaseShapeFile={handleBaseShapeFile}
          />
        </aside>

        <PaneResizer
          width={leftWidth}
          min={LEFT_PANE.min}
          max={LEFT_PANE.max}
          sign={1}
          onWidthChange={setLeftWidth}
          label={t('paneResizer.left')}
        />

        {/* 中央：プレビュー。残りの幅・高さを使い切る主役の列。狭幅で縦積みになったときに
            プレビューが潰れないよう最低高さを与える。エラー表示はプレビューの操作（読み込み・
            パラメータ変更）に対する応答だが、この列へ積むとエラーの出入りでビューワーの高さが
            変わってしまうため、Preview 内のオーバーレイとして前面に出す。 */}
        <section className="flex min-h-[60vh] min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-hidden">
          <Preview
            image={state.image}
            result={state.result}
            mmPerPixel={mmPerPixel}
            alphaThreshold={parameters.alphaThreshold}
            showBackPlate={parameters.showBackPlate}
            backImage={state.backImage}
            status={state.status}
            error={state.error}
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
          label={t('paneResizer.right')}
        />

        {/* 右パネル：解析結果と、それを書き出すエクスポート操作。左パネルと同じく
            可変幅・列内スクロール。 */}
        <aside className="flex shrink-0 flex-col gap-4 lg:w-[var(--right-pane-width)] lg:overflow-y-auto">
          <ResultPanel result={state.result} />
          {/* 結果がある時だけ各 onExport を渡し、無ければ prop 自体を省いてボタンを無効化する
              （exactOptionalPropertyTypes 下では undefined の明示代入を避け、条件スプレッドで出し分ける）。 */}
          <ExportPanel
            embedImageInSvg={embedImageInSvg}
            onEmbedImageInSvgChange={setEmbedImageInSvg}
            exporting={exporting}
            {...(result ? { onExportSvg: handleExportSvg, onExportAi: handleExportAi } : {})}
          />
        </aside>
      </main>
    </div>
  );
}

export default App;
