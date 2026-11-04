/**
 * RFC 4180 CSV for imports (03 §2.2): quoted fields may hold the delimiter, quotes and line breaks; a
 * leading UTF-8 BOM is dropped; LF or CRLF line ends. Rows are returned as written, never padded.
 */
export interface CsvTable {
  header: string[];
  /** 1-based data row number and fields; `malformed` marks bad quoting. */
  rows: { rowNumber: number; fields: string[]; malformed: boolean }[];
}

export function parseCsv(text: string): CsvTable {
  const records: { fields: string[]; malformed: boolean }[] = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let malformed = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const endField = () => {
    fields.push(wasQuoted ? field : field.trim());
    field = '';
    wasQuoted = false;
  };
  const endRecord = () => {
    endField();
    // A blank line is not a row.
    if (!(fields.length === 1 && fields[0] === '' && !malformed)) records.push({ fields, malformed });
    fields = [];
    malformed = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') {
      // A quote is only legal at the start of a field.
      if (field.trim() !== '' || wasQuoted) malformed = true;
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (ch === ',') endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord();
    } else if (wasQuoted) {
      if (ch.trim() !== '') malformed = true;
    } else field += ch;
  }
  if (quoted) malformed = true;
  if (field !== '' || fields.length > 0 || wasQuoted) endRecord();
  const [header, ...data] = records;
  return {
    header: header?.fields ?? [],
    rows: data.map((r, i) => ({ rowNumber: i + 1, fields: r.fields, malformed: r.malformed })),
  };
}
