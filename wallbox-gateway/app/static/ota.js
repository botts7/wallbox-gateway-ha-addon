// OTA upload UI. Drag-and-drop or file-picker accepts a single
// firmware.bin. We then POST it to /api/ota/upload via XHR (NOT
// fetch — fetch has no native upload-progress event).

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileInfo = document.getElementById('file-info');
const uploadBtn = document.getElementById('upload-btn');
const progressEl = document.getElementById('progress');
const barFill = document.getElementById('bar-fill');
const progressText = document.getElementById('progress-text');
const resultOk = document.getElementById('result-ok');
const resultErr = document.getElementById('result-err');

let selectedFile = null;

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function pickFile(file) {
  // Cheap validation. Server does the real magic-byte check.
  if (!file) return;
  if (file.size === 0) {
    showErr('That file is empty.');
    return;
  }
  if (file.size < 200 * 1024) {
    showErr('That looks too small for a firmware.bin (' + fmtBytes(file.size) + '). Expected ~1.3 MB.');
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    showErr('That looks too large for a firmware.bin (' + fmtBytes(file.size) + '). The OTA partition is ~2 MB.');
    return;
  }
  selectedFile = file;
  fileInfo.textContent = file.name + ' · ' + fmtBytes(file.size);
  fileInfo.hidden = false;
  uploadBtn.disabled = false;
  resultOk.hidden = true;
  resultErr.hidden = true;
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));

['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.add('drag');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => {
    e.preventDefault();
    dropZone.classList.remove('drag');
  });
});
dropZone.addEventListener('drop', e => {
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files[0]) pickFile(dt.files[0]);
});

function showOk(msg) {
  resultOk.textContent = msg;
  resultOk.hidden = false;
  resultErr.hidden = true;
}
function showErr(msg) {
  resultErr.textContent = msg;
  resultErr.hidden = false;
  resultOk.hidden = true;
}

uploadBtn.addEventListener('click', () => {
  if (!selectedFile) return;
  uploadBtn.disabled = true;
  resultOk.hidden = true;
  resultErr.hidden = true;
  progressEl.hidden = false;
  barFill.style.width = '0%';
  progressText.textContent = '0%';

  const fd = new FormData();
  fd.append('firmware', selectedFile, selectedFile.name);

  const xhr = new XMLHttpRequest();
  // Relative path under HA Supervisor ingress — see dashboard.js note.
  xhr.open('POST', 'api/ota/upload');
  xhr.upload.onprogress = ev => {
    if (!ev.lengthComputable) return;
    const pct = (ev.loaded / ev.total * 100);
    barFill.style.width = pct.toFixed(1) + '%';
    progressText.textContent =
      pct.toFixed(0) + '% — ' + fmtBytes(ev.loaded) + ' / ' + fmtBytes(ev.total);
  };
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
    if (xhr.status === 200 && body.ok) {
      showOk('Upload OK — gateway is rebooting into the new firmware. ' +
             fmtBytes(body.bytes || 0) + ' (MD5 ' + (body.md5 || '?') + '). ' +
             'Wait ~30 seconds, then reload the dashboard.');
    } else {
      const detail = body.detail || body.body || xhr.responseText || '(no detail)';
      showErr('Upload failed (HTTP ' + xhr.status + '): ' + detail);
    }
    uploadBtn.disabled = false;
  };
  xhr.onerror = () => {
    showErr('Network error during upload. Is the gateway reachable from the Add-on container?');
    uploadBtn.disabled = false;
  };
  xhr.send(fd);
});

// Hide the form entirely if no gateway is configured.
fetch('api/addon/config').then(r => r.json()).then(c => {
  if (!c.configured) {
    document.getElementById('not-configured').hidden = false;
    document.querySelectorAll('.card').forEach(el => {
      if (el.id !== 'not-configured') el.style.display = 'none';
    });
  }
});
