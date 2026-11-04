import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// E1.2: the repository's real ESLint configuration rejects each forbidden pattern.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const eslint = new ESLint({ cwd: root });

async function ruleIds(code, file) {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  return result.messages.map((m) => m.ruleId);
}

// The first lint builds the typed program for the whole repository, which takes seconds.
describe('package boundaries', { timeout: 30_000 }, () => {
  it('rejects a deep import into another package', async () => {
    const ids = await ruleIds(
      "import { x } from '@tradesoft/db/internal/repo';\nexport { x };\n",
      'packages/domain/src/fixture.ts',
    );
    // Both the deep-import and the domain-layer pattern match; either alone fails the build.
    expect(new Set(ids)).toEqual(new Set(['no-restricted-imports']));
  });

  it('rejects a relative import into another package', async () => {
    const ids = await ruleIds(
      "import { x } from '../../contracts/src/index';\nexport { x };\n",
      'packages/domain/src/a/fixture.ts',
    );
    expect(ids).toEqual(['no-restricted-imports']);
  });

  it('allows the public entrypoint', async () => {
    const ids = await ruleIds(
      "import { timeframe } from '@tradesoft/contracts';\nexport { timeframe };\n",
      'packages/domain/src/fixture.ts',
    );
    expect(ids).toEqual([]);
  });

  it('forbids I/O modules and the clock in domain', async () => {
    const ids = await ruleIds(
      "import { readFileSync } from 'node:fs';\nexport const t = Date.now() + readFileSync('x').length;\n",
      'packages/domain/src/fixture.ts',
    );
    expect(ids.sort()).toEqual(['no-restricted-imports', 'no-restricted-syntax']);
  });

  it('forbids contracts from importing any workspace package', async () => {
    const ids = await ruleIds(
      "import { x } from '@tradesoft/domain';\nexport { x };\n",
      'packages/contracts/src/fixture.ts',
    );
    expect(ids).toEqual(['no-restricted-imports']);
  });
});

describe('decimal discipline', () => {
  it('rejects a price typed as z.number() in contracts, but not an integer rank', async () => {
    const ids = await ruleIds(
      "import { z } from 'zod';\nexport const bar = z.object({ close: z.number().min(0), rank: z.number().int() });\n",
      'packages/contracts/src/fixture.ts',
    );
    expect(ids).toEqual(['tradesoft/decimal-discipline']);
  });

  it('rejects a price typed as number in a contracts interface', async () => {
    const ids = await ruleIds(
      'export interface Bar {\n  highPrice: number;\n  memberCount: number;\n}\n',
      'packages/contracts/src/fixture.ts',
    );
    expect(ids).toEqual(['tradesoft/decimal-discipline']);
  });
});
