# TODO（Daiza 実装タスク）

`docs/SPEC.md` の実装手順・仕様に基づくタスク一覧。上から順に進める想定。

## 1. 環境構築

- [x] Vite + React + TypeScript プロジェクトを初期化
- [x] TypeScript strict mode を有効化
- [x] ESLint + Prettier を設定（warningゼロ運用）
- [x] Tailwind CSS を導入
- [x] shadcn/ui を導入（`components.json`・`cn`ユーティリティ・テーマトークンを整備。個別コンポーネントは必要時に追加）
- [x] Vite の `base` を `/daiza/` に設定（GitHub Pages 用）
- [x] GitHub Pages へのデプロイ手順／ワークフローを整備（`.github/workflows/deploy.yml`）
- [x] `src/` のディレクトリ構成を作成（components / analysis / render / export / model / hooks / utils）

## 2. 型・状態基盤

- [x] `model/types.ts` に画像・解析結果・パラメータの型を定義
- [x] `model/state.ts` にアプリ状態の初期値・型を定義
- [x] React Hooks による状態管理を実装（Redux 等は使わない）

## 3. UIレイアウト

- [x] 左右2ペイン構成の `App.tsx` を作成
- [x] `components/LeftPanel.tsx`：各種入力コントロールを配置
- [x] `components/Preview.tsx`：画像プレビュー領域
- [x] `components/ResultPanel.tsx`：解析結果一覧
- [x] レスポンシブ対応（画面幅が狭い場合は上下配置へ切替）

## 4. PNG読み込み

- [x] `analysis/imageLoader.ts`：PNG読み込みと `ImageData` 取得
- [x] ドラッグ＆ドロップ対応
- [x] ファイル選択対応
- [x] RGBA判定（α=0を透明、α>0をアクリルとみなす）
- [x] 画像はブラウザ内のみで処理（外部送信しない）

## 5. パラメータ入力

- [x] フィギュア高さ(mm) 入力
- [x] 板厚(mm) 入力（例: 2/3/5mm）＝標準値プリセット＋カスタム入力（Select）
- [x] 差込口幅(mm) 入力（例: 5/6/7）＝標準値プリセット＋カスタム入力（Select）
- [x] 安全率スライダー（1.0〜2.0、初期値1.3）
- [x] 台座幅（実寸 1〜300mm、初期値50。指定値がそのまま台座幅／20-5 で余白から変更）

## 6. スケール計算

- [x] フィギュア高さ(mm)と画像高さ(px)から `mm_per_pixel` を算出

## 7. 重心計算

- [x] `analysis/centroid.ts`：α>0を均一密度とみなし画像モーメントで重心 `Cx=Σx/N`, `Cy=Σy/N`
- [x] `analysis/contour.ts`：外形（輪郭）抽出

## 8. プレビュー・オーバーレイ描画

- [x] `render/overlay.ts`：オーバーレイ描画ロジック
- [x] 外形（半透明）
- [x] 重心（赤丸）
- [x] 差込口（青矩形）
- [x] 台座（緑矩形）
- [x] 支持範囲（オレンジ線）
- [x] 重心からの鉛直線（点線）
- [x] すべてリアルタイム更新

## 9. 表示操作

- [x] ホイールズーム
- [x] ドラッグパン
- [x] Fit表示
- [x] 100%表示

## 10. 差込口探索

- [x] `analysis/slot.ts`：画像最下部から探索し、差込口幅が完全に収まる範囲のみ候補化
- [x] 複数候補時は重心真下に最も近い位置を採用

## 11. 台座サイズ計算

- [x] `analysis/base.ts`：支持多角形の考え方で台座幅を算出
- [x] 「重心が支持範囲内」を最低条件とする
- [x] 安全率を掛けて推奨台座幅を計算
- [x] 推奨奥行を算出

## 12. 転倒シミュレーション

- [x] `analysis/stability.ts`／`render/simulation.ts`：転倒角 `θ = atan(支持端距離 / 重心高さ)`
- [x] 左右それぞれの転倒角を計算・表示

## 13. 解析パイプライン統合

- [x] `hooks/useAnalysis.ts`：解析→状態更新→再描画のパイプラインを束ねる
- [x] `utils/geometry.ts` / `utils/image.ts` の共通処理を実装

## 14. 結果表示

- [x] 画像サイズ／実寸／重心座標(mm)
- [x] 差込口中心／差込口幅
- [x] 推奨台座幅／推奨奥行
- [x] 転倒角(左)／転倒角(右)／安全率

## 15. SVGエクスポート

- [x] `export/svg.ts`：外形・差込口・台座を含むSVGを実寸(mm)座標系で生成
- [x] ブラウザからのダウンロードを実装

