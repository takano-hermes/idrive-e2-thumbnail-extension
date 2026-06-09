# Issue #42: サムネイル垂直位置ずれ — 根本原因分析と修正仕様書

> **プロジェクト**: idrive-e2-thumbnail-extension
> **Issue**: [#42 サムネイルの垂直位置ずれ](https://github.com/takano-hermes/idrive-e2-thumbnail-extension/issues/42)
> **作成日**: 2026-06-09
> **優先度**: 高
> **修正見積**: 小〜中（content.js + styles.css の修正）

---

## 目次

1. [症状](#1-症状)
2. [DOM構造とCSSカスケード](#2-dom構造とcssカスケード)
3. [根本原因](#3-根本原因)
4. [過去の修正の失敗理由](#4-過去の修正の失敗理由)
5. [修正方針](#5-修正方針)
6. [詳細仕様](#6-詳細仕様)
7. [変更ファイル](#7-変更ファイル)
8. [検証項目](#8-検証項目)

---

## 1. 症状

### 1.1 ユーザー観測

| ブラウザ横幅 | 表示状態 | 症状 |
|-------------|---------|------|
| **広い** (≳1200px) | **× 異常** | サムネイルとファイル名テキストが行の垂直中央より**下にずれる**。見た目上「下寄り」になる。 |
| **狭い** (<900px) | **○ 正常** | サムネイルとテキストが行の垂直中央に**正しく表示**される。 |

### 1.2 実測データ（ユーザー提供）

```
広い画面（異常時）:
  div.e2c-tb-rw          → height: 60px  (行全体)
  div.e2c-td.e2c-os-name → height: 82px  (ファイル名セル)
  ⇒ セル(82px) > 行(60px) → 22px分あふれ

狭い画面（正常時）:
  div.e2c-tb-rw          → height: 60px  (行全体)
  div.e2c-td.e2c-os-name → height: ~60px (ファイル名セル)
  ⇒ セル≒行 → 中央揃え正常
```

---

## 2. DOM構造とCSSカスケード

### 2.1 拡張機能適用後のDOM構造

```html
<!-- ▼ IDrive e2 の仮想スクロール行 (CDK Virtual Scroll) -->
<!--  width: 100%; display: flex; または display: table-row? -->
<div class="e2c-tb-rw" style="height: 60px"> ← CDK が itemSize で固定

  <!-- ... 他のセル（チェックボックス、サイズ、更新日など）... -->

  <!-- ▼ ファイル名列セル (table-cell) -->
  <div class="e2c-td e2c-os-name">
    <!-- ★ 拡張機能が挿入したサムネイルwrapper (inline-flex) -->
    <div class="e2c-thumb-wrapper"
         style="display:inline-flex; align-items:center; justify-content:center;
                width:60px; min-width:60px; position:relative;
                vertical-align:middle; padding:2px 4px;">
      <img class="e2c-thumb-img" ...>
    </div>
    <!-- ★ 元のファイル種別アイコン span (背景画像は非表示に) -->
    <span class="e2c-sts-image e2c-icon-image-hidden">
      filename.ext        ← 元のテキストノード
    </span>
  </div>

  <!-- ... その他セル ... -->
</div>
```

### 2.2 セルの高さに影響するCSSの流れ

```
e2c-tb-rw (display: flex または table)
  ↓ height: 60px (CDK Virtual Scroll の itemSize=60)
  ↓
e2c-td.e2c-os-name (display: table-cell)
  ↓ vertical-align: middle !important  (拡張機能が設定)
  ↓ padding-top: 0, padding-bottom: 0  (拡張機能が設定)
  ↓
  ├── e2c-thumb-wrapper (inline-flex, ~32px高)
  │     height: ~32px (thumbSize=40のobject-fit:cover + padding)
  │
  └── e2c-sts-image (元のアイコンspan)
        ├── 元CSS: padding: 8px 4px  (← 推定値、広い画面で有効)
        │          line-height: 24px (← 推定値、広い画面で有効)
        │          ::before { width: 24px; height: 24px; } (アイコン画像)
        │          → トータル高さ: 8px + 24px + 8px = 40px
        │
        └── 拡張CSS: background-image: none !important
                     vertical-align: middle !important
                     height: auto !important
                     padding: 0 !important
                     line-height: normal !important
                     max-height: 1.5em !important
                     overflow: hidden !important
                     ::before/::after: display:none !important
```

### 2.3 CDK Virtual Scroll の特殊性

IDrive e2 コンソールは Angular CDK の `cdk-virtual-scroll-viewport` を使用している。
`<cdk-virtual-scroll-viewport itemSize="60">` のように、各行の高さを `itemSize` で指定している。
この場合：

1. CDK が各行の `.e2c-tb-rw` に **インラインの `height: 60px`** を設定
2. スクロール位置に応じて行の高さが一定になるよう強制
3. セル（`e2c-td`）は `display: table-cell` の性質上、**行より大きくなれる**
   - セルの内容が行の高さを超えると、セルだけがはみ出す
4. この「セルのはみ出し」が垂直位置ずれの直接原因

---

## 3. 根本原因

### 3.1 原因の連鎖

```
1. IDrive が広い画面でアイコン span に
   大きな padding / line-height / 疑似要素サイズを適用
   ↓
2. e2c-sts-image span の高さがテキスト＋余白で
   約40px になる（狭い画面では約20px）
   ↓
3. e2c-os-name (table-cell) が内容に合わせて拡大
   高さ = max(サムネイルwrapper高さ, アイコンspan高さ) + パディング
   　　 = max(~32px, ~40px) = 82px（セル内パディング込み）
   ↓
4. e2c-tb-rw は CDK により height:60px に固定されている
   ↓
5. セル(82px) > 行(60px) → セルが行の下にはみ出す（22px あふれ）
   ↓
6. vertical-align: middle はセル(82px) の中で中央揃えを計算
   　　 = 82/2 - コンテンツ高/2
   ↓
7. 行(60px) の中では、中央位置が**下寄り**に見える
   　　 = 可視領域の中央(30px) - コンテンツ中央(41px) = -11px
   　　 → コンテンツが11px下にずれて見える
```

### 3.2 なぜ狭い画面では正常なのか

IDrive e2 コンソールは **レスポンシブ** であり、ビューポート幅に応じてCSSクラスやプロパティを切り替えている可能性が高い：

| ビューポート | アイコンspanの状態 | セル高さ | 結果 |
|-------------|-------------------|---------|------|
| 広い | 大きなpadding/line-height | 82px (>60px) | ずれる |
| 狭い | 小さなpadding/line-height | ~60px (≒行) | 正常 |

具体的なCSSの切り替え手段としては：
- **CSS Media Query** (`@media (min-width: ...)`)
- **Angular CDK の Layout API**（`BreakpointObserver` によるクラス付与）
- **CDK Virtual Scroll 自体のビューポートサイズ依存のスタイル変更**

いずれにせよ、アイコンspan（`e2c-sts-image`）の寸法が広い画面で増大することが原因。

### 3.3 本質的な問題点

```text
【問題の本質】

「table-cell の vertical-align: middle はセル内コンテンツの
 中央揃えに使えるが、セル自体が行より大きい場合は効果がない」

つまり：
  Fix A: セルを行と同じ高さにする  OR  Fix B: セルが行より大きくならないようにする
  のどちらかが必要。
```

---

## 4. 過去の修正の失敗理由

### v1: `vertical-align: middle` をCSS追加
```
手法: .e2c-icon-image-hidden { vertical-align: middle !important; }
結果: 狭い画面OK、広い画面でCSS上書きされずれ解消せず
原因: vertical-align はinline要素の行内での揃えに効くが、
      セル(table-cell)の高さが行より大きい根本原因には無力
```

### v2: `height: auto` をCSS追加
```
手法: .e2c-icon-image-hidden { height: auto !important; }
結果: テキスト位置がずれたまま
原因: height だけでは padding/line-height 由来の高さを除去できない
```

### v3: flex wrapper導入（JS）
```
手法: e2c-os-name 内に div.e2c-thumb-flex (display:flex;align-items:center)
      でサムネイル＋テキストをラップ
結果: 左右の順序が逆（テキスト→サムネイル）
原因: 実装ミス（順序が逆）。flex wrapper 自体のアプローチは有効。
```

### v4: 順序修正＋vertical-align:middle（JS）
```
手法: flex wrapper内の順序修正、nameCell.style.verticalAlign = 'middle'
結果: 狭い画面OK、広い画面で下にずれる
原因: vertical-align が table-cell に効いても、セル>行のため無意味
```

### v5: display:flex に変更（JS）
```
手法: e2c-os-name自身を display:flex;align-items:center に変更
結果: セルの高さが行と一致せず、上寄りになる
原因: display:flex にすると table-cell ではなくなり、
      行(table-row)の高さ制約から外れる。
      結果としてセルが行の高さに引き伸ばされず、内容物の最小高さに縮む。
      行(60px)の中でセル(~32px)が上に張り付く。
```

### v6: アイコンspanのpadding/line-height制限（CSS+JS）
```
手法: .e2c-icon-image-hidden { padding:0; line-height:normal; 
       max-height:1.5em; overflow:hidden; }
結果: セルの高さは小さくなったが、行より小さいため上寄りのまま
原因: アイコンspanの高さは減ったが、セル全体の高さが行より
      小さくなってしまった（縮めすぎ）。
      加えて、display:flex が残っている場合はセル=行にならない。
```

### v7: table-cell + vertical-align に戻す（JS）
```
手法: display:flex を廃止。nameCell.style.setProperty('vertical-align',
      'middle', 'important')
結果: 未確認。ただし以下の問題が残る：
      1. アイコンspanのCSSが広い画面でセルを82pxに引き伸ばす
      2. 引き伸ばされたセル内で vertical-align:middle でも
         可視領域(60px)では下寄りに見える
      3. !important でもコンソールCSSのセル高さへの影響は防げない
```

### 失敗パターンのまとめ

| 試み | 結果 | なぜ失敗 |
|------|------|---------|
| CSSでアイコンspan縮小 | 広い画面で効果不十分 | IDriveのレスポンシブCSSが強力 |
| display:flex | セルが縮みすぎ | 行(60px)との高さ連動が切れる |
| vertical-align | セル>行では無意味 | 可視領域がセルの一部しかない |
| !important | 一部のプロパティのみ有効 | コンソールCSSの高さ影響までは防げない |

---

## 5. 修正方針

### 5.1 基本戦略

**「セルの高さを行の高さに強制的に一致させる」**

これが唯一、すべてのケースで機能する方法である。
理由：

1. `height: 60px` と固定された行に対して、セルを `height: 60px; max-height: 60px` に制限すれば、セルの**み**がはみ出すことはなくなる
2. セルが行にぴったり収まれば、`vertical-align: middle` が正しく機能する
3. アイコンspanがどんなCSSを持っていても、`overflow: hidden` であふれを隠せる

### 5.2 なぜCSS-onlyでは不十分か

```css
/* CSSでセルの高さを行に合わせようとしても… */
.e2c-os-name {
  height: 100% !important;     /* table-cellでは: テーブル全体の高さに対する% */
  max-height: 100% !important; /* table-cellでは: テーブル全体の高さに対する% */
}
```

CSS table レイアウトでは、セルの `height` や `max-height` のパーセンテージは**テーブル全体**（この場合 `.e2c-tb-rw` を含むコンテナ）に対する値であり、**行の高さ**に対するものではない。したがって純CSSでは「セルの高さを行と一致させる」ことができない。

**→ JavaScript で実測値を設定する必要がある**

### 5.3 採用するアプローチ

```
アプローチ: JS で行の高さを計測 → セルに同じ高さを設定
           
           processRow 内で:
             1. row.offsetHeight を計測
             2. nameCell.style.height を同じ値に設定
             3. nameCell.style.maxHeight も同じ値に設定
             4. nameCell.style.overflow = 'hidden'
             5. nameCell.style.boxSizing = 'border-box'
             6. nameCell の vertical-align:middle は維持
             7. アイコンspanのCSS制限も維持（防御的）
```

---

## 6. 詳細仕様

### 6.1 content.js の修正

#### 6.1.1 `processRow` 関数内の修正（既存の設定ブロック後）

現在のコード（v7）:

```js
nameCell.style.setProperty('vertical-align', 'middle', 'important');
nameCell.style.paddingTop = '0';
nameCell.style.paddingBottom = '0';
nameCell.insertBefore(thumbEl, iconEl);
```

修正後:

```js
nameCell.style.setProperty('vertical-align', 'middle', 'important');
nameCell.style.paddingTop = '0';
nameCell.style.paddingBottom = '0';
nameCell.insertBefore(thumbEl, iconEl);

// ============================================================
// ★★★ セル高さを行に一致させる（Issue #42 垂直位置ずれ対策）★★★
// ============================================================
// CDK Virtual Scroll が行に固定の高さを設定している場合、
// コンテンツ（アイコンspan）がセルを押し広げると
// セル(82px) > 行(60px) となり vertical-align が無効化される。
// 対策: 行の実測高さを取得し、セルに同じ高さを設定する。
const rowHeight = row.offsetHeight;
if (rowHeight > 0) {
  nameCell.style.height = rowHeight + 'px';
  nameCell.style.maxHeight = rowHeight + 'px';
  nameCell.style.overflow = 'hidden';
  nameCell.style.boxSizing = 'border-box';
}
```

#### 6.1.2 リサイズ時の再計算（追加の考慮点）

画面リサイズ時に CDK が行の高さを変える可能性がある。ただし：

- IDrive e2 の `itemSize` は固定値（60px）と思われ、リサイズで変わらない
- 仮に変わった場合でも、次にスクロールして行が再利用される際に `processRow` が再実行される
- したがって、**リサイズイベントでの再計算は不要**

ただし、MutationObserver で行の高さ変更を検出できるとより堅牢。以下のコードを任意（推奨）で追加：

```js
// MutationObserver の callback 内で、既存行の高さ変更を検出
// 新規に行が追加された場合は processRow が走るので不要
// 既存行のスタイル変更（高さ変更）を検出するための拡張（オプショナル）
```

→ **スコープ外とする**（MVPでは固定値のカバレッジで十分）

#### 6.1.3 該当ブロックの最終形

`content.js` の processRow 関数内、`nameCell.insertBefore(thumbEl, iconEl);` 直後に以下のコードブロックを追加：

```js
// ★★★ Issue #42: セル高さを行に一致させる ★★★
// CDK Virtual Scroll が行に height:60px を固定する一方、
// アイコンspanのCSSがセルを 82px に押し広げるため、
// 行の実測高さでセルを制限する。
const rh = row.offsetHeight;
if (rh > 0) {
  const cellStyle = nameCell.style;
  cellStyle.height = rh + 'px';
  cellStyle.maxHeight = rh + 'px';
  cellStyle.overflow = 'hidden';
  cellStyle.boxSizing = 'border-box';
}
```

### 6.2 styles.css の修正

現在の `.e2c-icon-image-hidden` は維持した上で、以下のプロパティを追加：

```css
.e2c-icon-image-hidden {
  /* 既存の設定（維持） */
  background-image: none !important;
  background: none !important;
  vertical-align: middle !important;
  height: auto !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  line-height: normal !important;
  max-height: 1.5em !important;
  overflow: hidden !important;

  /* ★★★ 追加: 水平方向の余白も削除 ★★★ */
  padding-left: 0 !important;
  padding-right: 0 !important;

  /* ★★★ 追加: min-height のリセット ★★★ */
  min-height: 0 !important;
  min-width: 0 !important;
}
```

**追加理由:**
- `padding-left/right` → アイコンspanが水平方向の余白を持っている場合、それが間接的にセル幅を増やし、レイアウトに影響する可能性を排除
- `min-height/min-width` → IDriveがこれらのプロパティで最小サイズを強制しているケースに対応

### 6.3 修正後の動作フロー

```
広い画面:
  1. CDK が行に height:60px を設定
  2. processRow が実行される
  3. row.offsetHeight → 60 を取得
  4. nameCell.style.height = '60px'
     nameCell.style.maxHeight = '60px'
     nameCell.style.overflow = 'hidden'
     nameCell.style.boxSizing = 'border-box'
  5. アイコンspanがどんなCSSを持っていても、
     セルの高さは60pxに制限される
  6. アイコンspanのあふれは overflow:hidden で隠れる
  7. vertical-align: middle が60pxの中で機能
     サムネイルwrapper + テキストが中央に表示される ✓

狭い画面:
  1. CDK が行に height:60px を設定
  2. processRow が実行される
  3. row.offsetHeight → 60 を取得
  4. nameCell.style.height = '60px' （もともと60pxなので変化なし）
  5. 従来通り正しく中央表示される ✓
```

### 6.4 エッジケース

| ケース | 動作 | 備考 |
|--------|------|------|
| row.offsetHeight が 0 | 条件ガードにより何もしない | DOM未レンダリング時など |
| 行の高さがリサイズで変更 | その行がMutationObserverで再検出されなければ再計算されない | 次回スクロール時の processRow 再実行で対応可 |
| display:flex の行 | offsetHeight 取得に問題なし | ただし flex 行ではこの処理は不要だが、悪影響もない |
| itemSize の変更 | 次回の processRow で新しい高さが反映される | OK |
| 古い .e2c-thumb-flex の残骸 | 既存の削除コードが対応 | OK |

---

## 7. 変更ファイル

| ファイル | 変更内容 | 行数影響 |
|---------|---------|---------|
| `content.js` | `processRow` 内にセル高さ制限コードを追加（12行） | +12行 |
| `styles.css` | `.e2c-icon-image-hidden` に4プロパティ追加 | +4行 |

### 7.1 変更の依存関係

- content.js の修正は **単独で機能する**
- styles.css の修正は **補助的**（必須ではないが、あったほうが堅牢）
- 既存の v7 コード（vertical-align:middle, paddingリセット）は**そのまま維持**

### 7.2 ロールバック手順

修正箇所は processRow 内の1ブロックと CSS の4行のみ。
リバートは以下のコマンドで可能:

```bash
git diff content.js styles.css  # 変更確認
git checkout -- content.js styles.css  # リバート
```

---

## 8. 検証項目

### 8.1 検証環境

- Chrome最新版（130+）
- IDrive e2 コンソール実環境（`console.idrivee2.com`）
- ビューポート: 1920×1080（広） / 800×600（狭）
- テストファイル: 画像(.jpg, .png, .heic)、動画(.mp4)

### 8.2 検証手順

```
手順1: 広い画面（1920px）でテスト
  期待結果: すべてのサムネイルとファイル名が行の垂直中央に表示される
  確認方法: Chrome DevTools Elements パネルで各セルの
            computed height が行と一致していることを確認

手順2: 狭い画面（800px）でテスト
  期待結果: 従来通り正常に中央表示される（リグレッションなし）

手順3: スクロール（仮想スクロールのDOM再利用）
  期待結果: スクロール後も新しく表示される行で垂直位置が正しい

手順4: SPA遷移（prefix変更→別フォルダへ移動）
  期待結果: 遷移後も正しく表示される

手順5: リサイズ（広→狭、狭→広）
  期待結果: リサイズ後に表示される行で垂直位置が正しい
  注: すでに表示されている行はリサイズで再計算されないが、
      これは「狭→広」の一方向でしか問題にならない（狭は元々正しい）
      かつ、次回スクロールで再計算される。
```

### 8.3 確認すべきCSSプロパティ

DevTools で以下のプロパティが正しく設定されていることを確認:

```text
div.e2c-td.e2c-os-name (Computed):
  height: 60px           ← row.offsetHeight の値
  max-height: 60px       ← row.offsetHeight の値
  overflow: hidden       ← 固定
  box-sizing: border-box ← 固定
  vertical-align: middle ← v7から維持
```

### 8.4 パス/失敗条件

| 条件 | 結果 |
|------|------|
| すべての行でセル高さ=行高さ | **PASS** |
| サムネイル＋テキストが行の垂直中央に表示される | **PASS** |
| 狭い画面でも従来通り表示される（リグレッションなし） | **PASS** |
| アクションメニュー（削除・コピー）の表示位置がずれない（#39 維持） | **PASS** |
| どの行のセル高さも行を超えている | **FAIL** → 原因調査 |

---

## Appendix A: 補足図解

### A.1 現状の問題（広い画面）

```
 表示領域 ONLY (行=60px)
┌──────────────────────────────────────┐
│                                      │  ← 行の上端
│                                      │
│          ┌────────────────┐          │
│          │ サムネイルwrapper │          │
│          │    (32px)      │          │
│          └────────────────┘          │
│          filename.ext                │
│                                      │
│                                      │
├──────────────────────────────────────┤  ← 行の下端 (=60px)
│        ↑                              │
│    この領域が "はみ出し" ている        │  ← セルの下端 (=82px)
│    セル内では中央揃えされているが       │
│    可視領域(行)より下にあるため         │
│    ユーザーには「下寄り」に見える       │
└──────────────────────────────────────┘

セル(82px)の中央 = 41px
行(60px)の中央   = 30px
ずれ = 41 - 30 = 11px 下にずれる
```

### A.2 修正後（広い画面）

```
 表示領域 = 行 = セル (どちらも60px)
┌──────────────────────────────────────┐
│                                      │
│          ┌────────────────┐          │
│    ← 空 │ サムネイルwrapper │          │
│    白   │    (32px)      │          │
│          └────────────────┘          │
│          filename.ext                │
│                                      │
│                                      │
├──────────────────────────────────────┤  ← 行の下端 = セルの下端
│ (アイコンspanのあふれは              │
│  overflow:hidden で隠れている)        │
└──────────────────────────────────────┘

セル(60px)の中央 = 30px
行(60px)の中央   = 30px
ずれ = 0px ✓
```

### A.3 なぜ JS による実測が必要か

CSS table レイアウトの制約:

```
CSS で「セルの高さを行に合わせる」には以下の理由で JS が必要：

1. height: 100%     → テーブル全体に対する% (行に対する%ではない)
2. max-height: 100% → 同上
3. height: inherit  → table-cell では親(table)の高さを継承（行ではない）
4. CSSには「親行の高さを参照する」プロパティがない
   → JavaScript で row.offsetHeight を取得するしか手段がない
```

---

*本仕様書は Issue #42 の根本原因分析と修正設計を目的としています。*
