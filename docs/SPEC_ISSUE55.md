# Issue #55 修正仕様書 — 2秒ごとのアイコン変化（サムネイル有無の周期性発振）

## 1. 症状

表示中のフォルダに `.ts` フォルダ（サムネイル格納ディレクトリ）がない場合、オブジェクト行のアイコン（ファイル種別アイコン＋サムネイル領域）が約2秒ごとに変化する。2つの状態を周期的に行き来する:

### State A（ノーマル／未処理状態）

```
<div class="e2c-td e2c-os-name" style="">
  <span class="e2c-sts-video" title="video.mp4"> video.mp4 </span>
</div>
```

- サムネイルwrapper (`e2c-thumb-wrapper`) なし
- `e2c-os-name` に flex インラインスタイルなし
- アイコンspan に `e2c-icon-image-hidden` なし
- → ファイル種別アイコンが元の状態で表示

### State B（サムネイルあり／処理済み状態）

```
<div class="e2c-td e2c-os-name"
     style="display:flex; align-items:center; gap:4px;
            padding-top:0; padding-bottom:0;
            height:60px; max-height:60px; overflow:hidden; box-sizing:border-box;">
  <div class="e2c-thumb-wrapper" style="display:inline-flex; ...">
    ▶<img style="display:none"><span>🎬</span>
  </div>
  <span class="e2c-sts-video e2c-icon-image-hidden"> video.mp4 </span>
</div>
```

- サムネイルwrapper あり（e2c-os-name 内に挿入）
- `e2c-os-name` に flex インラインスタイルあり
- アイコンspan に `e2c-icon-image-hidden` あり（元アイコンの背景画像を非表示）
- → サムネイル（またはフォールバック絵文字）が表示

### 観察された周期性

- 2秒間隔で State A ↔ State B が切り替わる
- 2秒は `setInterval(() => { ... }, 2000)` の周期と完全一致（line 1006）
- 画面リロードしても現象は再発する
- `.ts` フォルダが存在するフォルダでは発生しない（サムネイルが正常に読み込まれるため）

---

## 2. コード全体フロー図

```
[ページ読み込み]
    │
    ▼
init()
    │
    ▼
loadSettings() → s3Ready = true/false
    │
    ▼
waitForTable() → テーブルDOM検出後 startObserver()
    │
    ├── MutationObserver → processAllRows() （子ノード変更ごと）
    │
    ├── scrollHandler → debounce(300ms) → processAllRows()
    │
    ├── [Interval A: 2000ms] URL変更検出（line 992-1001）
    │   └─ URL変更時: wrapper全削除 + setTimeout(processAllRows, 1000)
    │
    └── [Interval B: 2000ms] 定期再チェック（line 1006-1011）
        └─ processedRows = new WeakSet() → processAllRows()
```

---

## 3. 根本原因の詳細トレース

### 3.1 発振のメカニズム

発振は以下の3要素の組み合わせで発生する:

| # | 要素 | 場所 | 説明 |
|---|------|------|------|
| ① | `processedRows` の定期的リセット | line 1008 | 2秒ごとに WeakSet を新規作成 → 全行が「未処理」扱いに |
| ② | ガード条件 `img.alt === filename` の脆弱性 | line 785 | 唯一の再処理防止機構。`getFilename(row)` の返り値が `img.alt` と一致しないと失敗 |
| ③ | クリティカルパス不在の State A 復元機能 | line 826-852, 804-824 | ガード失敗後、wrapper が削除され、スタイルがクリアされると State A が復元される |

#### 発振の1サイクル

```
Cycle N (t=0):
  1. Interval B 発火 → processedRows = new WeakSet()
  2. processRow() 呼び出し
  3. 📌 guard: existingWrapper? → 前回作成済み → img.alt === filename?
     └─ ✅ 成功: return → State B 維持

Cycle N+1 (t=2s):
  1. Interval B 発火 → processedRows = new WeakSet()
  2. processRow() 呼び出し
  3. 📌 guard: existingWrapper? → 存在 → img.alt === filename?
     └─ ❌ 何らかの理由で失敗 → existingWrapper.remove()（line 790）
  4. 処理継続: 新規 wrapper 作成 → State B 再作成
  5. しかし…前回 wrapper 削除により DOM が遷移 → 見た目上 State A と State B の切り替えが発生

Cycle N+2 (t=4s):
  → 同様のパターンで発振継続
```

