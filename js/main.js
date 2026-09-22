import { AudioEngine } from './audio.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { Game, rankOf } from './game.js';
import { songs, assets, fileId, loadSettings, saveSettings, fallTimeFor, CHART_VERSION } from './storage.js';
import { downmix } from './chart/analyze.js';

const $ = (id) => document.getElementById(id);

const audio = new AudioEngine();
const canvas = $('stage');
const renderer = new Renderer(canvas);
const input = new Input(canvas, renderer, audio);
let settings = loadSettings();

const DIFFS = [
  { key: 'EASY', color: '#6dffb0' },
  { key: 'NORMAL', color: '#5ce1ff' },
  { key: 'HARD', color: '#ffd35c' },
  { key: 'EXPERT', color: '#ff6fb5' },
];

const state = {
  song: null,
  buffer: null,
  bufferId: null,
  difficulty: 'NORMAL',
  game: null,
  running: false,
  paused: false,
  lastFrame: 0,
  wakeLock: null,
};

// ---------- 画面遷移(Android の戻るボタンにも対応) ----------

const SCREENS = ['home', 'song', 'loading', 'play', 'result', 'settings', 'calib'];
const stack = ['home'];

function show(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
}

function navigate(name) {
  stack.push(name);
  history.pushState({ screen: name }, '');
  show(name);
}

function replace(name) {
  stack[stack.length - 1] = name;
  history.replaceState({ screen: name }, '');
  show(name);
}

window.addEventListener('popstate', () => {
  const current = stack[stack.length - 1];
  if (current === 'play') {
    // プレイ中の戻るは一時停止にする
    history.pushState({ screen: 'play' }, '');
    if (state.running) pauseGame();
    return;
  }
  if (current === 'loading') {
    history.pushState({ screen: 'loading' }, '');
    return;
  }
  if (current === 'calib') stopCalibration();
  if (stack.length > 1) stack.pop();
  const top = stack[stack.length - 1];
  if (top === 'home') renderHome();
  if (top === 'song' && state.song) renderSong();
  show(top);
});

document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => history.back()));

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

// 複数曲をまとめて処理する時の見出し(「初期曲を準備中 1/3」など)
let loadingNote = '';

function setLoading(text, progress) {
  $('loading-text').textContent = loadingNote ? `${loadingNote}
${text}` : text;
  $('loading-bar').style.width = `${Math.round(progress * 100)}%`;
}

const fmtTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---------- ホーム ----------

async function renderHome() {
  const list = $('song-list');
  const all = (await songs.all()).sort((a, b) => b.createdAt - a.createdAt);
  list.replaceChildren();
  if (!all.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'まだ曲がありません。「曲を追加」から始めましょう。';
    list.append(li);
    return;
  }
  for (const song of all) {
    const li = document.createElement('li');
    li.className = 'song-item';
    const hue = parseInt(song.id.slice(0, 2), 16) * 1.4;
    const bestRanks = DIFFS.map((d) => song.best?.[d.key]?.rank).filter(Boolean);
    li.innerHTML = `
      <div class="jacket" style="background: linear-gradient(135deg, hsl(${hue} 90% 70%), hsl(${hue + 60} 80% 55%))"></div>
      <div class="info">
        <div class="name"></div>
        <div class="sub">BPM ${Math.round(song.bpm)} · ${fmtTime(song.duration)}${bestRanks.length ? ` · ベスト ${bestRanks[bestRanks.length - 1]}` : ''}</div>
      </div>
      <button class="icon-btn delete" aria-label="削除">✕</button>`;
    li.querySelector('.jacket').textContent = [...song.title][0] || '♪';
    li.querySelector('.name').textContent = song.title;
    li.addEventListener('click', () => openSong(song));
    li.querySelector('.delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`「${song.title}」を削除しますか？`)) return;
      await songs.remove(song.id);
      renderHome();
    });
    list.append(li);
  }
}

$('file-input').addEventListener('click', () => audio.ensure());
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const title = file.name.replace(/\.[^.]+$/, '');
  await addSong(await file.arrayBuffer(), title, file.type || 'audio/mpeg');
});

async function addSong(arrayBuffer, title, type) {
  navigate('loading');
  try {
    const { song, existed } = await importSong(arrayBuffer, title, type);
    if (existed) toast('この曲はもう追加されています');
    openSong(song, true);
  } catch (err) {
    console.error(err);
    toast('この音声ファイルは読み込めませんでした');
    replace('home');
    renderHome();
  }
}

