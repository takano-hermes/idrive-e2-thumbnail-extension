# 詳細仕様書: ポップアップでの対象変更操作

> **プロジェクト**: idrive-e2-thumbnail-extension
> **リポジトリ**: https://github.com/takano-hermes/idrive-e2-thumbnail-extension
> **作成日**: 2026-06-06
> **策定プロセス**: Multi-Agent Workflow（Architect → 質問抽出 → 詳細仕様書作成 → SpecificationReview）

---

## 1. Architect分析

### 1.1 現状の実装状況

| 項目 | 状態 | ファイル・関数 |
|---|---|---|
| `showOverlay(url, filename, isVideo)` | 実装済み | content.js |
| PresignedURL生成 (GetObject) | 実装済み | lib/sigv4.js, `window.E2C_S3.getPresignedUrl(config)` |
| 画像/動画拡張子リスト | 定義済み | content.js CONFIG |
| 行処理・MutationObserver | 実装済み | content.js processRow/processAllRows/startObserver |
| URL解析 (region, bucket, prefix) | 実装済み | content.js parseURL() |
| フォルダスタック | **未実装** | — |
| ListObjects PresignedURL | **未実装** | sigv4.jsに要追加 |
| オーバーレイのナビゲーションUI | **未実装** | showOverlayに要拡張 |
| フォルダ行の識別 | **未実装** | 末尾`/`判定ロジック |
| URL書き換え + polling検知連携 | **未実装** | — |

### 1.2 既存関数シグネチャ（コードリーディング確定）

**`showOverlay(url, filename, isVideo)`** (content.js)
- `url`: string — GetObjectのPresignedURL
- `filename`: string — 表示名
- `isVideo`: boolean
- 戻り値: void
- 内部でオーバーレイDOMを組み立ててdocument.bodyにappend

**`window.E2C_S3.getPresignedUrl(config)`** (lib/sigv4.js)
- `config`: `{ accessKeyId, secretAccessKey, region, bucket, key, expiresIn? }`
- 戻り値: `Promise<string|null>` — GETメソッド専用、パススタイルURL
- expiresInのデフォルト: 604800 (7日)

**`parseURL()`** (content.js)
- 戻り値: `{ region: string, bucket: string, prefix: string }`
- prefixはURL `?prefix=path/to/` から取得、空文字も可

**`getPresignedUrl(bucket, key, region)`** (content.js)
- キャッシュ付きラッパー。`window.E2C_S3.getPresignedUrl` を内部呼び出し
- 戻り値: `Promise<string|null>`

### 1.3 拡張子リスト（確定）

```
imageExts: .jpg, .jpeg, .png, .gif, .webp, .bmp, .tiff, .tif, .heic, .heif
videoExts: .mp4, .mov, .webm, .avi, .mkv, .m4v, .3gp, .wmv, .flv, .ts
```

### 1.4 不足点・曖昧点の整理

| # | 項目 | 現状の課題 |
|---|------|----------|
| A1 | ListObjects用PresignedURL | sigv4.jsの既存関数はkeyパスをURIエンコード。ListObjectsはkeyの代わりにクエリ文字列。新規関数の追加が必要。 |
| A2 | フォルダ行のDOM判定 | `getFilename(row)` の戻り値が末尾`/`かどうかで判定する想定だが、IDrive e2コンソールのフォルダ行が本当に末尾`/`を返すか未確認。 |
| A3 | フォルダ一覧の取得範囲 | `delimiter=/` でCommonPrefixesを得る。`prefix/` 以下のフォルダのみを抽出。 |
| A4 | フォルダスタックのクリアトリガー | URL手動変更やブラウザの戻るボタンでスタックが不整合になる。 |
| A5 | `processAllRows` とフォルダ行 | 現在は画像/動画のみ処理。フォルダ行はスキップされる前提。 |
| A6 | 動画再生中のナビゲーション | 「次へ」で再生中の動画を停止（video.pause()）して切り替えが必要。 |
| A7 | スライドショーボタン | UI配置に「右端」とあるが、機能自体は対応保留。プレースホルダーの扱い。 |

---

## 2. 質問・提案

### Q1: ListObjects PresignedURLの実装方式
**提案**: sigv4.jsに新関数 `getPresignedUrlS3List(prefix)` を追加する。クエリパラメータ部分のみ既存と異なり、署名アルゴリズムは同じ。既存のhmacSha256を流用する。