### 3.2 ガード失敗の根本原因

`img.alt === filename` 比較が失敗する根本原因は以下:

#### 原因A: `getFilename(row)` の返り値の不安定性（最有力）

`getFilename()` は DOM からファイル名を読み取る（line 92-100）:

```javascript
function getFilename(row) {
  const nameDiv = row.querySelector('div.e2c-os-name');
  if (!nameDiv) return null;
  const span = nameDiv.querySelector('span');
  if (!span) return null;
  const title = span.getAttribute('title');
  if (title && title.trim()) return title.trim();
  return span.textContent.trim();
}
```

**問題点**: この関数は ① `title` 属性 または ② `textContent` を使用する。IDrive e2 の SPA が以下のいずれかを定期的に行うと、呼び出しごとに異なる値が返る:

1. **`title` 属性の動的更新**: SPA が行の表示情報を更新する際、`title` 属性にフルパスを設定したり削除したりする可能性がある
2. **テキストフォーマットの変更**: SPA が `textContent` のフォーマットを変更する（例: "video.mp4" → "video .mp4" ← この場合 ext 解析は正常、ただし文字列比較は不一致）
3. **CDK Virtual Scroll の行再利用**: 仮想スクロールが行要素を別のファイル用に再利用する際、DOM 更新が非同期で行われる。更新途中の状態で `getFilename()` が呼ばれると不完全なファイル名が返る
4. **SPA のポーリング更新**: IDrive e2 がファイル一覧を定期的にポーリング更新する場合、その更新途中で行の内容が一時的に空または異なる値になる

**発生確率**: 高い。特に CDK Virtual Scroll 環境では、行の DOM 更新タイミングと 2秒間隔のタイマーが競合するシナリオは十分に起こり得る。

#### 原因B: `showFallback()` による img 要素の隠蔽と DOM 状態

`showFallback()`（line 303-309）は `img.style.display = 'none'` を設定するが、**img 要素自体は DOM に残る**。この時点では `img.alt` は保たれているため、通常はガードに影響しない。

しかし、`loadThumbnail()` の `img.onerror` チェーン（line 270-295）では:

```javascript
img.onerror = async () => {
  try {
    const resp = await fetch(url);  // 404 チェック
    ...
  } catch(e) { ... }
  getPresignedUrl(bucket, objKey, region).then(fullUrl => {
    if (fullUrl) {
      img.src = fullUrl;  // ★ 実際のファイルURLに差し替え
      img.onerror = () => { showFallback(); };
    } else {
      showFallback();
    }
  });
};
```

**問題のシナリオ**:
1. `.ts/filename.mp4.jpg` の presignedURL 取得成功 → `img.src` 設定
2. ブラウザが読み込み → 404 → `img.onerror` 発火
3. `getPresignedUrl(bucket, objKey, region)` が **非同期** で実行中
4. この非同期処理が **2秒以上かかる** 場合、次の Interval B 発火時に `img.src` はまだ最初の thumbUrl のまま（エラー読み込み状態）
5. ガード: `img.alt === filename` → 通常成功

**→ このシナリオだけではガードは失敗しないが**、原因Aと複合すると発振が発生する。

#### 原因C: フォルダ行の誤処理（Issue #52 未修正環境のみ）

Issue #52 で修正された `[class^="e2c-sts-"]` セレクタ不具合が **未デプロイ** の場合:

- `.ts` フォルダ行: `class="e2c-sts-folder"` → セレクタがマッチしない → `iconEl = null`
- `findOrigIconElements` が iconEl を発見できないと、フォルダスキップ（line 804）と非画像スキップ（line 826）の両方が失敗
- 画像/動画処理にフォールスルー → フォールバックパス（line 899-930）へ
- このパスでスタイルクリーンアップと wrapper 挿入が行われるが、**ガードは正常に機能する**

**結論**: Issue #52 の未修正は Issue #55 の**直接原因ではない**。ただし両者が複合すると症状が悪化する可能性がある。

### 3.3 なぜ State A と State B が「交互に」出現するのか

発振の周期性は以下のループで説明できる:

