// 曲(音声ファイルと生成済み譜面)は IndexedDB、設定は localStorage に置く。
// どちらも端末内だけに保存され、外には送らない。

const DB_NAME = 'music-tap-game';
const DB_VERSION = 1;

// 譜面生成アルゴリズムを変えたら上げる。古い譜面は自動で作り直す。
export const CHART_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const songs = {
  all: () => tx('songs', 'readonly', (s) => s.getAll()),
  get: (id) => tx('songs', 'readonly', (s) => s.get(id)),
  put: (song) => tx('songs', 'readwrite', (s) => s.put(song)),
  remove: (id) => tx('songs', 'readwrite', (s) => s.delete(id)),
};

export const assets = {
  get: (key) => tx('assets', 'readonly', (s) => s.get(key)),
  put: (key, value) => tx('assets', 'readwrite', (s) => s.put(value, key)),
  remove: (key) => tx('assets', 'readwrite', (s) => s.delete(key)),
};

// ファイルの中身から ID を作る。同じ曲を二度追加しても一つにまとまる。
export async function fileId(buffer) {
  if (globalThis.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // http で開いた場合など crypto.subtle が無い環境用
  const bytes = new Uint8Array(buffer);
  let h1 = 2166136261;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 7) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619);
    h2 = Math.imul(h2 ^ bytes[i], 2246822519);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}${bytes.length.toString(16)}`;
}

const SETTINGS_KEY = 'mtg-settings';
const DEFAULTS = {
  speed: 6,
  offsetMs: 0,
  musicVolume: 80,
  hitVolume: 60,
  bgDim: 55,
  auto: false,
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // プライベートモード等で保存できなくても遊べるようにする
  }
}

// ノーツ速度(1〜12)を、ノーツが画面奥から判定ラインまで届く秒数へ
export const fallTimeFor = (speed) => 6 / (speed + 1);
