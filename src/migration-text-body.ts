// This intentionally conservative check proves only the body-only migration case.
// It is not a general HTML sanitizer and does not change stored chapter content.
const resourceTags = new Set(['img', 'picture', 'source', 'video', 'audio', 'svg', 'image', 'object', 'embed',
  'iframe', 'frame', 'frameset', 'canvas', 'script', 'link', 'base', 'meta', 'applet', 'input', 'form']);
const resourceAttributes = new Set(['src', 'srcset', 'poster', 'background', 'srcdoc', 'data', 'codebase', 'archive', 'xlink:href']);
const namedEntities: Record<string, string> = { amp: '&', quot: '"', apos: "'", colon: ':', sol: '/', bsol: '\\', lpar: '(', rpar: ')', tab: '\t', newline: '\n' };

function decodeAttribute(value: string): string {
  return value.replace(/&(?:#(x[0-9a-f]+|\d+)|([a-z]+));?/gi, (match, numeric: string | undefined, named: string | undefined) => {
    if (numeric) {
      const code = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number.parseInt(numeric, 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    }
    return namedEntities[named!.toLowerCase()] ?? match;
  });
}
function unsafeCss(value: string): boolean {
  return /[<>]|\\|\/\*|@import|(?:url|image|image-set|expression)\s*\(/i.test(value);
}
function safeAttributes(value: string): boolean {
  let remaining = value;
  while (remaining.trim()) {
    remaining = remaining.trimStart();
    if (remaining === '/') return true;
    const name = /^[^\s"'=<>/\x60]+/.exec(remaining)?.[0];
    if (!name) return false;
    remaining = remaining.slice(name.length).trimStart();
    let attribute = '';
    if (remaining[0] === '=') {
      remaining = remaining.slice(1).trimStart();
      const quote = remaining[0];
      if (quote === '"' || quote === "'") {
        const end = remaining.indexOf(quote, 1);
        if (end < 0) return false;
        attribute = remaining.slice(1, end); remaining = remaining.slice(end + 1);
      } else {
        const unquoted = /^[^\s"'=<>\x60]+/.exec(remaining)?.[0];
        if (!unquoted) return false;
        attribute = unquoted; remaining = remaining.slice(unquoted.length);
      }
    }
    const normalized = name.toLowerCase();
    const decoded = decodeAttribute(attribute);
    if (resourceAttributes.has(normalized) || /^on[a-z]/.test(normalized)) return false;
    if (normalized === 'style' && unsafeCss(decoded)) return false;
    if (normalized === 'href' && /^(?:javascript|vbscript|data):/i.test(decoded.replace(/[\u0000-\u0020\u007f]/g, ''))) return false;
  }
  return true;
}

export function isMigrationTextBody(bytes: Uint8Array, contentType = 'html'): boolean {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return false; }
  if (!text.trim() || text.includes('\0') || (contentType === 'markdown' && /!\s*\[/.test(text))) return false;
  let offset = 0;
  while (true) {
    const start = text.indexOf('<', offset);
    if (start < 0) return true;
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      if (end < 0 || /[<>]/.test(text.slice(start + 4, end))) return false;
      offset = end + 3; continue;
    }
    const declaration = /^<!doctype\s+html\s*>/i.exec(text.slice(start));
    if (declaration) { offset = start + declaration[0].length; continue; }
    if (/^<[!?]/.test(text.slice(start))) return false;
    const tag = /^<(\/?)([a-z][a-z0-9:-]*)/i.exec(text.slice(start));
    if (!tag) { offset = start + 1; continue; }
    const name = tag[2].toLowerCase();
    if (resourceTags.has(name) || name.includes(':')) return false;
    let end = start + tag[0].length;
    let quote = '';
    for (; end < text.length; end++) {
      const character = text[end];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') return false;
    }
    if (end === text.length || quote) return false;
    const attributes = text.slice(start + tag[0].length, end);
    if (tag[1] ? attributes.trim() !== '' : !safeAttributes(attributes)) return false;
    offset = end + 1;
    if (name === 'style' && !tag[1]) {
      const closing = /<\/style\s*>/ig; closing.lastIndex = offset;
      const match = closing.exec(text);
      if (!match || unsafeCss(text.slice(offset, match.index))) return false;
      offset = closing.lastIndex;
    }
  }
}