// 音声を読み込んで譜面を作り、ライブラリへ保存する。画面遷移はしない。
async function importSong(arrayBuffer, title, type, extra = {}) {
  setLoading('曲を読み込み中…', 0.03);
  const id = await fileId(arrayBuffer);
  const existing = await songs.get(id);
  const buffer = await audio.decode(arrayBuffer);
  state.buffer = buffer;
  state.bufferId = id;
  if (existing && existing.chartVersion === CHART_VERSION) {
    // 自分で追加済みの曲が初期曲にもなった場合は、クレジットなどだけ付け足す
    if (Object.keys(extra).length) {
      Object.assign(existing, extra);
      await songs.put(existing);
    }
    return { song: existing, existed: true };
  }
  const analysis = await analyzeBuffer(buffer, id);
  const song = {
    id,
    title: existing?.title || title,
    blob: new Blob([arrayBuffer], { type }),
    createdAt: existing?.createdAt || Date.now(),
    best: existing?.best || {},
    chartVersion: CHART_VERSION,
    ...extra,
    ...analysis,
  };
  await songs.put(song);
  return { song, existed: false };
}

// ---------- 初期曲 ----------
// songs/index.json に並べた同梱音源を初回起動時にライブラリへ入れる。

const BUILTIN_KEY = 'mtg-builtins';

async function builtinList() {
  try {
    const res = await fetch('songs/index.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    return (await res.json()).map((entry) => ({
      key: `file:${entry.file}`,
      title: entry.title,
      extra: entry.credit ? { credit: entry.credit } : {},
      load: async () => {
        const r = await fetch(`songs/${encodeURIComponent(entry.file)}`);
        if (!r.ok) throw new Error(`songs/${entry.file}: ${r.status}`);
        return { bytes: await r.arrayBuffer(), type: r.headers.get('content-type') || 'audio/mpeg' };
      },
    }));
  } catch {
    // オフライン等で一覧が取れない時は何もしない(入れ済みの曲はそのまま)
    return null;
  }
}

