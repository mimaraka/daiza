// ヘッダー右端の常設表示。
//
// 1) プライバシー表明：本アプリは画像解析・幾何計算・SVG 生成をすべてブラウザ内で完結させ、
//    画像や解析データを外部へ送信しない（SPEC の設計制約）。利用者は「アップロードした絵柄が
//    どこかへ送られるのでは」と当然身構えるため、その保証は読み込み前から見える位置に置く。
// 2) ソースコードへの導線：上の主張は検証できて初めて意味を持つので、リポジトリを併記する。
//
// 状態を持たない presentational コンポーネント。

import { ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';

const REPOSITORY_URL = 'https://github.com/mimaraka/daiza';

/**
 * GitHub の Octocat マーク。lucide はブランドアイコンを廃止したため自前で持つ。
 * 色は currentColor に従わせ、Button の variant に追従させる。
 */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function HeaderActions() {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
      {/* 画面が狭いときは全文だと折り返して主役（プレビュー）を押し下げるため、
          アイコン＋短文に切り替える。title で全文を補う。 */}
      <p
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
        title="画像解析・計算・ファイル生成はすべてブラウザ内で完結します。画像や解析結果がサーバーへ送信されることはありません。"
      >
        <ShieldCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="hidden md:inline">
          画像はブラウザ内でのみ処理され、サーバーへ送信されません
        </span>
        <span className="md:hidden">サーバー送信なし</span>
      </p>

      {/* rel="noreferrer" は遷移先へ参照元を渡さないため。外部送信をしない方針と整合させる。 */}
      <Button variant="outline" size="sm" asChild>
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer" title="GitHub リポジトリを開く">
          <GithubMark className="size-4" />
          <span className="hidden sm:inline">GitHub</span>
        </a>
      </Button>
    </div>
  );
}