## 16. エラーハンドリング

- [x] PNG読み込み失敗
- [x] 非対応画像
- [x] 透明画像
- [x] 差込口が配置不可
- [x] 台座計算不可
- [x] 例外によるクラッシュを防止（UI上へ分かりやすく表示）

## 17. パフォーマンス最適化

- [x] `useMemo` / `useCallback` による不要な再計算の抑制
- [x] オーバーレイのみの再描画（画像解析全体を再実行しない）
- [x] 3000px程度の画像でも快適に動作することを確認

## 18. リファクタリング・品質

- [x] UI・画像処理・物理計算・描画の分離を再確認（`analysis`/`render`/`export`/`model`/`utils` に React 依存なし。未配線だった `render/simulation.ts` を `Preview` の転倒シミュレーション表示へ配線しデッドコードを解消）
- [x] `any` 型の排除（`src/` に `any` ゼロ）
- [x] ESLint warningゼロ／Prettier準拠を確認（`npm run lint`／`format:check`／`tsc -b`／`build` すべて通過）
- [x] 「なぜその処理が必要か」を中心としたコメント整備

## 19. テスト後の修正対応

初回テストで判明した不具合・仕様変更への対応（`docs/SPEC.md` 更新済み）。

### 19-1. 大画像フリーズ対策（パフォーマンス）

原因は読み込みではなく、第1相解析（α マスク・重心・輪郭抽出の O(W×H) 全画素処理）を
メインスレッドで同期実行していること。対策は「解析でメインスレッドを塞がない」ことを主眼とする。

**第一の対策：解析の Web Worker 化（原寸維持）**

- [x] 第1相解析（`analyzeImage`）を Web Worker 上で実行する（`analysis/analysis.worker.ts`）
- [x] `ImageData` の `ArrayBuffer` を Transferable として Worker へ転送する（往復転送でコピー回避。戻り側は `restoreImageData` で復元）
- [x] `useAnalysis` の `analyzing` 状態と接続し、解析中を UI 表示する（`Preview` にスピナーオーバーレイ）
- [x] パラメータのみ変更の第2相（`runAnalysis`）は Worker を跨がず即時計算のままとする
- [ ] 3000px超の画像を読み込んでもフリーズしないことを確認する（要ブラウザ実機確認）

**補助的対策：解析解像度の上限（任意・既定OFF）**

- [ ] Worker 化してもなお重い超巨大画像向けに、解析時のみ内部ダウンサンプリングを任意で用意
- [ ] その場合 `mm_per_pixel` は縮小後解像度で算出し、表示・SVG は原寸座標を用いる

### 19-2. 転倒シミュレーションのアイコン修正（UI）

- [x] リロード（更新）と誤認されるアイコンを差し替える（`RotateCw`→`PersonStanding`）。適切なアイコンが無ければテキストラベルにする

### 19-3. カットライン余白・平滑化パラメータ（仕様変更）

- [x] `LeftPanel` に「カットライン余白(mm)」入力（0〜10mm程度、初期値3）を追加
- [x] `LeftPanel` に「カットライン平滑化」入力を追加（0〜5 の平滑化強さスライダー）
- [x] `analysis/contour.ts`：不透明境界を余白ぶん外側へオフセットし、平滑化を適用したカットラインを生成（`offsetContour`／`smoothContour`／`buildCutline`）
- [x] 重心解析・台座計算・オーバーレイ・SVGエクスポートをカットラインベースへ統一（重心は `polygonCentroid` でカットライン領域の面積重心。`result.contour` がカットラインとなり overlay/SVG は自動追従）
- [x] `model/types.ts`・`model/state.ts` にパラメータを追加

### 19-4. 差込口を重心直下＋オフセット化（仕様変更）

- [x] `analysis/slot.ts`：最下点探索をやめ、差込口中心を「重心X + 差込口オフセット」に配置
- [x] `LeftPanel` に「差込口オフセット(mm)」入力（初期値0、正で右／負で左）を追加
- [x] ツメがカットラインから離れている場合、ツメを含むようカットラインを下方向へ拡張（`analysis/contour.ts` の `attachSlotTab`。区間端の下辺クロッシングからツメ矩形へ置換）
- [x] 拡張後の形状を外形として SVG エクスポートへ反映（`pipeline` が `result.contour` を拡張後カットラインに差し替え、overlay/SVG は自動追従。差込口帯は `bottomYPixel`＝足元まで）

### 19-5. 差込口幅のプリセット廃止（仕様変更）

- [x] 差込口幅入力を Select（プリセット）から数値入力のみへ変更（`LeftPanel` を `NumberField` 化。`state.ts` の `PARAMETER_PRESETS` から `slotWidthMm` を除去）

