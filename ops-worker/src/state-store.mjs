// Only small operations metadata lives in D1. Repository history stays on GitHub.
export class D1StateStore {
  constructor(db) { this.db = db; }
  checkKey(key) {
    if (!/^(monitor\/latest\.json|locks\/monitor|(?:recovery|backup-dispatch)\/\d{4}-\d{2}-\d{2}\.json)$/.test(key)) {
      throw new Error('Unsupported operations state key');
    }
  }
  async get(key) {
    this.checkKey(key);
    const row = await this.db.prepare('SELECT value, revision FROM operations_state WHERE key = ?1').bind(key).first();
    return row ? {etag: String(row.revision), json: async () => JSON.parse(row.value)} : null;
  }
  async put(key, value, options = {}) {
    this.checkKey(key);
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 65536) throw new Error('Operations state too large');
    JSON.parse(value);
    let statement;
    if (options.onlyIf?.etagDoesNotMatch === '*') {
      statement = this.db.prepare('INSERT INTO operations_state (key, value, revision) VALUES (?1, ?2, 1) ON CONFLICT(key) DO NOTHING').bind(key, value);
    } else if (options.onlyIf?.etagMatches !== undefined) {
      const revision = Number(options.onlyIf.etagMatches);
      if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid state revision');
      statement = this.db.prepare('UPDATE operations_state SET value = ?2, revision = revision + 1 WHERE key = ?1 AND revision = ?3').bind(key, value, revision);
    } else {
      statement = this.db.prepare('INSERT INTO operations_state (key, value, revision) VALUES (?1, ?2, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, revision = operations_state.revision + 1').bind(key, value);
    }
    const result = await statement.run();
    if (!result.success) throw new Error('Operations state write failed');
    return result.meta.changes === 1 ? {stored: true} : null;
  }
}
export function stateStore(env) {
  if (env.STATE_DB) return new D1StateStore(env.STATE_DB);
  // Compatibility for an explicitly configured R2 deployment.
  if (env.BACKUP_MODE === 'r2' && env.STORE) return env.STORE;
  throw new Error('Operations state storage not configured');
}
