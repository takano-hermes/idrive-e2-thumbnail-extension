# ポップアップ動画ビューアー 仕様書 v1.0

## 1. 背景・課題

### 1.1 現状の制約
IDrive e2 コンソールは以下の CSP を発行している:

```
default-src 'self'
```

この制約により、**オーバーレイ内での動画再生が不可**。`<video src="{PresignedURL}">` のように外部ドメイン（`s3.ap-northeast-1.idrivee2.com`）のメディアを埋め込もうとすると、ブラウザがブロックする。

現状の回避策として `clickAction: 'newtab'` を用意しているが、以下が問題:

- 毎回新規タブが開き、閲覧後に都度閉じる手間
- 連続視聴（前の動画/次の動画）ができない
- フォルダナビゲーション機能が動画に対して無効
- タブが増え続ける（ユーザーが手動で閉じる必要あり）

### 1.2 解決方針
Chrome 拡張機能の特権を利用し、**拡張機能由来のポップアップウィンドウ** を開くことで CSP の制約を受けずに動画を再生する。

<details>
<summary>技術的根拠</summary>

- CSP の `default-src 'self'` は拡張機能のリソース（`chrome-extension://` スキーム）に対して制限を課さない
- 拡張機能のポップアップページは拡張機能独自のオリジン（`chrome-extension://<id>/`）で動作
- ポップアップ内から `fetch()` で Presigned URL を取得し、`<video>` 要素の `src` に設定しても CSP 違反にならない（拡張機能の CSP は manifest.json で別途制御）
- Manifest V3 の `web_accessible_resources` は不要（ポップアップページは拡張機能内部の遷移）
</details>

---

## 2. 設計目標

| # | 目標 | 優先度 |
|---|------|--------|
| 1 | オーバーレイから動画クリックでポップアップウィンドウが開く | P0 |
| 2 | ポップアップ内で動画が再生できる（CSP制限を回避） | P0 |
| 3 | 前の動画 / 次の動画へのナビゲーション | P1 |
| 4 | キーボードショートカット | P1 |
| 5 | 再生状態を維持したままのフォルダ移動（バックグラウンド再生） | P2 |
| 6 | プレイリスト表示 | P2 |
| 7 | シークバー・音量・再生速度などの標準コントロール | P0（video要素のcontrolsに委ねる） |

---

## 3. アーキテクチャ

### 3.1 コンポーネント構成

```
┌─────────────────────────────────────────────────┐
│ IDrive e2 Console (console.idrivee2.com)         │
│                                                   │
│  ┌────────────────────┐    ┌──────────────────┐  │
│  │ content.js         │    │ MutationObserver  │  │
│  │ ・サムネイル表示   │◄───│ (SPA遷移検出)    │  │
│  │ ・オーバーレイ表示  │    └──────────────────┘  │
│  │ ・動画クリック検出  │                          │
│  └────────┬───────────┘                          │
└───────────┼───────────────────────────────────────┘
            │ chrome.runtime.sendMessage()
            ▼
┌─────────────────────────────────────────────────┐
│ Background Service Worker (service_worker.js)   │
│                                                  │
│ ・chrome.windows.create() でポップアップを開く   │
│ ・content.js ↔ player.html のメッセージ中継     │
│ ・PresignedURL 生成リクエストのプロキシ          │
│ ・ポップアップのライフサイクル管理              │
└──────────────────┬──────────────────────────────┘
                   │ chrome.windows.create()
                   ▼
┌─────────────────────────────────────────────────┐
│ Player Window (player.html)                      │
│  サイズ: 960x640, 固定サイズ                     │
│  位置: 画面中央                                  │
│                                                   │
│  ┌────────────────┐  ┌────────────────────────┐  │
│  │ <video> 要素   │  │ ナビゲーションバー     │  │
│  │ ・controls      │  │  ◀  ▶  プレイリスト   │  │
│  │ ・autoplay      │  │  [ファイル名]          │  │
│  │ ・presigned URL │  │  [N / M]               │  │
│  └────────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### 3.2 メッセージングプロトコル

#### content.js → Service Worker

```typescript
// 動画再生リクエスト（content.js → SW）
interface PlayVideoRequest {
  type: 'PLAY_VIDEO';
  payload: {
    fileList: Array<{
      filename: string;
      key: string;
      bucket: string;
      region: string;
      isVideo: boolean;
    }>;
    currentIndex: number;
    currentPrefix: string;      // 現在のフォルダprefix
    parentPrefix: string;       // 親フォルダprefix
  };
}
```

#### Service Worker → player.html（window作成時）

```typescript
// 初期化データ（chrome.windows.create の createData に含める、またはメッセージで送信）
interface InitPlayerData {
  fileList: FileItem[];
  currentIndex: number;
  currentPrefix: string;
  parentPrefix: string;
}
```

#### player.html → Service Worker（応答）

```typescript
// PresignedURL リクエスト（player → SW）
interface GetPresignedUrlRequest {
  type: 'GET_PRESIGNED_URL';
  payload: {
    bucket: string;
    key: string;
    region: string;
  };
}