```
[t=0]    Interval B → processRow() → Guard SUCCESS → State B 維持
[t=0.1s] loadThumbnail() → 非同期 presignedURL 生成開始
[t=~1s]  SPA が行 DOM を更新（例: title属性、テキストフォーマット）
[t=2s]   Interval B → processRow() → Guard FAIL（原因A: getFilename の値が不一致）
         └─ existingWrapper.remove() → 一時的に State A
         └─ 新規 wrapper 作成 → State B
[t=2.1s] loadThumbnail() → 非同期 presignedURL 生成開始
[t=~3s]  SPA が行 DOM を元の状態に戻す（または別の状態に更新）
[t=4s]   Interval B → processRow() → Guard FAIL → 前回の wrapper 削除 → 新規作成
         └─ このサイクルでは前回と異なるファイル名を getFilename が返すため、常に失敗
```

**本質**: `processedRows` をリセットするたびに、`getFilename(row)` の結果が **前回 processRow 実行時の getFilename 結果** と一致するかどうかでガードの成否が決まる。DOM が SPA によって頻繁に更新される環境では、一致しない確率が高い。

---

## 4. 現在の防御機構とその限界

### 4.1 2つのガード

| ガード | 条件 | 効果 | 限界 |
|--------|------|------|------|
| `processedRows.has(row)` | line 768 | WeakSet 内に行参照が存在するか | Interval B でリセットされるため、2秒しか持続しない |
| `img.alt === filename` | line 785 | `img` 要素の `alt` 属性と現在のファイル名を比較 | `getFilename(row)` の結果に依存 → DOM 更新で不一致が生じる |

### 4.2 ガード失敗後に実行されるコード

ガードが失敗すると、以下の順でコードが実行される:

1. **行790**: `existingWrapper.remove()` → サムネイルwrapper を DOM から削除
2. **行793-795**: 拡張子判定 → `isVideo = true`
3. **行799**: `findOrigIconElements(row)` → iconEl, nameCell 取得
4. **行804-824（フォルダスキップ）**: `.ts` フォルダの場合のみ実行 → **通常はスキップされる**
5. **行826-852（非画像スキップ）**: `isVideo=true` のためスキップされる
6. **行856-857**: `createThumbnailElement()` → 新規 wrapper 作成
7. **行859-898**: メインパス → iconEl に `e2c-icon-image-hidden` 追加、nameCell に flex 設定、wrapper 挿入

**→ ガード失敗 → wrapper 削除（State A 一瞬出現）→ 新規 wrapper 作成（State B 復元）**

### 4.3 根本的な設計問題

```
現在の設計:
  processedRows リセット (2s)
       ↓
  全行を再評価
       ↓
  img.alt === filename の1点で再処理防止
       ↓
  ❌ getFilename(row) の返り値が不安定だとガード突破
       ↓
  wrapper 削除 → 再作成で State A→B の発振

理想の設計:
  行ごとに「処理済みかつファイル名一致」を DOM 属性でマーク
       ↓
  processedRows リセット後も DOM 属性をチェック
       ↓
  ✅ SPA による DOM 更新がない限り再処理されない
       ↓
  行の実ファイルが変わった場合のみ wrapper を更新
```

---

## 5. 修正仕様

### 5.1 DOM 属性ベースの処理済みマーカー導入（P0 — 根本治療）

**問題**: `processedRows` WeakSet は行オブジェクトの参照を保持するだけ。リセット後は無効になる。

**修正**: 行要素に data 属性 `data-e2c-processed` を設定し、処理済みであることと、どのファイル名で処理済みかを記録する。

**変更対象**: `content.js` line 767-791（`processRow` 関数の先頭部分）

**修正内容**:

