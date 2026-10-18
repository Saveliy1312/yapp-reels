import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePosts, withOutliers, median, MEDIAN_WINDOW } from './insights-lib.mjs';

const day = 24 * 3600_000;
const NOW = Date.parse('2026-10-18T03:00:00Z');
const post = (id, daysAgo, views, type = 'reel') => ({ id, type, views, at: new Date(NOW - daysAgo * day).toISOString() });

test('пост, выпавший из свежей выгрузки, остаётся с прошлыми цифрами и датой среза', () => {
  const saved = [post('old', 20, 300), post('a', 3, 100)];
  const fresh = [post('b', 1, 50), post('a', 3, 120)];
  const merged = mergePosts(fresh, saved, '2026-10-18T03:00:00Z', '2026-10-17T03:00:00Z');
  assert.deepEqual(merged.map((p) => p.id), ['b', 'a', 'old']);
  assert.equal(merged.find((p) => p.id === 'a').views, 120);
  assert.equal(merged.find((p) => p.id === 'a').as_of, '2026-10-18T03:00:00Z');
  assert.equal(merged.find((p) => p.id === 'old').views, 300);
  assert.equal(merged.find((p) => p.id === 'old').as_of, '2026-10-17T03:00:00Z');
});

test('пост, пропавший из середины выгрузки, удалён с профиля и убирается', () => {
  const saved = [post('c', 1, 10), post('deleted', 2, 999), post('a', 3, 100)];
  const fresh = [post('c', 1, 20), post('a', 3, 120)];
  assert.deepEqual(mergePosts(fresh, saved, 'x').map((p) => p.id), ['c', 'a']);
});

test('дата среза у сохранённого поста не перезаписывается', () => {
  const saved = [{ ...post('old', 30, 10), as_of: '2026-10-01T03:00:00Z' }];
  const [p] = mergePosts([], saved, '2026-10-18T03:00:00Z', '2026-10-17T03:00:00Z');
  assert.equal(p.as_of, '2026-10-01T03:00:00Z');
});

test('медиана - по 50 последним постам старше 48 часов, x медианы - у всех', () => {
  const posts = [
    post('fresh', 1, 10_000),                                          // меньше 48 ч - в медиану не идёт
    ...Array.from({ length: MEDIAN_WINDOW - 1 }, (_, i) => post(`r${i}`, 3 + i * 0.3, 100)),
    post('old', 40, 1_000),                                            // за окном 50 постов
  ];
  const base = withOutliers(posts, NOW);
  assert.equal(base.reel, 100);
  assert.equal(base.carousel, null);
  assert.equal(posts.at(-1).outlier, 10);
  assert.equal(posts[0].outlier, 100);
});

test('median', () => {
  assert.equal(median([3, 1, null, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});
