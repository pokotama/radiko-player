// radiko プレイヤー（スマホ用 PWA）
// PC の Chrome 拡張機能が Google ドライブへ上げた録音を再生し、
// 再生位置をドライブ上の同期ファイルでやり取りする。

const CLIENT_ID = "2927916612-nsqr58e6lp0c15sqo1unuiciqnh7s6r8.apps.googleusercontent.com";
// スコープは drive（読み書き）。
// 拡張機能が上げたファイルや手動で置いたファイルを読むには drive.file では不足で、
// かつ再生位置の同期ファイルへ書き込む必要があるため。
const SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_NAME = "RadikoRecordings";
const SYNC_FILENAME = "radiko-sync.json";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DEVICE = "phone";

const statusEl = document.querySelector("#status");
const listEl = document.querySelector("#list");
const signInButton = document.querySelector("#signInButton");
const playerEl = document.querySelector("#player");
const playerTitle = document.querySelector("#playerTitle");
const audio = document.querySelector("#audio");
const playButton = document.querySelector("#playButton");
const seek = document.querySelector("#seek");
const currentTimeEl = document.querySelector("#currentTime");
const durationTimeEl = document.querySelector("#durationTime");
const rate = document.querySelector("#rate");
const rateOut = document.querySelector("#rateOut");

let accessToken = null;
let tokenClient = null;
let files = [];
let positions = {};
let syncFileId = null;
let current = null; // { file, key, objectUrl }
let lastSaved = 0;

// ---------- 表示ユーティリティ ----------

function setStatus(text, tone = "ready") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00";
  }
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function formatDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) {
    return "";
  }
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) {
    return "";
  }
  return n < 1024 * 1024
    ? `${Math.round(n / 1024)} KB`
    : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- 認証 ----------

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: async (res) => {
      if (res.error) {
        setStatus(`ログインに失敗しました: ${res.error}`, "error");
        return;
      }
      accessToken = res.access_token;
      sessionStorage.setItem("token", accessToken);
      signInButton.textContent = "再ログイン";
      await loadAll();
    },
  });

  const saved = sessionStorage.getItem("token");
  if (saved) {
    accessToken = saved;
    loadAll().catch(() => requestToken());
  }
}

function requestToken() {
  if (!tokenClient) {
    setStatus("認証を初期化できませんでした。通信環境を確認してください。", "error");
    return;
  }
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
}

// ---------- Drive API ----------

async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (res.status === 401) {
    accessToken = null;
    sessionStorage.removeItem("token");
    throw new Error("認証の有効期限が切れました。ログインし直してください。");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive API エラー (${res.status}) ${text.slice(0, 120)}`);
  }
  return res;
}

async function findFolderId() {
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const res = await api(`${DRIVE_API}/files?q=${q}&fields=files(id)`);
  const json = await res.json();
  return json.files?.[0]?.id || null;
}

async function listFiles() {
  const folderId = await findFolderId();
  if (!folderId) {
    return [];
  }
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const res = await api(
    `${DRIVE_API}/files?q=${q}&fields=files(id,name,size,mimeType,modifiedTime,appProperties)&pageSize=200`,
  );
  const json = await res.json();
  // 同期用JSONと、音声以外のファイルは除外する。
  return (json.files || []).filter(
    (f) =>
      f.name !== SYNC_FILENAME &&
      f.mimeType !== "application/vnd.google-apps.folder" &&
      !f.name.endsWith(".json"),
  );
}

async function loadPositions() {
  const q = encodeURIComponent(`name='${SYNC_FILENAME}' and trashed=false`);
  const res = await api(`${DRIVE_API}/files?q=${q}&fields=files(id)`);
  const json = await res.json();
  syncFileId = json.files?.[0]?.id || null;
  if (!syncFileId) {
    positions = {};
    return;
  }
  const data = await api(`${DRIVE_API}/files/${syncFileId}?alt=media`);
  const parsed = await data.json().catch(() => ({}));
  positions = parsed?.positions || {};
}

async function savePositions() {
  const body = JSON.stringify({ positions });
  if (syncFileId) {
    await api(`${DRIVE_UPLOAD_API}/files/${syncFileId}?uploadType=media`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return;
  }
  const folderId = await findFolderId();
  const boundary = `b${Date.now()}`;
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: SYNC_FILENAME, parents: folderId ? [folderId] : [] }) +
    `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
    body +
    `\r\n--${boundary}--`;
  const res = await api(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  const json = await res.json();
  syncFileId = json.id;
}

// ---------- 端末内キャッシュ（オフライン再生用） ----------

const DB_NAME = "radiko-player";
const STORE = "audio";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(fileId) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(fileId);
    tx.onsuccess = () => resolve(tx.result || null);
    tx.onerror = () => resolve(null);
  });
}