```javascript
function processRow(row) {
  // ★★★ DOM 属性ベースの処理済みチェック ★★★
  // processedRows がリセットされても data 属性は残るため、
  // SPA が行を再利用しない限り再処理を防止できる。
  const processedFilename = row.getAttribute('data-e2c-processed');
  if (processedFilename) {
    log('processRow: SKIP - data attribute marks as processed for', processedFilename);
    return;
  }

  // ★★★ 従来の WeakSet チェックは補助的に残す（パフォーマンス最適化）★★★
  if (processedRows.has(row)) {
    log('processRow: SKIP - already processed (WeakSet)');
    return;
  }
  processedRows.add(row);

  const filename = getFilename(row);
  log('processRow: filename?', filename);
  if (!filename) {
    log('processRow: filename is null/empty, row HTML:', row.innerHTML.slice(0, 200));
    // ★★★ null/empty の場合は data 属性を削除して再処理可能にする ★★★
    row.removeAttribute('data-e2c-processed');
    return;
  }

  // 仮想スクロール対応: 既存のサムネイルが正しいファイル名かを確認
  const existingWrapper = row.querySelector('.e2c-thumb-wrapper');
  if (existingWrapper) {
    const img = existingWrapper.querySelector('img');
    if (img && img.alt === filename) {
      log('processRow: SKIP - thumbnail already matches', filename);
      // ★★★ data 属性を設定して次回以降もスキップ ★★★
      row.setAttribute('data-e2c-processed', filename);
      return;
    }
    log('processRow: REMOVE stale thumbnail (was', img?.alt, ', now', filename + ')');
    existingWrapper.remove();
    // ★★★ data 属性も削除（行の内容が変わったため）★★★
    row.removeAttribute('data-e2c-processed');
  }

  // ... 従来の処理（変更なし）...
}
```

そして、処理が正常に完了した行の末尾（サムネイル挿入後）にも data 属性を設定する:

```javascript
// line 878 の nameCell.insertBefore(thumbEl, iconEl); の直後あたり:
nameCell.insertBefore(thumbEl, iconEl);
// ★★★ 処理完了マーカー ★★★
row.setAttribute('data-e2c-processed', filename);
```

**効果**:
- `processedRows` がリセットされても data 属性が残るため、ガードが堅牢になる
- SPA が行要素を完全に置き換えた場合のみ data 属性が失われ、再処理が行われる
- 行の内容が変わらない限り、`img.alt === filename` チェックに依存しない

### 5.2 `processedRows` リセットの削除または条件付き化（P1）

**問題**: Interval B（line 1006-1011）が無条件に `processedRows` をリセットする。5.1 の修正後は data 属性がガードを担当するため、WeakSet のリセットは不要になる。

**修正**: Interval B から `processedRows = new WeakSet()` を削除する。ただし URL 変更時（line 995）と `updateURLPrefix()`（line 721）では引き続きリセットが必要。

```javascript
// ★★★ 修正前 ★★★
setInterval(() => {
  if (s3Ready) {
    processedRows = new WeakSet();
    processAllRows();
  }
}, 2000);

// ★★★ 修正後 ★★★
// data-e2c-processed 属性がガードを担当するため、
// WeakSet リセットは不要。ただし新規に行が追加された場合の
// 検出は MutationObserver が担当するため、この定期チェック自体も
// 将来的に削減可能だが、安全のため processAllRows は維持する。
setInterval(() => {
  if (s3Ready) {
    processAllRows();  // data 属性により既処理行はスキップされる
  }
}, 2000);
```

### 5.3 `getFilename()` の安定性向上（P1）

**問題**: `getFilename()` が `title` 属性と `textContent` の2つを読み分けるため、SPA の更新タイミングによって値が変わり得る。

**修正**: 安定したファイル名取得のため、優先順位を明確にし、可能であれば両方を正規化して比較する。

```javascript
function getFilename(row) {
  const nameDiv = row.querySelector('div.e2c-os-name');
  if (!nameDiv) return null;
  const span = nameDiv.querySelector('span');
  if (!span) return null;
  
  // ★★★ title 属性と textContent の両方を取得し、一致する方を優先 ★★★
  // SPA 更新のタイミングでどちらかが一時的に不完全になる可能性があるため
  const title = span.getAttribute('title');
  const text = span.textContent;
  
  const titleClean = title ? title.trim() : '';
  const textClean = text ? text.trim() : '';
  
  // 両方とも有効で内容が一致する場合 → タイトル優先（標準化された値）
  if (titleClean && textClean && titleClean === textClean) {
    return titleClean;
  }
  // タイトルのみ有効
  if (titleClean) return titleClean;
  // テキストのみ有効
  if (textClean) return textClean;
  
  return null;
}
```

**効果**: SPA が `title` と `textContent` を非同期に更新する際のタイミング問題を緩和する。

### 5.4 リセット時の全 wrapper 削除の安全化（P1）

**問題**: URL 変更時（line 998）に `document.querySelectorAll('.e2c-thumb-wrapper').forEach(el => el.remove())` で全 wrapper を削除するが、この際 `data-e2c-processed` が削除されず、新しい行に古い data 属性が残る可能性がある。