// PresignedURL 応答
interface GetPresignedUrlResponse {
  type: 'PRESIGNED_URL';
  payload: {
    url: string | null;
  };
}

// ListObjects V2 リクエスト（フォルダナビゲーション用）
interface ListObjectsRequest {
  type: 'LIST_OBJECTS';
  payload: {
    bucket: string;
    prefix: string;
    region: string;
  };
}

interface ListObjectsResponse {
  type: 'LIST_OBJECTS_RESULT';
  payload: {
    prefixes: string[];  // CommonPrefixes
    keys: string[];      // ファイルキーの配列
  };
}
```

#### Service Worker → player.html

```typescript
// 動画データ更新（ナビゲーション時）
interface UpdateVideoData {
  type: 'UPDATE_VIDEO';
  payload: {
    url: string;
    filename: string;
    currentIndex: number;
    totalCount: number;
  };
}
```

---

## 4. UIデザイン

### 4.1 ウィンドウ仕様

| 項目 | 値 |
|------|-----|
| 横幅 | 960px |
| 高さ | 640px |
| リサイズ | 許可（最小 640x400） |
| 位置 | 画面中央（screenX/screenY 指定） |
| 種別 | `popup`（デコレーションなしの軽量ウィンドウ） |
| 最前面 | 常時前面表示（focused: true） |

### 4.2 レイアウト

```
┌──────────────────────────────────────────────────────────┐
│ [ファイル名]                              [✕] 閉じる    │ ← タイトルバー
├──────────────────────────────────────────────────────────┤
│                                                          │
│                    ┌──────────────┐                      │
│                    │              │                      │
│                    │   <video>    │                      │
│                    │   controls   │                      │
│                    │   autoplay   │                      │
│                    │              │                      │
│                    └──────────────┘                      │
│                                                          │
├──────────────────────────────────────────────────────────┤
│ [⏮] [◀]  [3 / 15]  video_001.mp4  [▶] [⏭]  [🗂️]     │ ← コントロールバー
│                                                          │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ playlist_preview_001.mp4  ← 再生中                  │ │ ← プレイリスト
│ │ playlist_preview_002.mp4                             │ │   （トグル式）
│ │ playlist_preview_003.mp4                             │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 4.3 コントロール要素

#### タイトルバー（上部固定）
| 要素 | 動作 |
|------|------|
| ファイル名表示 | 現在再生中の動画ファイル名（省略可、ツールチップでフル表示） |
| 閉じるボタン ✕ | ウィンドウを閉じる（`window.close()`） |
| Esc キー | 同上 |

#### コントロールバー（下部固定）

