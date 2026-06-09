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
      videoClickAction: 'popup',
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

  /**
   * 現在のテーブル行から画像/動画ファイル一覧を構築
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
    wrapper.className = 'e2c-thumb-wrapper';
    wrapper.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:${settings.thumbSize + 20}px;min-width:${settings.thumbSize + 20}px;position:relative;vertical-align:middle;padding:2px 4px;`;

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
      // 仮想スクロール対策: クリック時にDOMから現在のファイル名を再取得
      const row = wrapper.closest('.e2c-tb-rw');
      const currentFilename = row ? getFilename(row) : filename;

      // --- 動画: ポップアップビューアー or 新規タブ ---
      if (isVideo) {
        if (settings.videoClickAction === 'popup') {
          // 動画一覧を構築して Service Worker 経由でポップアップを開く
          const videoList = buildFileList().filter(item => item.isVideo);
          const vIdx = videoList.findIndex(
            item => item.filename === currentFilename && item.bucket === bucket
          );
          chrome.runtime.sendMessage({
            type: 'PLAY_VIDEO',
            payload: {
              fileList: videoList,
              currentIndex: vIdx >= 0 ? vIdx : 0,
              currentPrefix: prefix || '',
              parentPrefix: getParentPrefix(prefix || ''),
            }
          });
          return;
        }
        // 'newtab' の場合は後続の共通処理へ
      }

      // --- 画像 または 動画(newtab): PresignedURL取得 → 表示 ---
      const objKey = (prefix || '') + currentFilename;
      const url = await getPresignedUrl(bucket, objKey, region);
      if (!url) return;

      if (settings.clickAction === 'newtab') {
        window.open(url, '_blank');
      } else {
        overlayState.fileList = buildFileList();
        const currentIdx = overlayState.fileList.findIndex(
          item => item.filename === currentFilename && item.bucket === bucket
        );
        overlayState.currentIndex = currentIdx >= 0 ? currentIdx : 0;
        showOverlay(url, currentFilename, isVideo, overlayState.currentIndex);
      }
    });

    // 少し遅延して読み込み
    setTimeout(loadThumbnail, 100);
    return wrapper;
  }

  // ============================================================
  // HEIC/HEIF 非対応形式検出
  // ============================================================
  const unsupportedImageExts = new Set(['.heic', '.heif']);
  function isUnsupportedImage(filename) {
    const ext = getExtension(filename);
    return unsupportedImageExts.has(ext);
  }

  function createUnsupportedImageFallback(filename, url) {
    const container = document.createElement('div');
    container.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px;text-align:center;width:100%;`;

    // まずは「読み込み中」状態
    const loadingEl = document.createElement('div');
    loadingEl.textContent = '⏳';
    loadingEl.style.cssText = `font-size:32px;opacity:0.5;`;
    container.appendChild(loadingEl);

    // Async: サムネイルを試す
    (async () => {
      const { bucket, prefix } = parseURL();
      const s3Region = settings.s3Region || regionToEndpoint(parseURL().region);
      const thumbKey = (prefix || '') + CONFIG.thumbDir + '/' + filename + CONFIG.thumbSuffix;

      const thumbUrl = await getPresignedUrl(bucket, thumbKey, s3Region);

      if (thumbUrl) {
        // ✅ サムネイル取得成功 → 画像表示
        container.innerHTML = '';

        const img = document.createElement('img');
        img.src = thumbUrl;
        img.style.cssText = `max-width:85vw;max-height:75vh;object-fit:contain;border-radius:8px;cursor:default;`;
        img.loading = 'lazy';

        const label = document.createElement('div');
        label.textContent = '💡 サムネイル表示（.heic形式のため元画像のプレビューです）';
        label.style.cssText = `color:#999;font-size:12px;margin-top:4px;`;

        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.textContent = '🔗 元ファイルを開く（ダウンロード）';
        link.style.cssText = `color:#64b5f6;font-size:13px;text-decoration:none;padding:6px 14px;border:1px solid #64b5f6;border-radius:6px;cursor:pointer;transition:background 0.15s;margin-top:4px;`;
        link.addEventListener('mouseenter', () => { link.style.background = 'rgba(100,181,246,0.1)'; });
        link.addEventListener('mouseleave', () => { link.style.background = 'transparent'; });
        link.addEventListener('click', (e) => { e.stopPropagation(); });

        container.append(img, label, link);

      } else {
        // ❌ サムネイルなし → 従来のフォールバック
        container.innerHTML = '';

        const icon = document.createElement('div');
        icon.textContent = '🖼️';
        icon.style.cssText = `font-size:48px;opacity:0.5;`;

        const msg = document.createElement('div');
        msg.textContent = 'この画像形式 (.heic/.heif) はブラウザで表示できません';
        msg.style.cssText = `color:#aaa;font-size:14px;`;

        const hint = document.createElement('div');
        hint.textContent = 'ダウンロードして対応アプリで開いてください';
        hint.style.cssText = `color:#777;font-size:12px;`;

        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.textContent = '🔗 新規タブで開く (ダウンロード)';
        link.style.cssText = `color:#64b5f6;font-size:14px;text-decoration:none;padding:8px 16px;border:1px solid #64b5f6;border-radius:6px;cursor:pointer;transition:background 0.15s;`;
        link.addEventListener('mouseenter', () => { link.style.background = 'rgba(100,181,246,0.1)'; });
        link.addEventListener('mouseleave', () => { link.style.background = 'transparent'; });
        link.addEventListener('click', (e) => { e.stopPropagation(); });

        container.append(icon, msg, hint, link);
      }
    })();

    return container;
  }

  // ============================================================
  // オーバーレイ（ナビゲーション対応）
  // ============================================================
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
    } else if (isUnsupportedImage(filename)) {
      mediaEl = createUnsupportedImageFallback(filename, url);
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
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeOverlay();
        document.removeEventListener('keydown', onOverlayKeydown);
      }
    });
    document.addEventListener('keydown', onOverlayKeydown);

    updateNavButtons();
  }

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

  function updateOverlayContent(url, filename, isVideo) {
    const content = overlayState.overlayEl?.querySelector('.e2c-overlay-content');
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
    } else if (isUnsupportedImage(filename)) {
      newMedia = createUnsupportedImageFallback(filename, url);
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

  function getParentPrefix(prefix) {
    if (!prefix || prefix === '') return '';
    const withoutTrailing = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    const lastSlash = withoutTrailing.lastIndexOf('/');
    if (lastSlash < 0) return '';
    return withoutTrailing.slice(0, lastSlash + 1);
  }

  function updateURLPrefix(newPrefix) {
    const url = new URL(window.location.href);
    if (newPrefix) {
      url.searchParams.set('prefix', newPrefix);
    } else {
      url.searchParams.delete('prefix');
    }
    window.history.pushState({}, '', url.toString());
    processedRows = new WeakSet();
    setTimeout(processAllRows, 500);
  }

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

  // ============================================================
  // 行処理
  // ============================================================

  /**
   * 行内のファイル名列 (e2c-os-name) 内のアイコン要素を特定する
   * IDrive e2 の行構造（実際のDOM検証で確認）:
   *   div.e2c-check-container               — チェックボックス
   *   div.e2c-td.e2c-os-name                 — ファイル名列
   *     span.e2c-sts-image/e2c-sts-video     ← これがファイル種別アイコン（クラス名はファイル種別により異なる）
   *     (ファイル名テキスト)
   *   div.e2c-td.e2c-os-size                 — サイズ列
   *   div.e2c-td.e2c-os-mdf                  — 更新日列
   *   div.e2c-td.e2c-ut-action               — アクション列
   *
   * ※独立したアイコンセルは存在しない。アイコンは e2c-os-name 内の span 要素。
   *
   * @param {Element} row - div.e2c-tb-rw 要素
   * @returns {{iconEl: Element|null, nameCell: Element|null}} アイコン要素とファイル名セル
   */
  function findOrigIconElements(row) {
    const nameCell = row.querySelector('div.e2c-os-name');
    if (!nameCell) return { iconEl: null, nameCell: null };
    // e2c-os-name 内のアイコン要素（ファイル種別によって e2c-sts-image / e2c-sts-video 等）
    const iconEl = nameCell.querySelector('[class^="e2c-sts-"]');
    return { iconEl, nameCell };
  }

  function processRow(row) {
    if (processedRows.has(row)) {
      log('processRow: SKIP - already processed');
      return;
    }
    processedRows.add(row);

    const filename = getFilename(row);
    log('processRow: filename?', filename);
    if (!filename) {
      log('processRow: filename is null/empty, row HTML:', row.innerHTML.slice(0, 200));
      return;
    }

    // 仮想スクロール対応: 既存のサムネイルが正しいファイル名かを確認
    const existingWrapper = row.querySelector('.e2c-thumb-wrapper');
    if (existingWrapper) {
      const img = existingWrapper.querySelector('img');
      if (img && img.alt === filename) {
        log('processRow: SKIP - thumbnail already matches', filename);
        return;
      }
      log('processRow: REMOVE stale thumbnail (was', img?.alt, ', now', filename + ')');
      existingWrapper.remove();
    }

    const ext = getExtension(filename);
    const isImage = CONFIG.imageExts.has(ext);
    const isVideo = CONFIG.videoExts.has(ext);
    log('processRow: ext=', ext, 'isImage=', isImage, 'isVideo=', isVideo);

    // ファイル名列とアイコン要素を取得（stale復元と新規挿入で使い回す）
    const { iconEl, nameCell } = findOrigIconElements(row);

    // ★★★ フォルダ行（e2c-sts-folder）はスキップ ★★★
    // IDrive e2 の .ts フォルダ（サムネイル格納用）は拡張子が .ts で
    // videoExts にマッチするが、フォルダなので処理しない（Issue #41）
    if (iconEl && iconEl.classList.contains('e2c-sts-folder')) {
      // 以前の処理で nameCell に設定したスタイルをクリーンアップ
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
      // 古いサムネイルwrapperが行の子として残っている場合は除去
      const staleWrapper = row.querySelector(':scope > .e2c-thumb-wrapper');
      if (staleWrapper) staleWrapper.remove();
      log('processRow: SKIP - folder, not a file');
      return;
    }

    if (!isImage && !isVideo) {
      // ★★★ 常にアイコン非表示クラスを削除 ★★★
      // SPA遷移後やフォルダ変更時は全wrapperが削除済みで existingWrapper が null でも
      // 以前画像/動画だった行の e2c-icon-image-hidden が残っている可能性がある
      if (iconEl) {
        iconEl.classList.remove('e2c-icon-image-hidden');
      }
      // ★★★ 以前設定した flex スタイルをクリア ★★★
      // 仮想スクロールで行が再利用された際、前の行のスタイルが残ると
      // 非画像行のレイアウトが崩れる（Issue #52）
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
      // 古いサムネイルwrapperが行の子として残っている場合は除去
      const staleWrapper = row.querySelector(':scope > .e2c-thumb-wrapper');
      if (staleWrapper) staleWrapper.remove();
      log('processRow: SKIP - not image/video');
      return;
    }

    log('processRow: adding thumbnail for', filename, '(ext:', ext, ')');

    const { region, bucket, prefix } = parseURL();
    const thumbEl = createThumbnailElement(filename, ext, isVideo, bucket, prefix, region);

    if (iconEl && nameCell) {
      // 元のアイコン画像を非表示（テキストは残す）
      iconEl.classList.add('e2c-icon-image-hidden');

      // ★★★ flex でセル内のコンテンツを中央揃え ★★★
      // セル高さは後続のheight強制で行に固定されるため、
      // display:flex にしても縮まない。align-items:center で
      // サムネイルとテキストを確実に垂直中央揃えする（Issue #42）。
      nameCell.style.display = 'flex';
      nameCell.style.alignItems = 'center';
      nameCell.style.gap = '4px';
      // アイコンspanのpaddingはCSSで除去済み。念のためセル自体のpaddingもリセット。
      nameCell.style.paddingTop = '0';
      nameCell.style.paddingBottom = '0';
      // サムネイルを先頭（左）に挿入 → [サムネイル, テキスト] の順
      // ★ iconElがnameCell直下にいない場合（旧.e2c-thumb-flex内など）は先に移動
      if (iconEl.parentNode !== nameCell) {
        nameCell.appendChild(iconEl); // nameCell直下に移動
      }
      nameCell.insertBefore(thumbEl, iconEl);

      // 旧バージョンの .e2c-thumb-flex が残っている場合は除去
      const oldFlex = nameCell.querySelector('.e2c-thumb-flex');
      if (oldFlex && oldFlex.parentNode === nameCell) {
        oldFlex.remove();
      }

      // ★★★ Issue #42: セル高さを行に一致させる ★★★
      // CDK Virtual Scroll が行に固定高さを設定している一方、
      // アイコンspanの元CSSがセルを押し広げることがある（例: セル82px > 行60px）。
      // 行の設定高さ（または実測値）を取得し、セルを同じ高さに制限する。
      // parseInt(row.style.height) を優先: CDKのインラインスタイル値を直接読み、
      // offsetHeight（border含む）の誤差を回避する。
      const rowHeight = parseInt(row.style.height) || row.offsetHeight;
      if (rowHeight > 0) {
        nameCell.style.height = rowHeight + 'px';
        nameCell.style.maxHeight = rowHeight + 'px';
        nameCell.style.overflow = 'hidden';
        nameCell.style.boxSizing = 'border-box';
      }
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

    // 仮想スクロール対策: スクロール時にサムネイルの再チェック
    const scrollTarget = target.tagName === 'CDK-VIRTUAL-SCROLL-VIEWPORT' ? target : target.querySelector('cdk-virtual-scroll-viewport');
    if (scrollTarget) {
      let scrollTimeout;
      scrollTarget.addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(processAllRows, 300);
      }, { passive: true });
    }
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
        initFolderNavigation();
      } else {
        setTimeout(waitForTable, 500);
      }
    };
    setTimeout(waitForTable, 1500);
  }

  // URL変更検知（SPA遷移対応）
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      processedRows = new WeakSet();
      presignedUrlCache = new Map();
      // 既存のサムネイル要素をすべて削除（古いprefixの画像が残る問題対策）
      document.querySelectorAll('.e2c-thumb-wrapper').forEach(el => el.remove());
      setTimeout(processAllRows, 1000);
    }
  }, 2000);

  // 仮想スクロール定期チェック: 2秒ごとに全行のサムネイル一致確認
  // cdk-virtual-scroll-viewport は DOM 行を再利用するため、イベント検出が困難
  // processRow 内の img.alt === filename 照合により、正しい行は即座にスキップされる
  setInterval(() => {
    if (s3Ready) {
      processedRows = new WeakSet();
      processAllRows();
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

  // ============================================================
  // Service Worker からのメッセージ受信（ポップアップビューアーからの委譲）
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {

      case 'GET_PRESIGNED_URL': {
        const { bucket, key, region } = msg.payload;
        log('GET_PRESIGNED_URL: bucket=', bucket, 'key=', key, 'region=', region, 's3Ready=', s3Ready);
        getPresignedUrl(bucket, key, region).then(url => {
          log('GET_PRESIGNED_URL RESULT: url=', url ? url.slice(0, 60) + '...' : 'null');
          sendResponse({ type: 'PRESIGNED_URL', payload: { url } });
        }).catch(err => {
          log('GET_PRESIGNED_URL ERROR:', err.message);
          sendResponse({ type: 'PRESIGNED_URL', payload: { url: null } });
        });
        return true; // async
      }

      case 'LIST_OBJECTS': {
        const { bucket, prefix, region } = msg.payload;
        log('LIST_OBJECTS: bucket=', bucket, 'prefix=', prefix, 'region=', region);
        fetchFolderSiblings(bucket, region, prefix).then(prefixes => {
          log('LIST_OBJECTS RESULT: prefixes=', prefixes);
          sendResponse({ type: 'LIST_OBJECTS_RESULT', payload: { prefixes } });
        });
        return true; // async
      }

      default:
        return false;
    }
  });

  init();

  // popstate イベント対応：ブラウザの戻る/進むでフォルダ状態をリセット
  window.addEventListener('popstate', () => {
    folderState.history = [];
    folderState.siblings = [];
    folderState.currentSiblingIndex = -1;
  });
})();