### 19-6. カットライン不具合修正（2回目テスト）

2回目テストで判明したカットライン関連の不具合対応（`docs/SPEC.md` 更新済み）。

- [x] **自己交差の回避**：`buildCutline` で各パーツを余白オフセット後 `polygon-clipping` の union にかけ、自己交差を単純多角形へ正規化（union が破綻する退化ケースは全点凸包へフォールバック）
- [x] **見切れ防止**：`useViewport` を内容範囲（画像∪カットライン∪オーバーレイの外接矩形）ベースへ変更し Fit/100% を拡張。自動フィットは画像 id（`fitKey`）で制御しパラメータ変更では再フィットしない。オーバーレイ SVG は `overflow-visible` で枠外も描画
- [x] **複数パーツの包絡**：`contour.ts` に 8 連結の連結成分ラベリング＋成分ごとの外周追跡（`extractContours`）を実装。第 1 相を `Contour[]` 化し、`buildCutline` の union で近接パーツを結合、余白でも分離が残れば凸包で全パーツを包絡
- [x] **曲線補完**：`utils/curve.ts` に閉 Catmull-Rom→3 次ベジェ変換（`closedCurvePathData`）を追加し、オーバーレイ・SVG エクスポートを曲線パス（`C` コマンド）で出力

## 20. 3回目テストの修正対応（ルーラー・差込部の再構成）

3回目テストで判明した不具合・仕様変更への対応（`docs/SPEC.md` 更新済み）。

### 20-1. ビューワーのルーラー（新機能）

- [x] `components/Preview.tsx` の上端に水平ルーラー・左端に垂直ルーラーを表示する（`components/Ruler.tsx`。目盛り計算は純粋ロジックの `render/ruler.ts` へ分離）
- [x] 目盛りは実寸(mm)。ズーム・パン（`useViewport` の transform）に追従させる（`screen = tx + mm × scale / mmPerPixel` の1次式で算出。スケールは解析結果を待たず `App` が `computeMmPerPixel` で導いて渡す）
- [x] ズーム率に応じて目盛り間隔を自動選択（1 / 5 / 10 / 50 / 100 mm）。主目盛りに数値ラベル、副目盛りは線のみ（主目盛りは間隔60px以上になる最小の候補。副目盛りは主の1/5、5px未満に潰れる場合は非表示）
- [x] ルーラーが `pointer-events` を奪わず、ドラッグパン・ホイールズームを妨げないことを確認（ルーラー全体を `pointer-events-none` に固定。実機での操作確認は要ブラウザ）

### 20-2. アクリル板と台座の上下関係（不具合修正・仕様変更）

- [x] 台座上面 Y の基準を「画像下端」から**カットライン最下端**へ変更する（`analysis/base.ts` の `computeBaseTopYPixel`）
- [x] `model/types.ts`・`model/state.ts` に「アクリル板の持ち上げ量(mm)」（`plateLiftMm`、既定 0、0〜50）を追加
- [x] 台座上面 Y = カットライン最下端 Y + 持ち上げ量 として `analysis/base.ts` ／ `render/overlay.ts` ／ `export/svg.ts` の基準線を統一する（`SlotResult.baseTopYPixel`／`BaseResult.topYMm` を単一の基準として共有。オーバーレイの台座も上辺を台座上面に合わせた幅×奥行の footprint 描画へ変更し、ツメが貫通していないことを目視できるようにした）
- [x] `LeftPanel` に「アクリル板の持ち上げ量(mm)」入力を追加
- [x] 重心高さ（転倒角・推奨奥行）の基準を台座上面へ変更する（`analysis/base.ts`・`analysis/stability.ts`。`render/simulation.ts` の支点も台座上面へ）

### 20-3. 重心マーカーの縮小（UI）

- [x] `render/overlay.ts` の `centroidRadius` を約 50% に縮小する（画像短辺の 1%→0.5%、下限 3px→1.5px）

### 20-4. 差込部を「首部＋ツメ」の2矩形へ再構成（仕様変更）

