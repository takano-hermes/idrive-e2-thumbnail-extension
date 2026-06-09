# Issue #52 修正仕様書 — フォルダ移動時のアイコン・アクションアイコン位置ズレ

## 1. 症状

フォルダ間をSPA遷移すると、サムネイルがない行（非画像/動画ファイル行や `.ts` フォルダ行）で以下の位置ズレが発生する:

- ファイル名列 (`.e2c-os-name`) 内のアイコン表示位置がズレる
- アクション列のアイコン（削除・コピー・移動等）の表示位置が1行分ずれる
- **画面リロードで直る** → SPA遷移時のスタイルクリーンアップ不足

## 2. 観察されたDOM（ずれ状態）

```html
<div class="e2c-tb-rw">
  <div class="e2c-check-container">...</div>
  <!-- ★ サムネイルwrapperが行の直接の子（e2c-os-name内部ではない） -->
  <div class="e2c-thumb-wrapper" style="display: inline-flex; ...">
    ▶<img alt=".ts" style="display:none"><span>🎬</span>
  </div>
  <!-- ★ nameCell に前の行の flex スタイルが残っている -->
  <div class="e2c-td e2c-os-name"
       style="display: flex; align-items: center; gap: 4px;
              padding-top: 0px; padding-bottom: 0px;
              height: 60px; max-height: 60px; overflow: hidden;
              box-sizing: border-box;">
    <span class="e2c-icon-image-hidden e2c-sts-folder" title=".ts"> .ts </span>
  </div>
  ...
</div>
```

### 異常箇所

| 要素 | 問題 |
|------|------|
| `.e2c-thumb-wrapper` | 行の直接の子として存在（本来は存在すべきでない `.ts` フォルダ行） |
| `.e2c-os-name` | `display:flex; height:60px` が残っている（前の画像行のスタイル） |
| `.e2c-sts-folder` | `e2c-icon-image-hidden` クラスが付与されたまま（除去されていない） |

## 3. 根本原因

### 原因1: `findOrigIconElements()` の `[class^="e2c-sts-"]` セレクタ不具合

**ファイル**: `content.js` 763行目

```javascript
const iconEl = nameCell.querySelector('[class^="e2c-sts-"]');
```

CSS属性セレクタ `[class^="e2c-sts-"]` は、`class` 属性値が **文字列として** `e2c-sts-` で「始まる」要素のみマッチする。

拡張機能が `e2c-icon-image-hidden` クラスを追加すると、`class` 属性値は以下のようになる:

```
e2c-icon-image-hidden e2c-sts-folder
```

この文字列は `e2c-icon-image-hidden` で始まり、`e2c-sts-` では始まらない。**よってセレクタがマッチせず、`iconEl` が `null` になる。**

#### 影響の連鎖

```
iconEl = null
  ↓
フォルダスキップ不可（line 804: iconEl && ... → false）
  ↓
.ts フォルダがフォルダと認識されない
  ↓
(次に進む)
```

### 原因2: `.ts` が `videoExts` とフォルダ名の両方にマッチする

**ファイル**: `content.js` 16行目

```javascript
videoExts: new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp', '.wmv', '.flv', '.ts']),
```

`CONFIG.thumbDir = '.ts'`（サムネイル格納ディレクトリ）であり、IDrive e2 のUI上で `.ts` という名前のフォルダが行として表示される。

`.ts` フォルダ行:
- `getFilename(row)` → `".ts"`
- `getExtension(".ts")` → `".ts"`
- `CONFIG.videoExts.has(".ts")` → **`true`**（動画拡張子として登録済み）
- `isVideo = true`

#### 影響の連鎖

```
isVideo = true
  ↓
非画像/非動画スキップ不可（line 824: !isImage && !isVideo → false）
  ↓
(次に進む)
```

### 原因3: 原因1+原因2の複合 → 二重スキップ失敗

```
iconEl = null（原因1） ∧ isVideo = true（原因2）
  ↓
line 804: iconEl && iconEl.classList.contains('e2c-sts-folder') → FALSE ❌（フォルダスキップ失敗）
line 824: !isImage && !isVideo → FALSE ❌（非画像スキップ失敗）
  ↓
画像/動画処理にフォールスルーしてしまう
  ↓
line 857: iconEl && nameCell → FALSE（iconElがnull）
  ↓
フォールバックパス（line 897-906）へ
  ↓
サムネイルwrapperが行の直接の子として挿入される
  ↓
nameCellのスタイルはクリーンアップされない
```