### Q2: フォルダ行のDOM識別方法
**確認**: IDrive e2コンソールのフォルダ行において、`div.e2c-os-name > span[title]` の値が実際に末尾`/`で終わる文字列になっているか？

### Q3: フォルダスタックのクリアトリガー
**提案**: 以下のタイミングでフォルダスタックをリセットする。
- URLのbucketが変更されたとき
- URLのregionが変更されたとき
- ユーザーがIDrive e2の通常のフォルダクリックで移動したとき

### Q4: スライドショーボタンの扱い
**確認**: プレースホルダーボタン（disabled状態）だけ配置すべきか、それともボタン自体をこのフェーズでは非表示にするか？

### Q5: ListObjectsのエラー時動作
**確認**: ListObjects APIがエラー（403/500等）を返した場合、ユーザーにエラーを伝えるUI（トースト通知等）は不要か？

### Q6: 動画のオーバーレイ再生中に「次へ」を押したとき
**確認**: 再生中の動画は `video.pause()` してから次のファイルに遷移する。動画の再生位置はリセット（currentTime=0）して構わないか？

### Q7: ルート（prefix空）でのフォルダナビゲーション
**確認**: ルート（`?prefix=`）では「前のフォルダ」が存在しないのでdisabled固定で良いか？

---

## 3. 詳細仕様書

### 3.1 ファイル改変一覧

| ファイル | 変更内容 |
|---------|---------|
| `lib/sigv4.js` | ListObjects用PresignedURL生成関数を追加（`getPresignedUrlS3List`） |
| `content.js` | オーバーレイのナビゲーション機能全体を追加。既存showOverlayを拡張。フォルダ一覧管理、ファイル一覧管理、ナビゲーションUI構築。 |

popup.html/popup.jsは変更不要。

### 3.2 データ構造

#### 3.2.1 グローバル状態 (content.js スコープ内)

```javascript
// 現在のオーバーレイ状態
let overlayState = {
  /** @type {HTMLElement|null} */
  overlayEl: null,
  /** @type {number} 現在表示中のファイルインデックス (fileList内) */
  currentIndex: -1,
  /** @type {Array<{filename:string, ext:string, isVideo:boolean, bucket:string, key:string, region:string}>} */
  fileList: [],
  /** @type {boolean} 動画再生中か */
  isPlayingVideo: false,
  /** @type {HTMLVideoElement|null} 再生中のvideo要素 */
  videoEl: null,
};

// フォルダナビゲーション状態
let folderState = {
  /** @type {Array<{currentPrefix:string, siblings:string[]}>} */
  history: [],
  /** @type {string} 現在のフォルダパス (prefix) */
  currentPrefix: '',
  /** @type {string[]} 現在の兄弟フォルダ一覧 */
  siblings: [],
  /** @type {number} siblings内の現在インデックス (currentPrefixの位置) */
  currentSiblingIndex: -1,
};
```

#### 3.2.2 FileListエントリの構築元

現在の`processAllRows()`が走査する`div.e2c-tb-rw`行から、画像/動画のみ抽出して`overlayState.fileList`を構築する。

```javascript
/**
 * @returns {Array<{filename:string, ext:string, isVideo:boolean, bucket:string, key:string, region:string}>}
 */
function buildFileList() {
  const { region, bucket, prefix } = parseURL();
  const rows = document.querySelectorAll('div.e2c-tb-rw');
  const list = [];
  rows.forEach(row => {
    const filename = getFilename(row);
    if (!filename) return;
    const ext = getExtension(filename);
    const isImage = CONFIG.imageExts.has(ext);
    const isVideo = CONFIG.videoExts.has(ext);
    if (!isImage && !isVideo) return;
    const fullKey = (prefix || '') + filename;
    list.push({ filename, ext, isVideo, bucket, key: fullKey, region });
  });
  return list;
}
```

### 3.3 lib/sigv4.js への追加

#### 3.3.1 ListObjects V2 PresignedURL生成関数