| 要素 | ラベル | 動作 |
|------|--------|------|
| 前フォルダ | ⏮ | 前のフォルダの先頭動画に移動（ListObjects API経由） |
| 前の動画 | ◀ | 現在のフォルダ内の前の動画に移動 |
| 位置表示 | N / M | 「3 / 15」形式（現在インデックス / 総数） |
| ファイル名 | - | 現在のファイル名（省略可、ホバーでフル表示） |
| 次の動画 | ▶ | 現在のフォルダ内の次の動画に移動 |
| 次フォルダ | ⏭ | 次のフォルダの先頭動画に移動 |
| プレイリスト | 🗂️ | プレイリストパネルの表示/非表示トグル |

#### プレイリストパネル（下部、コントロールバーの上、トグル式）

| 項目 | 動作 |
|------|------|
| ファイル一覧 | 現在のフォルダ内の動画のみをリスト表示 |
| スクロール | 縦スクロール（max-height 制限あり） |
| クリック | 該当動画にジャンプして再生開始 |
| 現在再生中 | ハイライト表示（太字 + 色付け） |
| 表示/非表示 | 🗂️ ボタンでトグル。デフォルトは非表示 |

#### キーボードショートカット

| キー | 動作 | 備考 |
|------|------|------|
| ← / → | 前の動画 / 次の動画 | video要素にフォーカスがないときのみ |
| ↑ / ↓ | 音量 +/- 5% | - |
| M | ミュートトグル | - |
| Space | 再生/一時停止 | video要素のデフォルト動作に委ねる |
| F | フルスクリーン切り替え | video要素のrequestFullscreen() |
| Esc | 閉じる | フルスクリーン中は解除優先、解除後再度Escで閉じる |
| P | プレイリストトグル | 🗂️ と同動作 |

### 4.4 フォルダナビゲーション動作

オーバーレイのフォルダナビゲーション（content.js 既存実装）と同様のロジックを player.html 内でも実装する。ただし、**ポップアップウィンドウは独立しているため、コンソール側のURL変更は行わない**。ポップアップ内で閉じたフォルダツリーを保持する。

**フォルダ移動の流れ:**

1. ⏮/⏭ クリック → player.html → SW → `LIST_OBJECTS` リクエスト
2. Service Worker が content.js 経由（または同期的に）ListObjects V2 API をコール
3. `CommonPrefixes` を返却
4. player.html が新しいフォルダ内の動画一覧を構築
5. 先頭の動画の PresignedURL を取得し再生開始
6. ファイルリスト・インデックスを更新

---

## 5. ファイル構成

```
extension-root/
├── player.html            ← NEW: 動画プレイヤーページ
├── player.js              ← NEW: プレイヤーロジック
├── player.css             ← NEW: プレイヤースタイル
├── manifest.json          ← MODIFY: service_worker 追加、player.html を公開
├── service_worker.js      ← NEW: バックグラウンドサービスワーカー
├── content.js             ← MODIFY: 動画クリック時の処理を SW 委譲に変更
├── lib/
│   └── sigv4.js           ← （変更なし）
├── popup.html             ← （変更なし）
├── popup.js               ← MODIFY: 設定項目追加（ポップアップ動作設定）
├── styles.css             ← （変更なし）
└── SPEC_VIDEO_POPUP.md    ← 本仕様書
```

---

## 6. 実装詳細

### 6.1 manifest.json 変更点

```json
{
  "manifest_version": 3,
  "name": "IDrive e2 サムネイルビューアー",
  "version": "2.1.0",
  "permissions": [
    "storage",
    "activeTab"
  ],
  // --- 追加: service_worker ---
  "background": {
    "service_worker": "service_worker.js"
  },
  // --- 追加: web_accessible_resources（player.html を拡張機能内で開くため）---
  "web_accessible_resources": [{
    "resources": ["player.html"],
    "matches": ["<all_urls>"]
  }],
  "host_permissions": [
    "https://console.idrivee2.com/*",
    "https://s3.*.idrivee2.com/*"
  ],
  "content_scripts": [{
    "matches": ["https://console.idrivee2.com/*"],
    "js": ["lib/sigv4.js", "content.js"],
    "css": ["styles.css"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup.html",
    "default_icon": "icon128.png",
    "default_title": "IDrive e2 サムネイル設定"
  },
  "icons": {
    "128": "icon128.png"
  }
}
```