### 原因4: フォールバックパスにスタイルクリーンアップがない

**ファイル**: `content.js` 897-906行目

```javascript
} else {
  // フォールバック: e2c-os-name が見つからない場合
  log('processRow: WARN - e2c-os-name not found, using fallback position');
  const checkContainer = row.querySelector('.e2c-check-container');
  if (checkContainer && checkContainer.nextSibling) {
    row.insertBefore(thumbEl, checkContainer.nextSibling);
  } else {
    row.insertBefore(thumbEl, row.firstChild);
  }
}
```

このパスでは:
- `nameCell` のインラインスタイル (`display:flex`, `height:60px` etc.) が**一切クリアされない**
- `e2c-icon-image-hidden` クラスが**除去されない**
- 古い `.e2c-thumb-wrapper` の削除しか行われない

### 原因5: SPA遷移時のタイミング問題（二次的要因）

**ファイル**: `content.js` 968-977行目

```javascript
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    processedRows = new WeakSet();
    presignedUrlCache = new Map();
    document.querySelectorAll('.e2c-thumb-wrapper').forEach(el => el.remove());
    setTimeout(processAllRows, 1000);
  }
}, 2000);
```

**2000ms間隔のURLチェック** + **1000ms遅延のprocessAllRows** の間に、2秒ごとの定期チェック（line 982-987）が割り込む可能性がある:

1. URL変更検出 → wrapper全削除、processAllRowsを1秒後に予約
2. 仮想スクロールがDOM行を更新中（データ読み込み完了前）
3. 2秒ごとの定期チェック（line 982）が **即時** processAllRowsを実行
4. 仮想スクロールの行更新が完了していない → 行の `getFilename()` が前のフォルダのファイル名や空文字を返す
5. **間違ったファイル名で `processedRows.add(row)` が実行される**
6. その後仮想スクロールが行を正しく更新しても、当該行は `processedRows` に登録済み → 再処理されない
7. 次回の定期チェック（最大2秒後）まで表示が壊れたまま

### 原因6: `:scope > .e2c-thumb-wrapper` が誤った前提に基づく

**ファイル**: `content.js` 818行目, 846行目

```javascript
const staleWrapper = row.querySelector(':scope > .e2c-thumb-wrapper');
```

このセレクタは `wrapper` が**行の直接の子**であることを前提としている。しかし、画像/動画行では `nameCell.insertBefore(thumbEl, iconEl)`（line 876）で `wrapper` は **`nameCell` 内**に挿入される。したがって:

- 画像/動画行 → wrapperは `nameCell` 内 → `:scope > .e2c-thumb-wrapper` でマッチしない（正しい挙動）
- フォールバックパス（原因3）→ wrapperは行の直接の子 → `:scope > .e2c-thumb-wrapper` でマッチする

これは間違ってはいないが、**原因3のフォールバックパスで挿入されたwrapperだけがこのセレクタで除去される** という非対称性が存在する。

## 4. 問題の全体フロー図

```
[ユーザー操作: フォルダ移動]
        │
        ▼
[SPA URL変更] ─── setInterval(2000ms) ───→ [wrapper全削除]
        │                                      processAllRows(1000ms後予約)
        ▼
[仮想スクロール: DOM行を非同期で更新開始]
        │
        ▼
[定期チェック(2000ms): processedRowsリセット + processAllRows即時実行]
        │
        ▼
[processRow実行]
   ├─ getFilename(row) → ".ts"
   ├─ ext = ".ts"
   ├─ isVideo = TRUE（原因2: .ts ∈ videoExts）
   ├─ findOrigIconElements()
   │    └─ [class^="e2c-sts-"] マッチせず → iconEl = null（原因1）
   ├─ フォルダスキップ: iconEl==null → false（原因3）
   ├─ 非画像スキップ: isVideo=true → false（原因3）
   └─ 画像/動画処理へ
        ├─ createThumbnailElement(".ts", ".ts", isVideo=true)
        │    └─ wrapper作成（▶ + 🎬）
        ├─ iconEl && nameCell → false（iconEl==null）
        └─ フォールバックパス（原因4）
             ├─ wrapperを行の直接の子に挿入
             └─ nameCellスタイル未クリア ← ★ ズレの直接原因
```

