// IDrive e2 サムネイルビューアー - Service Worker v1.0
// 責務: メッセージ中継、ポップアップウィンドウ生成

'use strict';

// ============================================================
// プレイヤーウィンドウの初期データストア
// content.js → PLAY_VIDEO で保存 → player.html が GET_INIT_DATA で取得
// ============================================================
const pendingPlayerData = new Map();
let dataIdCounter = 0;

// ============================================================
// 開いているプレイヤーウィンドウの管理
// ============================================================
const openPlayers = new Map(); // windowId -> tabId

// ============================================================
// メッセージハンドラ
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // --- content.js → SW: 動画再生リクエスト ---
    case 'PLAY_VIDEO': {
      const dataId = String(++dataIdCounter);
      pendingPlayerData.set(dataId, msg.payload);

      const playerUrl = chrome.runtime.getURL('player.html?dataId=' + dataId);
      console.log('[SW] Creating player window, dataId=' + dataId);

      chrome.windows.create({
        url: playerUrl,
        type: 'popup',
        width: 960,
        height: 640,
        focused: true,
      }, (win) => {
        if (chrome.runtime.lastError) {
          console.error('[SW] window.create error:', chrome.runtime.lastError);
          pendingPlayerData.delete(dataId);
          return;
        }
        console.log('[SW] Player window created: id=' + win.id);
      });

      sendResponse({ type: 'PLAY_VIDEO_ACK', payload: { dataId } });
      return true; // async
    }

    // --- player.html → SW: 初期データ要求 ---
    case 'GET_INIT_DATA': {
      const data = pendingPlayerData.get(msg.payload.dataId);
      if (data) {
        pendingPlayerData.delete(msg.payload.dataId);
        console.log('[SW] GET_INIT_DATA: found, fileList.length=', data.fileList.length);
      } else {
        console.warn('[SW] GET_INIT_DATA: dataId not found:', msg.payload.dataId);
      }
      sendResponse({ type: 'INIT_DATA', payload: data || null });
      return true;
    }

    // --- player.html → SW → content.js: PresignedURL要求 ---
    case 'GET_PRESIGNED_URL': {
      forwardToContent(msg, sendResponse);
      return true; // async
    }

    // --- player.html → SW → content.js: ListObjects要求 ---
    case 'LIST_OBJECTS': {
      forwardToContent(msg, sendResponse);
      return true; // async
    }

    default:
      console.warn('[SW] Unknown message type:', msg.type);
      sendResponse(null);
      return false;
  }
});

// ============================================================
// content.js へのメッセージ転送
// ============================================================
function forwardToContent(msg, sendResponse) {
  chrome.tabs.query({ url: 'https://console.idrivee2.com/*' }, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error('[SW] tabs.query error:', chrome.runtime.lastError);
      sendResponse(null);
      return;
    }
    if (!tabs || tabs.length === 0) {
      console.warn('[SW] No console tab found');
      sendResponse(null);
      return;
    }

    // 最もアクティブなコンソールタブを選ぶ
    const target = tabs.find(t => t.active) || tabs[0];
    console.log('[SW] Forwarding', msg.type, 'to tab', target.id);

    chrome.tabs.sendMessage(target.id, msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[SW] Forward error:', chrome.runtime.lastError.message);
        sendResponse(null);
        return;
      }
      sendResponse(response);
    });
  });
}

// ============================================================
// ウィンドウ削除検知（クリーンアップ用）
// ============================================================
chrome.windows.onRemoved.addListener((windowId) => {
  if (openPlayers.has(windowId)) {
    openPlayers.delete(windowId);
    console.log('[SW] Player window closed:', windowId);
  }
});

console.log('[SW] Service Worker initialized');