async function putCached(fileId, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(blob, fileId);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteCached(fileId) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(fileId);
    tx.onsuccess = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function cachedIds() {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
    tx.onsuccess = () => resolve(new Set(tx.result || []));
    tx.onerror = () => resolve(new Set());
  });
}

// ---------- 一覧 ----------

function syncKeyOf(file) {
  // 拡張機能側と同じキー。なければファイル名で代用する。
  return file.appProperties?.syncKey || `name:${file.name}`;
}

// ファイル名「番組名_YYYYMMDD.webm」から番組名と放送日を取り出す。
// （手動でドライブに置いたファイル用のフォールバック）
function parseFilename(name) {
  const base = name.replace(/\.[^.]+$/, "");
  const m = /^(.*)_(\d{4})(\d{2})(\d{2})$/.exec(base);
  if (!m) {
    return { title: base, broadcastAt: 0 };
  }
  const [, title, y, mo, d] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T00:00:00+09:00`);
  return { title: title || base, broadcastAt: Number.isFinite(ms) ? ms : 0 };
}

function titleOf(file) {
  return file.appProperties?.title || parseFilename(file.name).title;
}

function broadcastOf(file) {
  const v = file.appProperties?.broadcastAt;
  if (v) {
    return Number(v);
  }
  return parseFilename(file.name).broadcastAt;
}

async function renderList() {
  const cached = await cachedIds();
  listEl.innerHTML = "";

  if (files.length === 0) {
    listEl.innerHTML = '<p class="card">録音がまだありません。</p>';
    return;
  }

  const sorted = [...files].sort((a, b) => {
    const ab = broadcastOf(a) || Date.parse(a.modifiedTime);
    const bb = broadcastOf(b) || Date.parse(b.modifiedTime);
    return bb - ab;
  });

  for (const file of sorted) {
    const key = syncKeyOf(file);
    const pos = positions[key]?.position || 0;
    const duration = Number(file.appProperties?.duration || 0) / 1000;
    const isCached = cached.has(file.id);

    const card = document.createElement("article");
    card.className = "card";
    if (current?.file.id === file.id) {
      card.classList.add("playing");
    }

    const title = document.createElement("p");
    title.className = "card-title";
    title.textContent = titleOf(file);
    card.append(title);

    const detail = document.createElement("p");
    detail.className = "card-detail";
    const parts = [];
    const bd = formatDate(broadcastOf(file));
    if (bd) parts.push(`放送 ${bd}`);
    if (duration > 0) parts.push(formatTime(duration));
    parts.push(formatSize(file.size));
    detail.textContent = parts.join(" / ");
    card.append(detail);

    if (pos > 0 && duration > 0) {
      const bar = document.createElement("div");
      bar.className = "progress-bar";
      const fill = document.createElement("span");
      fill.style.width = `${Math.min(100, (pos / duration) * 100)}%`;
      bar.append(fill);
      card.append(bar);

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent =
        pos >= duration - 2 ? "聞き終わりました" : `続き ${formatTime(pos)} から`;
      card.append(badge);
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";

    const playBtn = document.createElement("button");
    playBtn.className = "primary";
    playBtn.textContent = isCached ? "再生" : "再生（ストリーミング）";
    playBtn.addEventListener("click", () => playFile(file));
    actions.append(playBtn);

    const dlBtn = document.createElement("button");
    dlBtn.textContent = isCached ? "端末から削除" : "ダウンロード";
    dlBtn.addEventListener("click", async () => {
      dlBtn.disabled = true;
      try {
        if (isCached) {
          await deleteCached(file.id);
          setStatus("端末から削除しました。");
        } else {
          dlBtn.textContent = "取得中...";
          const blob = await fetchFileBlob(file);
          await putCached(file.id, blob);
          setStatus(`「${titleOf(file)}」を端末に保存しました。オフラインで聴けます。`);
        }
        await renderList();
      } catch (error) {
        setStatus(error.message, "error");
        dlBtn.disabled = false;
      }
    });
    actions.append(dlBtn);

    card.append(actions);
    listEl.append(card);
  }
}

async function fetchFileBlob(file) {
  const res = await api(`${DRIVE_API}/files/${file.id}?alt=media`);
  return res.blob();
}

// ---------- 再生 ----------

async function playFile(file) {
  try {
    setStatus("読み込んでいます...");
    const key = syncKeyOf(file);

    let blob = await getCached(file.id);
    if (!blob) {
      blob = await fetchFileBlob(file);
    }

    if (current?.objectUrl) {
      URL.revokeObjectURL(current.objectUrl);
    }
    const objectUrl = URL.createObjectURL(blob);
    current = { file, key, objectUrl };

    audio.src = objectUrl;
    playerTitle.textContent = titleOf(file);
    playerEl.hidden = false;

    const saved = positions[key]?.position || 0;
    audio.addEventListener(
      "loadedmetadata",
      () => {
        const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (saved > 0 && (!dur || saved < dur - 1)) {
          audio.currentTime = saved;
        }
        syncSeekUi();
      },
      { once: true },
    );

    await audio.play();
    setStatus(`再生中: ${titleOf(file)}`);
    updateMediaSession(file);
    await renderList();
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function syncSeekUi() {
  const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const pos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  seek.max = String(dur);
  seek.value = String(Math.min(pos, dur || pos));
  currentTimeEl.textContent = formatTime(pos);
  durationTimeEl.textContent = formatTime(dur);
}

async function savePosition(force = false) {
  if (!current) {
    return;
  }
  const now = Date.now();
  if (!force && now - lastSaved < 10000) {
    return;
  }
  lastSaved = now;
  positions[current.key] = {
    position: audio.currentTime || 0,
    updatedAt: now,
    device: DEVICE,
  };
  try {
    await savePositions();
  } catch (_e) {
    // オフラインなら次回に回す。
  }
}

// 車のハンドルや通知領域から操作できるようにする。
function updateMediaSession(file) {
  if (!("mediaSession" in navigator)) {
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: titleOf(file),
    artist: "radiko",
  });
  navigator.mediaSession.setActionHandler("play", () => audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", () => seekBy(30));
  navigator.mediaSession.setActionHandler("previoustrack", () => seekBy(-15));
  navigator.mediaSession.setActionHandler("seekforward", (d) => seekBy(d?.seekOffset || 30));
  navigator.mediaSession.setActionHandler("seekbackward", (d) => seekBy(-(d?.seekOffset || 15)));
}

function seekBy(sec) {
  const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
  audio.currentTime = Math.min(Math.max(audio.currentTime + sec, 0), dur || audio.currentTime);
  syncSeekUi();
  savePosition(true);
}

audio.addEventListener("timeupdate", () => {
  syncSeekUi();
  if (!audio.paused) {
    savePosition(false);
  }
});
audio.addEventListener("play", () => {
  playButton.textContent = "一時停止";
});
audio.addEventListener("pause", () => {
  playButton.textContent = "再生";
  savePosition(true);
});
audio.addEventListener("ended", () => {
  playButton.textContent = "再生";
  // 聞き終わった印として終端を残す。
  if (current) {
    positions[current.key] = {
      position: Number.isFinite(audio.duration) ? audio.duration : audio.currentTime,
      updatedAt: Date.now(),
      device: DEVICE,
    };
    savePositions().catch(() => {});
  }
  renderList();
});

playButton.addEventListener("click", () => {
  if (audio.paused) {
    audio.play();
  } else {
    audio.pause();
  }
});

seek.addEventListener("input", () => {
  audio.currentTime = Number(seek.value);
  syncSeekUi();
});
seek.addEventListener("change", () => savePosition(true));

document.querySelectorAll(".skip").forEach((btn) => {
  btn.addEventListener("click", () => seekBy(Number(btn.dataset.skip)));
});

rate.addEventListener("input", () => {
  audio.playbackRate = Number(rate.value);
  rateOut.textContent = `${Number(rate.value).toFixed(2)}x`;
  localStorage.setItem("rate", rate.value);
});

// 画面を閉じる直前に位置を確定保存する。
window.addEventListener("pagehide", () => savePosition(true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    savePosition(true);
  }
});

// ---------- 起動 ----------

async function loadAll() {
  setStatus("読み込んでいます...");
  try {
    files = await listFiles();
    await loadPositions();
    await renderList();
    setStatus(`${files.length} 件の録音があります。`);
  } catch (error) {
    setStatus(error.message, "error");
    throw error;
  }
}

signInButton.addEventListener("click", requestToken);

const savedRate = localStorage.getItem("rate");
if (savedRate) {
  rate.value = savedRate;
  audio.playbackRate = Number(savedRate);
  rateOut.textContent = `${Number(savedRate).toFixed(2)}x`;
}

// Google のライブラリ読み込み後に初期化する。
const gsi = document.createElement("script");
gsi.src = "https://accounts.google.com/gsi/client";
gsi.async = true;
gsi.onload = initAuth;
gsi.onerror = () => setStatus("Googleの認証ライブラリを読み込めませんでした。", "error");
document.head.append(gsi);