## 5. 修正仕様

### 5.1 `findOrigIconElements()` のセレクタ修正（原因1への対策）

**対象行**: `content.js` 763行目

**変更内容**: `[class^="e2c-sts-"]` を、スペース区切りクラスを正しく認識するセレクタに変更する。

CSS属性セレクタ `[class^="e2c-sts-"]` は class 属性値の**文字列先頭**と比較するため、`e2c-icon-image-hidden e2c-sts-folder` のような複数クラスで機能しない。代わりに以下を使用する:

**案A（推奨）**: `[class*=" e2c-sts-"], [class^="e2c-sts-"]`

- `[class^="e2c-sts-"]` → クラスが先頭にある場合に対応
- `[class*=" e2c-sts-"]` → クラスが途中（スペース区切り後）にある場合に対応

```javascript
const iconEl = nameCell.querySelector('[class*=" e2c-sts-"], [class^="e2c-sts-"]');
```

**案B**: `Element.matches()` + クラスリストの確認

```javascript
const allSpans = nameCell.querySelectorAll('span');
let iconEl = null;
for (const span of allSpans) {
  for (const cls of span.classList) {
    if (cls.startsWith('e2c-sts-')) {
      iconEl = span;
      break;
    }
  }
  if (iconEl) break;
}
```

**評価**: 案Aがシンプルで軽量。ただし複数クラスが `e2c-` で始まる別のクラスを持つ場合は誤マッチの可能性があるが、IDrive e2 の `e2c-sts-*` パターンは一意であるため問題ない。**案Aを採用。**

### 5.2 `.ts` の `videoExts` からの削除または迂回（原因2への対策）

**対象行**: `content.js` 16行目

**変更内容**: `.ts` を `videoExts` から削除する。

**.ts が videoExts に含まれている理由（推定）:**
- MPEG-TS（Transport Stream）動画フォーマットの拡張子としての対応
- しかし IDrive e2 のコンテキストでは `.ts` はサムネイルディレクトリ名であり、実際の動画ファイルとしてアップロードされることは稀

**リスク評価:**
- `.ts` 動画ファイルがアップロードされていた場合、サムネイル表示と動画再生機能が動作しなくなる
- 現実的には `.ts` ファイルはIDrive e2ではほとんど使われない（MP4/MOVが主流）
- `.ts` フォルダ問題を解決するメリットの方が大きい

**代替案**: 拡張子チェックの前にフォルダクラスチェックを行う（原因1が修正されれば自然に解決する）。

**推奨**: `.ts` を `videoExts` から削除する。または、フォルダスキップを拡張子チェックより前に移動する（下記5.3参照）。

### 5.3 フォルダスキップの判定条件強化（原因3への対策）

**対象行**: `content.js` 804行目

**変更内容**: `iconEl` に依存しないフォルダ判定を追加する。

現在:
```javascript
if (iconEl && iconEl.classList.contains('e2c-sts-folder')) {
```

修正後:
```javascript
// フォルダ判定: iconEl の classList 確認 + 代替手段として class 属性の文字列検索
const isFolder = iconEl
  ? iconEl.classList.contains('e2c-sts-folder')
  : nameCell && nameCell.querySelector('[class*=" e2c-sts-folder"], [class^="e2c-sts-folder"]');
if (isFolder) {
```

これにより `iconEl` が null でもフォルダ判定が可能になる。

### 5.4 フォールバックパスにスタイルクリーンアップを追加（原因4への対策）

**対象行**: `content.js` 897-906行目

**変更内容**: フォールバックパスでも `nameCell` のインラインスタイルをクリアし、`e2c-icon-image-hidden` を除去する。

