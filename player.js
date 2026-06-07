// IDrive e2 Video Player - Player Script v1.0 (Phase 1)
'use strict';

// ============================================================
// DEBUG
// ============================================================
const DEBUG = true; // デバッグログON/OFF
const log = DEBUG ? console.log.bind(console, '[Player]') : () => {};
const warn = DEBUG ? console.warn.bind(console, '[Player]') : () => {};

// ============================================================
// 状態
// ============================================================
const state = {
  fileList: [],
  currentIndex: -1,
  currentPrefix: '',
  parentPrefix: '',
  siblings: [],
  playlistVisible: false,
  presignedUrlCache: new Map(),
};

// ============================================================
// DOM参照
// ============================================================
const $ = (id) => document.getElementById(id);
const videoEl = $('videoPlayer');
const loadingEl = $('loading-overlay');
const errorEl = $('error-overlay');
const errorTextEl = $('error-text');

// ============================================================
// 初期化
// ============================================================
async function init() {
  const params = new URLSearchParams(location.search);
  const dataId = params.get('dataId');
  if (!dataId) {
    showError('データが見つかりません (dataId missing)');
    return;
  }

  // Service Worker から初期データを取得
  const response = await sendMessage('GET_INIT_DATA', { dataId });
  if (!response || !response.fileList || response.fileList.length === 0) {
    showError('再生できる動画がありません');
    return;
  }

  state.fileList = response.fileList;
  state.currentIndex = response.currentIndex || 0;
  state.currentPrefix = response.currentPrefix || '';
  state.parentPrefix = response.parentPrefix || '';

  log('Init:', state.fileList.length, 'videos, start idx=', state.currentIndex);

  // フォルダナビゲーションの初期化（siblings は Phase 2 以降）
  state.siblings = [];

  bindUI();
  loadVideo(state.currentIndex);
}

// ============================================================
// 動画読み込み
// ============================================================
async function loadVideo(index) {
  if (index < 0 || index >= state.fileList.length) return;

  const item = state.fileList[index];
  state.currentIndex = index;

  showLoading('読み込み中...');
  hideError();

  // 既存の動画を停止・解放
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.load();

  const url = await getPresignedUrl(item.bucket, item.key, item.region);
  if (!url) {
    showError('Presigned URL の生成に失敗しました');
    updateUI();
    return;
  }

  // イベントハンドラは src 設定前にセット（同期発火を逃さない）
  videoEl.onloadeddata = () => {
    hideLoading();
    hideError();
    updateUI();
    log('Loaded:', item.filename);
  };
  videoEl.onerror = () => {
    const mediaError = videoEl.error;
    hideLoading();
    showError(`動画を読み込めませんでした (${mediaError ? mediaError.message : 'unknown error'})`);
    updateUI();
  };
  videoEl.onended = () => {
    // 自動的に次の動画へ
    if (state.currentIndex < state.fileList.length - 1) {
      loadVideo(state.currentIndex + 1);
    }
  };

  videoEl.src = url;
  videoEl.play().catch((err) => {
    // ユーザー操作が必要な場合がある（autoplayポリシー）
    log('play() failed:', err.message);
    // controls があるのでユーザーが手動再生可能
  });

  updateUI();
}

// ============================================================
// PresignedURL 取得（SW経由 content.js に委譲）
// ============================================================
async function getPresignedUrl(bucket, key, region) {
  const cacheKey = `${bucket}/${key}`;
  if (state.presignedUrlCache.has(cacheKey)) {
    return state.presignedUrlCache.get(cacheKey);
  }

  const response = await sendMessage('GET_PRESIGNED_URL', { bucket, key, region });
  const url = response ? response.url : null;
  if (url) {
    state.presignedUrlCache.set(cacheKey, url);
  }
  return url;
}

// ============================================================
// メッセージ送信（SW→content.js）
// ============================================================
function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        warn('sendMessage error:', chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      resolve(response ? response.payload : null);
    });
  });
}

// ============================================================
// ナビゲーション
// ============================================================
function navigatePrev() {
  if (state.currentIndex > 0) {
    loadVideo(state.currentIndex - 1);
  }
}

