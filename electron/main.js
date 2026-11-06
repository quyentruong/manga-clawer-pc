const electron = require('electron');
if (typeof electron === 'string') {
  // Chạy trong môi trường có ELECTRON_RUN_AS_NODE=1 (như terminal tích hợp của IDE)
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, process.argv.slice(1), {
    stdio: 'inherit',
    env,
  });
  child.on('close', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code || 0);
  });
  return;
}

const fs = require('fs');
const { app, BrowserWindow, session, shell } = electron;
const path = require('path');

function loadProjectEnvFile() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!key) continue;
      if (typeof process.env[key] === 'undefined' || process.env[key] === '') {
        process.env[key] = value;
      }
    }
  } catch {
    /* ignore env parsing errors */
  }
}

loadProjectEnvFile();

// Check and try to install sharp on Windows if missing
const { tryInstallSharpForWindows } = require('./lib/shared/checkSharp');
const brandingStorage = require('./lib/platform/storage/brandingStorage');
app.whenReady().then(async () => {
  // Bỏ Electron/xxx và manga-crawler/xxx khỏi User-Agent mặc định để tránh bị chặn bởi Cloudflare
  app.userAgentFallback = session.defaultSession.getUserAgent()
    .replace(/Electron\/\S+\s?/, '')
    .replace(/manga-crawler\/\S+\s?/, '');

  if (process.platform === 'win32') {
    await tryInstallSharpForWindows();
  }
});

// Allow HTML5 Audio (chat beep) without a prior user gesture — desktop app, not a random website.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const { getImageRefererForUrl } = require('./lib/download/connector/connectorReferer');
const {
  normalizeChapterFolderFormat,
} = require('./lib/shared/mangaUtils');
const { resolveMangaDir } = require('./lib/download/connector/connectorPathUtils');
const { registerAllIpc } = require('./ipc');

/**
 * Gốc thư mục truyện: ưu tiên đường dẫn tuyệt đối (offline) nếu hợp lệ, không thì Save To + tên.
 */
function resolveMangaRootForRead(baseSaveDir, mangaTitle, offlineMangaDirAbsolute) {
  const absRaw = String(offlineMangaDirAbsolute || '').trim();
  if (absRaw) {
    try {
      const r = path.resolve(absRaw);
      if (fs.existsSync(r)) {
        const st = fs.statSync(r);
        if (st.isDirectory()) return r;
      }
    } catch {
      /* fall through */
    }
  }
  const base = String(baseSaveDir || '').trim();
  const mt = String(mangaTitle || '').trim();
  if (!base || !mt) return null;
  return resolveMangaDir(base, mt);
}