```javascript
} else {
  // フォールバック: e2c-os-name が見つからない場合
  log('processRow: WARN - e2c-os-name not found, using fallback position');

  // ★★★ フォールバック時もスタイルクリーンアップを実施 ★★★
  // 仮想スクロール行再利用時に前の画像行のスタイルが残っているため
  if (nameCell) {
    nameCell.style.display = '';
    nameCell.style.alignItems = '';
    nameCell.style.gap = '';
    nameCell.style.paddingTop = '';
    nameCell.style.paddingBottom = '';
    nameCell.style.height = '';
    nameCell.style.maxHeight = '';
    nameCell.style.overflow = '';
    nameCell.style.boxSizing = '';
  }
  // ★★★ iconEl があれば e2c-icon-image-hidden を除去 ★★★
  if (iconEl) {
    iconEl.classList.remove('e2c-icon-image-hidden');
  }

  const checkContainer = row.querySelector('.e2c-check-container');
  if (checkContainer && checkContainer.nextSibling) {
    row.insertBefore(thumbEl, checkContainer.nextSibling);
  } else {
    row.insertBefore(thumbEl, row.firstChild);
  }
}
```

### 5.5 SPA遷移検出のタイミング改善（原因5への対策）

**対象行**: `content.js` 968-977行目

**変更内容**: URL変更検出時の処理をより堅牢にする。

現在:
```javascript
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    processedRows = new WeakSet();
    presignedUrlCache = new Map();
    document.querySelectorAll('.e2c-thumb-wrapper').forEach(el => el.remove());
    setTimeout(processAllRows, 1000);
  }
}, 2000);
```

問題点:
1. `setInterval` ベース（2秒間隔） → 高速なSPA遷移（1秒以内）を見逃す可能性
2. 1000msの遅延＋仮想スクロールの非同期更新 → タイミング競合

修正後:
```javascript
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    processedRows = new WeakSet();
    presignedUrlCache = new Map();
    document.querySelectorAll('.e2c-thumb-wrapper').forEach(el => el.remove());

    // ★★★ 仮想スクロールの更新を待つため、遅延+リトライ ★★★
    // 1回目のprocessAllRows: 1000ms後（データ読み込み完了を期待）
    // 2回目のprocessAllRows: 2000ms後（データ読み込みが遅い場合のフォールバック）
    const attemptProcess = (delay) => {
      setTimeout(() => {
        // URLが変わっていないこと（連続遷移でないこと）を確認
        if (location.href === lastUrl) {
          processedRows = new WeakSet();
          processAllRows();
        }
      }, delay);
    };
    attemptProcess(1000);
    attemptProcess(2000);
  }
}, 1000); // ★★★ チェック間隔を 2s→1s に短縮
```

これにより:
- URL変更検出がより迅速に
- 2回のprocessAllRows試行で仮想スクロールの非同期更新をカバー
- URL連続遷移時の誤処理を防止

### 5.6 定期チェックとURL変更検出の競合防止（原因5の副次対策）

**対象行**: `content.js` 982-987行目

現在:
```javascript
setInterval(() => {
  if (s3Ready) {
    processedRows = new WeakSet();
    processAllRows();
  }
}, 2000);
```

問題: URL変更検出直後（wrapper全削除直後）に定期チェックが割り込むと、仮想スクロール更新前の不完全なDOMに対して `processAllRows` が走る。

修正後:
```javascript
// ★★★ URL変更後の遷移中フラグ ★★★
let isNavigating = false;

// URL変更検出部（5.5）内で:
//   isNavigating = true;
//   setTimeout(() => { isNavigating = false; }, 3000);

setInterval(() => {
  if (s3Ready && !isNavigating) {
    processedRows = new WeakSet();
    processAllRows();
  }
}, 2000);
```

### 5.7 `getFilename()` の null/空行に対するスキップマーカー（補強）

**対象行**: `content.js` 774-779行目

現在:
```javascript
if (!filename) {
  log('processRow: filename is null/empty, row HTML:', row.innerHTML.slice(0, 200));
  return;
}
```

問題: `filename` が null/空の場合でも `processedRows.add(row)` は既に行われている（line 772）。その後の行更新で正しいファイル名になっても再処理されない。

修正後:
```javascript
if (!filename) {
  log('processRow: filename is null/empty, row HTML:', row.innerHTML.slice(0, 200));
  processedRows.delete(row);  // ★★★ 再処理可能にする ★★★
  return;
}
```

