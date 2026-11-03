import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DomainError,
  importBatchMachine,
  instrumentMachine,
  isTerminal,
  jobMachine,
  scannerRunMachine,
  transition,
  userMachine,
  type StateMachine,
} from '../src';

// E1.1: each machine equals the Mermaid diagram in 01 §3, and every (state, event) pair is decided.
const spec = readFileSync(
  new URL('../../../docs/architecture/01-domain-model.md', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');

function diagram(heading: string) {
  const start = spec.indexOf(heading);
  if (start < 0) throw new Error(`missing heading ${heading}`);
  const block = /```mermaid\n([\s\S]*?)```/.exec(spec.slice(start))![1]!;
  const edges = [...block.matchAll(/^\s*(\[\*\]|\w+)\s*-->\s*(\[\*\]|\w+)/gm)].map(
    (m) => [m[1]!, m[2]!] as const,
  );
  return {
    initial: new Set(edges.filter(([a]) => a === '[*]').map(([, b]) => b)),
    terminal: new Set(edges.filter(([, b]) => b === '[*]').map(([a]) => a)),
    pairs: new Set(edges.filter(([a, b]) => a !== '[*]' && b !== '[*]').map(([a, b]) => `${a}->${b}`)),
  };
}

const cases: [string, StateMachine<string, string>][] = [
  ['### 3.1 Import batch', importBatchMachine],
  ['### 3.2 Job', jobMachine],
  ['### 3.3 Scanner run', scannerRunMachine],
  ['### 3.4 User account', userMachine],
  ['### 3.5 Instrument', instrumentMachine],
];

describe.each(cases)('%s', (heading, machine) => {
  const expected = diagram(heading);
  const states = [...new Set(machine.transitions.flatMap((t) => [t.from, t.to]))];
  const events = [...new Set(machine.transitions.map((t) => t.event))];

  it('has exactly the initial states, terminal states and edges of the specification', () => {
    expect(new Set(machine.initial)).toEqual(expected.initial);
    expect(new Set(machine.terminal)).toEqual(expected.terminal);
    expect(new Set(machine.transitions.map((t) => `${t.from}->${t.to}`))).toEqual(expected.pairs);
  });

  it('allows exactly the declared (state, event) pairs and rejects every other one', () => {
    for (const from of states) {
      for (const event of events) {
        const declared = machine.transitions.find((t) => t.from === from && t.event === event);
        if (declared) {
          expect(transition(machine, from, event)).toBe(declared.to);
        } else {
          expect(() => transition(machine, from, event)).toThrow(DomainError);
        }
      }
    }
  });

  it('never leaves a terminal state', () => {
    for (const state of machine.terminal) {
      expect(isTerminal(machine, state)).toBe(true);
      for (const event of events) {
        expect(() => transition(machine, state, event)).toThrow(DomainError);
      }
    }
  });
});

it('reports the catalogue conflict code', () => {
  expect(() => transition(importBatchMachine, 'COMPLETED', 'START_VALIDATION')).toThrow(
    expect.objectContaining({ code: 'IMPORT_BATCH_STATE_INVALID' }),
  );
});
