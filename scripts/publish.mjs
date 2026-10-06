// Публикует рилсы из queue.json в Instagram через Instagram API with Instagram Login.
// Запуск: node scripts/publish.mjs [publish|check|refresh]
// Переменные: IG_TOKEN (токен we_yapp), MEDIA_BASE (адрес GitHub Pages с роликами и обложками).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const API = `https://graph.instagram.com/${process.env.IG_API_VERSION || 'v23.0'}`;
const TOKEN = process.env.IG_TOKEN;
const MEDIA_BASE = (process.env.MEDIA_BASE || '').replace(/\/$/, '');
const LEAD_MIN = 30;       // за сколько минут до слота начинаем готовить ролик (cron каждые 30 мин)
const LATE_MIN = 180;      // до скольких минут опоздания ещё публикуем
const STATE = 'state/published.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const summary = (line) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');

async function ig(method, path, params = {}) {
  if (!TOKEN) throw new Error('нет секрета IG_TOKEN');
  const url = new URL(API + path);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = method === 'GET'
    ? await fetch(url + '?' + body)
    : await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method} ${path}: ${JSON.stringify(json.error || json)}`);
  return json;
}

const mediaUrl = (item, ext) => `${MEDIA_BASE}/${item.media}.${ext}`;
const loadState = () => JSON.parse(readFileSync(STATE, 'utf8'));
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');

// Ролик уже вышел, если среди последних постов есть пост с той же первой строкой подписи
// (страховка от двойной публикации, если отметка в state не успела сохраниться).
async function alreadyOnProfile(item) {
  const first = item.caption.split('\n')[0].trim();
  const { data = [] } = await ig('GET', '/me/media', { fields: 'id,caption,permalink', limit: '30' });
  return data.find((m) => (m.caption || '').split('\n')[0].trim() === first);
}

async function prepare(item) {
  const c = await ig('POST', '/me/media', {
    media_type: 'REELS',
    video_url: mediaUrl(item, 'mp4'),
    cover_url: mediaUrl(item, 'png'),
    caption: item.caption,
    share_to_feed: 'true',
  });
  log(item.id, 'контейнер', c.id);
  for (let i = 0; i < 90; i++) {           // до 15 минут на обработку видео
    const s = await ig('GET', '/' + c.id, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED') return c.id;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`${item.id}: ${s.status_code} ${s.status}`);
    await sleep(10_000);
  }
  throw new Error(`${item.id}: Meta не обработала видео за 15 минут`);
}

async function publish() {
  const queue = JSON.parse(readFileSync('queue.json', 'utf8'));
  const state = loadState();
  const now = Date.now();
  const due = queue
    .filter((q) => !state[q.id])
    .filter((q) => new Date(q.at) - now <= LEAD_MIN * 60_000)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  if (!due.length) return log('ничего не пора публиковать');

  let failed = false;
  for (const item of due) {
    const lateMin = (Date.now() - new Date(item.at)) / 60_000;
    if (lateMin > LATE_MIN) {
      state[item.id] = { status: 'missed', at: new Date().toISOString() };
      saveState(state);
      summary(`- ❌ ${item.at} ${item.title}: пропущен (опоздание ${Math.round(lateMin)} мин), выложи вручную`);
      failed = true;
      continue;
    }
    try {
      const existing = await alreadyOnProfile(item);
      if (existing) {
        state[item.id] = { status: 'published', media_id: existing.id, permalink: existing.permalink, note: 'найден в профиле' };
        saveState(state);
        continue;
      }
      const container = await prepare(item);
      const wait = new Date(item.at) - Date.now();
      if (wait > 0) { log(item.id, `жду ${Math.round(wait / 1000)} с до ${item.at}`); await sleep(wait); }
      const { id } = await ig('POST', '/me/media_publish', { creation_id: container });
      const { permalink } = await ig('GET', '/' + id, { fields: 'permalink' }).catch(() => ({}));
      state[item.id] = { status: 'published', media_id: id, permalink, published_at: new Date().toISOString() };
      saveState(state);
      log(item.id, 'опубликован', permalink);
      summary(`- ✅ ${item.at} ${item.title} ${permalink || id}`);
    } catch (e) {
      failed = true;
      log('ОШИБКА', e.message);
      summary(`- ❌ ${item.at} ${item.title}: ${e.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

// Проверка перед стартом: токен рабочий, все ролики и обложки отдаются по ссылкам.
async function check() {
  const me = await ig('GET', '/me', { fields: 'user_id,username' });
  log('аккаунт', me.username);
  const queue = JSON.parse(readFileSync('queue.json', 'utf8'));
  const state = loadState();
  let bad = 0;
  for (const q of queue.filter((q) => !state[q.id])) {
    for (const ext of ['mp4', 'png']) {
      const r = await fetch(mediaUrl(q, ext), { method: 'HEAD' });
      if (!r.ok) { bad++; log('нет файла', r.status, mediaUrl(q, ext)); }
    }
  }
  log(`в очереди ${queue.filter((q) => !state[q.id]).length}, недоступных файлов ${bad}`);
  if (bad) process.exitCode = 1;
}

// Продлевает 60-дневный токен; новый токен печатается в файл для обновления секрета.
async function refresh() {
  if (!TOKEN) throw new Error('нет секрета IG_TOKEN');
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('refresh: ' + JSON.stringify(json.error || json));
  writeFileSync(process.env.TOKEN_OUT || '.new-token', json.access_token);
  log(`токен продлён на ${Math.round(json.expires_in / 86400)} дн.`);
}

const cmd = process.argv[2] || 'publish';
await ({ publish, check, refresh }[cmd])();
