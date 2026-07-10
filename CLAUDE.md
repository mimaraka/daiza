# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト状態

**環境構築（TODO 1）まで完了**。Vite + React + TypeScript + Tailwind CSS v4 + shadcn/ui 基盤（`components.json`・`src/lib/utils.ts`・テーマトークン）・ESLint/Prettier・GitHub Pages 用デプロイワークフロー（`.github/workflows/deploy.yml`）・`src/` のレイヤ別ディレクトリ構成が整備済み。アプリ本体のロジック（型定義以降、TODO 2〜）は未実装。実装を進める際は必ず `docs/SPEC.md` を正典（source of truth）、`docs/TODO.md` を進行表として参照すること。以下はSPECの要点を、コード全体を読まずに把握できるよう要約したもの。

備考: `npm create vite` は使わず手動スキャフォールド。ESLint 10 のフラットコンフィグでは `eslint-plugin-react-hooks` の `recommended-latest` が `plugins` を文字列配列で返し無効になるため、`eslint.config.js` ではプラグインをオブジェクトで自前登録しルールのみ取り込んでいる。TypeScript は typescript-eslint 対応のため 5.9 系に固定（`latest` だと 7 系が入り非対応）。

## 概要

**Daiza** は、PNG画像からアクリルフィギュアの重心を解析し、差込口位置・台座サイズを自動計算するWebアプリ。

- **完全クライアントサイド**：画像解析・幾何計算・SVG生成はすべてブラウザ内で完結する。**画像や解析データを外部APIへ送信してはならない**（プライバシー要件かつ設計制約）。
- **静的サイト**：GitHub Pages（github.io）へそのままデプロイできる構成にする。サーバーは持たない。
- 将来的なPWA化・WebAssembly置き換えを容易にする設計とする。

## 技術スタック

- React + TypeScript + Vite
- Tailwind CSS + shadcn/ui
- 描画：SVG（必要に応じてCanvas API）
- 画像処理：Canvas `ImageData`
- 幾何計算：必要に応じて `gl-matrix` / `polygon-clipping` / `martinez-polygon-clipping`

## 想定コマンド（Vite標準・環境構築後に有効）

まだ `package.json` が存在しないため、最初の作業はVite + React + TSでのプロジェクト初期化になる。初期化後は概ね以下：

```bash
npm run dev       # 開発サーバー
npm run build     # 本番ビルド（GitHub Pages配布物を生成）
npm run preview   # ビルド結果のローカル確認
npm run lint      # ESLint（warningゼロが要件）
```

GitHub Pagesへ配置する都合上、Viteの `base` をリポジトリ名（`/daiza/`）に合わせる必要がある点に注意。

## アーキテクチャ（レイヤ分離が最重要）

SPECは **UI・画像解析・物理計算・描画・エクスポートの厳密な分離**を要求している。解析ロジックはUIから独立したモジュールとして実装し、Reactに依存させないこと。想定ディレクトリ構成：

```
src/
  App.tsx
  components/     LeftPanel / Preview / ResultPanel   … UI（2ペイン構成）
  analysis/       imageLoader, contour, centroid, slot, base, stability  … 純粋ロジック
  render/         overlay, simulation                 … オーバーレイ描画
  export/         svg.ts                              … 実寸(mm)座標系でSVG生成
  model/          state.ts, types.ts                  … 状態・型定義
  hooks/          useAnalysis.ts                       … 解析パイプラインの束ね
  utils/          geometry.ts, image.ts
```

### データフロー

パラメータ変更時は必ず **解析 → 状態更新 → 再描画** を即時実行する。Reactの再レンダリングを活かしつつ、`useMemo` / `useCallback` で不要な再計算を抑える。オーバーレイのみの更新で済む場合は画像解析全体を再実行しない。

### 解析パイプラインの核心ロジック（`analysis/`）

- **スケール**：フィギュア高さ(mm)と画像高さ(px)から `mm_per_pixel` を算出。
- **重心**：α>0のピクセルを均一密度とみなし、画像モーメントで `Cx = Σx/N`, `Cy = Σy/N`。
- **差込口候補**：画像最下部から探索し、差込口幅が完全に収まる範囲のみ候補とする。複数候補があれば**重心の真下に最も近い位置**を採用。
- **台座幅**：支持多角形の考え方。「重心が支持範囲内」を最低条件とし、安全率を掛けて推奨台座幅を計算。
- **転倒角**：左右方向それぞれ `θ = atan(支持端距離 / 重心高さ)`。

### 入力の前提

RGBA PNG。**α=0を透明、α>0をアクリル**とみなす。ドラッグ＆ドロップとファイル選択の両対応。

## 状態管理

React Hooksのみで管理する。**Redux等の大掛かりなグローバル状態管理ライブラリは使用しない**（SPECの明示的制約）。

## エラーハンドリング

以下は例外でクラッシュさせず、UI上に分かりやすく表示する：PNG読み込み失敗 / 非対応画像 / 透明画像 / 差込口配置不可 / 台座計算不可。

## コード品質要件（SPEC準拠）

- TypeScript strict mode、ESLint warningゼロ、Prettier準拠
- `any` 型は原則禁止（やむを得ない場合のみ）
- 関数は単一責務。コメントは「なぜその処理が必要か」を中心に書く
- パフォーマンス目標：3000px程度の画像でも快適に動作すること

## 将来拡張（設計時に考慮）

複数差込口・円形/楕円/任意形状台座・金属スタンド・密度マップ・複数PNG同時計算など。解析ロジックをUIから切り離しておくことでこれらに対応する。