### 6.2 service_worker.js

**責務:**
1. `chrome.runtime.onMessage` リスナー
2. `PLAY_VIDEO` メッセージ受信 → `chrome.windows.create()` で player.html を開く → player.html にデータを転送
3. `GET_PRESIGNED_URL` メッセージ受信 → `chrome.tabs.sendMessage()` で content.js に委譲（SigV4署名は content.js 内の window.E2C_S3 で行うため）
4. `LIST_OBJECTS` メッセージ受信 → content.js に委譲（または SW 内で直接 S3 API を叩く）

**なぜ Service Worker 経由か:**
- `chrome.windows.create()` は content script から呼べない（拡張機能の特権API）
- メッセージの中継地点として必要
- player.html のライフサイクル管理

**注意点:**
- Manifest V3 の Service Worker は非永続的（約30秒でアンロードされる可能性あり）
- `runtime.onConnect` で長寿命接続（Port）を確立し、アンロードを防止
- または player.html が開いている間は生きていると想定

### 6.3 content.js 変更点

#### 6.3.1 動画クリック時の動作分岐

`createThumbnailElement()` 内のクリックハンドラを修正:

```javascript
// 現状:
wrapper.addEventListener('click', async (e) => {
  // ...
  if (settings.clickAction === 'newtab') {
    window.open(url, '_blank');
  } else {
    // overlay 表示（動画はCSPでブロック）
  }
});

// 修正後:
wrapper.addEventListener('click', async (e) => {
  // ...
  if (isVideo && settings.clickAction === 'overlay') {
    // 動画 → ポップアップビューアーを開く
    chrome.runtime.sendMessage({
      type: 'PLAY_VIDEO',
      payload: {
        fileList: buildFileList().filter(item => item.isVideo),
        currentIndex: /* 現在の動画インデックス */,
        currentPrefix: parseURL().prefix,
        parentPrefix: getParentPrefix(parseURL().prefix),
      }
    });
  } else if (settings.clickAction === 'newtab') {
    window.open(url, '_blank');
  } else {
    // 画像 → 既存オーバーレイ
    showOverlay(url, filename, false, currentIndex);
  }
});
```

#### 6.3.2 新しいメッセージハンドラ

```javascript
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_PRESIGNED_URL') {
    const { bucket, key, region } = msg.payload;
    getPresignedUrl(bucket, key, region).then(url => {
      sendResponse({ type: 'PRESIGNED_URL', payload: { url } });
    });
    return true;  // 非同期応答
  }
  if (msg.type === 'LIST_OBJECTS') {
    const { bucket, prefix, region } = msg.payload;
    fetchFolderSiblings(bucket, region, prefix).then(prefixes => {
      sendResponse({ type: 'LIST_OBJECTS_RESULT', payload: { prefixes, keys: [] } });
    });
    return true;
  }
});
```

> **設計判断: SigV4署名をSWで行わない理由**
>
> `lib/sigv4.js` は `window.E2C_S3` 名前空間に依存し、DOM API（`crypto.subtle`）を使用する。Service Worker では `window` が存在しないため、そのまま再利用できない。また、Access Key / Secret Key は `chrome.storage.sync` に保存されているが、SW からも読める。しかし、既存の署名ロジックを SW 用に移植する工数を避けるため、**署名は content.js に一元化**し、SW は中継役に徹する。

### 6.4 player.html

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IDrive e2 Video Player</title>
  <link rel="stylesheet" href="player.css">
