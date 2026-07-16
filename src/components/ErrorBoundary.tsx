// アプリ全体のクラッシュ受け皿（React Error Boundary）。
//
// 解析・読み込みの想定内失敗は型付きエラーとして state に載り、通常フローで
// 表示される。しかし描画（Preview のオーバーレイ等）やレンダリング中に想定外の
// 例外が投げられると、React はツリーをアンマウントし白画面になる。SPEC の
// 「例外でクラッシュさせず UI へ分かりやすく表示する」を満たすため、最終防衛線
// として例外を捕捉し、再読み込みできる代替 UI を出す。
//
// Error Boundary は現状 React の仕様上クラスコンポーネントでしか実装できないため、
// このファイルのみ関数コンポーネント方針の例外とする。

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { LocaleContext } from '@/locales';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  /** 例外を捕捉したか。true の間はフォールバック UI を表示する。 */
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static contextType = LocaleContext;
  declare context: React.ContextType<typeof LocaleContext>;

  state: ErrorBoundaryState = { hasError: false };

  /** 子ツリーで投げられた例外を捕捉し、フォールバック表示へ切り替える。 */
  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  /** デバッグ用に詳細をコンソールへ残す（プライバシー要件のため外部送信はしない）。 */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Daiza: 描画中の想定外エラー', error, info);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    // 一度クラッシュしたツリーは状態が壊れている可能性があるため、部分復帰では
    // なくページ全体の再読み込みで確実に初期状態へ戻す。
    const t = this.context?.t;
    return (
      <div className="bg-background flex h-svh flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="space-y-1">
          <h1 className="text-lg font-bold">
            {t ? t('errorBoundary.title') : 'An unexpected error occurred'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t
              ? t('errorBoundary.message')
              : 'Unable to continue. Please reload the page and try again.'}
          </p>
        </div>
        <Button onClick={() => window.location.reload()}>
          {t ? t('errorBoundary.reload') : 'Reload'}
        </Button>
      </div>
    );
  }
}