```javascript
/**
 * S3 ListObjectsV2用PresignedURLを生成
 * @param {Object} config
 * @param {string} config.accessKeyId
 * @param {string} config.secretAccessKey
 * @param {string} config.region
 * @param {string} config.bucket
 * @param {string} config.prefix - リスト対象のprefix（空文字列可）
 * @param {number} [config.expiresIn=604800]
 * @returns {Promise<string>}
 */
async function getPresignedUrlS3List(config) {
  const { accessKeyId, secretAccessKey, region, bucket, prefix = '', expiresIn = 604800 } = config;

  const now = new Date();
  const yyyymmdd = now.toISOString().split('T')[0].replace(/-/g, '');
  const datetime = now.toISOString().replace(/[\-:]/g, '').split('.')[0] + 'Z';

  const host = `s3.${region}.idrivee2.com`;
  const canonicalUri = '/' + bucket + '/';
  const credentialScope = `${yyyymmdd}/${region}/s3/aws4_request`;
  const encodedCredential = encodeURIComponent(accessKeyId + '/' + credentialScope);

  const qsParts = [
    `delimiter=${encodeURIComponent('/')}`,
    `list-type=2`,
    `prefix=${encodeURIComponent(prefix)}`,
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${encodedCredential}`,
    `X-Amz-Date=${datetime}`,
    `X-Amz-Expires=${expiresIn}`,
    `X-Amz-SignedHeaders=host`
  ];
  const canonicalQs = qsParts.join('&');
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const crParts = ['GET', canonicalUri, canonicalQs, canonicalHeaders, signedHeaders, payloadHash];
  const canonicalRequest = crParts.join('\n');

  // 署名計算（既存のhmacSha256関数を流用）
  const encoder = new TextEncoder();
  const crHash = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest))
    .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));

  const stringToSign = ['AWS4-HMAC-SHA256', datetime, credentialScope, crHash].join('\n');

  const kDate = await hmacSha256(encoder.encode('AWS4' + secretAccessKey), encoder.encode(yyyymmdd));
  const kRegion = await hmacSha256(kDate, encoder.encode(region));
  const kService = await hmacSha256(kRegion, encoder.encode('s3'));
  const kSigning = await hmacSha256(kService, encoder.encode('aws4_request'));

  const signature = await hmacSha256(kSigning, encoder.encode(stringToSign))
    .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''));

  return `https://${host}${canonicalUri}?${canonicalQs}&X-Amz-Signature=${signature}`;
}
```

**exportの追加**:
```javascript
window.E2C_S3 = {
  getPresignedUrl: getPresignedUrlS3Get,
  getPresignedUrlList: getPresignedUrlS3List,  // ← 追加
};
```

#### 3.3.2 content.js側ラッパー追加

```javascript
async function getListPresignedUrl(bucket, prefix, region) {
  if (!s3Ready) return null;
  try {
    const s3Region = settings.s3Region || regionToEndpoint(region);
    const url = await window.E2C_S3.getPresignedUrlList({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      region: s3Region,
      bucket: bucket,
      prefix: prefix,
      expiresIn: 300,  // Listは短期（5分）でOK
    });
    return url;
  } catch (e) {
    log('getListPresignedUrl ERROR:', e.message || e);
    return null;
  }
}
```

### 3.4 ListObjectsレスポンスXMLパース

```javascript
/**
 * ListObjectsV2 XMLレスポンスからCommonPrefixes（フォルダ）を抽出
 * @param {string} xmlText
 * @returns {string[]} prefixのリスト（例: ['photos/', 'docs/']）
 */
function parseCommonPrefixes(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, 'text/xml');
  const commonPrefixes = xml.querySelectorAll('CommonPrefixes > Prefix');
  const prefixes = [];
  commonPrefixes.forEach(el => {
    const p = el.textContent.trim();
    if (p) prefixes.push(p);
  });
  return prefixes;  // S3の応答順（通常辞書順）
}
```

### 3.5 フォルダ一覧取得

```javascript
/**
 * ListObjects APIを呼び、現在の親prefix下のフォルダ（CommonPrefixes）一覧を取得
 * @param {string} bucket
 * @param {string} region
 * @param {string} parentPrefix - 親フォルダのprefix
 * @returns {Promise<string[]>} フォルダprefixの配列（空の場合は空配列）
 */
async function fetchFolderSiblings(bucket, region, parentPrefix) {
  if (!s3Ready) return [];
  const url = await getListPresignedUrl(bucket, parentPrefix, region);
  if (!url) return [];

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      log('fetchFolderSiblings HTTP', resp.status, resp.statusText);
      return [];  // フォルダボタンdisabledにフォールバック
    }
    const xml = await resp.text();
    const prefixes = parseCommonPrefixes(xml);
    return prefixes;
  } catch (e) {
    log('fetchFolderSiblings FETCH ERROR:', e.message);
    return [];
  }
}
```

### 3.6 フォルダスタック操作

```javascript
/**
 * フォルダを開く（スタックにpush）
 */
