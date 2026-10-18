// Чистые функции статистики Instagram: слияние свежей выгрузки с сохранённой и «x медианы».
// Проверка: node --test scripts/insights.test.mjs

export const MEDIAN_WINDOW = 50;   // медиана - по 50 последним постам, как было до слияния с историей
const SETTLED_MS = 48 * 3600_000;  // свежие посты ещё набирают просмотры

export const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : null;
};

export const settled = (p, now = Date.now()) => now - new Date(p.at) > SETTLED_MS;

// Свежие посты получают дату среза asOf; пост старше всей свежей выгрузки остаётся с последними
// известными цифрами и своей датой среза (у записей до слияния её нет - берём savedAt, время прошлой выгрузки).
// Пост, которого нет в выгрузке, хотя он новее её самого старого поста, удалён с профиля - его убираем.
// Порядок - от новых к старым.
export function mergePosts(fresh, saved = [], asOf, savedAt = null) {
  const oldest = Math.min(...fresh.map((p) => Date.parse(p.at)));
  const byId = new Map(saved.filter((p) => Date.parse(p.at) < oldest)
    .map((p) => [p.id, { ...p, as_of: p.as_of || savedAt }]));
  for (const p of fresh) byId.set(p.id, { ...p, as_of: asOf });
  return [...byId.values()].sort((a, b) => new Date(b.at) - new Date(a.at));
}

// Медиана просмотров по типам среди MEDIAN_WINDOW последних постов старше 48 часов
// и «во сколько раз пост обошёл медиану своего типа» для каждого поста.
export function withOutliers(posts, now = Date.now()) {
  const recent = posts.slice(0, MEDIAN_WINDOW);
  const base = {};
  for (const type of ['reel', 'carousel', 'post']) {
    base[type] = median(recent.filter((p) => p.type === type && settled(p, now)).map((p) => p.views));
  }
  for (const p of posts) p.outlier = p.views != null && base[p.type] ? Math.round((p.views / base[p.type]) * 10) / 10 : null;
  return base;
}
