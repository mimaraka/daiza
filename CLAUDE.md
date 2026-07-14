# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト状態

**一通り実装済み**（PNG読み込み → 解析 → 2D/3Dプレビュー → SVG / Illustrator(.ai) エクスポート。台座形状は矩形・角丸・円・楕円・正多角形・任意形状に対応）。残っているのは `docs/TODO.md` のとおり、(1) ブラウザ・Illustrator 実機での目視確認、(2) 超巨大画像向けの解析解像度上限（任意・既定OFF。実機で問題が出たら着手）、(3) 将来拡張のバックログ。実装を進める際は必ず `docs/SPEC.md` を正典（source of truth）、`docs/TODO.md` を残タスク表として参照すること。以下はSPECの要点と実装上の勘所を、コード全体を読まずに把握できるよう要約したもの。

備考: `npm create vite` は使わず手動スキャフォールド。ESLint 10 のフラットコンフィグでは `eslint-plugin-react-hooks` の `recommended-latest` が `plugins` を文字列配列で返し無効になるため、`eslint.config.js` ではプラグインをオブジェクトで自前登録しルールのみ取り込んでいる。TypeScript は typescript-eslint 対応のため 5.9 系に固定（`latest` だと 7 系が入り非対応）。

## 概要

**Daiza** は、PNG画像からアクリルフィギュアの重心を解析し、差込口位置・台座サイズを自動計算するWebアプリ。

- **完全クライアントサイド**：画像解析・幾何計算・SVG生成はすべてブラウザ内で完結する。**画像や解析データを外部APIへ送信してはならない**（プライバシー要件かつ設計制約）。
- **静的サイト**：GitHub Pages（github.io）へそのままデプロイできる構成にする。サーバーは持たない。
- 将来的なPWA化・WebAssembly置き換えを容易にする設計とする。

## 技術スタック

- React 19 + TypeScript（strict）+ Vite
- Tailwind CSS v4 + shadcn/ui（Radix UI / lucide-react）
- 描画：画像は Canvas、オーバーレイ・ルーラー・グリッドは SVG
- 3Dプレビュー：Three.js + React Three Fiber + drei（**dynamic import** で分離チャンク化し、初期バンドルへ載せない）
- 画像処理：Canvas `ImageData`（解析は Web Worker 上で実行）
- 幾何計算：`polygon-clipping`（union / simplify）。EDT・輪郭追跡・平滑化・曲線補完は自前実装（`analysis/`・`utils/curve`）
- `.ai` エクスポート：`pdf-lib`（PDFを生成して `.ai` として書き出す。これも dynamic import）

SPECが「利用可」とする `gl-matrix` / `martinez-polygon-clipping` は使っていない。

## コマンド

```bash
npm run dev       # 開発サーバー
npm run build     # tsc -b && vite build（GitHub Pages 配布物を dist/ へ生成）
npm run preview   # ビルド結果のローカル確認
npm run lint      # ESLint（warningゼロが要件）
npm run format    # Prettier（検証のみは format:check）
```

GitHub Pages はリポジトリ名配下で配信するため、Viteの `base` は `/daiza/` に固定済み。`main` への push で `.github/workflows/deploy.yml` が lint → build → デプロイを実行する。

## アーキテクチャ（レイヤ分離が最重要）

SPECは **UI・画像解析・物理計算・描画・エクスポートの厳密な分離**を要求している。解析ロジックはUIから独立した純粋モジュールとして実装し、Reactに依存させないこと（失敗は例外ではなく `null` で返す）。