function navigateNext() {
  if (state.currentIndex < state.fileList.length - 1) {
    loadVideo(state.currentIndex + 1);
  }
}

// ============================================================
// UI更新
// ============================================================
function updateUI() {
  const item = state.fileList[state.currentIndex];
  if (!item) return;

  // タイトルバー
  $('titlebar-filename').textContent = item.filename;

  // ファイル名表示（コントロールバー）
  $('filenameDisplay').textContent = item.filename;
  $('filenameDisplay').title = item.filename;

  // ポジション表示
  $('position').textContent = `${state.currentIndex + 1} / ${state.fileList.length}`;

  // ナビゲーションボタン状態
  $('prevBtn').disabled = state.currentIndex <= 0;
  $('nextBtn').disabled = state.currentIndex >= state.fileList.length - 1;

  // フォルダナビゲーションボタン（Phase 2で有効化）
  $('prevFolderBtn').disabled = true;
  $('nextFolderBtn').disabled = true;

  // プレイリスト更新
  updatePlaylist();
}

function updatePlaylist() {
  const list = $('playlist');
  const empty = $('playlist-empty');
  list.innerHTML = '';

  if (state.fileList.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  state.fileList.forEach((item, idx) => {
    const li = document.createElement('li');
    if (idx === state.currentIndex) li.className = 'active';

    const idxSpan = document.createElement('span');
    idxSpan.className = 'pl-index';
    idxSpan.textContent = String(idx + 1);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'pl-filename';
    nameSpan.textContent = item.filename;

    li.appendChild(idxSpan);
    li.appendChild(nameSpan);

    li.addEventListener('click', () => {
      if (idx !== state.currentIndex) {
        loadVideo(idx);
      }
    });

    list.appendChild(li);
  });
}

// ============================================================
// オーバーレイ制御
// ============================================================
function showLoading(text) {
  $('loading-text').textContent = text || '読み込み中...';
  loadingEl.classList.remove('hidden');
}

function hideLoading() {
  loadingEl.classList.add('hidden');
}

function showError(msg) {
  errorTextEl.textContent = msg || '動画を読み込めませんでした';
  errorEl.classList.remove('hidden');
}

function hideError() {
  errorEl.classList.add('hidden');
}

// ============================================================
// プレイリストトグル
// ============================================================
function togglePlaylist() {
  state.playlistVisible = !state.playlistVisible;
  $('playlistPanel').classList.toggle('hidden', !state.playlistVisible);
  $('playlistToggle').style.opacity = state.playlistVisible ? '1' : '';
}

// ============================================================
// イベントバインディング
// ============================================================
function bindUI() {
  // 閉じる
  $('closeBtn').addEventListener('click', () => window.close());

  // ナビゲーション
  $('prevBtn').addEventListener('click', navigatePrev);
  $('nextBtn').addEventListener('click', navigateNext);
  // フォルダナビゲーションは Phase 2 で実装予定
  $('prevFolderBtn').addEventListener('click', () => {});
  $('nextFolderBtn').addEventListener('click', () => {});

  // プレイリスト
  $('playlistToggle').addEventListener('click', togglePlaylist);

  // リトライ
  $('retryBtn').addEventListener('click', () => {
    loadVideo(state.currentIndex);
  });

  // キーボード
  document.addEventListener('keydown', onKeydown);
}

// ============================================================
// キーボードショートカット
// ============================================================
function onKeydown(e) {
  // テキスト入力中はスキップ
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case 'Escape':
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        window.close();
      }
      break;
    case 'ArrowLeft':
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        navigatePrev();
      }
      break;
    case 'ArrowRight':
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        navigateNext();
      }
      break;
    case 'p':
    case 'P':
      togglePlaylist();
      break;
    case 'f':
    case 'F':
      if (videoEl.requestFullscreen) {
        videoEl.requestFullscreen().catch(() => {});
      }
      break;
  }
}

// ============================================================
// 起動
// ============================================================
document.addEventListener('DOMContentLoaded', init);