function installedBuiltins() {
  try {
    return new Set(JSON.parse(localStorage.getItem(BUILTIN_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveInstalledBuiltins(keys) {
  try {
    localStorage.setItem(BUILTIN_KEY, JSON.stringify([...keys]));
  } catch {
    // 保存できなければ次回また入れ直すだけ
  }
}

async function installBuiltins(force = false) {
  const list = await builtinList();
  if (!list) return;
  const keys = new Set(list.map((b) => b.key));
  const installed = installedBuiltins();

  // 初期曲から外れた曲は片付ける(自分で追加した曲には builtin が付かないので残る)
  for (const song of await songs.all()) {
    if (song.builtin && !keys.has(song.builtin)) await songs.remove(song.id);
  }
  for (const key of installed) if (!keys.has(key)) installed.delete(key);

  const todo = list.filter((b) => force || !installed.has(b.key));
  if (!todo.length) {
    saveInstalledBuiltins(installed);
    await renderHome();
    return;
  }
  // 今の画面(起動時はホーム、設定から呼べば設定)を一時的に置き換えて、終わったら戻す
  const back = stack[stack.length - 1];
  replace('loading');
  for (const [i, b] of todo.entries()) {
    loadingNote = `初期曲を準備中 ${i + 1}/${todo.length}「${b.title}」`;
    try {
      setLoading('曲を読み込み中…', 0.02);
      const { bytes, type } = await b.load();
      await importSong(bytes, b.title, type, { builtin: b.key, ...b.extra });
      installed.add(b.key);
    } catch (err) {
      console.error(err);
    }
  }
  loadingNote = '';
  saveInstalledBuiltins(installed);
  await renderHome();
  replace(back);
}

function analyzeBuffer(buffer, id) {
  setLoading('譜面を作成中…', 0.08);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const { samples, sampleRate } = downmix(channels, buffer.sampleRate);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./chart/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') setLoading('譜面を作成中…', 0.08 + 0.9 * msg.value);
      if (msg.type === 'done') {
        worker.terminate();
        resolve(msg.result);
      }
      if (msg.type === 'error') {
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(e);
    };
    worker.postMessage({ samples, sampleRate, seed: parseInt(id.slice(0, 8), 16) }, [samples.buffer]);
  });
}

// ---------- 曲詳細 ----------

async function openSong(song, replaceCurrent = false) {
  state.song = song;
  // 譜面生成のしくみが変わっていたら作り直す(スコアは残す)
  if (song.chartVersion !== CHART_VERSION) {
    if (replaceCurrent) replace('loading');
    else navigate('loading');
    replaceCurrent = true;
    try {
      await prepareBuffer(true);
      Object.assign(song, await analyzeBuffer(state.buffer, song.id), { chartVersion: CHART_VERSION });
      await songs.put(song);
      toast('新しい譜面に作り直しました');
    } catch (err) {
      console.error(err);
      toast('譜面を作り直せませんでした');
    }
  }
  renderSong();
  if (replaceCurrent) replace('song');
  else navigate('song');
}

function renderSong() {
  const song = state.song;
  $('song-title').textContent = song.title;
  $('song-meta').textContent = `BPM ${Math.round(song.bpm)} · ${fmtTime(song.duration)}${song.credit ? ` · ♪ ${song.credit}` : ''}`;
  const list = $('difficulty-list');
  list.replaceChildren();
  for (const d of DIFFS) {
    const chart = song.charts[d.key];
    const best = song.best?.[d.key];
    const btn = document.createElement('button');
    btn.className = `diff${state.difficulty === d.key ? ' selected' : ''}`;
    btn.style.setProperty('--diff-color', d.color);
    btn.innerHTML = `
      <div class="lv"><div><small>Lv</small>${chart.level}</div></div>
      <div>
        <div class="name">${d.key}</div>
        <div class="detail">${chart.notes.length} ノーツ</div>
      </div>
      <div class="best">${best ? `<b>${best.rank}</b>${best.score.toLocaleString()}${best.ap ? ' AP' : best.fc ? ' FC' : ''}` : '未プレイ'}</div>`;
    btn.addEventListener('click', () => {
      state.difficulty = d.key;
      renderSong();
    });
    list.append(btn);
  }
}

$('start-game').addEventListener('click', async () => {
  audio.ensure();
  await prepareBuffer();
  startGame(false);
});

$('regenerate').addEventListener('click', async () => {
  audio.ensure();
  const song = state.song;
  navigate('loading');
  try {
    await prepareBuffer(true);
    Object.assign(song, await analyzeBuffer(state.buffer, song.id), { chartVersion: CHART_VERSION });
    await songs.put(song);
    toast('譜面を作り直しました');
  } catch (err) {
    console.error(err);
    toast('譜面を作れませんでした');
  }
  replace('song');
  renderSong();
});

async function prepareBuffer(loadingShown = false) {
  const song = state.song;
  if (state.bufferId === song.id && state.buffer) return;
  if (!loadingShown) navigate('loading');
  setLoading('曲を読み込み中…', 0.3);
  state.buffer = await audio.decode(await song.blob.arrayBuffer());
  state.bufferId = song.id;
  if (!loadingShown) replace('song');
}

// ---------- プレイ ----------

function startGame(isRetry) {
  const song = state.song;
  const chart = song.charts[state.difficulty];
  const fallTime = fallTimeFor(settings.speed);
  const game = new Game(chart, { offset: settings.offsetMs / 1000, auto: settings.auto });
  const lastNote = chart.notes.reduce((m, n) => Math.max(m, n.end || n.t), 0);
  const firstNote = chart.notes.length ? chart.notes[0].t : 0;

  state.game = game;
  state.fallTime = fallTime;
  state.endTime = Math.max(song.duration, lastNote) + 1.2;
  state.running = true;
  state.paused = false;
  renderer.setLanes(chart.lanes);
  renderer.particles = [];
  input.attach(game);
  audio.setVolumes(settings.musicVolume / 100, settings.hitVolume / 100);
  audio.play(state.buffer, Math.max(1.5, fallTime - firstNote + 1));

  $('pause-menu').hidden = true;
  if (isRetry) replace('play');
  else navigate('play');
  requestWakeLock();
  state.lastFrame = performance.now();
  requestAnimationFrame(loop);
}

function loop(ts) {
  if (!state.running) return;
  const game = state.game;
  const now = audio.songTime();
  const dt = Math.min(0.05, Math.max(0, (ts - state.lastFrame) / 1000));
  state.lastFrame = ts;

  if (!state.paused) game.update(now);
  for (const e of game.events) {
    if (e.type === 'judge' && e.grade !== 'MISS' && e.part === 'head') audio.hit(e.kind === 'flick' ? 'flick' : 'tap');
  }
  renderer.handleEvents(game.events, now);
  game.events.length = 0;

  const song = state.song;
  renderer.draw({
    now,
    dt: state.paused ? 0 : dt,
    game,
    fallTime: state.fallTime,
    beats: song.beats,
    duration: song.duration,
    title: song.title,
    safeTop: safeTop(),
  });

  if (!state.paused && now >= state.endTime) finishGame();
  else requestAnimationFrame(loop);
}

function pauseGame() {
  if (!state.running || state.paused) return;
  state.paused = true;
  audio.pause();
  $('pause-menu').hidden = false;
}

async function resumeGame() {
  $('pause-menu').hidden = true;
  await audio.resume();
  state.paused = false;
}

function stopGame() {
  state.running = false;
  state.paused = false;
  input.detach();
  audio.stop();
  audio.resume();
  releaseWakeLock();
}

$('pause-btn').addEventListener('click', pauseGame);
$('resume-btn').addEventListener('click', resumeGame);
$('retry-btn').addEventListener('click', async () => {
  stopGame();
  await audio.resume();
  startGame(true);
});
$('quit-btn').addEventListener('click', () => {
  stopGame();
  stack.pop();
  history.replaceState({ screen: 'song' }, '');
  renderSong();
  show('song');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseGame();
});

async function finishGame() {
  const game = state.game;
  const song = state.song;
  stopGame();

  const score = game.score;
  const rank = rankOf(score);
  const ap = game.counts.PERFECT === game.total;
  const fc = game.counts.MISS === 0;
  $('result-song').textContent = `${song.title} ・ ${state.difficulty}`;
  $('result-rank').textContent = rank;
  $('result-rank').style.setProperty('--rank-color', { S: '#ffd35c', A: '#ff6fb5', B: '#5ce1ff', C: '#6dffb0', D: '#b3a9d6' }[rank]);
  $('result-badge').textContent = ap ? 'ALL PERFECT' : fc ? 'FULL COMBO' : '';
  $('r-perfect').textContent = game.counts.PERFECT;
  $('r-great').textContent = game.counts.GREAT;
  $('r-good').textContent = game.counts.GOOD;
  $('r-miss').textContent = game.counts.MISS;
  $('r-combo').textContent = `${game.maxCombo} / ${game.total}`;
  const timing = game.timingStats();
  $('r-timing').textContent = !timing || settings.auto
    ? '―'
    : `平均 ${timing.meanMs > 0 ? '+' : ''}${timing.meanMs}ms ${Math.abs(timing.meanMs) < 8 ? '(ぴったり)' : timing.meanMs > 0 ? '(遅め)' : '(早め)'}`;

  let bestText = '';
  if (settings.auto) {
    bestText = 'オートプレイ（記録されません）';
  } else {
    const prev = song.best?.[state.difficulty];
    if (!prev || score > prev.score) {
      song.best = { ...song.best, [state.difficulty]: { score, rank, fc, ap } };
      await songs.put(song);
      if (prev) bestText = 'NEW BEST!';
    }
  }
  $('result-best').textContent = bestText;

  replace('result');
  countUp($('result-score'), score);
}

function countUp(el, target) {
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 900);
    el.textContent = Math.round(target * (1 - (1 - k) ** 3)).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

$('result-retry').addEventListener('click', () => {
  audio.ensure();
  startGame(true);
});
$('result-back').addEventListener('click', () => {
  stack.pop();
  history.replaceState({ screen: 'song' }, '');
  renderSong();
  show('song');
});

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // 非対応・拒否されても遊べる
  }
}

function releaseWakeLock() {
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
}

// ノッチ付き端末の上端の余白(CSS の env() から読む)
let safeTopCache = null;
function safeTop() {
  if (safeTopCache === null) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;padding-top:env(safe-area-inset-top,0px);visibility:hidden';
    document.body.append(probe);
    safeTopCache = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
  }
  return safeTopCache;
}
window.addEventListener('resize', () => (safeTopCache = null));