```
src/
  App.tsx
  components/     LeftPanel / Preview / ResultPanel / ExportPanel / Ruler / Grid / TopView … UI（3ペイン構成）
                  preview3d/                                  … 3Dビュー（R3F。Preview から lazy 読み込み）
  analysis/       imageLoader, baseShapeSource, scale, contour, distance, centroid, slot,
                  footprint, base, stability, pipeline, analysis.worker  … 純粋ロジック
                  （imageLoader / baseShapeSource だけは入力の受け口として DOM に依存）
  render/         overlay, simulation, ruler, scene3d, topView … 描画モデル（純粋）
                  texture3d                                   … 絵柄／白版・床タイルのテクスチャ（DOM 依存）
  export/         geometry, svg, ai, raster                   … 実寸(mm)座標系でSVG / Illustrator(.ai)生成
  model/          state.ts（reducer）, types.ts, errors.ts, pixelStore.ts
  hooks/          useAnalysis（解析パイプラインの駆動）, useAppState, useViewport
  utils/          geometry.ts, image.ts, curve.ts
  assets/         textures/wood.png                           … 3Dの床サンプル（3Dチャンクからのみ参照）
```

### データフロー

パラメータ変更時は必ず **解析 → 状態更新 → 再描画** を即時実行する。状態遷移は `model/state.ts` の reducer（純粋関数）に集約し、`hooks/useAppState` がReactへ橋渡しする。

解析は `hooks/useAnalysis` が Web Worker（`analysis/analysis.worker.ts`）上で駆動し、2相に分ける：

- **第1相 `analyzeImage`** … 画像だけに依存する前処理（αプレーン抽出）。O(W×H)。画像が変わったときだけ実行し、αプレーンは **Worker 内に保持する**（メインスレッドへは送らない）。
- **第2相 `runAnalysis`** … パラメータに依存する計算（二値化 → カットライン → 重心 → 差込部 → 台座 → 転倒角）。重い段（二値化・EDT膨張・カットライン生成・差込部の合流）は依存パラメータを鍵に**段ごとメモ化**する（`CutlineMemo`）。台座幅だけを変えてもどの段も再計算されない。

`ImageData` を React の state / props に載せてはならない。解析用ピクセルは `model/pixelStore` 経由で受け渡し、state には描画用の `ImageBitmap` だけを置く（React 19 の dev ビルドが全画素を列挙し、3000px級で数十秒フリーズするため）。

### 解析パイプラインの核心ロジック（`analysis/`）