</head>
<body>
  <div id="titlebar">
    <span id="filename"></span>
    <button id="closeBtn" title="閉じる (Esc)">✕</button>
  </div>

  <div id="player-container">
    <video id="videoPlayer" controls autoplay></video>
  </div>

  <div id="controls">
    <button id="prevFolderBtn" title="前のフォルダ (⌘⏮)">⏮</button>
    <button id="prevBtn" title="前の動画 (←)">◀</button>
    <span id="position">- / -</span>
    <span id="filenameDisplay" title=""></span>
    <button id="nextBtn" title="次の動画 (→)">▶</button>
    <button id="nextFolderBtn" title="次のフォルダ (⌘⏭)">⏭</button>
    <button id="playlistToggle" title="プレイリスト (P)">🗂️</button>
  </div>

  <div id="playlistPanel" class="hidden">
    <ul id="playlist"></ul>
  </div>

  <script src="player.js"></script>
</body>
</html>
```

### 6.5 player.js

**状態管理:**

```javascript
const state = {
  fileList: [],          // FileItem[]
  currentIndex: -1,
  currentPrefix: '',     // 現在のフォルダprefix
  parentPrefix: '',      // 親フォルダprefix
  siblings: [],          // 同階層のフォルダ一覧
  playlistVisible: false,
};
```

**主要機能:**

1. **init()**: Service Worker から初期データを受け取り、最初の動画を再生
2. **loadVideo(index)**: PresignedURL を取得し、video 要素の src を更新
3. **navigatePrev/Next()**: fileList のインデックス移動
4. **navigatePrevFolder/NextFolder()**: sibling フォルダ移動 → ListObjects → fileList再構築
5. **updatePlaylist()**: プレイリスト UI を fileList から再描画
6. **setupKeyboardShortcuts()**: キーボードイベントハンドラ
7. **connectToSW()**: Service Worker との Port 接続を確立（PresignedURL取得用）

**PresignedURL 取得パス:**

```
player.js → chrome.runtime.sendMessage({GET_PRESIGNED_URL})
  → service_worker.js (中継)
    → content.js (署名生成)
      → service_worker.js (応答)
        → player.js (URL受信 → video.src 設定)
```

### 6.6 player.css

**方針:**
- ダークテーマ（IDrive e2 コンソールと統一感）
- 最小限のスタイルで video 要素のデフォルト controls を活かす
- プレイリストパネルはスライドインアニメーション

```css
/* 主要スタイル案 */
body {
  margin: 0;
  background: #1a1a1a;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
  user-select: none;
}

#titlebar {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: #2a2a2a;
  -webkit-app-region: drag;
  /* ↑ ウィンドウドラッグ可能に */
}

#closeBtn {
  -webkit-app-region: no-drag;
  /* ↑ 閉じるボタンだけドラッグ対象外 */
}

#player-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: calc(100vh - 36px - 44px);
  /* タイトルバー + コントロールバーを除いた高さ */
}

#videoPlayer {
  max-width: 100%;
  max-height: 100%;
}

#controls { /* 下部固定 */
  height: 44px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: #2a2a2a;
}

#playlistPanel {
  position: absolute;
  bottom: 44px;
  left: 0;
  right: 0;
  max-height: 200px;
  overflow-y: auto;
  background: rgba(30, 30, 30, 0.95);
  transition: max-height 0.2s ease;
}