// ---------- 設定 ----------

$('open-settings').addEventListener('click', () => {
  renderSettings();
  navigate('settings');
});

const sliders = [
  ['set-speed', 'speed', 'speed-value', (v) => v.toFixed(1)],
  ['set-offset', 'offsetMs', 'offset-value', (v) => `${v > 0 ? '+' : ''}${v}ms`],
  ['set-music-vol', 'musicVolume', 'music-vol-value', (v) => `${v}%`],
  ['set-hit-vol', 'hitVolume', 'hit-vol-value', (v) => `${v}%`],
  ['set-bg-dim', 'bgDim', 'bg-dim-value', (v) => `${v}%`],
];

function renderSettings() {
  for (const [id, key, label, fmt] of sliders) {
    $(id).value = settings[key];
    $(label).textContent = fmt(Number(settings[key]));
  }
  $('set-auto').checked = settings.auto;
}

for (const [id, key, label, fmt] of sliders) {
  $(id).addEventListener('input', (e) => {
    settings[key] = Number(e.target.value);
    $(label).textContent = fmt(settings[key]);
    saveSettings(settings);
    applyVisualSettings();
  });
}

$('reinstall-builtins').addEventListener('click', async () => {
  audio.ensure();
  await installBuiltins(true);
  toast('初期曲を入れ直しました');
});

