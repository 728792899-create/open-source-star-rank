import { describe, expect, it } from 'vitest';
import { normalizeBasePath, parseRepositoryPath, safeReturnTo } from '../src/index';

describe('auth input validation', () => {
  it('normalizes and constrains return paths to the Pages base path', () => {
    expect(normalizeBasePath('/open-source-star-rank/')).toBe('/open-source-star-rank');
    expect(safeReturnTo('/open-source-star-rank/repo/1/?q=x', '/open-source-star-rank')).toBe('/open-source-star-rank/repo/1/?q=x');
    expect(safeReturnTo('https://evil.example/', '/open-source-star-rank')).toBe('/open-source-star-rank/');
    expect(safeReturnTo('/another-site/', '/open-source-star-rank')).toBe('/open-source-star-rank/');
  });

  it('accepts only safe GitHub owner/repository paths', () => {
    expect(parseRepositoryPath('/api/star/openai/codex')).toEqual({ owner: 'openai', repository: 'codex' });
    expect(parseRepositoryPath('/api/star/openai/codex/extra')).toBeNull();
    expect(parseRepositoryPath('/api/star/a%2Fb/repo')).toBeNull();
  });
});