**修正**: wrapper 削除と同時に data 属性もクリアする。

```javascript
// line 995-998 の修正
if (location.href !== lastUrl) {
  lastUrl = location.href;
  processedRows = new WeakSet();
  presignedUrlCache = new Map();
  // ★★★ data 属性も同時にクリア ★★★
  document.querySelectorAll('.e2c-thumb-wrapper').forEach(el => {
    const row = el.closest('.e2c-tb-rw');
    if (row) row.removeAttribute('data-e2c-processed');
    el.remove();
  });
  setTimeout(processAllRows, 1000);
}
```

### 5.5 `showFallback()` 後のガード強化（P2）

**問題**: `showFallback()` は `img.style.display = 'none'` を設定するが、img 要素は残るためガードには影響しない。ただしフォールバックアイコン（🎬/🖼️）が追加されると DOM が肥大化する。

**修正**: `showFallback()` が呼ばれた時点で処理済みとマークする（ガードの補強）。

```javascript
function showFallback() {
  img.style.display = 'none';
  const icon = document.createElement('span');
  icon.className = 'e2c-thumb-fallback';
  icon.textContent = isVideo ? '🎬' : '🖼️';
  icon.style.cssText = `font-size:${settings.thumbSize * 0.5}px;opacity:0.5;cursor:pointer;`;
  wrapper.appendChild(icon);
  
  // ★★★ フォールバック表示完了 → 行を処理済みマーク ★★★
  const row = wrapper.closest('.e2c-tb-rw');
  if (row) {
    const currentName = getFilename(row);
    if (currentName) {
      row.setAttribute('data-e2c-processed', currentName);
    }
  }
}
```

### 5.6 `img.alt` の代わりに `data-e2c-filename` 属性を使用（P2）

**問題**: `img.alt` はブラウザの画像読み込み状態によってリセットされる可能性は低いが、アクセシビリティ目的でブラウザ拡張やユーザースクリプトが上書きする可能性は否定できない。

**修正**: ファイル名を `data-e2c-filename` 属性にも保存し、ガードでは `img.dataset.e2cFilename === filename` を使用する。

```javascript
// createThumbnailElement 内（line 248 付近）
img.alt = filename;
img.dataset.e2cFilename = filename;  // ★★★ 追加 ★★★

// processRow 内（line 785）
// ★★★ 修正前 ★★★
if (img && img.alt === filename) {
// ★★★ 修正後 ★★★
if (img && (img.dataset.e2cFilename === filename || img.alt === filename)) {
```

### 5.7 null/empty filename 時の再処理許可（Issue #52 フォローアップ）

**問題**: `filename` が null/empty の場合、`processedRows.add(row)` は既に行われている（line 772）ため、後で正しいファイル名になっても再処理されない。

**修正**: null/empty の場合は `processedRows.delete(row)` を呼ぶ（5.1 の data 属性削除と併用）。

```javascript
if (!filename) {
  log('processRow: filename is null/empty, row HTML:', row.innerHTML.slice(0, 200));
  processedRows.delete(row);  // ★★★ 追加 ★★★
  row.removeAttribute('data-e2c-processed');  // ★★★ 追加 ★★★
  return;
}
```

---

## 6. 修正優先順位

| 優先度 | 修正項目 | 該当セクション | 難易度 | 効果 | 備考 |
|--------|----------|----------------|--------|------|------|
| **P0** | DOM 属性ベースの処理済みマーカー | 5.1 | 低 | **高い（発振を根本的に防止）** | 本Issueの核となる修正 |
| **P1** | `processedRows` リセット削除 | 5.2 | 低 | 中 | P0 の補完 |
| **P1** | `getFilename()` 安定性向上 | 5.3 | 低 | 中 | ガードの信頼性向上 |
| **P1** | リセット時の data 属性クリア | 5.4 | 低 | 中 | 整合性維持 |
| **P2** | `showFallback()` 後のマーキング | 5.5 | 低 | 低 | ガード補強 |
| **P2** | `data-e2c-filename` 属性 | 5.6 | 低 | 低 | 冗長性向上 |
| **P3** | null filename 時の再処理許可 | 5.7 | 低 | 低 | エッジケース対策 |

---

## 7. 実装の流れ（推奨順序）