- [x] `model/types.ts`・`model/state.ts` に「首部幅(mm)」（`neckWidthMm`、既定 10、差込口幅とは独立）を追加
- [x] **制約「首部幅 > 差込口幅」を強制**する：下限を `差込口幅 + 2 × 最小ショルダー幅(片側0.5mm)` とし（`minNeckWidthMm`）、差込口幅の変更で下限を割る場合は首部幅を自動で押し上げる（`normalizeParameters` を reducer の `updateParameters` に噛ませ、UI 入力に依らず不変条件を保つ）
- [x] `LeftPanel` に「首部幅(mm)」入力を追加（下限を差込口幅に連動させる）
- [x] `analysis/slot.ts`：差込部を「首部（幅=首部幅、カットライン下辺〜台座上面）」と「ツメ（幅=差込口幅、深さ=板厚）」の2矩形として返す（`SlotResult` を拡張）。制約が破れた場合・首部が板から外れる場合は `slotPlacementFailed`
- [x] ツメ深さを板厚(mm)に固定し、台座を貫通しないこと（ツメ深さ ≦ 台座奥行）を保証する（台座奥行の床をツメ深さ×3＝スリット壁ぶんに取ることで構成的に保証）
- [x] `analysis/contour.ts` の `attachSlotTab` を「首部＋ツメ」形状のカットライン拡張へ変更する（`attachSlotBody`。首部側面→肩→ツメの外周で下辺の弧を置換）
- [x] `render/overlay.ts`・`export/svg.ts` を首部・ツメの2矩形描画へ更新する

### 20-5. 台座幅の直接指定・既定値見直し（仕様変更）

- [x] パラメータ「台座余白（`baseMarginMm`）」を「台座幅（`baseWidthMm`）」へ置き換える（`model/types.ts`・`model/state.ts`・`components/LeftPanel.tsx`）。**指定値がそのまま台座の実寸幅**になり、2 倍・加算はしない。既定値 50mm、範囲 1〜300mm
- [x] `analysis/base.ts`：安全率は幅を作る係数ではなく**指定幅の検査**に使う。必要幅 = `max(2 × |重心X − 差込口中心X| × 安全率, 差込口幅)` を下回る指定は自動で広げず `baseCalculationFailed`（`pipeline.ts` のメッセージも台座幅の見直しを促す文面へ）
- [x] 結果表示の「推奨台座幅」を「台座幅」へ改称（`components/ResultPanel.tsx`）
- [x] 既定値変更：差込口幅 5mm → **20mm**、首部幅 10mm → **40mm**（`model/state.ts` の `DEFAULT_PARAMETERS`）

## 21. 狭い隙間の充填（隙間埋め・仕様追加）

カットライン間の隙間が閾値より狭いとアクリルが破損しやすいため、狭い隙間をなめらかに充填する
（`docs/SPEC.md`「隙間埋め閾値」「狭い隙間の充填（隙間埋め）」参照）。方式はモルフォロジカル
クロージング（半径 = 閾値/2 の円板で膨張→収縮）。

- [x] `model/types.ts`・`model/state.ts` に「隙間埋め閾値(mm)」（`gapFillThresholdMm`、既定 0=無効、0〜20mm）を追加
- [x] `components/LeftPanel.tsx` に「隙間埋め閾値(mm)」入力を追加（カットライン平滑化の近くに配置）
- [x] `analysis/distance.ts`：`erodeMask(mask, width, height, radiusPx)` を実装（背景からの EDT > r をしきい値化。`dilateMask` の双対）
- [x] `analysis/distance.ts`：`closeMask(mask, width, height, radiusPx)` を実装（`dilateMask` のパディング付きグリッド上で `erodeMask` を掛け、原点ずれ（`offsetX/offsetY`）を返して呼び出し側で元座標へ復元。膨張・収縮でクランプ後の同一半径を共有。radiusPx ≦ 0 はスキップ）
- [x] `analysis/contour.ts`：`buildCutline` に `gapFillPx` 引数を追加し、余白膨張（`dilateMask`）直後・輪郭抽出前に半径 `gapFillPx / 2` のクロージングを適用
- [x] `analysis/pipeline.ts`：`cutlineKey` に隙間埋め閾値を含め、閾値変更時にカットラインメモ（`cutlineMemo`）が再生成されるようにする
- [x] クロージングで結合したパーツがブリッジ連結／凸包退避の対象から外れる（結合後の外周が 1 リングとして扱われる）ことを確認（Node 上の合成マスク検証：隙間 6px の 2 パーツが閾値 8px で 1 リング化・閾値 4px では 2 リングのまま／幅 40px の隙間は閾値 8px で埋まらない／元マスク ⊆ 充填後（外延性）を確認）
- [x] 重心・差込口・台座・オーバーレイ・SVG エクスポートが充填後カットラインへ自動追従することを確認（`buildCutline` の戻り値が `runAnalysis` の `contour` としてそのまま下流へ流れるため構造的に追従。要ブラウザ実機確認）

## 将来拡張（バックログ）

- [ ] 複数差込口
- [ ] 円形台座
- [ ] 楕円台座
- [ ] 任意形状台座
- [ ] 金属スタンド対応
- [ ] アクリル以外の素材
- [ ] 密度マップ
- [ ] パーツ分割
- [ ] 複数PNG同時計算
- [ ] PWA化 / WebAssembly置き換え