#playlistPanel.hidden {
  max-height: 0;
  overflow: hidden;
}
```

### 6.7 popup.html / popup.js 変更点

**新設する設定項目:**

| 設定 | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| videoClickAction | select | 'popup' | 動画クリック時の動作: 'popup'（ポップアップ）/ 'newtab'（新規タブ）/ 'overlay'（オーバーレイ＝CSPエラーになるが選択肢として残す） |

`clickAction` は画像用、`videoClickAction` は動画用と分離する。

---

## 7. エッジケース・エラーハンドリング

### 7.1 動画読み込み失敗

| 状況 | 対応 |
|------|------|
| PresignedURL 生成失敗 | エラーメッセージをオーバーレイ表示。リトライボタンを表示 |
| ネットワークエラー | video 要素の `onerror` イベントをハンドリング。リトライ可能なら PresignedURL を再生成 |
| 期限切れ PresignedURL | 現在の有効期限は 7日（604800秒）。ポップアップ内で期限切れが発生した場合、即座に再生成してリトライ |
| 対応コーデックなし | ブラウザのネイティブエラーメッセージに委ねる（`MEDIA_ERR_SRC_NOT_SUPPORTED`） |
| 空のフォルダに移動 | 「動画がありません」メッセージを表示。フォルダ移動ボタンは無効のまま |

### 7.2 ウィンドウライフサイクル

| 状況 | 対応 |
|------|------|
| ポップアップが開いている間にコンソールのURLが変わる | content.js の `PLAY_VIDEO` 送信時に動画一覧のスナップショットを渡すため、影響なし |
| ポップアップを開いたままコンソールを離れる | ポップアップは独立して動作継続。閉じるまで再生は続く |
| Service Worker がアンロードされる | `runtime.onConnect` Port を維持。Port が切れたら再接続（player.js 側でリカバリ） |
| 複数のポップアップ | 現時点では制限なし。ユーザーが複数開くことも許容（ただし、同一フォルダで複数開くケースは稀） |

### 7.3 リソース管理

| 項目 | 対応 |
|------|------|
| PresignedURL キャッシュ | player.js 内で Map 管理。キーは `bucket/key`。ポップアップが閉じれば破棄 |
| 動画要素のメモリ | ナビゲーション時に `video.pause()` + `src=""` + `load()` でリソース解放 |
| 再生中のフォルダ移動 | 現在の動画を停止してから新しいフォルダの動画を読み込む |

---

## 8. 実装フェーズ

### Phase 1（P0）: 基本動画再生
- service_worker.js 作成（chrome.windows.create + メッセージ中継）
- player.html / player.js / player.css 作成（最小構成）
- content.js に動画クリック → SW → ポップアップのパスを追加
- **成果物**: 動画をクリックするとポップアップが開き、動画が再生される

### Phase 2（P1）: ナビゲーション
- 前/次の動画ナビゲーション
- フォルダナビゲーション（ListObjects API 経由）
- キーボードショートカット
- **成果物**: オーバーレイ同等のナビゲーション体験

### Phase 3（P2）: プレイリスト
- プレイリストパネルの実装
- ファイル一覧表示とハイライト
- **成果物**: プレイリストからの動画選択

### Phase 4（P2）: 設定統合・仕上げ
- popup.html に videoClickAction 設定追加
- トランジションアニメーション
- エラーハンドリング強化
- フォルダナビゲーションのコンテキスト分離（ポップアップ独自履歴）

---

## 9. 非機能要件

| 項目 | 要件 |
|------|------|
| パフォーマンス | ポップアップ開封〜動画再生開始まで 3秒以内（PresignedURL生成含む） |
| メモリ | ポップアップ1ウィンドウあたり 100MB 以内（動画バッファ含む） |
| 対応フォーマット | ブラウザがサポートする動画形式（MP4/H.264, WebM/VP9 等）。コーデック変換は行わない |
| アクセシビリティ | ボタンに aria-label 設定。キーボードのみで全操作可能 |
| エラーレート | 動画再生開始失敗率 5% 未満（PresignedURL の期限切れは除く） |

---

## 10. 未解決・検討事項

1. **Service Worker の永続性**: Manifest V3 の SW は非永続的。`chrome.runtime.onConnect` による Port 維持でどこまでカバーできるか要検証
2. **S3 API 直接呼び出し**: SW 内で SigV4 署名を実装するか（`crypto.subtle` は SW でも利用可能）。SW 内実装なら content.js を経由せず、レイテンシ削減
3. **複数ファイルの PresignedURL 先読み**: 前後 N 件の PresignedURL を事前生成して滑らかなナビゲーションを実現するか
4. **ポップアップ位置の記憶**: 次回開封時に前回と同じ位置に開くか
5. **pip（Picture-in-Picture）**: ポップアップ内で PiP ボタンを表示するか（video 要素のデフォルト controls に含まれる）

---

## 11. 改訂履歴

| 版 | 日付 | 変更内容 |
|----|------|----------|
| 1.0 | 2026-06-07 | 初版作成 |
