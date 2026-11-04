import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy } from '../src/index.ts';

const ctx = {
  email: 'dinesh.nikam@example.com',
  displayName: 'Dinesh Nikam',
  blocklist: new Set(['correcthorsebatterystaple']),
};
const rules = (pw: string) => checkPasswordPolicy(pw, ctx).map((v) => v.rule);

describe('password policy (06 §4.3)', () => {
  it('accepts a long, unrelated passphrase with no composition rules', () => {
    expect(rules('purple monsoon ledger quietly')).toEqual([]);
  });

  it('counts code points after NFKC, and bounds length both ways', () => {
    expect(rules('short pass')).toEqual(['MIN_LENGTH']);
    expect(rules('ﬀﬀﬀﬀﬀﬀ')).toEqual([]); // six ligatures normalise to twelve letters
    expect(rules('a'.repeat(129))).toContain('MAX_LENGTH');
  });

  it('rejects blocklisted passwords, also with punctuation stripped, and product names', () => {
    expect(rules('Correct-Horse-Battery-Staple')).toEqual(['BLOCKLIST']);
    expect(rules('my tradesoft password')).toEqual(['BLOCKLIST']);
  });

  it('rejects the email local part and name tokens of four or more letters', () => {
    expect(rules('dinesh.nikam2026!!')).toEqual(['CONTEXT']);
    expect(rules('welcome nikam friend')).toEqual(['CONTEXT']);
  });
});
