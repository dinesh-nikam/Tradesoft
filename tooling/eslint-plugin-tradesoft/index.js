// Field names that carry numeric(...) or bigint values in the database and therefore travel as strings
// (05 §4.1, ADR-005). Integers (counts, ranks, limits) are deliberately absent.
const DECIMAL_FIELD =
  /^(open|high|low|close|price|value|ratio|score|percentile|slope|turnover|volume|factor|tickSize|openInterest)$|(Price|Pct|Percent|Volume|Turnover|Ratio|Slope|Factor)$|^(sma|ema|rsi|adx|atr|bb|di|avgVolume)[A-Z0-9_]/;

const NUMBER_FACTORIES = new Set(['number', 'bigint', 'int', 'int32', 'float32', 'float64']);

function keyName(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

// z.number().min(0).optional() -> the innermost z.number() call
function zodFactory(node) {
  let current = node;
  while (
    current.type === 'CallExpression' &&
    current.callee.type === 'MemberExpression' &&
    current.callee.object.type === 'CallExpression'
  ) {
    current = current.callee.object;
  }
  if (
    current.type === 'CallExpression' &&
    current.callee.type === 'MemberExpression' &&
    current.callee.object.type === 'Identifier' &&
    current.callee.object.name === 'z' &&
    current.callee.property.type === 'Identifier'
  ) {
    return current.callee.property.name;
  }
  return null;
}

const decimalDiscipline = {
  meta: {
    type: 'problem',
    docs: { description: 'Decimal and bigint fields must be decimal strings on the wire (05 §4.1).' },
    messages: {
      decimalAsNumber:
        'Field "{{name}}" holds a decimal or bigint value and must be a string on the wire (05 §4.1, ADR-005). Use decimalString() or int64String.',
    },
    schema: [],
  },
  create(context) {
    const report = (node, name) => context.report({ node, messageId: 'decimalAsNumber', data: { name } });
    return {
      Property(node) {
        const name = keyName(node.key);
        if (!name || !DECIMAL_FIELD.test(name)) return;
        const factory = zodFactory(node.value);
        if (factory && NUMBER_FACTORIES.has(factory)) report(node, name);
      },
      TSPropertySignature(node) {
        const name = keyName(node.key);
        const type = node.typeAnnotation?.typeAnnotation?.type;
        if (name && DECIMAL_FIELD.test(name) && (type === 'TSNumberKeyword' || type === 'TSBigIntKeyword')) {
          report(node, name);
        }
      },
    };
  },
};

export default {
  meta: { name: 'eslint-plugin-tradesoft' },
  rules: { 'decimal-discipline': decimalDiscipline },
};