async function navigateToFolder(targetPrefix) {
  const { region, bucket } = parseURL();

  // 現在の状態をスタックに保存
  folderState.history.push({
    currentPrefix: folderState.currentPrefix,
    siblings: folderState.siblings,
  });

  // 新しいprefixで兄弟一覧を取得
  folderState.currentPrefix = targetPrefix;
  const siblings = await fetchFolderSiblings(bucket, region, targetPrefix);
  folderState.siblings = siblings;

  // targetPrefixの兄弟内での位置を特定
  const parentPrefix = getParentPrefix(targetPrefix);
  const parentSiblings = await fetchFolderSiblings(bucket, region, parentPrefix);
  const idx = parentSiblings.indexOf(targetPrefix);
  folderState.currentSiblingIndex = idx;

  // URL書き換え
  updateURLPrefix(targetPrefix);
}

/**
 * フォルダ履歴を戻る（スタックからpop）
 */
function navigateBackFolder() {
  if (folderState.history.length === 0) return;
  const prev = folderState.history.pop();
  folderState.currentPrefix = prev.currentPrefix;
  folderState.siblings = prev.siblings;
  folderState.currentSiblingIndex = prev.siblings.indexOf(prev.currentPrefix);
  updateURLPrefix(prev.currentPrefix);
}

/**
 * 親prefixを取得（/で区切って最後のセグメントを除去）
 */
function getParentPrefix(prefix) {
  if (!prefix || prefix === '') return '';
  const withoutTrailing = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  const lastSlash = withoutTrailing.lastIndexOf('/');
  if (lastSlash < 0) return '';
  return withoutTrailing.slice(0, lastSlash + 1);
}
```

### 3.7 URL書き換え（既存polling検知との連携）

既存の `lastUrl` はIIFEスコープ内の `const` で書き換え不能。以下の方式でバイパスする:

```javascript
function updateURLPrefix(newPrefix) {
  const url = new URL(window.location.href);
  if (newPrefix) {
    url.searchParams.set('prefix', newPrefix);
  } else {
    url.searchParams.delete('prefix');
  }
  window.history.pushState({}, '', url.toString());
  // 既存のpolling機構に頼らず直接トリガー（processedRowsはletで再代入可能）
  processedRows = new WeakSet();
  setTimeout(processAllRows, 500);
}
```

### 3.8 ナビゲーションボタンUI

#### 3.8.1 新しいshowOverlayシグネチャ

```javascript
/**
 * オーバーレイを表示（ナビゲーション機能付き）
 * @param {string} url - GetObject PresignedURL
 * @param {string} filename - 表示ファイル名
 * @param {boolean} isVideo - 動画フラグ
 * @param {number} currentIndex - overlayState.fileList内の現在インデックス
 */
function showOverlay(url, filename, isVideo, currentIndex) {
  // 既存呼び出し側も拡張
}
```

#### 3.8.2 既存呼び出し箇所の拡張（サムネイルクリックハンドラ）

```javascript
wrapper.addEventListener('click', async (e) => {
  e.stopPropagation();
  const url = await getPresignedUrl(bucket, objKey, region);
  if (!url) return;
  overlayState.fileList = buildFileList();
  const currentIdx = overlayState.fileList.findIndex(
    item => item.filename === filename && item.bucket === bucket
  );
  overlayState.currentIndex = currentIdx >= 0 ? currentIdx : 0;

  if (settings.clickAction === 'newtab') {
    window.open(url, '_blank');
  } else {
    showOverlay(url, filename, isVideo, overlayState.currentIndex);
  }
});
```

#### 3.8.3 ナビゲーションUIのDOM構造

```
#e2c-thumb-overlay (既存のラッパー)
  └── .e2c-overlay-content
       ├── [メディア要素: img または video]
       ├── .e2c-overlay-close (既存のcloseボタン)
       ├── .e2c-overlay-bottom-bar (新規: 下部情報バー)
       │    ├── .e2c-nav-btn.e2c-nav-prev-folder (⏮ 前のフォルダ)
       │    ├── .e2c-nav-btn.e2c-nav-prev (◀ 前へ)
       │    ├── .e2c-filename (ファイル名表示)
       │    ├── .e2c-nav-btn.e2c-nav-next (次へ ▶)
       │    ├── .e2c-nav-btn.e2c-nav-next-folder (次のフォルダ ⏭)
       │    └── .e2c-nav-btn.disabled (⏩ スライドショー - 将来拡用)
       └── .e2c-overlay-title (既存のtitle)
