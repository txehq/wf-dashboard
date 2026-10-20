export type Status = 'open' | 'done';
export type Priority = 1 | 2 | 3;

export interface Task {
  id: number;
  title: string;
  status: Status;
  /** 1 is the most urgent. */
  priority: Priority;
  /** Milliseconds since the epoch, taken from the store's clock. */
  createdAt: number;
}

export interface NewTask {
  title: string;
  priority?: Priority;
}

export type SortField = 'createdAt' | 'priority' | 'title';

export interface ListOptions {
  status?: Status;
  /** Case-insensitive substring match on the title. */
  search?: string;
  sort?: SortField;
  order?: 'asc' | 'desc';
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export interface ListResult {
  items: Task[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class TaskNotFoundError extends Error {
  constructor(readonly id: number) {
    super(`Task ${String(id)} not found`);
    this.name = 'TaskNotFoundError';
  }
}

const compareBy: Record<SortField, (a: Task, b: Task) => number> = {
  createdAt: (a, b) => a.createdAt - b.createdAt,
  priority: (a, b) => a.priority - b.priority,
  title: (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
};

function positiveInteger(name: string, value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer between 1 and ${String(max)}`);
  }
  return value;
}

export class TaskStore {
  readonly #tasks = new Map<number, Task>();
  #nextId = 1;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  add(input: NewTask): Task {
    const title = input.title.trim();
    if (title === '') throw new RangeError('title must not be empty');
    const task: Task = {
      id: this.#nextId++,
      title,
      status: 'open',
      priority: input.priority ?? 2,
      createdAt: this.#now(),
    };
    this.#tasks.set(task.id, task);
    return { ...task };
  }

  get(id: number): Task | undefined {
    const task = this.#tasks.get(id);
    return task && { ...task };
  }

  complete(id: number): Task {
    const task = this.#tasks.get(id);
    if (!task) throw new TaskNotFoundError(id);
    task.status = 'done';
    return { ...task };
  }

  remove(id: number): boolean {
    return this.#tasks.delete(id);
  }

  get size(): number {
    return this.#tasks.size;
  }

  list(options: ListOptions = {}): ListResult {
    const page = positiveInteger('page', options.page ?? 1);
    const pageSize = positiveInteger('pageSize', options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const sort = options.sort ?? 'createdAt';
    const direction = (options.order ?? 'asc') === 'asc' ? 1 : -1;
    const needle = options.search?.trim().toLowerCase() ?? '';

    const matching = [...this.#tasks.values()].filter(
      (task) =>
        (options.status === undefined || task.status === options.status) &&
        task.title.toLowerCase().includes(needle),
    );
    // Ties keep ascending id order in both directions so pages are stable.
    matching.sort((a, b) => direction * compareBy[sort](a, b) || a.id - b.id);

    const start = (page - 1) * pageSize;
    return {
      items: matching.slice(start, start + pageSize).map((task) => ({ ...task })),
      total: matching.length,
      page,
      pageSize,
      totalPages: Math.ceil(matching.length / pageSize),
    };
  }
}
