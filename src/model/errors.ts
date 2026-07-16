// エラー生成の共有ヘルパー。
//
// 個別の失敗（読み込み・差込口・台座…）は各モジュールが型付き AnalysisError を
// 返すが、それらの想定を外れた「予期しない例外」（バグ・環境依存の失敗等）は
// どの層でも起こり得る。SPEC の「例外でクラッシュさせず UI へ表示する」を満たす
// ため、そうした例外を一括で AnalysisError('unexpectedError') へ写す口を用意する。

import type { AnalysisError } from './types';

/**
 * 捕捉した例外を表示用の AnalysisError へ変換する。
 *
 * 原因はユーザーに見せても意味が薄く、また機微を含み得るため、UI へは種別コードのみを
 * 出す。表示テキストは UI 層の翻訳テーブルへ委ねる。開発時の追跡のため、元の例外は
 * console.error へ残す（外部送信はしない）。
 */
export function toUnexpectedError(cause: unknown): AnalysisError {
  // 原因を握り潰すとデバッグ不能になるため、コンソールにだけ詳細を残す。
  console.error('Daiza: 想定外のエラー', cause);
  return { kind: 'unexpectedError' };
}
