/** One run of terminal text with the SGR attributes in effect (colours are 0–15 palette indices). */
export interface AnsiSegment {
  text: string;
  fg?: number;
  bg?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const ESC = String.fromCharCode(27);
// CSI sequences (colours, cursor moves) and OSC sequences (titles, hyperlinks).
const SEQ = new RegExp(
  `${ESC}\\[([0-9;?]*)([@-~])|${ESC}\\][^${String.fromCharCode(7)}${ESC}]*(?:${String.fromCharCode(7)}|${ESC}\\\\)?`,
  'g',
);

/** 256-colour index → nearest of the 16 base colours (only the first 16 map exactly). */
const base16 = (n: number) => (n < 16 ? n : undefined);

function applySgr(params: number[], s: Omit<AnsiSegment, 'text'>) {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      delete s.fg;
      delete s.bg;
      delete s.bold;
      delete s.italic;
      delete s.underline;
    } else if (p === 1) s.bold = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 22) delete s.bold;
    else if (p === 23) delete s.italic;
    else if (p === 24) delete s.underline;
    else if (p >= 30 && p <= 37) s.fg = p - 30;
    else if (p >= 90 && p <= 97) s.fg = p - 90 + 8;
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = p - 40;
    else if (p >= 100 && p <= 107) s.bg = p - 100 + 8;
    else if (p === 49) delete s.bg;
    else if (p === 38 || p === 48) {
      // 38;5;n / 38;2;r;g;b — keep palette colours, skip true colour.
      const key = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5) {
        const c = base16(params[i + 2] ?? 0);
        if (c === undefined) delete s[key];
        else s[key] = c;
        i += 2;
      } else if (params[i + 1] === 2) i += 4;
    }
  }
}

/** Split terminal output into styled segments; non-colour escape sequences are dropped. */
export function parseAnsi(text: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  const style: Omit<AnsiSegment, 'text'> = {};
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    const same =
      prev &&
      prev.fg === style.fg &&
      prev.bg === style.bg &&
      prev.bold === style.bold &&
      prev.italic === style.italic &&
      prev.underline === style.underline;
    if (same) prev.text += t;
    else out.push({ text: t, ...style });
  };
  for (const m of text.matchAll(SEQ)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === 'm')
      applySgr(
        (m[1] || '0').split(';').map((x) => Number(x) || 0),
        style,
      );
  }
  push(text.slice(last));
  return out;
}

/** Plain text without any escape sequences (for copying and searching). */
export const stripAnsi = (text: string) => text.replace(SEQ, '');

/**
 * Apply carriage returns the way a terminal does, so progress bars (tqdm) collapse to their last
 * state instead of piling up: text after a lone `\r` replaces the start of the current line.
 */
export function collapseCR(text: string): string {
  if (!text.includes('\r')) return text;
  const lines = text.split('\n');
  return lines
    .map((line, i) => {
      const parts = line.split('\r');
      if (parts.length === 1) return line;
      // `\r\n` leaves an empty last part: keep what was on the line.
      let cur = '';
      for (const p of parts) cur = p + cur.slice(p.length);
      // A trailing `\r` still applies to text that arrives in the next chunk.
      return i === lines.length - 1 && line.endsWith('\r') ? `${cur}\r` : cur;
    })
    .join('\n');
}
