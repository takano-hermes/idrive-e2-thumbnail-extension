// IDrive e2 サムネイルビューアー - Service Worker v1.0
// 責務: メッセージ中継、ポップアップウィンドウ生成
'use strict';

// ============================================================
// DEBUG
// ============================================================
const DEBUG = false; // デバッグログON/OFF
const log = DEBUG ? console.log.bind(console, '[SW]') : () => {};
const warn = DEBUG ? console.warn.bind(console, '[SW]') : () => {};

// ============================================================
// プレイヤーウィンドウの初期データストア
// content.js → PLAY_VIDEO で保存 → player.html が GET_INIT_DATA で取得
// ============================================================
const pendingPlayerData = new Map();
let dataIdCounter = 0;

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
      log('Creating player window, dataId=' + dataId);

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
        log('Player window created: id=' + win.id);
      });

      sendResponse({ type: 'PLAY_VIDEO_ACK', payload: { dataId } });
      return true; // async
    }

    // --- player.html → SW: 初期データ要求 ---
    case 'GET_INIT_DATA': {
      const data = pendingPlayerData.get(msg.payload.dataId);
      if (data) {
        pendingPlayerData.delete(msg.payload.dataId);
        log('GET_INIT_DATA: found, fileList.length=', data.fileList.length);
      } else {
        warn('GET_INIT_DATA: dataId not found:', msg.payload.dataId);
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
      warn('Unknown message type:', msg.type);
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
      warn('No console tab found');
      sendResponse(null);
      return;
    }

    // 最もアクティブなコンソールタブを選ぶ
    const target = tabs.find(t => t.active) || tabs[0];
    log('Forwarding', msg.type, 'to tab', target.id);

    chrome.tabs.sendMessage(target.id, msg, (response) => {
      if (chrome.runtime.lastError) {
        warn('Forward error:', chrome.runtime.lastError.message);
        sendResponse(null);
        return;
      }
      sendResponse(response);
    });
  });
}

log('Service Worker initialized');