/** Ảnh CDN cần Referer = domain connector (Java: connector.getDomain() khi download). */
function registerConnectorImageRefererHeaders() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const ref = getImageRefererForUrl(details.url);
    if (ref) {
      callback({
        requestHeaders: {
          ...details.requestHeaders,
          Referer: ref,
        },
      });
      return;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

const connectors = require('./lib/platform/connectors');
const googleAuth = require('./lib/auth/googleAuthService');

const cookieManager = require('./lib/platform/cookies/cookieManager');

// Inject connector registry into cookieManager to break circular dependency
cookieManager.setRegistry(connectors);

/** Renderer gửi khi bấm Dừng — downloadChapter kiểm tra giữa các trang. */
let mangaDownloadAbortRequested = false;

const isDev = !app.isPackaged;

let mainWindow = null;
let membershipValidateIntervalId = null;
let membershipFocusDebounceId = null;

/** Thư mục giải nén CBZ tạm (dưới temp); dọn khi mở CBZ khác hoặc renderer gọi release.
 *  Còn dùng cho các định dạng khác (ZIP/RAR/EPUB/PDF/MOBI) vẫn cần extract thật. */
let lastCbzTempExtractDir = null;

/** Active CBZ session id (see electron/lib/reader/cbzSessionService.js).
 *  Khi mở CBZ mới, session cũ được close để giải phóng file handle + bộ nhớ. */
let lastCbzSessionId = null;

/** Active PDF session id (see electron/lib/reader/pdfSessionService.js).
 *  Tương tự CBZ: chỉ giữ 1 file đang đọc, mở file mới là đóng cái cũ. */
let lastPdfSessionId = null;

/** Đóng mọi session reader (CBZ + PDF) đang sống — dùng trước khi mở file mới. */
function closeActiveReaderSessions() {
  if (lastCbzSessionId) {
    try {
      require('./lib/reader/cbzSessionService').closeSession(lastCbzSessionId);
    } catch { /* */ }
    lastCbzSessionId = null;
  }
  if (lastPdfSessionId) {
    try {
      require('./lib/reader/pdfSessionService').closeSession(lastPdfSessionId);
    } catch { /* */ }
    lastPdfSessionId = null;
  }
}

function getCbzTempRoot() {
  return path.join(app.getPath('temp'), 'manga-crawler-cbz');
}

function isAllowedCbzTempPath(dir) {
  const root = path.resolve(getCbzTempRoot());
  const child = path.resolve(String(dir || '').trim());
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Để export PDF/CBZ/EPUB từ một CBZ đang mở dưới dạng session, ta cần file
 * thật trên đĩa — materialize các chương được chọn vào temp dir, rồi để
 * caller chạy export như đang đọc một thư mục offline bình thường. Caller
 * phải gọi `cleanup()` sau khi xong (hoặc khi lỗi).
 *
 * Trả `{ ok:true, materialized:false, dir, cleanup }` khi `absoluteMangaDir`
 * không phải session URI — caller cứ truyền `dir` vào pipeline cũ.
 *
 * @param {string} absoluteMangaDir
 * @param {Array<{folderBasename?: string, title?: string}>} chapters
 * @param {(folderBasename: string, done: number, total: number) => void} [onProgress]
 */
async function materializeIfSession(absoluteMangaDir, chapters, onProgress) {
  const cbzSession = require('./lib/reader/cbzSessionService');
  const pdfSession = require('./lib/reader/pdfSessionService');

  // Chọn service phù hợp dựa theo URI; nếu không phải session thì trả nguyên dir.
  const sessionMod = cbzSession.isSessionUri(absoluteMangaDir)
    ? cbzSession
    : pdfSession.isSessionUri(absoluteMangaDir)
      ? pdfSession
      : null;
  if (!sessionMod) {
    return {
      ok: true,
      materialized: false,
      dir: String(absoluteMangaDir || ''),
      cleanup: async () => { },
    };
  }
  const sid = sessionMod.sessionIdFromUri(absoluteMangaDir);
  const session = sessionMod.getSession(sid);
  if (!session) {
    return { ok: false, error: 'Phiên đã đóng. Hãy mở lại file.' };
  }

  const tempRoot = path.join(
    getCbzTempRoot(),
    `export-${Date.now()}-${require('crypto').randomBytes(4).toString('hex')}`,
  );
  await fs.promises.mkdir(tempRoot, { recursive: true });

  // Danh sách chương cần materialize:
  //   - CBZ session: từ `chapters` truyền vào, hoặc toàn bộ session khi rỗng.
  //   - PDF session: luôn là chương ảo duy nhất `_pdf_pages`.
  let targets;
  if (sessionMod === pdfSession) {
    targets = [{ folderBasename: pdfSession.PDF_PAGES_FOLDER }];
  } else {
    targets = Array.isArray(chapters) && chapters.length > 0
      ? chapters
      : [...session.chaptersMap.keys()].map((fb) => ({ folderBasename: fb }));
  }
  const total = targets.length;
  let done = 0;

  for (const ch of targets) {
    const fb = String(ch?.folderBasename || '').trim();
    if (!fb) continue;
    if (
      sessionMod === cbzSession &&
      !session.chaptersMap.has(fb)
    ) {
      continue;
    }
    const destDir = path.join(tempRoot, fb);
    const res = await sessionMod.materializeChapter(sid, fb, destDir);
    if (!res.ok) {
      try { await fs.promises.rm(tempRoot, { recursive: true, force: true }); } catch { /* */ }
      return { ok: false, error: res.error || 'Không trích xuất được chương.' };
    }
    done += 1;
    if (onProgress) onProgress(fb, done, total);
  }

  return {
    ok: true,
    materialized: true,
    dir: tempRoot,
    cleanup: async () => {
      try { await fs.promises.rm(tempRoot, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

function broadcastSessionInvalidated(reason) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('auth:sessionInvalidated', { reason });
  }
}

async function runMembershipValidationAndNotify() {
  try {
    const r = await googleAuth.validateMembershipSession(app.getPath('userData'));
    if (!r.ok && r.reason) {
      broadcastSessionInvalidated(r.reason);
    }
  } catch {
    /* ignore */
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(partial) {
  const next = { ...readSettings(), ...partial };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
}

function getChapterFolderSettings() {
  const s = readSettings();
  return normalizeChapterFolderFormat({
    mode: s.chapterFolderMode,
    prefix: s.chapterFolderPrefix,
    padDigits: s.chapterFolderPadDigits,
    layout: s.chapterFolderLayout,
  });
}

/** Thư mục mặc định: <Downloads của OS>/Manga — đa nền tảng qua Electron (Windows, macOS, Linux). */
function getDefaultMangaSaveDir() {
  return path.join(app.getPath('downloads'), 'Manga');
}

function createWindow() {
  const brandingConfig = brandingStorage.getBrandingConfig();
  const initialTitle = brandingConfig.appName?.trim() ? brandingConfig.appName : ' ';
  const nativeIcon = brandingStorage.resolveNativeIcon(brandingConfig);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 640,
    center: true,
    frame: false,
    title: initialTitle,
    backgroundColor: '#0e0e0e',
    icon: !nativeIcon.isEmpty() ? nativeIcon : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === 'darwin' && app.dock && !nativeIcon.isEmpty()) {
    app.dock.setIcon(nativeIcon);
  }

  mainWindow.on('focus', () => {
    if (membershipFocusDebounceId) clearTimeout(membershipFocusDebounceId);
    membershipFocusDebounceId = setTimeout(() => {
      membershipFocusDebounceId = null;
      runMembershipValidationAndNotify();
    }, 1500);
  });

  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => runMembershipValidationAndNotify(), 4000);
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

function sendLog(msg, level = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('manga:log', { msg, level, t: Date.now() });
  }
}

const { setPluginConsoleSender } = require('./lib/plugins/pluginConsoleBridge');
setPluginConsoleSender((payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('manga:pluginConsole', payload);
  }
});

function sendDownloadProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('manga:downloadProgress', payload);
  }
}

function sendCbzLoadProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('manga:cbzLoadProgress', payload);
  }
}

