// String-aware JSONC: strips // and /* */ comments and trailing commas,
// then parses as JSON.
//
// Two passes on purpose. Deciding "is this comma trailing?" by looking ahead
// in the *original* text gets it wrong whenever a comment sits between the
// comma and the bracket -- the common
//     { "name": "bash-judge", ... },
//     // { "name": "list-and-inspect", "disabled": true },
//   ]
// then keeps a comma that really is trailing once the comment is gone.
// Stripping comments first and judging commas afterwards has no such blind spot.

function walk(text, onChar) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    const handled = onChar(c, i, text);
    if (handled === undefined) {
      out += c;
    } else {
      out += handled.emit;
      i = handled.skipTo ?? i;
    }
  }
  return out;
}

export function stripComments(text) {
  return walk(text, (c, i, src) => {
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      return { emit: '\n', skipTo: j - 1 };
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      return { emit: '', skipTo: j + 1 };
    }
    return undefined;
  });
}

export function stripTrailingCommas(text) {
  return walk(text, (c, i, src) => {
    if (c !== ',') return undefined;
    let j = i + 1;
    while (j < src.length && /\s/.test(src[j])) j++;
    return src[j] === '}' || src[j] === ']' ? { emit: '' } : undefined;
  });
}

export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripComments(text)));
}
