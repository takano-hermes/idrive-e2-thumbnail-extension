// IDrive e2 サムネイルビューアー - Popup Script v1.1
(function() {
  const DEFAULTS = {
    clickAction: 'overlay',
    thumbSize: 40,
    accessKeyId: '',
    secretAccessKey: '',
    s3Region: 'ap-northeast-1',
  };

  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(DEFAULTS);
      document.getElementById('accessKeyId').value = result.accessKeyId || '';
      document.getElementById('secretAccessKey').value = result.secretAccessKey || '';
      document.getElementById('s3Region').value = result.s3Region || 'ap-northeast-1';
      document.getElementById('clickAction').value = result.clickAction;
      document.getElementById('thumbSize').value = result.thumbSize;
    } catch (e) {}
  }

  async function saveSettings() {
    const settings = {
      accessKeyId: document.getElementById('accessKeyId').value.trim(),
      secretAccessKey: document.getElementById('secretAccessKey').value.trim(),
      s3Region: document.getElementById('s3Region').value,
      clickAction: document.getElementById('clickAction').value,
      thumbSize: parseInt(document.getElementById('thumbSize').value, 10) || 40,
    };

    const status = document.getElementById('status');

    if (!settings.accessKeyId || !settings.secretAccessKey) {
      status.textContent = '⚠️ Access Key と Secret Key を入力してください';
      status.className = 'status err';
      return;
    }

    try {
      await chrome.storage.sync.set(settings);
      status.textContent = '✅ 保存しました！ページをリロードしてください';
      status.className = 'status ok';
      setTimeout(() => { status.textContent = ''; status.className = 'status'; }, 3000);
    } catch (e) {
      status.textContent = '❌ 保存に失敗しました: ' + e.message;
      status.className = 'status err';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
  });
})();