$('set-auto').addEventListener('change', (e) => {
  settings.auto = e.target.checked;
  saveSettings(settings);
});

$('bg-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    renderer.bgImage = await createImageBitmap(file);
    await assets.put('background', file);
    toast('背景を変更しました');
  } catch {
    toast('この画像は使えませんでした');
  }
});

$('bg-clear').addEventListener('click', async () => {
  renderer.bgImage = null;
  await assets.remove('background');
  toast('背景を元に戻しました');
});

function applyVisualSettings() {
  renderer.bgDim = settings.bgDim / 100;
}

// ---------- タイミング調整 ----------

const calib = { active: false, taps: [], beat: 60 / 100, count: 24, timer: null, result: null };

$('open-calib').addEventListener('click', () => {
  $('calib-result').textContent = '―';
  $('calib-apply').disabled = true;
  navigate('calib');
});

$('calib-start').addEventListener('click', () => {
  audio.ensure();
  audio.setVolumes(settings.musicVolume / 100, Math.max(0.6, settings.hitVolume / 100));
  audio.startClock(0.8);
  for (let i = 0; i < calib.count; i++) audio.scheduleClick(i * calib.beat, i % 4 === 0);
  calib.active = true;
  calib.taps = [];
  $('calib-apply').disabled = true;
  $('calib-result').textContent = '音に合わせてタップ…';
  clearTimeout(calib.timer);
  calib.timer = setTimeout(endCalibration, (0.8 + calib.count * calib.beat + 0.6) * 1000);
});

$('calib-pad').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const pad = $('calib-pad');
  pad.classList.add('hit');
  setTimeout(() => pad.classList.remove('hit'), 80);
  if (!calib.active) return;
  const t = audio.songTime(e.timeStamp || performance.now());
  const k = Math.round(t / calib.beat);
  // 最初の 4 拍はリズムをつかむ時間として捨てる
  if (k < 4 || k >= calib.count) return;
  calib.taps.push(t - k * calib.beat);
  const m = median(calib.taps);
  $('calib-result').textContent = `${m > 0 ? '+' : ''}${Math.round(m * 1000)}ms（${calib.taps.length}回）`;
});

function endCalibration() {
  calib.active = false;
  if (calib.taps.length < 8) {
    $('calib-result').textContent = 'タップが少なすぎました。もう一度どうぞ';
    return;
  }
  calib.result = Math.round(median(calib.taps) * 1000);
  $('calib-result').textContent = `結果: ${calib.result > 0 ? '+' : ''}${calib.result}ms`;
  $('calib-apply').disabled = false;
}

function stopCalibration() {
  calib.active = false;
  clearTimeout(calib.timer);
}

$('calib-apply').addEventListener('click', () => {
  settings.offsetMs = Math.max(-250, Math.min(250, calib.result));
  saveSettings(settings);
  toast(`判定タイミングを ${settings.offsetMs}ms にしました`);
  history.back();
  renderSettings();
});

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---------- 起動 ----------

async function boot() {
  history.replaceState({ screen: 'home' }, '');
  applyVisualSettings();
  try {
    const bg = await assets.get('background');
    if (bg) renderer.bgImage = await createImageBitmap(bg);
  } catch {
    // 背景が読めなくても続行
  }
  await renderHome();
  show('home');
  await installBuiltins();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