- **不透明判定**：`α > アルファ閾値 × 255`。アルファ閾値はユーザーパラメータ（既定 0 ＝ SPECの「α>0 をアクリル」と一致）。二値マスクは画像不変量ではないため、第1相ではなく第2相で作る。
- **スケール**：**画像高さではなく絵柄の高さが基準**。フィギュア高さは「接地面〜カットライン上端」の全高なので、`mm_per_pixel = (フィギュア高さ − (余白×2 + 持ち上げ量 + 板厚)) / 絵柄の高さ(px)`（`analysis/scale`）。画像高さを使うと PNG の透明余白の量で実寸が変わってしまう。
- **カットライン**：輪郭抽出 → 余白オフセット（EDT膨張）→ 隙間埋め（半径 = 閾値/2 の円板クロージング）→ 自己交差の除去 → 平滑化 → 曲線補完 → 差込部の一体化。以降の重心・差込部・台座・オーバーレイ・SVGはすべてこの外形に追従する。
- **複数パーツ**：凸包で緩く包まず、輪郭に沿わせたままブリッジで連結する。ブリッジとパーツ輪郭の接合部も隙間埋めの対象（尖らせない）。
- **重心**：**カットラインが囲む領域の面積重心**（多角形重心公式）。α>0 画素の平均ではない。
- **差込部**：中心X = `重心X + 差込口オフセット`（最下部からの探索はしない）。首部（幅 = 首部幅）＋ツメ（幅 = 差込口幅・深さ = 板厚）の2段構成で、幅の差でできる肩が台座上面に乗り挿入深さを止める。`首部幅 ≧ 差込口幅 + 2 × 最小ショルダー幅(0.5mm)` は `model/state` の `normalizeParameters` が常に強制する。
- **台座 footprint**（`analysis/footprint`）：台座形状（矩形・角丸・円・楕円・正多角形・任意形状）は「footprint」という**単一の表現**へ畳み込む。台座ローカル座標（原点 = bbox 中心、x = 右正、**y = 前正**）で、**閉パス（直線＋3次ベジェ）＋折れ線（許容誤差 0.05mm）＋凸包**を併せ持つ。検査・転倒角・3Dはこの折れ線／凸包、プレビュー・エクスポートは曲線パスを使うので、見た目と計算が食い違わない。配置は 原点X = 差込口中心X、原点Y = 奥行原点。形状ごとの分岐はこのモジュールの中だけに閉じる（矩形はその特殊形）。台座形状の変更でカットライン段は再計算されない（メモ化粒度を維持）。
- **台座サイズの検査**（`analysis/base`）：寸法はユーザー指定値をそのまま実寸とし（自動算出しない）、①スリット矩形（幅=差込口幅・開口=板厚・中心=(0, 前後オフセット)）が**footprint に内包**されるか（4隅の内包＋4辺が輪郭と交差しないこと。非凸形状では隅だけでは不十分）、②重心の鉛直投影（`(重心X − 差込口中心X, 前後オフセット)`）が**凸包に内包**されるか、の2つを検査する。境界上ちょうどは成立側。矩形では従来式（必要幅 = `max(2 × |重心X − 差込口中心X|, 差込口幅)`、必要奥行 = `板厚 + 2 × |前後オフセット|`）と厳密に一致する。倒れにくさの余裕は検査に含めず転倒角で判断する（安全率パラメータは廃止）。
- **転倒角**（`analysis/stability`）：`θ(d) = atan(支持端距離(d) / 重心高さ)`、支持端距離 = footprint 凸包の**支持関数** `h(d) − ⟨g, d⟩`。左右前後は `d = (∓1,0)/(0,±1)` の特殊形で、矩形では従来式と一致する。**最小転倒角**（全方位の最悪方向）は探索不要で、重心投影から凸包の最近傍辺までの距離＝閉形式で求まる（方位角は右0°・前90°）。正多角形・任意形状では最悪方向が斜めになり得るため、4方向だけでは見落とす。前後は画像に写らないため、重心の奥行位置＝スリット中心（差込口の前後オフセット）とする。
- **曲線補完の例外**：差込部の肩（台座上面ライン上の4つの角）は加工寸法に直結する直角なので丸めない（`analysis/slot` の `slotJunctionCorners` → `utils/curve` の `sharpCorners`）。

### 入力の受け口（画像・台座形状ソース）

`analysis/imageLoader`（フィギュアPNG）と `analysis/baseShapeSource`（任意形状の台座：PNGシルエット／SVGパス）は解析層で唯一 DOM に依存する。台座形状ソースは **PNG は固定しきい値 α>127**（絵柄用のアルファ閾値は適用しない）・最大面積パーツ・軽い平滑化、**SVG はブラウザの SVG 実装へ解釈を委ねる**（非表示SVGへ幾何属性だけを複製して挿入し `getTotalLength`/`getPointAtLength` でサンプリング。独自パーサは書かない。サブパスの切れ目は「サンプル間隔に対する飛び」で検出する）。結果は bbox 正規化した折れ線として state に持ち、ピクセルデータは保持しない。読込時に台座奥行がソースのアスペクト比へ自動追従する（幅は維持）。

### プレビューの3モード

解析表示 / 完成プレビュー / 3D。いずれも**表示のみの切替**であり、解析結果・パラメータ・エクスポートには一切影響しない。2Dグリッドは既定OFF（絵柄・オーバーレイの読みやすさを優先）、3Dの床グリッドは既定ON。前面図には台座の奥行・形状が現れないため、**上面図インセット**（`render/topView` + `components/TopView`。footprint／スリット／重心投影／最悪方位矢印）を右下に重ねる（既定は矩形でOFF・それ以外でON、ユーザーのトグルが優先）。