### Step 1: data 属性マーカーの導入（5.1 + 5.2）

変更対象: `processRow()` 関数と Interval B

最小限の変更で最大の効果を得る。data 属性をチェック/設定するロジックを追加し、Interval B の WeakSet リセットを削除する。

**期待効果**: `getFilename()` の不安定性があっても、一度処理された行は data 属性でスキップされるため、発振が停止する。

### Step 2: `getFilename()` 安定化（5.3）

変更対象: `getFilename()` 関数

`title` と `textContent` の両方を評価し、タイミング問題による値のブレを吸収する。

### Step 3: リセット時の整合性確保（5.4 + 5.7）

変更対象: URL変更検出ブロックと null filename ハンドリング

data 属性が古い行に残らないようにし、null filename で処理が止まらないようにする。

### Step 4: 補強（5.5 + 5.6）

変更対象: `showFallback()` と `createThumbnailElement()`

ガードの冗長性を高め、フォールバック後の状態も適切にマークする。

---

## 8. 検証方法

### 8.1 手動テスト

1. **基本発振テスト**: `.ts` フォルダがないフォルダを開き、30秒間観察する → 発振が発生しないこと
2. **正常フォルダテスト**: `.ts` フォルダがあるフォルダを開く → サムネイルが正しく表示されること
3. **フォルダ遷移テスト**: フォルダ間をSPA遷移 → 各遷移で正しい表示になること
4. **リロードテスト**: 画面リロード後も発振しないこと
5. **長期安定テスト**: 60秒以上放置しても発振しないこと

### 8.2 確認すべきDOM状態

修正後、処理済み行の DOM は以下を含むべき:

```html
<div class="e2c-tb-rw" data-e2c-processed="video.mp4">
  <!-- ... -->
  <div class="e2c-td e2c-os-name" style="display:flex; ...">
    <div class="e2c-thumb-wrapper">...</div>
    <span class="e2c-sts-video e2c-icon-image-hidden">...</span>
  </div>
</div>
```

### 8.3 デバッグログ確認

修正後に以下のログが期待通り出力されること:

```
[IDriveThumb] processRow: SKIP - data attribute marks as processed for video.mp4
```

このログが毎サイクル出力されれば、data 属性によるガードが正常に機能している証拠となる。

---

## 9. 関連Issue

| Issue | 関係 | 備考 |
|-------|------|------|
| #39 | 関連 | アクションメニュー位置ズレ → サムネイル挿入位置の修正 |
| #41 | 関連 | フォルダスキップの導入 |
| #42 | 関連 | 垂直中央揃え → `display:flex` + `height` 制約 |
| #52 | **関連（重要）** | `[class^="e2c-sts-"]` セレクタ不具合 → 修正済みだが未デプロイ |
| #54 | 関連 | PR #52 の修正内容を含むPR |

---

## 10. リスク評価

| リスク | 影響 | 確率 | 対策 |
|--------|------|------|------|
| data 属性が SPA の行更新時に残り、新しい行が処理されない | 中 | 低 | `updateURLPrefix()` と URL変更検出で data 属性をクリア |
| `getFilename()` の安定化で title/textContent 不一致時に誤ったファイル名を返す | 低 | 低 | 両方の値が有効で一致する場合のみ早期 return |
| data 属性の付与漏れでガードが機能しない | 低 | 低 | 全分岐に data 属性設定を徹底（コードレビューで確認） |
| パフォーマンス低下（data 属性の読み書き） | 低 | 低 | `setAttribute`/`getAttribute` は DOM 操作だが、行数が多くても軽量 |

---

## 11. 変更ファイル一覧

| ファイル | 変更内容 | 影響行 |
|----------|----------|--------|
| `content.js` | `processRow()` — data 属性マーカー導入 | line 767-791, 878付近 |
| `content.js` | Interval B — WeakSet リセット削除 | line 1006-1011 |
| `content.js` | `getFilename()` — 両方の値の同時評価 | line 92-100 |
| `content.js` | URL変更検出 — data 属性クリア追加 | line 998 |
| `content.js` | `showFallback()` — data 属性設定追加 | line 303-309 |
| `content.js` | `createThumbnailElement()` — `data-e2c-filename` 属性追加 | line 248 |
| `content.js` | null filename — `processedRows.delete` + `removeAttribute` 追加 | line 776-779 |
