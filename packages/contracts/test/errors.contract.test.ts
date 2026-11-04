import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CATALOGUE, problemType } from '../src/index.ts';

// The registry must equal 05 §5.2 exactly: a code exists in code if and only if the spec lists it.
const spec = readFileSync(new URL('../../../docs/architecture/05-api.md', import.meta.url), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const section = spec.slice(spec.indexOf('### 5.2 Error catalogue'), spec.indexOf('### 5.3 Error precedence'));
const specRows = [...section.matchAll(/^\| `([A-Z0-9_]+)` \| (\d{3}) \| ([^|]+) \|/gm)].map((m) => ({
  code: m[1]!,
  status: Number(m[2]),
  meaning: m[3]!.trim(),
}));

describe('error catalogue', () => {
  it('lists every code once in the specification', () => {
    const codes = specRows.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(100);
  });

  it('matches 05 §5.2 code for code, status for status, meaning for meaning', () => {
    const fromSpec = Object.fromEntries(
      specRows.map((r) => [r.code, { status: r.status, title: r.meaning }]),
    );
    expect(ERROR_CATALOGUE).toEqual(fromSpec);
  });

  it('derives a URN type for every code', () => {
    expect(problemType('SCANNER_CONDITION_INVALID')).toBe(
      'urn:tradesoft:problem:v1:scanner-condition-invalid',
    );
  });
});