## 6. 修正優先順位

| 優先度 | 原因 | 修正箇所 | 難易度 | 効果 |
|--------|------|----------|--------|------|
| P0 | 原因1: `[class^="e2c-sts-"]` セレクタ | 5.1 `findOrigIconElements()` | 低 | 高い（根本治療） |
| P0 | 原因4: フォールバックパスのクリーンアップ不足 | 5.4 フォールバックパス | 低 | 高い（直接原因の除去） |
| P1 | 原因2: `.ts` が videoExts に含まれる | 5.2 videoExts から削除 OR 5.3 に統合 | 低 | 中 |
| P1 | 原因3: フォルダ判定が iconEl に依存 | 5.3 フォルダ判定強化 | 中 | 中 |
| P2 | 原因5: SPA遷移タイミング問題 | 5.5 URL変更検出 + 5.6 競合防止 | 中 | 中（二次的） |
| P3 | 空行スキップマーカー | 5.7 processedRows.delete | 低 | 低（補強） |

## 7. 検証方法

### 7.1 手動テスト手順

1. ChromeでIDrive e2バケットを開く
2. 画像ファイルのあるフォルダに移動 → サムネイルが正しく表示されることを確認
3. サムネイルなしのフォルダ（テキストファイルのみ等）に移動 → **ズレがないこと** を確認
4. `.ts` フォルダ（サムネイル格納ディレクトリ）があるフォルダに移動 → **フォルダ行にサムネイルwrapperが表示されず、アイコン位置がズレないこと** を確認
5. 画像フォルダ → 非画像フォルダ → 画像フォルダ の往復遷移を5回繰り返す → 各遷移で正しい表示になること
6. 画面リロードしても状態が変わらないことを確認

### 7.2 確認すべきDOM状態

修正後、`.ts` フォルダ行のDOMは以下のようになるべき:

```html
<div class="e2c-tb-rw">
  <div class="e2c-check-container">...</div>
  <!-- ★ .e2c-thumb-wrapper が存在しない -->
  <div class="e2c-td e2c-os-name"
       style="">  <!-- ★ インラインスタイルがクリアされている -->
    <span class="e2c-sts-folder" title=".ts"> .ts </span>
    <!-- ★ e2c-icon-image-hidden が除去されている -->
  </div>
  ...
</div>
```

## 8. 関連Issue

| Issue | 関係 | 備考 |
|-------|------|------|
| #39 | 関連 | アクションメニュー位置ズレ → サムネイルを `e2c-os-name` 内に挿入する修正 |
| #41 | 関連 | フォルダスキップの導入 |
| #42 | 関連 | 垂直中央揃え → `display:flex` + `height` 制約の導入（本Issueのスタイルを設定） |

## 9. リスク評価

| リスク | 影響 | 確率 | 対策 |
|--------|------|------|------|
| `.ts` を videoExts から削除 → `.ts` 動画のサムネイル未表示 | 低（.ts動画は稀） | 低 | 5.3のフォルダ判定強化で代替可能 |
| `[class*=" e2c-sts-"]` の誤マッチ | 低 | 低 | IDrive e2のクラス命名規則上、他のクラス名との衝突はない |
| スタイルクリアによる既存機能への影響 | 低 | 低 | クリア対象は拡張機能が設定したインラインスタイルのみ |

## 10. 実装メモ

### 変更ファイル一覧

- `content.js` — 以下の関数・ブロックを修正:
  - `findOrigIconElements()` (763行目) — セレクタ修正
  - `processRow()` フォルダスキップブロック (804行目) — 判定強化
  - `processRow()` フォールバックパス (897行目) — クリーンアップ追加
  - URL変更検出ブロック (968行目) — タイミング改善
  - 定期チェックブロック (982行目) — 競合防止フラグ追加
  - `processRow()` 空行スキップ (776行目) — processedRows.delete追加

### 非機能要件

- パフォーマンス: querySelectorの追加呼び出しは軽微
- 互換性: 既存の全機能（オーバーレイ、動画再生、フォルダナビゲーション）に影響しないこと
- デバッグ: 各分岐に `log()` 出力を維持する
