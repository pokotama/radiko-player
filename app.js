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
const downloadAllButton = document.querySelector("#downloadAllButton");
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

// トークンは localStorage に有効期限と一緒に残す。
// （sessionStorage だとアプリを閉じるたびにログインが必要になる）
function saveToken(token, expiresIn) {
  accessToken = token;
  const expiry = Date.now() + (Number(expiresIn) || 3600) * 1000 - 60000;
  localStorage.setItem("token", token);
  localStorage.setItem("tokenExpiry", String(expiry));
}

function loadSavedToken() {
  const token = localStorage.getItem("token");
  const expiry = Number(localStorage.getItem("tokenExpiry") || 0);
  if (token && Date.now() < expiry) {
    accessToken = token;
    return true;
  }
  return false;
}

function clearToken() {
  accessToken = null;
  localStorage.removeItem("token");
  localStorage.removeItem("tokenExpiry");
}

function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: async (res) => {
      if (res.error) {
        // 無言での取得に失敗しただけ。オフライン表示のまま使える。
        signInButton.hidden = false;
        return;
      }
      saveToken(res.access_token, res.expires_in);
      signInButton.textContent = "再ログイン";
      await loadAll();
    },
  });

  if (loadSavedToken()) {
    loadAll().catch(() => silentSignIn());
    return;
  }
  // 一度許可済みなら、画面を出さずに取り直せることが多い。
  silentSignIn();
}

function silentSignIn() {
  if (!tokenClient) {
    return;
  }
  tokenClient.requestAccessToken({ prompt: "" });
}

function requestToken() {
  if (!tokenClient) {
    setStatus("認証を初期化できませんでした。通信環境を確認してください。", "error");
    return;
  }
  tokenClient.requestAccessToken({ prompt: "consent" });
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
    clearToken();
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
    playBtn.textContent = isCached ? "再生" : "ダウンロードして再生";
    playBtn.addEventListener("click", async () => {
      if (isCached) {
        playFile(file);
        return;
      }
      // 未ダウンロードなら先に端末へ保存してから再生する。
      playBtn.disabled = true;
      try {
        await downloadFile(file, playBtn);
        await renderList();
        playFile(file);
      } catch (error) {
        setStatus(error.message, "error");
        playBtn.disabled = false;
        playBtn.textContent = "ダウンロードして再生";
      }
    });
    actions.append(playBtn);

    const dlBtn = document.createElement("button");
    dlBtn.textContent = isCached ? "端末から削除" : "ダウンロードのみ";
    dlBtn.addEventListener("click", async () => {
      dlBtn.disabled = true;
      try {
        if (isCached) {
          await deleteCached(file.id);
          setStatus("端末から削除しました。");
        } else {
          await downloadFile(file, dlBtn);
        }
        await renderList();
      } catch (error) {
        setStatus(error.message, "error");
        dlBtn.disabled = false;
      }
    });
    actions.append(dlBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    // 未ログインだとドライブを触れないので、押せないことを明示する。
    if (!accessToken) {
      delBtn.textContent = "削除（要ログイン）";
      delBtn.disabled = true;
      delBtn.title = "ドライブからの削除にはログインが必要です。端末から消すだけなら「端末から削除」を使ってください。";
      actions.append(delBtn);
      card.append(actions);
      listEl.append(card);
      continue;
    }
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        `「${titleOf(file)}」を削除します。\nGoogleドライブから消え、他の端末でも聞けなくなります。\n（ドライブのゴミ箱から復元できます）よろしいですか？`,
      );
      if (!ok) {
        return;
      }
      delBtn.disabled = true;
      delBtn.textContent = "削除中...";
      try {
        await deleteFile(file);
        setStatus("削除しました。");
        await renderList();
      } catch (error) {
        setStatus(error.message, "error");
        delBtn.disabled = false;
        delBtn.textContent = "削除";
      }
    });
    actions.append(delBtn);

    card.append(actions);
    listEl.append(card);
  }
}

// ファイルを取得する。大きいので進捗を返せるようにしている。
async function fetchFileBlob(file, onProgress) {
  const res = await api(`${DRIVE_API}/files/${file.id}?alt=media`);
  const total = Number(file.size) || 0;

  if (!res.body || !onProgress || !total) {
    return res.blob();
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }

  return new Blob(chunks, { type: file.mimeType || "audio/webm" });
}

// 端末へ保存する。進捗をボタンに出す。
async function downloadFile(file, button) {
  const blob = await fetchFileBlob(file, (received, total) => {
    const percent = Math.floor((received / total) * 100);
    if (button) {
      button.textContent = `${percent}%`;
    }
    setStatus(`「${titleOf(file)}」を取得中... ${percent}%`);
  });
  await putCached(file.id, blob);
  setStatus(`「${titleOf(file)}」を端末に保存しました。オフラインで聴けます。`);
}