function createIpcContext() {
  return {
    getMainWindow: () => mainWindow,
    readSettings,
    writeSettings,
    getChapterFolderSettings,
    getDefaultMangaSaveDir,
    sendLog,
    sendDownloadProgress,
    sendCbzLoadProgress,
    isAbortRequested: () => mangaDownloadAbortRequested,
    setAbortRequested: (flag_value) => {
      mangaDownloadAbortRequested = Boolean(flag_value);
    },
    getCbzTempDir: () => lastCbzTempExtractDir,
    setCbzTempDir: (dir_value) => {
      lastCbzTempExtractDir = dir_value;
    },
    getCbzSessionId: () => lastCbzSessionId,
    setCbzSessionId: (session_id) => {
      lastCbzSessionId = session_id;
    },
    getPdfSessionId: () => lastPdfSessionId,
    setPdfSessionId: (session_id) => {
      lastPdfSessionId = session_id;
    },
    closeActiveReaderSessions,
    getCbzTempRoot,
    isAllowedCbzTempPath,
    resolveMangaRootForRead,
    materializeIfSession,
    shell,
    trashItem: async (filePath) => shell.trashItem(filePath),
  };
}

function purgeCbzTempRootSync() {
  try {
    const root = getCbzTempRoot();
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}

app.whenReady().then(() => {
  purgeCbzTempRootSync();
  cookieManager.init(app.getPath('userData'));
  registerConnectorImageRefererHeaders();
  registerAllIpc(createIpcContext());
  try {
    createWindow();
  } catch (e) {
    console.error('createWindow failed:', e);
  }
  membershipValidateIntervalId = setInterval(() => {
    runMembershipValidationAndNotify();
  }, 30 * 60 * 1000);
});

app.on('before-quit', () => {
  closeActiveReaderSessions();
  purgeCbzTempRootSync();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
