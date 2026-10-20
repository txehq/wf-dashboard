import { describe, expect, test } from 'vitest';
import { TaskStore } from '../../src/index.ts';

function clock() {
  let t = 1_000;
  return () => (t += 10);
}

// 7 tasks: ids 1..7, createdAt 1010..1070
function seeded() {
  const store = new TaskStore(clock());
  store.add({ title: 'Write release notes', priority: 2 });
  store.add({ title: 'fix login bug', priority: 1 });
  store.add({ title: 'Banana bread recipe', priority: 3 });
  store.add({ title: 'Review LOGIN flow', priority: 1 });
  store.add({ title: 'apple pie', priority: 2 });
  store.add({ title: 'Cherry pick hotfix', priority: 1 });
  store.add({ title: 'Deploy', priority: 3 });
  store.complete(2);
  store.complete(5);
  return store;
}

const ids = (result: { items: { id: number }[] }) => result.items.map((t) => t.id);

describe('defaults', () => {
  test('no options lists everything by creation time, ascending', () => {
    const result = seeded().list();
    expect(ids(result)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result).toMatchObject({ total: 7, page: 1, pageSize: 20, totalPages: 1 });
  });

  test('empty store', () => {
    expect(new TaskStore(clock()).list()).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 0,
    });
  });

  test('items are full task objects', () => {
    const [first] = seeded().list({ pageSize: 1 }).items;
    expect(first).toEqual({
      id: 1,
      title: 'Write release notes',
      status: 'open',
      priority: 2,
      createdAt: 1010,
    });
  });
});

describe('filtering', () => {
  test('by status', () => {
    expect(ids(seeded().list({ status: 'done' }))).toEqual([2, 5]);
    expect(ids(seeded().list({ status: 'open' }))).toEqual([1, 3, 4, 6, 7]);
  });

  test('search is a case-insensitive substring match', () => {
    expect(ids(seeded().list({ search: 'login' }))).toEqual([2, 4]);
    expect(ids(seeded().list({ search: 'PIE' }))).toEqual([5]);
  });

  test('search ignores surrounding whitespace; blank search matches all', () => {
    expect(ids(seeded().list({ search: '  bread ' }))).toEqual([3]);
    expect(seeded().list({ search: '   ' }).total).toBe(7);
  });

  test('status and search combine', () => {
    expect(ids(seeded().list({ status: 'open', search: 'login' }))).toEqual([4]);
  });

  test('total counts all matches, not just the page', () => {
    const result = seeded().list({ status: 'open', pageSize: 2 });
    expect(result.total).toBe(5);
    expect(result.totalPages).toBe(3);
  });
});

describe('sorting', () => {
  test('priority ascending breaks ties by id', () => {
    expect(ids(seeded().list({ sort: 'priority' }))).toEqual([2, 4, 6, 1, 5, 3, 7]);
  });

  test('priority descending still breaks ties by ascending id', () => {
    expect(ids(seeded().list({ sort: 'priority', order: 'desc' }))).toEqual([3, 7, 1, 5, 2, 4, 6]);
  });

  test('title sorting ignores case', () => {
    expect(ids(seeded().list({ sort: 'title' }))).toEqual([5, 3, 6, 7, 2, 4, 1]);
  });

  test('createdAt descending', () => {
    expect(ids(seeded().list({ order: 'desc' }))).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  test('equal createdAt falls back to id', () => {
    const store = new TaskStore(() => 5);
    store.add({ title: 'b' });
    store.add({ title: 'a' });
    store.add({ title: 'c' });
    expect(ids(store.list({ order: 'desc' }))).toEqual([1, 2, 3]);
  });
});

describe('pagination', () => {
  test('pages are 1-based slices', () => {
    const store = seeded();
    expect(ids(store.list({ pageSize: 3, page: 1 }))).toEqual([1, 2, 3]);
    expect(ids(store.list({ pageSize: 3, page: 2 }))).toEqual([4, 5, 6]);
    expect(store.list({ pageSize: 3, page: 3 })).toMatchObject({
      total: 7,
      page: 3,
      pageSize: 3,
      totalPages: 3,
    });
    expect(ids(store.list({ pageSize: 3, page: 3 }))).toEqual([7]);
  });

  test('a page past the end is empty but keeps the totals', () => {
    expect(seeded().list({ pageSize: 3, page: 9 })).toEqual({
      items: [],
      total: 7,
      page: 9,
      pageSize: 3,
      totalPages: 3,
    });
  });

  test('pageSize up to 100 is accepted', () => {
    expect(seeded().list({ pageSize: 100 }).pageSize).toBe(100);
  });

  test('pagination applies after filtering and sorting', () => {
    expect(ids(seeded().list({ status: 'open', sort: 'priority', pageSize: 2, page: 2 }))).toEqual([
      1, 3,
    ]);
  });
});

describe('validation', () => {
  test.each([0, -1, 1.5, Number.NaN])('page %s is rejected', (page) => {
    expect(() => seeded().list({ page })).toThrow(RangeError);
  });

  test.each([0, 101, 2.5, Number.POSITIVE_INFINITY])('pageSize %s is rejected', (pageSize) => {
    expect(() => seeded().list({ pageSize })).toThrow(RangeError);
  });
});

describe('isolation', () => {
  test('mutating returned items does not change the store', () => {
    const store = seeded();
    const [first] = store.list().items;
    if (!first) throw new Error('missing');
    first.title = 'Mutated';
    first.status = 'done';
    expect(store.get(1)).toMatchObject({ title: 'Write release notes', status: 'open' });
  });

  test('listing does not change insertion order for later calls', () => {
    const store = seeded();
    store.list({ sort: 'title', order: 'desc' });
    expect(ids(store.list())).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