// ドライブから削除する（ゴミ箱へ移すので復元可能）。
// あわせて再生位置の記録と端末内のキャッシュも消す。
async function deleteFile(file) {
  await api(`${DRIVE_API}/files/${file.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });

  const key = syncKeyOf(file);
  if (key in positions) {
    delete positions[key];
    await savePositions().catch(() => {});
  }

  await deleteCached(file.id);

  // 再生中のものを消したら止める。
  if (current?.file.id === file.id) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    if (current.objectUrl) {
      URL.revokeObjectURL(current.objectUrl);
    }
    current = null;
    playerEl.hidden = true;
  }

  files = files.filter((f) => f.id !== file.id);
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
      async () => {
        // 実際の長さを確定させてから位置を戻す。
        await resolveRealDuration();
        const dur = getDuration();
        if (saved > 0) {
          audio.currentTime = dur > 0 ? Math.min(saved, dur) : saved;
        } else {
          audio.currentTime = 0;
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

// MediaRecorder が作る webm は長さのメタデータを持たず、duration が Infinity になる。
// そのままだとシークできないので、一度終端へシークして実際の長さを確定させる。
function resolveRealDuration() {
  return new Promise((resolve) => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      audio.removeEventListener("durationchange", onChange);
      resolve();
    };

    const onChange = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        audio.currentTime = 0;
        finish();
      }
    };

    audio.addEventListener("durationchange", onChange);
    try {
      audio.currentTime = 1e101;
    } catch (_e) {
      finish();
    }
    setTimeout(finish, 5000);
  });
}

// 再生時間。取れなければドライブに記録された録音時間を使う。
function getDuration() {
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    return audio.duration;
  }
  const fallback = Number(current?.file?.appProperties?.duration || 0) / 1000;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function syncSeekUi() {
  const dur = getDuration();
  const pos = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const clamped = dur > 0 ? Math.min(Math.max(pos, 0), dur) : 0;
  seek.max = String(dur);
  seek.value = String(clamped);
  currentTimeEl.textContent = formatTime(clamped);
  durationTimeEl.textContent = formatTime(dur);
}

// オフライン時は再生位置を手元にだけ残し、次につながったとき送る。
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
  localStorage.setItem("positionsCache", JSON.stringify(positions));
  if (!accessToken) {
    return;
  }
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
  navigator.mediaSession.setActionHandler("previoustrack", () => seekBy(-10));
  navigator.mediaSession.setActionHandler("seekforward", (d) => seekBy(d?.seekOffset || 30));
  navigator.mediaSession.setActionHandler("seekbackward", (d) => seekBy(-(d?.seekOffset || 10)));
}

function seekBy(sec) {
  const dur = getDuration();
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
      position: getDuration() || audio.currentTime,
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
    // オフライン時に一覧を出せるよう、手元にも控えを残す。
    localStorage.setItem("filesCache", JSON.stringify(files));
    localStorage.setItem("positionsCache", JSON.stringify(positions));
    await renderList();
    setStatus(`${files.length} 件の録音があります。`);
  } catch (error) {
    // 通信や認証がだめでも、ダウンロード済みの番組は聴けるようにする。
    await loadOffline(error);
    throw error;
  }
}

// 保存済みの情報だけで一覧を組み立てる（ログイン不要）。
async function loadOffline(error) {
  try {
    const cachedFiles = JSON.parse(localStorage.getItem("filesCache") || "[]");
    positions = JSON.parse(localStorage.getItem("positionsCache") || "{}");
    const cached = await cachedIds();
    // 端末に入っているものだけ表示する。
    files = cachedFiles.filter((f) => cached.has(f.id));
    await renderList();

    if (files.length > 0) {
      setStatus(`オフライン表示です。ダウンロード済みの ${files.length} 件を聴けます。`);
    } else {
      setStatus(`ログインすると番組一覧を取得できます。(${error?.message || "未ログイン"})`);
    }
  } catch (_e) {
    setStatus("ログインしてください。", "error");
  }
}

signInButton.addEventListener("click", requestToken);

// 出かける前にまとめて落としておくためのボタン。
downloadAllButton.addEventListener("click", async () => {
  downloadAllButton.disabled = true;
  const original = downloadAllButton.textContent;

  try {
    const cached = await cachedIds();
    const targets = files.filter((f) => !cached.has(f.id));

    if (targets.length === 0) {
      setStatus("すべて端末に保存済みです。");
      return;
    }

    let done = 0;
    let failed = 0;

    for (const file of targets) {
      downloadAllButton.textContent = `保存中 (${done + failed + 1}/${targets.length})`;
      try {
        await downloadFile(file, null);
        done += 1;
      } catch (_e) {
        failed += 1;
      }
    }

    await renderList();
    setStatus(
      failed === 0
        ? `${done} 件を端末に保存しました。オフラインで聴けます。`
        : `${done} 件成功、${failed} 件失敗しました。`,
      failed === 0 ? "ready" : "error",
    );
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    downloadAllButton.disabled = false;
    downloadAllButton.textContent = original;
  }
});

const savedRate = localStorage.getItem("rate");
if (savedRate) {
  rate.value = savedRate;
  audio.playbackRate = Number(savedRate);
  rateOut.textContent = `${Number(savedRate).toFixed(2)}x`;
}

// Google のライブラリ読み込み後に初期化する。
// 先にオフライン分を出しておき、ログインが通ったら差し替える。
loadOffline().catch(() => {});

const gsi = document.createElement("script");
gsi.src = "https://accounts.google.com/gsi/client";
gsi.async = true;
gsi.onload = initAuth;
gsi.onerror = () => {
  setStatus("オフラインです。ダウンロード済みの番組は聴けます。");
};
document.head.append(gsi);
