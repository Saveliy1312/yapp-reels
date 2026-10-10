// Публикует посты из threads.json в Threads через официальный Threads API.
// Запуск: node scripts/threads.mjs [publish|check|refresh|exchange|insights]
// Переменные: TH_TOKEN (токен Threads we_yapp), MEDIA_BASE (адрес GitHub Pages с картинками),
// для exchange - TH_APP_SECRET (секрет Meta-приложения, только локально).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const HOST = 'https://graph.threads.net';
const API = `${HOST}/${process.env.TH_API_VERSION || 'v1.0'}`;
const TOKEN = process.env.TH_TOKEN;
const MEDIA_BASE = (process.env.MEDIA_BASE || '').replace(/\/$/, '');
const LEAD_MIN = 30;       // за сколько минут до слота начинаем готовить пост (cron каждые 30 мин)
const LATE_MIN = 180;      // до скольких минут опоздания ещё публикуем
const MAX_TEXT = 500;      // лимит Threads на текст поста
const QUEUE = 'threads.json';
const STATE = 'state/threads.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const summary = (line) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n');
const load = (f) => JSON.parse(readFileSync(f, 'utf8'));
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
const firstLine = (t) => (t || '').split('\n')[0].trim();
const title = (item) => item.title || firstLine(item.text).slice(0, 60);

