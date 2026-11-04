import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/reference/csv.ts';

describe('reference CSV parsing (03 §2.2)', () => {
  it('reads quoted delimiters, quotes and line breaks, drops a BOM and blank lines', () => {
    const t = parseCsv('﻿symbol, name\r\nTCS,"Tata ""Consultancy"", Services"\n\nINFY,"Infosys\nLtd"\n');
    expect(t.header).toEqual(['symbol', 'name']);
    expect(t.rows).toEqual([
      { rowNumber: 1, fields: ['TCS', 'Tata "Consultancy", Services'], malformed: false },
      { rowNumber: 2, fields: ['INFY', 'Infosys\nLtd'], malformed: false },
    ]);
  });

  it('marks bad quoting as malformed and keeps the true column count', () => {
    const t = parseCsv('a,b\nx"y",z\n"open,w\n');
    expect(t.rows[0]).toMatchObject({ malformed: true });
    expect(t.rows[0]!.fields).toHaveLength(2);
    expect(t.rows[1]).toMatchObject({ malformed: true });
    expect(parseCsv('a,b\n1,2,3').rows[0]!.fields).toHaveLength(3);
  });

  it('returns no rows for a header-only file', () => {
    expect(parseCsv('a,b\n').rows).toEqual([]);
  });
});
