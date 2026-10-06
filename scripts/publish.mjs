// Публикует рилсы из queue.json в Instagram через Instagram API with Instagram Login.
// Запуск: node scripts/publish.mjs [publish|check|probe|refresh|insights]
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

// Пробный прогон: Instagram забирает ближайший ролик и обложку и обрабатывает их, но пост не публикуется
// (неопубликованный контейнер нигде не виден и сам удаляется через 24 часа).
async function probe() {
  const queue = JSON.parse(readFileSync('queue.json', 'utf8'));
  const state = loadState();
  const item = queue.filter((q) => !state[q.id]).sort((a, b) => new Date(a.at) - new Date(b.at))[0];
  if (!item) return log('очередь пуста');
  const id = await prepare(item);
  log(`ОК: ${item.title} принят и обработан Instagram (контейнер ${id}), публикации не было`);
  summary(`- 🧪 ${item.title}: Instagram принял видео и обложку, пост не публиковался`);
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

// Статистика последних постов профиля: state/insights.json (для скриптов и Claude) и state/insights.md (для людей).
// Нужно право instagram_business_manage_insights у IG_TOKEN.
const INSIGHTS = 'state/insights';
const REEL_METRICS = ['views', 'reach', 'saved', 'shares', 'likes', 'comments', 'total_interactions',
  'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
const FEED_METRICS = ['views', 'reach', 'saved', 'shares', 'likes', 'comments', 'total_interactions',
  'follows', 'profile_visits'];

async function mediaInsights(m) {
  const metrics = m.media_product_type === 'REELS' ? REEL_METRICS : FEED_METRICS;
  const read = async (list) => {
    const { data = [] } = await ig('GET', `/${m.id}/insights`, { metric: list.join(',') });
    return Object.fromEntries(data.map((d) => [d.name, d.values?.[0]?.value ?? d.total_value?.value ?? null]));
  };
  try {
    return await read(metrics);
  } catch (e) {
    if (/"code":(10|200)\b|permission/i.test(e.message)) {
      throw new Error('у IG_TOKEN нет права instagram_business_manage_insights - выпусти токен заново с этим правом');
    }
    // Какую-то метрику Instagram не отдаёт для этого поста - собираем по одной, пропуская неподдерживаемые.
    const out = {};
    for (const k of metrics) Object.assign(out, await read([k]).catch(() => ({})));
    return out;
  }
}

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null;
};
const msk = (t) => new Date(t).toLocaleString('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

async function insights() {
  const me = await ig('GET', '/me', { fields: 'username,followers_count,media_count' });
  const { data: media = [] } = await ig('GET', '/me/media', {
    fields: 'id,caption,media_type,media_product_type,timestamp,permalink', limit: '50',
  });
  const queue = JSON.parse(readFileSync('queue.json', 'utf8'));
  const titles = Object.fromEntries(queue.map((q) => [q.id, q.title]));
  const byMedia = Object.fromEntries(Object.entries(loadState())
    .filter(([, s]) => s.media_id).map(([id, s]) => [s.media_id, id]));

  const posts = [];
  for (const m of media) {
    const queueId = byMedia[m.id] || null;
    const i = await mediaInsights(m);
    posts.push({
      id: m.id,
      queue_id: queueId,
      type: m.media_product_type === 'REELS' ? 'reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel' : 'post',
      at: m.timestamp,
      permalink: m.permalink,
      title: titles[queueId] || (m.caption || '').split('\n')[0].trim(),
      ...i,
      ...(i.ig_reels_avg_watch_time != null && { avg_watch_s: Math.round(i.ig_reels_avg_watch_time / 100) / 10 }),
    });
  }

  // Свежие посты ещё набирают просмотры, поэтому медиана - по постам старше 48 часов, отдельно для каждого типа.
  const settled = (p) => Date.now() - new Date(p.at) > 48 * 3600_000;
  const base = {};
  for (const type of ['reel', 'carousel', 'post']) {
    base[type] = median(posts.filter((p) => p.type === type && settled(p)).map((p) => p.views));
  }
  for (const p of posts) p.outlier = p.views != null && base[p.type] ? Math.round((p.views / base[p.type]) * 10) / 10 : null;

  let followers = [];
  try { followers = JSON.parse(readFileSync(INSIGHTS + '.json', 'utf8')).followers || []; } catch {}
  const today = new Date().toISOString().slice(0, 10);
  followers = [...followers.filter((f) => f.date !== today), { date: today, count: me.followers_count }];

  const updated = new Date().toISOString();
  writeFileSync(INSIGHTS + '.json', JSON.stringify({
    updated_at: updated, username: me.username, followers_count: me.followers_count,
    median_views: base, followers, posts,
  }, null, 2) + '\n');

  const n = (x) => (x == null ? '-' : x);
  const md = [
    `# Статистика @${me.username}`, '',
    `Обновлено ${msk(updated)} МСК. Подписчиков: ${me.followers_count}. ` +
      `Медиана просмотров (посты старше 48 ч): рилсы ${n(base.reel)}, карусели ${n(base.carousel)}.`,
    '«x медианы» - во сколько раз пост обошёл обычный пост своего типа. * - вышел меньше 48 ч назад, ещё набирает.', '',
    '| Вышел (МСК) | Тип | Просмотры | x медианы | Охват | Сохр. | Репосты | Ср. досмотр, с | Пост |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...posts.map((p) => `| ${msk(p.at)}${settled(p) ? '' : '*'} | ${p.type} | ${n(p.views)} | ${n(p.outlier)} | ${n(p.reach)} | ` +
      `${n(p.saved)} | ${n(p.shares)} | ${n(p.avg_watch_s)} | [${p.title.replace(/[|[\]]/g, ' ').slice(0, 60)}](${p.permalink}) |`),
  ].join('\n') + '\n';
  writeFileSync(INSIGHTS + '.md', md);
  log(`статистика: ${posts.length} постов, подписчиков ${me.followers_count}`);
  summary(`Статистика: ${posts.length} постов, подписчиков ${me.followers_count}, медиана рилсов ${n(base.reel)}`);
}

const cmd = process.argv[2] || 'publish';
await ({ publish, check, probe, refresh, insights }[cmd])();
