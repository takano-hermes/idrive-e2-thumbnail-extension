# Issue #55 v2: 修正仕様書 — 2秒ごとのアイコン変化 再発の根本原因と改訂修正

> 作成日: 2026-06-09
> 対象: main ブランチ (PR #56 + PR #57 マージ後)
> トレース対象: content.js (1086行), styles.css (135行)

---

## 1. 症状（再確認）

`.ts` フォルダ（サムネイル格納ディレクトリ）がないフォルダで、オブジェクト行の表示が約2秒ごとに以下の2状態を周期的に行き来する:

- **State A**（約2秒間）: 元のファイル種別アイコン表示。サムネイルwrapperなし、flexインラインスタイルなし、`e2c-icon-image-hidden`なし。
- **State B**（約2秒間）: サムネイルwrapperあり、flexインラインスタイルあり、アイコン非表示クラスあり。

PR #56（data-e2c-processed属性導入）と PR #57（fallthrough修正）をマージした現在の main でも再発を確認。

---

## 2. 現行コードの完全トレース

### 2.1 パス構成とタイミング

```
[初期化]
  init()
    → loadSettings()           (設定読み込み)
    → waitForTable()           (テーブルDOM待ち、1.5s遅延)
      → startObserver()        (MutationObserver + scrollHandler)
      → initFolderNavigation() (フォルダ一覧取得)

[定期実行]
  Interval A: 2000ms           (line 1014-1025) → URL変更検出
  Interval B: 2000ms           (line 1029-1033) → processAllRows()
  MutationObserver: 同期的     (line 968-987)   → processAllRows()
  Scroll debounce: 300ms       (line 981-986)   → processAllRows()
```

### 2.2 processRow データフロー（line 770-953）

```
processRow(row)
  │
  ├─① processedFilename ← row.getAttribute('data-e2c-processed')
  ├─② filename ← getFilename(row)
  │
  ├─③ if (!filename) → removeAttribute + return
  │
  ├─④ if (processedFilename === filename)
  │     ├─ existingWrapper → img.alt === filename → SKIP ✅
  │     ├─ existingWrapper → img.alt !== filename → REMOVE → fallthrough
  │     └─ no wrapper → fallthrough (PR #57 修正)
  │
  ├─⑤ existingWrapper → img.alt === filename → SKIP ✅ (冗長チェック)
  ├─⑥ existingWrapper → img.alt !== filename → REMOVE
  │
  ├─⑦ ext判定 → isImage/isVideo
  ├─⑧ フォルダスキップ or 非画像スキップ → クリーンアップ → return
  │
  ├─⑨ createThumbnailElement(...) → thumbEl
  ├─⑩ nameCell.insertBefore(thumbEl, iconEl)
  │
  └─⑪ row.setAttribute('data-e2c-processed', filename)
```

### 2.3 getFilename の動作（line 92-100）

```javascript
function getFilename(row) {
    const nameDiv = row.querySelector('div.e2c-os-name');
    if (!nameDiv) return null;
    const span = nameDiv.querySelector('span');  // ★ 問題: 最初の<span>を取得
    if (!span) return null;
    const title = span.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return span.textContent.trim();
}
```

**重要な注意**: `nameDiv.querySelector('span')` は e2c-os-name 内の **最初の `<span>` 要素**（DOM順）を返す。これは必ずしも元のファイル種別アイコン（`e2c-sts-video` 等）とは限らない。

---

## 3. 根本原因の解明

### 3.1 なぜ data-e2c-processed が機能していないのか

data-e2c-processed 属性が機能しない理由は、**getFilename() が showFallback() で追加された `<span>` を誤って拾ってしまう** ためである。以下が完全な発振サイクル:

#### 事前条件
- `.ts` フォルダなし → 全サムネイルリクエストが404 → `showFallback()` が必ず実行される
- `showFallback()` は `<span class="e2c-thumb-fallback">🎬</span>` をサムネイルwrapper内に追加する

#### サイクル詳細

```
[t=0 — Interval B 発火]

  1. processedFilename = null            (初回、data属性なし)
  2. filename = getFilename(row) → "video.mp4" (元のspan.e2c-sts-videoを正しく取得)
  3. processedFilename !== filename → 先頭ガード通過
  4. existingWrapper = null → 通過
  5. ext = ".mp4", isVideo = true
  6. createThumbnailElement("video.mp4", ...)
     → img.alt = "video.mp4"
     → setTimeout(loadThumbnail, 100)
        → getPresignedUrl(bucket, thumbKey) → FAIL (404)
        → img.onerror → async chain
          → showFallback()  ← 100ms+後
            → wrapper.appendChild(<span class="e2c-thumb-fallback">🎬</span>)
              ★★★ ここで fallback <span> が DOM に追加される ★★★
  7. nameCell.insertBefore(thumbEl, iconEl)
     → DOM 順: wrapper > fallback span > ... > icon span
  8. row.setAttribute('data-e2c-processed', 'video.mp4')

  State B (サムネイル+フォールバック🎬表示)


[t=2s — Interval B 発火]

  1. processedFilename = 'video.mp4'     (data属性から取得)
  2. filename = getFilename(row)
     → nameDiv.querySelector('span') → fallback <span> を発見！
     → title = null
     → textContent = '🎬'
     → filename = '🎬'                  ← ★★★ 誤った値 ★★★
  3. processedFilename('video.mp4') !== filename('🎬') → ガード突破！
  4. existingWrapper → 存在する
     → img.alt = 'video.mp4'
     → filename = '🎬'
     → img.alt !== filename → REMOVE wrapper    ← ★★★ wrapper削除 ★★★
  5. ext = getExtension('🎬') → ''        (ドットなし)
  6. isImage = false, isVideo = false
  7. 非画像クリーンアップブロック (line 846-872)
     → iconEl.classList.remove('e2c-icon-image-hidden')
     → nameCell スタイルクリア
     → staleWrapper = null (既に削除済み)
  8. return                              ← ★★★ data属性を更新せず！ ★★★

  State A (元のアイコン表示、wrapperなし)
  data-e2c-processed は 'video.mp4' のまま


[t=4s — Interval B 発火]

  1. processedFilename = 'video.mp4'     (前回更新されず残っている)
  2. filename = getFilename(row)
     → wrapperは削除済み、fallback spanも除去済み
     → 唯一の <span> = 元の span.e2c-sts-video
     → 'video.mp4'                       ← 正しい値
  3. processedFilename('video.mp4') === filename('video.mp4') → ガード成功！
  4. existingWrapper = null → fallthrough (PR #57)
  5. ext = '.mp4', isVideo = true
  6. createThumbnailElement("video.mp4", ...) → 新規wrapper作成
     → showFallback() が非同期で再実行される
  7. wrapper挿入 → data-e2c-processed = 'video.mp4'

  State B (サムネイル+フォールバック🎬再表示)


[t=6s — Interval B 発火]

  → t=2s と同じパターン
  → getFilename() → '🎬' (fallback span発見)
  → ガード突破 → wrapper削除 → State A

[t=8s]
  → t=4s と同じパターン → State B

... 無限ループ (2秒周期で State A ↔ B)
```

### 3.2 根本原因の要約

| # | 原因 | 該当行 | 説明 |
|---|------|--------|------|
| **①** | `getFilename()` のセレクタが脆弱 | line 96 | `nameDiv.querySelector('span')` は最初の `<span>` を返す。`showFallback()` で追加された fallback span を誤って拾う |
| **②** | `showFallback()` が `<span>` を使用 | line 304-308 | `<span class="e2c-thumb-fallback">` を作成。これが `querySelector('span')` の対象になる。`<div>` なら問題なかった |
| **③** | 非画像パスで return しても data属性を更新しない | line 846-872 | wrapper削除後に `getFilename()` が誤った値を返した場合、`return` する前に `row.removeAttribute('data-e2c-processed')` を実行していない。結果的に古い data 属性が残り、4秒後にガードが成功して再作成される |

### 3.3 PR #56 と PR #57 の修正が再発を防げなかった理由

**PR #56 (data-e2c-processed 導入)**:
- `getFilename()` が正しい値を返すことを前提としている
- `getFilename()` が fallback span を拾って誤った値を返すため、data属性との一致比較が機能しない
- 修正の前提条件が崩れている

**PR #57 (fallthrough 修正: else { return; } 削除)**:
- wrapper がない場合に正しくフォールスルーするようになった
- しかし **フォールスルー後に showFallback() が再実行され、再び fallback span が追加される**
- 結果として発振周期が継続する（発振の「原因」ではなく「結果」の一部を改善したに過ぎない）

### 3.4 CDK Virtual Scroll による行再利用の影響

CDK Virtual Scroll が行を再利用する場合:
- 行の innerHTML が完全に置き換えられる → `data-e2c-processed` と wrapper は自動的に消える
- 新しいファイル名で processRow が呼ばれる → 正しく処理される
- **CDK の再利用は発振の直接原因ではない**が、以下の問題を複合させる:
  - Interval B (2s) と CDK の DOM 更新タイミングが競合する
  - スクロール中に processAllRows が頻発する（scroll debounce 300ms + Interval B 2s）
  - デバッグログが多数出力されてパフォーマンスに影響する可能性

---

## 4. 改訂修正仕様

### 4.0 前提: この修正は以下を前提とする

- **PR #52** の修正（`[class^="e2c-sts-"]` セレクタ修正 + スタイルクリーンアップ）は適用済み
- **PR #56** の修正（data-e2c-processed 属性導入）は適用済み
- **PR #57** の修正（fallthrough 修正）は適用済み

### 4.1 [P0] getFilename() を堅牢化する（根本治療）

**問題**: `getFilename()` が `nameDiv.querySelector('span')` を使うため、サムネイルwrapper内の fallback span を拾ってしまう。

**修正**: ファイル種別アイコンを特異的に特定するセレクタに変更する。

```javascript
// ★★★ BEFORE ★★★
function getFilename(row) {
    const nameDiv = row.querySelector('div.e2c-os-name');
    if (!nameDiv) return null;
    const span = nameDiv.querySelector('span');
    if (!span) return null;
    const title = span.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return span.textContent.trim();
}

// ★★★ AFTER ★★★
function getFilename(row) {
    const nameDiv = row.querySelector('div.e2c-os-name');
    if (!nameDiv) return null;
    // ファイル種別アイコン（e2c-sts-image, e2c-sts-video, e2c-sts-folder 等）のみを対象とする
    // querySelector('span') は全ての<span>にマッチし、サムネイルwrapper内の
    // フォールバック要素（e2c-thumb-fallback）も拾ってしまう（Issue #55 根本原因）。
    // [class*=" e2c-sts-"] で「クラス名に' e2c-sts-'を含む要素」に限定する。
    const span = nameDiv.querySelector('[class*=" e2c-sts-"], [class^="e2c-sts-"]');
    if (!span) return null;
    const title = span.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return span.textContent.trim();
}
```

**変更行**: line 92-100 → line 92-101

**根拠**: `[class*=" e2c-sts-"]` は `e2c-sts-video`, `e2c-sts-image`, `e2c-sts-folder` 等にのみマッチする。`e2c-thumb-fallback` にはマッチしない。このセレクタは `findOrigIconElements()`（line 766）で既に使用されており、実績がある。

### 4.2 [P1] showFallback() を <div> ベースに変更する（防御的修正）

**問題**: `showFallback()` が `<span>` を使うため、他のセレクタ（`querySelector('span')`）に影響を与える。

**修正**: フォールバックアイコンを `<span>` から `<div>` に変更する。

```javascript
// ★★★ BEFORE ★★★
function showFallback() {
    img.style.display = 'none';
    const icon = document.createElement('span');
    icon.className = 'e2c-thumb-fallback';
    icon.textContent = isVideo ? '🎬' : '🖼️';
    icon.style.cssText = `font-size:${settings.thumbSize * 0.5}px;opacity:0.5;cursor:pointer;`;
    wrapper.appendChild(icon);
}

// ★★★ AFTER ★★★
function showFallback() {
    img.style.display = 'none';
    const icon = document.createElement('div');     // ★★★ span → div ★★★
    icon.className = 'e2c-thumb-fallback';
    icon.textContent = isVideo ? '🎬' : '🖼️';
    icon.style.cssText = `font-size:${settings.thumbSize * 0.5}px;opacity:0.5;cursor:pointer;display:inline;`;  // display:inline でインライン要素相当に
    wrapper.appendChild(icon);
}
```

**変更行**: line 304-308

**補足**: `display:inline` を指定することで、`<div>` をインライン要素と同等の表示振る舞いにし、レイアウトに影響を与えない。

### 4.3 [P1] 非画像パスで data-e2c-processed をクリアする

**問題**: processRow の非画像スキップパス（line 846-872）で return する際、data-e2c-processed が更新されない。wrapper が削除されても古い data 属性が残り、次のサイクルで誤ったガード成功を引き起こす。

**修正**: 非画像スキップパスで data 属性もクリアする。

```javascript
// ★★★ line 868-871 付近、staleWrapper削除後に追加 ★★★
    const staleWrapper = row.querySelector(':scope > .e2c-thumb-wrapper');
    if (staleWrapper) staleWrapper.remove();
    // ★★★ data 属性もクリア（古いマーカーが残ると発振の原因になる）★★★
    row.removeAttribute('data-e2c-processed');
    log('processRow: SKIP - not image/video');
    return;
```

**変更行**: line 868-871 → line 868-873

### 4.4 [P2] フォルダスキップパスでも data-e2c-processed をクリアする

**問題**: フォルダ行（line 824-844）も同様に古い data 属性が残る可能性がある。

**修正**: フォルダスキップパスでも data 属性をクリアする。

```javascript
// ★★★ line 841-843 付近 ★★★
    const staleWrapper = row.querySelector(':scope > .e2c-thumb-wrapper');
    if (staleWrapper) staleWrapper.remove();
    // ★★★ data 属性もクリア ★★★
    row.removeAttribute('data-e2c-processed');
    log('processRow: SKIP - folder, not a file');
    return;
```

**変更行**: line 840-843 → line 840-845

### 4.5 [P2] data-e2c-processed ガードに filename の妥当性検証を追加する

**問題**: data-e2c-processed 属性があっても、それが正しいファイル名とは限らない（前回の誤った値が設定される可能性）。ガードが成功しても、その後に非画像スキップパスに到達する可能性がある。

**修正**: data-e2c-processed によるガード成功後も、filename が実際に画像/動画拡張子を持つかを検証する。

```javascript
// ★★★ processRow の先頭部分、line 784-798 ★★★
    if (processedFilename === filename) {
      // すでに同じファイル名で処理済み → 既存wrapperとaltを確認してスキップ
      const existingWrapper = row.querySelector('.e2c-thumb-wrapper');
      if (existingWrapper) {
        const img = existingWrapper.querySelector('img');
        if (img && img.alt === filename) {
          log('processRow: SKIP - data-e2c-processed matches', filename);
          return;
        }
        log('processRow: REMOVE stale thumbnail (was', img?.alt, ', now', filename + ')');
        existingWrapper.remove();
      }
      // ★★★ filename が有効な拡張子を持つか確認 ★★★
      const ext = getExtension(filename);
      const isImage = CONFIG.imageExts.has(ext);
      const isVideo = CONFIG.videoExts.has(ext);
      if (!isImage && !isVideo) {
        // 拡張子なしの場合は data 属性が不正な可能性がある（例: '🎬'）
        log('processRow: data attr value is not an image/video, resetting');
        row.removeAttribute('data-e2c-processed');
        return;
      }
      // ★★★ wrapperがない場合はフォールスルー（再作成）★★★
    }
```

### 4.6 [P3] スタイルクリーンアップ関数を共通化する（リファクタリング）

**問題**: 非画像スキップパス（line 849-870）とフォルダスキップパス（line 827-840）で同じスタイルクリーンアップコードが重複している。

**修正**: スタイルクリーンアップを補助関数に抽出する。

```javascript
// 新規関数として追加
function cleanupRowStyles(nameCell, iconEl) {
    if (iconEl) {
        iconEl.classList.remove('e2c-icon-image-hidden');
    }
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
    const staleWrapper = nameCell?.closest('.e2c-tb-rw')?.querySelector(':scope > .e2c-thumb-wrapper');
    if (staleWrapper) staleWrapper.remove();
}
```

**効果**: コード重複削減、一貫性向上、見落とし防止。

---

## 5. 発振が停止するメカニズム（検証ロジック）

修正適用後の発振抑制フロー:

```
[t=0 — Interval B 発火]

  1. processedFilename = null
  2. filename = getFilename(row)
     → nameDiv.querySelector('[class*=" e2c-sts-"]')
     → span.e2c-sts-video → 'video.mp4'
  3. Create thumbnail → showFallback() → fallback <div>

[t=2s — Interval B 発火]

  1. processedFilename = 'video.mp4'
  2. filename = getFilename(row)
     → nameDiv.querySelector('[class*=" e2c-sts-"]')
     → span.e2c-sts-video → 'video.mp4'      ← ★ fallback <div> は無視！
  3. processedFilename('video.mp4') === filename('video.mp4') → ガード成功！
  4. existingWrapper → img.alt === filename → SKIP ✅

[t=4s, t=6s, ... — Interval B 発火]

  → 毎回ガード成功 → SKIP ✅
  → 発振なし！State B が安定維持される
```

---

## 6. 修正優先順位（改訂版）

| 優先度 | 修正項目 | セクション | 難易度 | 効果 | 備考 |
|--------|----------|-----------|--------|------|------|
| **P0** | `getFilename()` セレクタ強化 | 4.1 | 低 | **高い（根本原因を直接修正）** | これだけで発振は止まる |
| **P1** | `showFallback()` → `<div>` 変更 | 4.2 | 低 | 中（防御的） | 同じパターンの再発を防止 |
| **P1** | 非画像パスで data 属性クリア | 4.3 | 低 | 中（整合性） | State 一貫性確保 |
| **P2** | フォルダパスで data 属性クリア | 4.4 | 低 | 低（エッジケース） | 同 |
| **P2** | data ガードに拡張子検証追加 | 4.5 | 低 | 中（堅牢性） | 異常値検出 |
| **P3** | スタイルクリーンアップ共通化 | 4.6 | 低 | 低（リファクタリング） | 保守性向上 |

**推奨実装順序**: P0 → P1 → P2 → P3

---

## 7. 推奨実装手順

### Step 1: getFilename() セレクタ変更 (4.1) → これだけで発振は止まる

変更ファイル: `content.js` line 92-100

```javascript
// 変更前: nameDiv.querySelector('span')
// 変更後: nameDiv.querySelector('[class*=" e2c-sts-"], [class^="e2c-sts-"]')
```

### Step 2: showFallback() の要素変更 (4.2)

変更ファイル: `content.js` line 304-308

```javascript
// 変更前: document.createElement('span')
// 変更後: document.createElement('div') + 'display:inline'
```

### Step 3: 非画像/フォルダパスに removeAttribute を追加 (4.3 + 4.4)

変更ファイル: `content.js` line 841, 869 にそれぞれ追加

### Step 4: dataガードに拡張子検証を追加 (4.5)

変更ファイル: `content.js` line 784-798

### Step 5: リファクタリング (4.6) — 任意

---

## 8. 検証方法

### 8.1 デバッグログでの確認

修正後、以下のログパターンが期待される:

```
[IDriveThumb] processAllRows: found 12 rows
[IDriveThumb] processRow: SKIP - data-e2c-processed matches video.mp4    ← 毎回出力
```

`processRow: SKIP - data-e2c-processed matches` が **毎サイクル全行に対して出力** されること。これが data 属性ガードの正常動作を示す。

`processRow: filename? 🎬` のようなログが **絶対に出力されない** こと。

### 8.2 手動テスト

| # | テストケース | 手順 | 期待結果 |
|---|-------------|------|---------|
| 1 | 基本発振テスト | `.ts`フォルダがないフォルダを開き60秒観察 | アイコン変化なし |
| 2 | 正常フォルダテスト | `.ts`フォルダがあるフォルダを開く | サムネイル正常表示 |
| 3 | SPA遷移テスト | フォルダ間をSPA遷移 | 各遷移で正しい表示 |
| 4 | リロードテスト | 画面リロード | 発振しない |
| 5 | 長期安定テスト | 3分以上放置 | 発振しない |
| 6 | ダイアログ操作テスト | 行のチェックボックス、アクションメニュー操作 | 正常動作 |
| 7 | スクロールテスト | 大量行をスクロール | サムネイルが正しいファイルに対応 |

### 8.3 DOM 状態チェック

処理済み行の DOM を確認:
```html
<div class="e2c-tb-rw" data-e2c-processed="video.mp4">
  <div class="e2c-check-container">...</div>
  <div class="e2c-td e2c-os-name" style="display:flex; align-items:center; gap:4px; ...">
    <div class="e2c-thumb-wrapper" style="display:inline-flex; ...">
      <img class="e2c-thumb-img" style="display:none" alt="video.mp4">
      <div class="e2c-thumb-fallback" style="display:inline; ...">🎬</div>
      <div class="e2c-play-btn">▶</div>
    </div>
    <span class="e2c-sts-video e2c-icon-image-hidden"> video.mp4 </span>
  </div>
</div>
```

ポイント:
- `data-e2c-processed="video.mp4"` — 行に設定されている
- `fallback` は `<div>` — `span` セレクタに干渉しない
- 元の icon span は `e2c-icon-image-hidden` クラス保持
- サムネイルwrapper は表示状態

---

## 9. リスク評価

| リスク | 影響 | 確率 | 対策 |
|--------|------|------|------|
| IDrive e2 の DOM 構造変更で `[class*=" e2c-sts-"]` がマッチしなくなる | サムネイル未表示 | 低 | `findOrigIconElements()` と同一ロジックのため、どちらかが先に壊れる。定期的なDOM検証で対処 |
| `<div>` フォールバックのレイアウト崩れ | 見た目の問題 | 低 | `display:inline` 指定でインライン要素相当に。元の `<span>` と同等の表示を確認 |
| data-e2c-processed の異常値が残る | 行が処理されない | 低 | 4.3/4.4/4.5 の修正でクリア/検証パスを確保。URL変更時と Interval A でもクリア |

---

## 10. 変更ファイル一覧

| ファイル | 変更内容 | 影響行 |
|----------|----------|--------|
| `content.js` | `getFilename()` — セレクタを `span` → `[class*=" e2c-sts-"]` に変更 | 96 |
| `content.js` | `showFallback()` — `document.createElement('span')` → `document.createElement('div')` + `display:inline` | 304-308 |
| `content.js` | 非画像スキップパス — `row.removeAttribute('data-e2c-processed')` 追加 | 869付近 |
| `content.js` | フォルダスキップパス — `row.removeAttribute('data-e2c-processed')` 追加 | 841付近 |
| `content.js` | data ガード内 — 拡張子検証追加 | 790-797（新規ブロック） |
| `content.js` | (任意) スタイルクリーンアップ共通化関数 | 新規関数 |

---

## 11. 補足: なぜ PR #56 の修正では不十分だったのか

PR #56 は「WeakSet を data 属性に置き換える」という設計判断だった。この判断自体は正しい方向性だったが、以下の前提が崩れた:

| 前提 | 現実 | 結果 |
|------|------|------|
| `getFilename()` は常に正しいファイル名を返す | `showFallback()` の `<span>` を拾って `'🎬'` を返す | data 属性との比較が無意味に |
| `data-e2c-processed` が正しくガードする | `getFilename()` が誤った値を返すとガードを通過 | 発振が継続 |
| 非画像パスで古い data 属性は残らない | return 前にクリアしていない | 4秒後にガード成功→新しいwrapper作成→showFallback→2秒後にガード突破... |

**教訓**: DOM 属性ベースのガードは「正しい値が得られる」という前提に依存する。値取得ロジック (`getFilename()`) の堅牢性がガードの有効性を左右する。
