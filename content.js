// IDrive e2 サムネイルビューアー - Content Script v2.0
// ページの既存のS3Clientを利用してPreSignedURLを生成
(function () {
  'use strict';

  const DEBUG = true;  // ← デバッグログON
  const log = DEBUG ? console.log.bind(console, '[IDriveThumb]') : () => {};

  // ============================================================
  // 設定
  // ============================================================
  const CONFIG = {
    thumbDir: '.ts',
    thumbSuffix: '.jpg',
    imageExts: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif']),
    videoExts: new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.3gp', '.wmv', '.flv', '.ts']),
    playButtonEmoji: '▶',
    defaults: {
      clickAction: 'overlay',
      thumbSize: 40,
      accessKeyId: '',
      secretAccessKey: '',
      s3Region: 'ap-northeast-1',
    }
  };

  let settings = { ...CONFIG.defaults };
  let observer = null;
  let processedRows = new WeakSet();
  let presignedUrlCache = new Map();
  let s3Ready = false;

  // 現在のオーバーレイ状態
  let overlayState = {
    overlayEl: null,
    currentIndex: -1,
    fileList: [],
    isPlayingVideo: false,
    videoEl: null,
  };

  // フォルダナビゲーション状態
  let folderState = {
    history: [],
    currentPrefix: '',
    siblings: [],
    currentSiblingIndex: -1,
  };

  // ============================================================
  // 設定読み込み
  // ============================================================
  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(CONFIG.defaults);
      settings = { ...CONFIG.defaults, ...result };
      s3Ready = !!(settings.accessKeyId && settings.secretAccessKey);
      log('Settings loaded: s3Ready=', s3Ready, 'region=', settings.s3Region,
          'ak=', settings.accessKeyId ? settings.accessKeyId.slice(0,5)+'...' : '(empty)');
    } catch (e) {
      log('Settings load error:', e);
    }
  }

  // ============================================================
  // URL解析
  // ============================================================
  function parseURL() {
    const url = new URL(window.location.href);
    const pathParts = url.pathname.split('/');
    const regionIdx = pathParts.indexOf('region');
    const bucketIdx = pathParts.indexOf('buckets');
    const region = regionIdx >= 0 ? pathParts[regionIdx + 1] : 'TYO';
    const bucket = bucketIdx >= 0 ? pathParts[bucketIdx + 1] : '';
    const prefix = url.searchParams.get('prefix') || '';
    return { region, bucket, prefix };
  }

  function regionToEndpoint(region) {
    const regionMap = {
      'TYO': 'ap-northeast-1',
      'IAD': 'us-east-1',
      'FRA': 'eu-central-1',
      'LHR': 'eu-west-2',
      'SGP': 'ap-southeast-1',
      'SYD': 'ap-southeast-2',
    };
    return regionMap[region] || region.toLowerCase();
  }

  function getFilename(row) {
    const nameDiv = row.querySelector('div.e2c-os-name');
    if (!nameDiv) return null;
    const span = nameDiv.querySelector('span');
    if (!span) return null;
    const title = span.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return span.textContent.trim();
  }

  function getExtension(filename) {
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx < 0) return '';
    return filename.slice(dotIdx).toLowerCase();
  }

  // ============================================================
  // XML パース（CommonPrefixes抽出）
  // ============================================================
  /**
   * ListObjectsV2 XML レスポンスから CommonPrefixes（フォルダ）を抽出
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
    return prefixes;
  }

  // ============================================================
  // PreSignedURL 生成（SigV4）
  // ============================================================
  async function getPresignedUrl(bucket, key, region) {
    if (!s3Ready) { log('getPresignedUrl: s3 not ready'); return null; }
    const cacheKey = `${bucket}/${key}`;
    if (presignedUrlCache.has(cacheKey)) {
      log('getPresignedUrl: cache HIT for', cacheKey);
      return presignedUrlCache.get(cacheKey);
    }

    try {
      const s3Region = settings.s3Region || regionToEndpoint(region);
      log('getPresignedUrl: generating for', cacheKey, 'region=', s3Region);
      const url = await window.E2C_S3.getPresignedUrl({
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        region: s3Region,
        bucket: bucket,
        key: key,
        expiresIn: 604800  // 7日
      });
      if (url) {
        presignedUrlCache.set(cacheKey, url);
        log('getPresignedUrl: SUCCESS', url.slice(0, 80) + '...');
      } else {
        log('getPresignedUrl: FAILED - returned null');
      }
      return url;
    } catch (e) {
      log('getPresignedUrl: ERROR', e.message || e);
      return null;
    }
  }

  // ============================================================
  // List用 PresignedURL 生成ラッパー
  // ============================================================
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
        expiresIn: 300,
      });
      return url;
    } catch (e) {
      log('getListPresignedUrl ERROR:', e.message || e);
      return null;
    }
  }

  // ============================================================
  // フォルダ一覧取得（ListObjects V2）
  // ============================================================
  /**
   * ListObjects API を呼び、指定 parentPrefix 下のフォルダ（CommonPrefixes）一覧を取得
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
        return [];
      }
      const xml = await resp.text();
      const prefixes = parseCommonPrefixes(xml);
      return prefixes;
    } catch (e) {
      log('fetchFolderSiblings FETCH ERROR:', e.message);
      return [];
    }
  }

  // ============================================================
  // サムネイル要素
  // ============================================================
  function createThumbnailElement(filename, ext, isVideo, bucket, prefix, region) {
    const wrapper = document.createElement('div');
    wrapper.className = 'e2c-td e2c-thumb-wrapper';
    wrapper.style.cssText = `width:${settings.thumbSize + 20}px;min-width:${settings.thumbSize + 20}px;display:flex;align-items:center;justify-content:center;position:relative;padding:2px 4px;`;

    const img = document.createElement('img');
    img.className = 'e2c-thumb-img';
    img.style.cssText = `width:${settings.thumbSize}px;height:${settings.thumbSize}px;object-fit:cover;border-radius:4px;cursor:pointer;background:#f0f0f0;`;
    img.loading = 'lazy';
    img.alt = filename;

    // PresignedURL を生成して表示
    const thumbKey = (prefix || '') + CONFIG.thumbDir + '/' + filename + CONFIG.thumbSuffix;
    const objKey = (prefix || '') + filename;

    log('--- Thumbnail for:', filename, '---');
    log('  prefix:', prefix);
    log('  bucket:', bucket);
    log('  region:', region);
    log('  thumbKey:', thumbKey);
    log('  objKey:', objKey);
    log('  ext:', ext);
    log('  isVideo:', isVideo);
    log('  s3Ready:', s3Ready);

    async function loadThumbnail() {
      log('loadThumbnail: thumbKey=', thumbKey);
      const url = await getPresignedUrl(bucket, thumbKey, region);
      if (url) {
        log('loadThumbnail: setting img.src');
        img.src = url;
        img.onerror = async () => {
          log('loadThumbnail: IMG ONERROR - checking why...');
          // fetch でエラーの詳細を取得
          try {
            const resp = await fetch(url);
            log('loadThumbnail: fetch status:', resp.status, resp.statusText);
            const text = await resp.text().catch(() => '(cannot read)');
            log('loadThumbnail: error XML:', text.slice(0, 500));
          } catch(e) {
            log('loadThumbnail: fetch also failed:', e.message);
          }
          log('loadThumbnail: trying objKey as fallback...');
          getPresignedUrl(bucket, objKey, region).then(fullUrl => {
            if (fullUrl) {
              log('loadThumbnail: fallback to objKey SUCCESS');
              img.src = fullUrl;
              img.onerror = () => {
                log('loadThumbnail: fallback img onerror too');
                showFallback();
              };
            } else {
              log('loadThumbnail: fallback to objKey FAILED');
              showFallback();
            }
          });
        };
        img.onload = () => log('loadThumbnail: image loaded OK');
      } else {
        log('loadThumbnail: no URL returned from getPresignedUrl');
        showFallback();
      }
    }

    function showFallback() {
      img.style.display = 'none';
      const icon = document.createElement('span');
      icon.className = 'e2c-thumb-fallback';
      icon.textContent = isVideo ? '🎬' : '🖼️';
      icon.style.cssText = `font-size:${settings.thumbSize * 0.5}px;opacity:0.5;cursor:pointer;`;
      wrapper.appendChild(icon);
    }

    // 動画再生ボタン
    if (isVideo) {
      const playBtn = document.createElement('div');
      playBtn.className = 'e2c-play-btn';
      playBtn.textContent = CONFIG.playButtonEmoji;
      playBtn.style.cssText = `position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:${settings.thumbSize * 0.4}px;color:white;text-shadow:0 1px 3px rgba(0,0,0,0.6);pointer-events:none;opacity:0.9;`;
      wrapper.appendChild(playBtn);
    }

    wrapper.appendChild(img);

    // クリック
    wrapper.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = await getPresignedUrl(bucket, objKey, region);
      if (!url) return;
      if (settings.clickAction === 'newtab') {
        window.open(url, '_blank');
      } else {
        showOverlay(url, filename, isVideo);
      }
    });

    // 少し遅延して読み込み
    setTimeout(loadThumbnail, 100);
    return wrapper;
  }

  // ============================================================
  // オーバーレイ
  // ============================================================
  function showOverlay(url, filename, isVideo) {
    const existing = document.getElementById('e2c-thumb-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'e2c-thumb-overlay';
    overlay.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:999999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;`;

    const content = document.createElement('div');
    content.style.cssText = `max-width:90vw;max-height:90vh;position:relative;`;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `position:absolute;top:-40px;right:0;background:none;border:none;color:white;font-size:28px;cursor:pointer;z-index:10;`;

    const title = document.createElement('div');
    title.textContent = filename;
    title.style.cssText = `position:absolute;bottom:-30px;left:0;color:#ccc;font-size:14px;`;

    if (isVideo) {
      const video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.autoplay = true;
      video.style.cssText = `max-width:90vw;max-height:85vh;border-radius:8px;`;
      content.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = url;
      img.style.cssText = `max-width:90vw;max-height:85vh;object-fit:contain;border-radius:8px;`;
      img.onerror = () => { img.alt = '⛔ 画像を読み込めません'; img.style.width = '200px'; img.style.height = '200px'; };
      content.appendChild(img);
    }

    content.appendChild(closeBtn);
    content.appendChild(title);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, { once: true });
  }

  // ============================================================
  // 行処理
  // ============================================================
  function processRow(row) {
    if (processedRows.has(row)) {
      log('processRow: SKIP - already processed');
      return;
    }
    processedRows.add(row);
    if (row.querySelector('.e2c-thumb-wrapper')) {
      log('processRow: SKIP - already has thumbnail wrapper');
      return;
    }

    const filename = getFilename(row);
    log('processRow: filename?', filename);
    if (!filename) {
      log('processRow: filename is null/empty, row HTML:', row.innerHTML.slice(0, 200));
      return;
    }

    const ext = getExtension(filename);
    const isImage = CONFIG.imageExts.has(ext);
    const isVideo = CONFIG.videoExts.has(ext);
    log('processRow: ext=', ext, 'isImage=', isImage, 'isVideo=', isVideo);
    if (!isImage && !isVideo) {
      log('processRow: SKIP - not image/video');
      return;
    }

    log('processRow: adding thumbnail for', filename, '(ext:', ext, ')');

    const { region, bucket, prefix } = parseURL();
    const thumbEl = createThumbnailElement(filename, ext, isVideo, bucket, prefix, region);

    const checkContainer = row.querySelector('.e2c-check-container');
    if (checkContainer && checkContainer.nextSibling) {
      row.insertBefore(thumbEl, checkContainer.nextSibling);
    } else {
      row.insertBefore(thumbEl, row.firstChild);
    }
  }

  function processAllRows() {
    if (!s3Ready) {
      log('processAllRows: SKIP - s3 not ready (access keys not set)');
      return;
    }
    const rows = document.querySelectorAll('div.e2c-tb-rw');
    log('processAllRows: found', rows.length, 'rows');
    rows.forEach(processRow);
  }

  // ============================================================
  // MutationObserver
  // ============================================================
  function startObserver() {
    if (observer) observer.disconnect();
    const target = document.querySelector('cdk-virtual-scroll-viewport') ||
                   document.querySelector('.e2c-tb-bdy') ||
                   document.querySelector('.e2c-table');
    if (!target) { setTimeout(startObserver, 1000); return; }
    observer = new MutationObserver(() => processAllRows());
    observer.observe(target, { childList: true, subtree: true });
    processAllRows();
  }

  // ============================================================
  // 初期化
  // ============================================================
  async function init() {
    await loadSettings();

    if (!s3Ready) {
      // アクセスキー未設定の場合はポップアップで設定を促す
      console.info('[IDrive Thumbnail] 設定画面でアクセスキーを設定してください');
      return;
    }

    const waitForTable = () => {
      if (document.querySelector('.e2c-table')) {
        startObserver();
      } else {
        setTimeout(waitForTable, 500);
      }
    };
    setTimeout(waitForTable, 1500);
  }

  // URL変更検知
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      processedRows = new WeakSet();
      setTimeout(processAllRows, 1000);
    }
  }, 2000);

  // 設定変更をリスン
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.accessKeyId || changes.secretAccessKey || changes.s3Region) {
      loadSettings().then(() => {
        presignedUrlCache = new Map();
        processAllRows();
      });
    }
  });

  init();
})();