### 3Dプレビュー（`render/scene3d` + `components/preview3d`）

- **座標系**：原点＝接地面（台座底面）上の台座 footprint 中心、Y上正・Z前正。前面図（下向き+Y）からの換算は `X = x_mm − 差込部中心X` / `Y = 接地面_mm − y_mm` の2式のみ。ツメ底面が Y=0（台座底面とツライチ）、台座上面が Y=板厚 になる。
- **依存の閉じ込め**：three / R3F の import は `components/preview3d/` 以下だけ。`Preview` が `React.lazy` で読み込むため、2D利用時は three をダウンロードしない。`render/scene3d.ts` は three にも React にも依存しない純粋ロジック（曲線補完済みカットラインを `utils/curve` の `closedCurvePolyline` で折れ線化して押し出す）。
- **押し出しの罠（巻き方向）**：`ExtrudeGeometry` は**外形が反時計回りのときだけ**穴の巻き方向を正規化する。footprint を shape へ写すときは y を反転する（shape の y = 世界の −Z）ため巻きが逆転し得るので、`geometry3d` の `counterClockwise()` で外形をそろえてから渡す。これを怠るとスリット内壁の面が裏返り、片面描画のアクリル素材では内壁が消える。
- **印刷レイヤの罠**：three の `transmission` は、屈折の背景バッファへ**不透明オブジェクトしか描かない**（`renderTransmissionPass`）。絵柄を半透明マテリアルにするとアクリル越しに消えるため、絵柄テクスチャは白版と合成して不透明にし、シルエットは `alphaTest` で切り抜く（`render/texture3d.ts`）。実物の「白版の上にインクが載る」構造とも一致する。
- **床**（`components/preview3d/Floor.tsx`）：テクスチャ（既定 = なし／木目サンプル `src/assets/textures/wood.png`／ユーザー画像アップロード）と実寸グリッド（10mmマス・既定ON）を**1枚のタイルへ焼き込んで**敷き詰める（`render/texture3d.ts` の `buildFloorTexture`）。グリッドを透明な面として重ねないのは上記 transmission の罠と同じ理由（アクリル越しに格子が消える）。床の `map` は無地のときも外さない：three がシェーダを組み直すのは `material.version` が上がったときだけで、R3F は `map` の差し替えで `needsUpdate` を立てないため、`null ↔ テクスチャ`の切替は反映されない。

### 入力の前提

RGBA PNG。既定（アルファ閾値 0）では **α=0を透明、α>0をアクリル**とみなす。ドラッグ＆ドロップとファイル選択の両対応。

## 状態管理

React Hooksのみで管理する。**Redux等の大掛かりなグローバル状態管理ライブラリは使用しない**（SPECの明示的制約）。

## エラーハンドリング

以下は例外でクラッシュさせず、**プレビュー前面のオーバーレイ**として表示する（列の上へ積むとエラーの出入りでビューワーの寸法が変わり、表示が跳ねるため）：PNG読み込み失敗 / 非対応画像 / 透明画像（アルファ閾値が高すぎて不透明画素が残らない場合を含む）/ スケール計算不可 / 差込口配置不可 / 台座計算不可 / 台座形状が利用できない（`baseShapeFailed`。任意形状のソース未読込・読込失敗）。

## コード品質要件（SPEC準拠）

- TypeScript strict mode、ESLint warningゼロ、Prettier準拠
- `any` 型は原則禁止（やむを得ない場合のみ）
- 関数は単一責務。コメントは「なぜその処理が必要か」を中心に書く
- パフォーマンス目標：3000px程度の画像でも快適に動作すること

## 将来拡張（設計時に考慮）

複数差込口・台座 footprint の穴あき対応（ドーナツ形状等）・金属スタンド・密度マップ・複数PNG同時計算など。解析ロジックをUIから切り離しておくことでこれらに対応する。
