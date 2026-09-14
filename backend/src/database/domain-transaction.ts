import { EntityManager } from 'typeorm';
const writers = new WeakMap<object, Promise<unknown>>();
/** better-sqlite3 has one connection: unrelated async transactions must not share savepoints. */
export async function domainTransaction<T>(manager: EntityManager, work: (transaction: EntityManager) => Promise<T>): Promise<T> {
  const key = manager.connection ?? manager;
  const previous = writers.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => manager.transaction(work));
  writers.set(key, current);
  try { return await current; } finally { if (writers.get(key) === current) writers.delete(key); }
}
