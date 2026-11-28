const ESCAPE_BY_CHARACTER = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\u0007", "\\a"],
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\v", "\\v"],
  ["\f", "\\f"],
  ["\r", "\\r"],
]);

const CHARACTER_BY_ESCAPE: Record<string, number> = {
  '"': 0x22,
  "\\": 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

const QUOTE = '"';
const DELETE_CHARACTER = 0x7f;
const LOWEST_PRINTABLE = 0x20;
const BACKSLASH = 0x5c;

const utf8 = new TextEncoder();
// A leading U+FEFF is part of the filename, not an encoding marker.
const fromUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** Include the a/ or b/ prefix in the quoted token, as Git does. */
export function quoteGitPatchPath(path: string): string {
  let body = "";
  let quoting = false;
  for (const character of path) {
    const escape = ESCAPE_BY_CHARACTER.get(character);
    if (escape !== undefined) {
      body += escape;
      quoting = true;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code < LOWEST_PRINTABLE || code === DELETE_CHARACTER) {
      body += `\\${code.toString(8).padStart(3, "0")}`;
      quoting = true;
      continue;
    }
    body += character;
  }
  return quoting ? `${QUOTE}${body}${QUOTE}` : path;
}

// Octal escapes represent bytes; rejoin before UTF-8 decoding.
function decodeGitPathToken(token: string, decoder: typeof fromUtf8): string {
  const body =
    token.length >= 2 && token.startsWith(QUOTE) && token.endsWith(QUOTE)
      ? token.slice(1, -1)
      : token;
  if (!body.includes("\\")) return body;
  const bytes: Array<number> = [];
  // Encode literal runs together to preserve surrogate pairs.
  let literal = "";
  const flush = () => {
    if (literal.length === 0) return;
    bytes.push(...utf8.encode(literal));
    literal = "";
  };
  let at = 0;
  while (at < body.length) {
    const character = body.charAt(at);
    if (character !== "\\") {
      literal += character;
      at += 1;
      continue;
    }
    const escaped = body.charAt(at + 1);
    if (escaped === "") {
      flush();
      bytes.push(BACKSLASH);
      break;
    }
    const named = CHARACTER_BY_ESCAPE[escaped];
    if (named !== undefined) {
      flush();
      bytes.push(named);
      at += 2;
      continue;
    }
    const octal = body.slice(at + 1, at + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      flush();
      bytes.push(Number.parseInt(octal, 8));
      at += 4;
      continue;
    }
    literal += escaped;
    at += 2;
  }
  flush();
  return decoder.decode(new Uint8Array(bytes));
}

/** Unescape with or without quotes; client parsers strip them inconsistently across patch headers. */
export function unquoteGitPatchPath(token: string): string {
  return decodeGitPathToken(token, fromUtf8);
}

/** Returns null when Git's quoted bytes cannot be decoded as UTF-8. */
export function tryUnquoteGitPatchPath(token: string): string | null {
  try {
    return decodeGitPathToken(token, new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }));
  } catch {
    return null;
  }
}