```

**配置順**: ⏮ 前のフォルダ | ◀ 前へ | [ファイル名] | 次へ ▶ | 次のフォルダ ⏭ | [スライドショー]

#### 3.8.4 CSS追加（styles.cssに追記）

```css
.e2c-overlay-bottom-bar {
  position: absolute;
  bottom: -50px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0,0,0,0.6);
  border-radius: 8px;
  padding: 6px 12px;
  white-space: nowrap;
}

.e2c-nav-btn {
  background: none;
  border: 1px solid rgba(255,255,255,0.3);
  color: white;
  font-size: 16px;
  cursor: pointer;
  border-radius: 4px;
  padding: 4px 8px;
  min-width: 32px;
  text-align: center;
  transition: background 0.15s;
  line-height: 1.2;
}

.e2c-nav-btn:hover:not(.disabled) {
  background: rgba(255,255,255,0.15);
  border-color: rgba(255,255,255,0.6);
}

.e2c-nav-btn.disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.e2c-filename {
  color: #ccc;
  font-size: 13px;
  padding: 0 8px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

#### 3.8.5 ナビゲーションイベントハンドラ

```javascript
async function navigatePrev() {
  if (overlayState.currentIndex <= 0) return;
  const newIdx = overlayState.currentIndex - 1;
  const item = overlayState.fileList[newIdx];
  const url = await getPresignedUrl(item.bucket, item.key, item.region);
  if (!url) return;
  overlayState.currentIndex = newIdx;
  updateOverlayContent(url, item.filename, item.isVideo);
}

async function navigateNext() {
  if (overlayState.currentIndex >= overlayState.fileList.length - 1) return;
  const newIdx = overlayState.currentIndex + 1;
  const item = overlayState.fileList[newIdx];
  const url = await getPresignedUrl(item.bucket, item.key, item.region);
  if (!url) return;
  overlayState.currentIndex = newIdx;
  updateOverlayContent(url, item.filename, item.isVideo);
}

async function navigatePrevFolder() {
  const { region, bucket } = parseURL();
  if (folderState.currentSiblingIndex <= 0) return;
  const targetPrefix = folderState.siblings[folderState.currentSiblingIndex - 1];
  folderState.history.push({
    currentPrefix: folderState.currentPrefix,
    siblings: folderState.siblings,
  });
  folderState.currentPrefix = targetPrefix;
  updateURLPrefix(targetPrefix);
  closeOverlay();
  folderState.siblings = await fetchFolderSiblings(bucket, region, targetPrefix);
  folderState.currentSiblingIndex = folderState.siblings.indexOf(targetPrefix);
}

async function navigateNextFolder() {
  const { region, bucket } = parseURL();
  if (folderState.currentSiblingIndex >= folderState.siblings.length - 1) return;
  const targetPrefix = folderState.siblings[folderState.currentSiblingIndex + 1];
  folderState.history.push({
    currentPrefix: folderState.currentPrefix,
    siblings: folderState.siblings,
  });
  folderState.currentPrefix = targetPrefix;
  updateURLPrefix(targetPrefix);
  closeOverlay();
  folderState.siblings = await fetchFolderSiblings(bucket, region, targetPrefix);
  folderState.currentSiblingIndex = folderState.siblings.indexOf(targetPrefix);
}
```

#### 3.8.6 オーバーレイコンテンツ更新

```javascript
function updateOverlayContent(url, filename, isVideo) {
  const content = overlayState.overlayEl.querySelector('.e2c-overlay-content');
  if (!content) return;

  // 古いメディア要素を削除（videoの場合は停止）
  const oldMedia = content.querySelector('img, video');
  if (oldMedia) {
    if (oldMedia.tagName === 'VIDEO') {
      oldMedia.pause();
      oldMedia.removeAttribute('src');
      oldMedia.load();
    }
    oldMedia.remove();
  }

  // 新しいメディア要素を作成
  let newMedia;
  if (isVideo) {
    newMedia = document.createElement('video');
    newMedia.src = url;
    newMedia.controls = true;
    newMedia.autoplay = true;
    newMedia.style.cssText = `max-width:90vw;max-height:85vh;border-radius:8px;`;
  } else {
    newMedia = document.createElement('img');
    newMedia.src = url;
    newMedia.style.cssText = `max-width:90vw;max-height:85vh;object-fit:contain;border-radius:8px;`;
    newMedia.onerror = () => { newMedia.alt = '⛔ 画像を読み込めません'; };
  }

  const closeBtn = content.querySelector('.e2c-overlay-close');
  content.insertBefore(newMedia, closeBtn);

  // ファイル名更新
  const titleEl = content.querySelector('.e2c-overlay-title');
  if (titleEl) titleEl.textContent = filename;
  const filenameEl = content.querySelector('.e2c-filename');
  if (filenameEl) filenameEl.textContent = filename;

  updateNavButtons();
}

function updateNavButtons() {
  const bar = overlayState.overlayEl?.querySelector('.e2c-overlay-bottom-bar');
  if (!bar) return;

  const prevBtn = bar.querySelector('.e2c-nav-prev');
  const nextBtn = bar.querySelector('.e2c-nav-next');
  const prevFolderBtn = bar.querySelector('.e2c-nav-prev-folder');
  const nextFolderBtn = bar.querySelector('.e2c-nav-next-folder');

  prevBtn.classList.toggle('disabled', overlayState.currentIndex <= 0);
  nextBtn.classList.toggle('disabled', overlayState.currentIndex >= overlayState.fileList.length - 1);
  prevFolderBtn.classList.toggle('disabled', folderState.currentSiblingIndex <= 0);
  nextFolderBtn.classList.toggle('disabled', folderState.currentSiblingIndex >= folderState.siblings.length - 1);
}

function closeOverlay() {
  if (overlayState.overlayEl) {
    overlayState.overlayEl.remove();
    overlayState.overlayEl = null;
  }
  overlayState.currentIndex = -1;
  overlayState.fileList = [];
}
```

#### 3.8.7 キーボードショートカット

```javascript
function onOverlayKeydown(e) {
  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      navigatePrev();
      break;
    case 'ArrowRight':
      e.preventDefault();
      navigateNext();
      break;
    case 'Escape':
      closeOverlay();
      document.removeEventListener('keydown', onOverlayKeydown);
      break;
  }
}
```

### 3.9 改変後のshowOverlay全体像

```javascript
function showOverlay(url, filename, isVideo, currentIndex) {
  const existing = document.getElementById('e2c-thumb-overlay');
  if (existing) existing.remove();

  // 既存のkeydownリスナーを削除（多重登録防止）
  document.removeEventListener('keydown', onOverlayKeydown);

  overlayState.currentIndex = currentIndex >= 0 ? currentIndex : 0;

  const overlay = document.createElement('div');
  overlay.id = 'e2c-thumb-overlay';
  overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:999999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;`;

  const content = document.createElement('div');
  content.className = 'e2c-overlay-content';
  content.style.cssText = `max-width:90vw;max-height:90vh;position:relative;`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'e2c-overlay-close';
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `position:absolute;top:-40px;right:0;background:none;border:none;color:white;font-size:28px;cursor:pointer;z-index:10;`;

  let mediaEl;
  if (isVideo) {
    mediaEl = document.createElement('video');
    mediaEl.src = url;
    mediaEl.controls = true;
    mediaEl.autoplay = true;
    mediaEl.style.cssText = `max-width:90vw;max-height:85vh;border-radius:8px;`;
  } else {
    mediaEl = document.createElement('img');
    mediaEl.src = url;
    mediaEl.style.cssText = `max-width:90vw;max-height:85vh;object-fit:contain;border-radius:8px;`;
    mediaEl.onerror = () => { mediaEl.alt = '⛔ 画像を読み込めません'; };
  }

  const bottomBar = createNavigationBar(filename);
  const title = document.createElement('div');
  title.className = 'e2c-overlay-title';
  title.textContent = filename;
  title.style.cssText = `position:absolute;bottom:-30px;left:0;color:#ccc;font-size:14px;`;

  content.appendChild(mediaEl);
  content.appendChild(closeBtn);
  content.appendChild(title);
  content.appendChild(bottomBar);
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  overlayState.overlayEl = overlay;

  closeBtn.addEventListener('click', () => {
    closeOverlay();
    document.removeEventListener('keydown', onOverlayKeydown);
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) {
    closeOverlay();
    document.removeEventListener('keydown', onOverlayKeydown);
  }});
  document.addEventListener('keydown', onOverlayKeydown);

  updateNavButtons();
}
```

### 3.10 ナビゲーションバー構築

```javascript
function createNavigationBar(filename) {
  const bar = document.createElement('div');
  bar.className = 'e2c-overlay-bottom-bar';

  const prevFolder = document.createElement('button');
  prevFolder.className = 'e2c-nav-btn e2c-nav-prev-folder';
  prevFolder.textContent = '⏮';
  prevFolder.title = '前のフォルダ';
  prevFolder.addEventListener('click', (e) => { e.stopPropagation(); navigatePrevFolder(); });

  const prev = document.createElement('button');
  prev.className = 'e2c-nav-btn e2c-nav-prev';
  prev.textContent = '◀';
  prev.title = '前へ';
  prev.addEventListener('click', (e) => { e.stopPropagation(); navigatePrev(); });

  const nameSpan = document.createElement('span');
  nameSpan.className = 'e2c-filename';
  nameSpan.textContent = filename;

  const next = document.createElement('button');
  next.className = 'e2c-nav-btn e2c-nav-next';
  next.textContent = '▶';
  next.title = '次へ';
  next.addEventListener('click', (e) => { e.stopPropagation(); navigateNext(); });

  const nextFolder = document.createElement('button');
  nextFolder.className = 'e2c-nav-btn e2c-nav-next-folder';
  nextFolder.textContent = '⏭';
  nextFolder.title = '次のフォルダ';
  nextFolder.addEventListener('click', (e) => { e.stopPropagation(); navigateNextFolder(); });

  const slideshow = document.createElement('button');
  slideshow.className = 'e2c-nav-btn disabled';
  slideshow.textContent = '⏩';
  slideshow.title = 'スライドショー（準備中）';
  slideshow.disabled = true;

  bar.append(prevFolder, prev, nameSpan, next, nextFolder, slideshow);
  return bar;
}
```

### 3.11 フォルダ兄弟一覧の初期化

```javascript
async function initFolderNavigation() {
  const { region, bucket, prefix } = parseURL();
  if (!bucket) return;

  const parentPrefix = getParentPrefix(prefix);
  folderState.currentPrefix = prefix;
  folderState.history = [];

  const siblings = await fetchFolderSiblings(bucket, region, parentPrefix);
  folderState.siblings = siblings;
  folderState.currentSiblingIndex = siblings.indexOf(prefix);
  log('initFolderNavigation: siblings=', siblings, 'currentIndex=', folderState.currentSiblingIndex);
}
```

`init()` の最後で呼び出すこと。

### 3.12 エラーハンドリング詳細

| ケース | ハンドリング |
|--------|------------|
| PresignedURL生成失敗（null） | 該当ファイルスキップせず、ボタンクリック時に何もしない |
| PresignedURL生成例外 | catchしてnull、上位でnullチェック |
| ListObjects HTTP 403 | `return []` → フォルダボタンdisabled、コンソールに警告ログ |
| ListObjects HTTP 5xx | `return []` → フォルダボタンdisabled |
| ListObjects ネットワークエラー | catchブロックで`return []` |
| ListObjects XMLパースエラー | try-catchで空配列返却 |
| fileList空（画像/動画0件） | サムネイルクリック時、`currentIdx=-1` で早期return、オーバーレイを開かない |
| フォルダ移動後、新しいフォルダに画像/動画0件 | オーバーレイは閉じたまま、テーブル表示のみ |
| 動画再生中にファイル遷移 | video.pause() + src削除 + load() |

### 3.13 境界条件

| 条件 | 動作 |
|------|------|
| fileList.length === 0 | オーバーレイを開かない（早期return） |
| currentIndex === 0 | 「前へ」ボタンdisabled |
| currentIndex === fileList.length - 1 | 「次へ」ボタンdisabled |
| fileList.length === 1 | 「前へ」「次へ」両方disabled |
| siblings.length === 0 | 「前のフォルダ」「次のフォルダ」両方disabled |
| siblings.length === 1 | 同上（現在のフォルダしかない） |
| currentSiblingIndex === 0 | 「前のフォルダ」disabled |
| currentSiblingIndex === siblings.length - 1 | 「次のフォルダ」disabled |
| ルート (prefix='') | currentSiblingIndex=-1 → 両方disabled |

### 3.14 実装優先順位

| 優先度 | タスク | 依存 |
|--------|-------|------|
| P0 | sigv4.js: getPresignedUrlS3List 追加 + E2C_S3.export更新 | なし |
| P0 | content.js: overlayState/folderState 状態変数追加 | P0完了後 |
| P1 | content.js: buildFileList() 追加 | P0完了後 |
| P1 | content.js: fetchFolderSiblings() + parseCommonPrefixes() | P0完了後 |
| P1 | content.js: showOverlay拡張（createNavigationBar + updateOverlayContent） | P0, P1完了後 |
| P2 | content.js: navigatePrev/Next + navigatePrevFolder/NextFolder | P1完了後 |
| P2 | content.js: updateNavButtons + keyboard handler | P2完了後 |
| P2 | content.js: initFolderNavigation() のinit()への組み込み | P0, P1完了後 |
| P3 | styles.css: ナビゲーションバー用CSS追記 | P1完了後 |
| P3 | エラーハンドリング・境界値テスト | 全P0-P2完了後 |

---

## 4. SpecificationReview

### 4.1 上位設計からの漏れ・乖離

| チェック項目 | 結果 |
|-------------|------|
| オブジェクトナビゲーション（前へ/次へ） | ✅ 準拠（DOM出現順、ループなし、範囲外disabled） |
| フォルダナビゲーション（前のフォルダ/次のフォルダ） | ✅ 準拠（ListObjects+CommonPrefixes、スタック式履歴） |
| UI配置順（⏮ ◀ ファイル名 ▶ ⏭） | ✅ 準拠 |
| 画像/動画のみ対象 | ✅ 準拠（CONFIG.imageExts/videoExts流用） |
| フォルダ行識別: 末尾/ | ✅ 設計反映 |
| S3 ListObjects V2 + PresignedURL | ✅ 設計反映（新規関数） |
| フォルダ履歴スタック | ✅ 設計反映（folderState.history push/pop） |
| 動画ファイルもナビゲーション対象 | ✅ 準拠 |
| ルート対応 | ✅ 設計反映（getParentPrefix('') → ''） |
| スライドショーボタン | ⚠️ 保留（プレースホルダーdisabled配置） |

**乖離**: なし。

### 4.2 実装者が迷わず開発できる具体性

| 項目 | 結果 |
|------|------|
| 関数シグネチャ（引数・戻り値・型） | ✅ JSDocコメント付きで明示 |
| データ構造 | ✅ overlayState/folderState の型定義完備 |
| DOM操作パス | ✅ 各セレクタと挿入位置を明示 |
| CSSクラス名 | ✅ 全クラス名定義済み |
| アルゴリズムの流れ | ✅ 主要関数の疑似コードと制御フロー完備 |
| 未実装部分との結合点 | ✅ showOverlay拡張方法、既存pollingとの連携方法を明示 |
| ファイル改変箇所 | ✅ sigv4.js + content.js + styles.css の3ファイルのみ |

### 4.3 例外処理・エラーハンドリング

**不足として特定された2点**:

1. **キーボードイベントの多重登録**: showOverlayが連続して呼ばれるとkeydownリスナーが重複する。対策: showOverlay先頭で `document.removeEventListener('keydown', onOverlayKeydown)` を呼ぶ（仕様書3.9に反映済み）。

2. **popstateイベント対応**: ブラウザの戻るボタンでURLが変わった場合、`folderState` が不整合になる。対策: 以下のpopstateリスナーを追加推奨。
   ```javascript
   window.addEventListener('popstate', () => {
     folderState.history = [];
     folderState.siblings = [];
     folderState.currentSiblingIndex = -1;
   });
   ```

### 4.4 テスト容易性・保守性

| 項目 | 評価 |
|------|------|
| 関数の責務分離 | ✅ 良好（buildFileList / fetchFolderSiblings / navigatePrev/Next / updateNavButtons が独立） |
| 状態の局所性 | ✅ IIFEスコープ内のオブジェクト変数で管理 |
| 副作用の明示 | ✅ URL書き換え関数の副作用をコメントで明示 |
| キャッシュ戦略 | ✅ 既存のpresignedUrlCacheをファイルナビゲーションでも利用 |
| DOM生成の分離 | ✅ createNavigationBar() がナビゲーションUI生成を担当 |

**推奨テストケース**:
1. 画像3ファイル + 動画1ファイル → 前へ/次へが正しい順序で動作する
2. fileListに1件のみ → 前へ/次へが両方disabled
3. フォルダ兄弟3つ（'a/', 'b/', 'c/'）で'b/'にいる → 両方向のフォルダボタンが活性
4. ルート（prefix=''） → フォルダボタン両方disabled
5. ListObjects APIが403を返す → フォルダボタンdisabled、ファイルナビゲーションは正常
6. 動画再生中に「次へ」 → 古いvideoがpauseされ、次のファイルに遷移
7. キーボード左右キーでファイル遷移、Escapeで閉じる