async function th(method, path, params = {}) {
  if (!TOKEN) throw new Error('нет секрета TH_TOKEN');
  const url = new URL(API + path);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = method === 'GET'
    ? await fetch(url + '?' + body)
    : await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method} ${path}: ${JSON.stringify(json.error || json)}`);
  return json;
}

// Ошибки в записи очереди, которые Threads всё равно не пропустит.
function problems(item) {
  const out = [];
  const texts = [item.text, ...(item.replies || [])];
  if (!item.id || !item.at || !item.text) out.push('нужны id, at и text');
  texts.forEach((t, i) => {
    const n = [...(t || '')].length;
    if (n > MAX_TEXT) out.push(`${i ? `ответ ${i}` : 'текст'}: ${n} знаков, можно ${MAX_TEXT}`);
  });
  const images = item.images || [];
  if (images.length > 20) out.push('картинок больше 20');
  if (item.poll && (item.poll.length < 2 || item.poll.length > 4)) out.push('в опросе 2-4 варианта');
  if (item.poll && images.length) out.push('опрос бывает только у поста без картинок');
  return out;
}

// Контейнер готов к публикации: у картинок Threads сначала скачивает и обрабатывает файл.
async function ready(id) {
  for (let i = 0; i < 60; i++) {           // до 10 минут
    const s = await th('GET', '/' + id, { fields: 'status,error_message' });
    if (s.status === 'FINISHED') return id;
    if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new Error(`контейнер ${id}: ${s.status} ${s.error_message || ''}`);
    await sleep(10_000);
  }
  throw new Error(`контейнер ${id}: Threads не обработал за 10 минут`);
}

async function prepare(user, item) {
  const images = item.images || [];
  const common = { text: item.text, ...(item.topic && { topic_tag: item.topic }) };
  let params;
  if (images.length === 0) {
    params = { ...common, media_type: 'TEXT' };
    if (item.poll) {
      const keys = ['option_a', 'option_b', 'option_c', 'option_d'];
      params.poll_attachment = JSON.stringify(Object.fromEntries(item.poll.map((o, i) => [keys[i], o])));
    }
  } else if (images.length === 1) {
    params = { ...common, media_type: 'IMAGE', image_url: `${MEDIA_BASE}/${images[0]}` };
  } else {
    const children = [];
    for (const f of images) {
      const c = await th('POST', `/${user}/threads`, { media_type: 'IMAGE', image_url: `${MEDIA_BASE}/${f}`, is_carousel_item: 'true' });
      children.push(await ready(c.id));
    }
    params = { ...common, media_type: 'CAROUSEL', children: children.join(',') };
  }
  const c = await th('POST', `/${user}/threads`, params);
  log(item.id, 'контейнер', c.id);
  return ready(c.id);
}

async function publishContainer(user, creationId) {
  const { id } = await th('POST', `/${user}/threads_publish`, { creation_id: creationId });
  const { permalink } = await th('GET', '/' + id, { fields: 'permalink' }).catch(() => ({}));
  return { id, permalink };
}

// Пост уже вышел, если среди последних постов есть пост с той же первой строкой
// (страховка от двойной публикации, если отметка в state не успела сохраниться).
async function alreadyOnProfile(item) {
  const { data = [] } = await th('GET', '/me/threads', { fields: 'id,text,permalink', limit: '30' });
  return data.find((m) => firstLine(m.text) === firstLine(item.text));
}

async function publish() {
  const queue = load(QUEUE);
  const state = load(STATE);
  const now = Date.now();
  const due = queue
    .filter((q) => !state[q.id])
    .filter((q) => new Date(q.at) - now <= LEAD_MIN * 60_000)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  if (!due.length) return log('ничего не пора публиковать');

  const { id: user } = await th('GET', '/me', { fields: 'id' });
  let failed = false;
  for (const item of due) {
    const lateMin = (Date.now() - new Date(item.at)) / 60_000;
    const bad = problems(item);
    if (lateMin > LATE_MIN || bad.length) {
      const why = bad.length ? bad.join('; ') : `опоздание ${Math.round(lateMin)} мин`;
      state[item.id] = { status: 'missed', note: why, at: new Date().toISOString() };
      saveState(state);
      summary(`- ❌ ${item.at} ${title(item)}: пропущен (${why}), выложи вручную`);
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
      const container = await prepare(user, item);
      const wait = new Date(item.at) - Date.now();
      if (wait > 0) { log(item.id, `жду ${Math.round(wait / 1000)} с до ${item.at}`); await sleep(wait); }
      const post = await publishContainer(user, container);
      state[item.id] = { status: 'published', media_id: post.id, permalink: post.permalink, published_at: new Date().toISOString() };
      saveState(state);
      log(item.id, 'опубликован', post.permalink);

      // Продолжение треда: каждый следующий пост - ответ на предыдущий.
      let parent = post.id;
      for (const [i, text] of (item.replies || []).entries()) {
        const c = await th('POST', `/${user}/threads`, { media_type: 'TEXT', text, reply_to_id: parent });
        parent = (await publishContainer(user, await ready(c.id))).id;
        state[item.id].replies = i + 1;
        saveState(state);
      }
      summary(`- ✅ ${item.at} ${title(item)} ${post.permalink || post.id}`);
    } catch (e) {
      failed = true;
      log('ОШИБКА', e.message);
      summary(`- ❌ ${item.at} ${title(item)}: ${e.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

// Проверка перед стартом: токен рабочий, тексты влезают в лимит, картинки отдаются по ссылкам.
async function check() {
  const me = await th('GET', '/me', { fields: 'id,username' });
  log('аккаунт', me.username);
  const queue = load(QUEUE);
  const state = load(STATE);
  const left = queue.filter((q) => !state[q.id]);
  let bad = 0;
  for (const q of left) {
    for (const p of problems(q)) { bad++; log(q.id, p); }
    for (const f of q.images || []) {
      const r = await fetch(`${MEDIA_BASE}/${f}`, { method: 'HEAD' });
      if (!r.ok) { bad++; log(q.id, 'нет картинки', r.status, `${MEDIA_BASE}/${f}`); }
    }
  }
  const ids = queue.map((q) => q.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) { bad++; log('повторяются id', [...new Set(dup)].join(', ')); }
  log(`в очереди ${left.length}, ошибок ${bad}`);
  summary(`Threads @${me.username}: в очереди ${left.length}, ошибок ${bad}`);
  if (bad) process.exitCode = 1;
}

// Продлевает 60-дневный токен; новый токен печатается в файл для обновления секрета.
async function refresh() {
  if (!TOKEN) throw new Error('нет секрета TH_TOKEN');
  const res = await fetch(`${HOST}/refresh_access_token?grant_type=th_refresh_token&access_token=${TOKEN}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('refresh: ' + JSON.stringify(json.error || json));
  writeFileSync(process.env.TOKEN_OUT || '.new-token', json.access_token);
  log(`токен Threads продлён на ${Math.round(json.expires_in / 86400)} дн.`);
}

// Меняет короткий токен (живёт час) на 60-дневный. Запускать локально, секрет приложения в репо не класть.
async function exchange() {
  const secret = process.env.TH_APP_SECRET;
  if (!TOKEN || !secret) throw new Error('нужны TH_TOKEN (короткий) и TH_APP_SECRET');
  const res = await fetch(`${HOST}/access_token?grant_type=th_exchange_token&client_secret=${secret}&access_token=${TOKEN}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('exchange: ' + JSON.stringify(json.error || json));
  writeFileSync(process.env.TOKEN_OUT || '.new-token', json.access_token);
  log(`долгий токен на ${Math.round(json.expires_in / 86400)} дн. записан в ${process.env.TOKEN_OUT || '.new-token'}`);
}

// Статистика последних постов профиля: state/threads-insights.json (для скриптов и Claude) и .md (для людей).
// Нужно право threads_manage_insights у TH_TOKEN.
const INSIGHTS = 'state/threads-insights';
const METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];
const value = (d) => d.total_value?.value ?? d.values?.[0]?.value ?? null;

async function postInsights(id) {
  const read = async (list) => {
    const { data = [] } = await th('GET', `/${id}/insights`, { metric: list.join(',') });
    return Object.fromEntries(data.map((d) => [d.name, value(d)]));
  };
  try {
    return await read(METRICS);
  } catch (e) {
    if (/"code":(10|200)\b|permission/i.test(e.message)) {
      throw new Error('у TH_TOKEN нет права threads_manage_insights - выпусти токен заново с этим правом');
    }
    // Какую-то метрику Threads не отдаёт для этого поста - собираем по одной, пропуская неподдерживаемые.
    const out = {};
    for (const k of METRICS) Object.assign(out, await read([k]).catch(() => ({})));
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
  const me = await th('GET', '/me', { fields: 'id,username' });
  const { data: media = [] } = await th('GET', '/me/threads', { fields: 'id,text,media_type,timestamp,permalink', limit: '50' });
  const queue = Object.fromEntries(load(QUEUE).map((q) => [q.id, q]));
  const byMedia = Object.fromEntries(Object.entries(load(STATE))
    .filter(([, s]) => s.media_id).map(([id, s]) => [s.media_id, id]));

  const posts = [];
  for (const m of media) {
    const q = queue[byMedia[m.id]];
    const type = q?.poll ? 'poll' : q?.replies ? 'thread' : m.media_type === 'CAROUSEL_ALBUM' ? 'carousel'
      : m.media_type === 'IMAGE' ? 'image' : 'post';
    posts.push({
      id: m.id, queue_id: q?.id || null, type, at: m.timestamp, permalink: m.permalink,
      title: q ? title(q) : firstLine(m.text).slice(0, 60),
      ...(await postInsights(m.id)),
    });
  }

  // Свежие посты ещё набирают просмотры, поэтому медиана - по постам старше 48 часов.
  const settled = (p) => Date.now() - new Date(p.at) > 48 * 3600_000;
  const base = median(posts.filter(settled).map((p) => p.views));
  for (const p of posts) p.outlier = p.views != null && base ? Math.round((p.views / base) * 10) / 10 : null;

  let count = null;
  try {
    const { data = [] } = await th('GET', `/${me.id}/threads_insights`, { metric: 'followers_count' });
    count = value(data[0] || {});
  } catch (e) { log('подписчики:', e.message); }
  let followers = [];
  try { followers = load(INSIGHTS + '.json').followers || []; } catch {}
  const today = new Date().toISOString().slice(0, 10);
  if (count != null) followers = [...followers.filter((f) => f.date !== today), { date: today, count }];

  const updated = new Date().toISOString();
  writeFileSync(INSIGHTS + '.json', JSON.stringify({
    updated_at: updated, username: me.username, followers_count: count, median_views: base, followers, posts,
  }, null, 2) + '\n');

  const n = (x) => (x == null ? '-' : x);
  const md = [
    `# Статистика Threads @${me.username}`, '',
    `Обновлено ${msk(updated)} МСК. Подписчиков: ${n(count)}. Медиана просмотров (посты старше 48 ч): ${n(base)}.`,
    '«x медианы» - во сколько раз пост обошёл обычный пост. * - вышел меньше 48 ч назад, ещё набирает.',
    'Тип: post - текст, poll - опрос, thread - тред с продолжением (цифры только по первому посту).', '',
    '| Вышел (МСК) | Тип | Просмотры | x медианы | Лайки | Ответы | Репосты | Цитаты | Поделились | Пост |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...posts.map((p) => `| ${msk(p.at)}${settled(p) ? '' : '*'} | ${p.type} | ${n(p.views)} | ${n(p.outlier)} | ${n(p.likes)} | ` +
      `${n(p.replies)} | ${n(p.reposts)} | ${n(p.quotes)} | ${n(p.shares)} | [${p.title.replace(/[|[\]]/g, ' ').slice(0, 60)}](${p.permalink}) |`),
  ].join('\n') + '\n';
  writeFileSync(INSIGHTS + '.md', md);
  log(`статистика Threads: ${posts.length} постов, подписчиков ${n(count)}`);
  summary(`Статистика Threads: ${posts.length} постов, подписчиков ${n(count)}, медиана просмотров ${n(base)}`);
}

const cmd = process.argv[2] || 'publish';
await ({ publish, check, refresh, exchange, insights }[cmd])();
