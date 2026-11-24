// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit made, as [old path, new path] pairs, for section 2's `R` lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- lines of a file (SPEC.md section 3) ----

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(p: FileParts): string {
  if (p.lines.length === 0) return '';
  return p.lines.join(p.br) + (p.final ? p.br : '');
}

// ---- matching lines (SPEC.md section 5) ----

const trimTail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTail(a) === trimTail(b);
  return trimBoth(a) === trimBoth(b);
}

function occurrences(lines: string[], O: string[], tier: number, from: number, only?: (start: number) => boolean): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    if (only !== undefined && !only(i)) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(tier, lines[i + j]!, O[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with the positions there; null when it occurs at none. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0, only?: (start: number) => boolean): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, O, tier, from, only);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is; -1 when none. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(tier, lines[i]!, anchor)) return i;
    }
  }
  return -1;
}

/** One line of a replacement: a context line names its index in O, a new line has ctxAt -1. */
interface NEnt {
  ctxAt: number;
  text: string;
}

/** A body of context / old / new entries read as the old lines O and the new lines N. */
function bodyON(body: { k: string; text: string }[]): { O: string[]; N: NEnt[] } {
  const O: string[] = [];
  const N: NEnt[] = [];
  for (const e of body) {
    if (e.k === 'ctx') {
      N.push({ ctxAt: O.length, text: e.text });
      O.push(e.text);
    } else if (e.k === 'old') O.push(e.text);
    else if (e.k === 'new') N.push({ ctxAt: -1, text: e.text });
  }
  return { O, N };
}

/** The lines that take the place of the match at pos: context lines are the file's own, tier 2 re-indents the rest. */
function buildN(lines: string[], pos: number, O: string[], N: NEnt[], tier: number): string[] {
  const F = leadWs(pos < lines.length ? lines[pos]! : '');
  const P = leadWs(O.length > 0 ? O[0]! : '');
  return N.map((e) => {
    if (e.ctxAt >= 0) return lines[pos + e.ctxAt]!;
    let t = e.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    return t;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC.md section 6) ----

interface HunkEnt {
  k: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  rawEmpty: boolean;
}
interface Hunk {
  a: number;
  body: HunkEnt[];
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function bsAfterLastWrite(body: HunkEnt[]): boolean {
  let last = -1;
  body.forEach((e, idx) => {
    if (e.k === 'ctx' || e.k === 'new') last = idx;
  });
  return last >= 0 && last + 1 < body.length && body[last + 1]!.k === 'bs';
}

function applyHunks(parts: FileParts, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), parts.lines.length);
      const ins = buildN(parts.lines, at, O, N, 0);
      const atEnd = at === parts.lines.length;
      parts.lines.splice(at, 0, ...ins);
      if (atEnd) parts.final = !bsAfterLastWrite(h.body);
    } else {
      const found = findTier(parts.lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      for (const cand of found.at) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const repl = buildN(parts.lines, pos, O, N, found.tier);
      const atEnd = pos + O.length === parts.lines.length;
      parts.lines.splice(pos, O.length, ...repl);
      if (atEnd) parts.final = !bsAfterLastWrite(h.body);
    }
    d += N.length - O.length;
  }
}

/** The path after `--- ` or `+++ `: up to the first tab, spaces removed, /dev/null as null, a/ or b/ stripped. */
function headerPath(rest: string): string | null {
  let p = rest.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null | undefined; // undefined: no --- line seen; null: /dev/null
  plus: string | null | undefined;
  renFrom: string | null;
  renTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP: string | null = sec.minus !== undefined ? sec.minus : sec.renFrom !== null ? sec.renFrom : sec.gitOld;
  const newP: string | null = sec.plus !== undefined ? sec.plus : sec.renTo !== null ? sec.renTo : sec.gitNew;
  const creating = sec.newFile || oldP === null;
  const deleting = sec.delFile || newP === null;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (creating && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out: string[] = [];
      let bsLast = false;
      for (const h of sec.hunks) {
        h.body.forEach((e, idx) => {
          if (e.k === 'new') {
            out.push(e.text);
            const nx = h.body[idx + 1];
            bsLast = nx !== undefined && nx.k === 'bs';
          }
        });
      }
      tree.now.set(newP, out.length === 0 ? '' : out.join('\n') + (bsLast ? '' : '\n'));
      return;
    }
    if (deleting && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null || newP === null) return;
    const t = tree.get(oldP);
    if (t === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const parts = splitFile(t);
    applyHunks(parts, sec.hunks, strict, oldP);
    const out = joinFile(parts);
    if (newP !== oldP) {
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { gitOld: m[1]!, gitNew: m[2]!, minus: undefined, plus: undefined, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      const minus = headerPath(line.slice(4));
      const plus = headerPath(lines[i + 1]!.slice(4));
      if (sec !== null && inHeader && sec.minus === undefined) {
        sec.minus = minus;
        sec.plus = plus;
      } else {
        sec = { gitOld: null, gitNew: null, minus, plus, renFrom: null, renTo: null, newFile: false, delFile: false, hunks: [] };
        sections.push(sec);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(hm[1]!), body: [] };
      sec.hunks.push(hunk);
      inHeader = false;
      i += 1;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        const c = bl.charAt(0);
        if (bl === '') hunk.body.push({ k: 'ctx', text: '', rawEmpty: true });
        else if (c === ' ') hunk.body.push({ k: 'ctx', text: bl.slice(1), rawEmpty: false });
        else if (c === '-') hunk.body.push({ k: 'old', text: bl.slice(1), rawEmpty: false });
        else if (c === '+') hunk.body.push({ k: 'new', text: bl.slice(1), rawEmpty: false });
        else if (c === '\\') hunk.body.push({ k: 'bs', text: bl, rawEmpty: false });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.rawEmpty) hunk.body.pop();
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newL.length === 0 ? '' : `${newL.join('\n')}\n`);
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const parts = splitFile(t);
    const found = findTier(parts.lines, oldL, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const pos = found.at[0]!;
    const repl = buildN(parts.lines, pos, oldL, newL.map((text) => ({ ctxAt: -1, text })), found.tier);
    parts.lines.splice(pos, oldL.length, ...repl);
    tree.now.set(path, joinFile(parts));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchLine + 1}`);
    }
    let j = searchLine + 1;
    const oldL: string[] = [];
    let sep = false;
    while (j < n) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = true;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
      oldL.push(lines[j]!);
      j += 1;
    }
    if (!sep) throw new Exit2(`error: parse ${searchLine + 1}`);
    j += 1;
    const newL: string[] = [];
    let end = false;
    while (j < n) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = true;
        break;
      }
      newL.push(lines[j]!);
      j += 1;
    }
    if (!end) throw new Exit2(`error: parse ${searchLine + 1}`);
    prevPath = path;
    searchFrom = j + 1;
    i = j + 1;
    edits.push(srEdit(path, oldL, newL, strict));
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { k: 'ctx' | 'old' | 'new'; text: string }[];
}
interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'upd' && sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    let dest = p;
    if (sec.moveTo !== null) {
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      dest = sec.moveTo;
    }
    const parts = splitFile(t);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(parts.lines, ch.anchor, strict, cursor);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const at = ch.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        const ins = buildN(parts.lines, at, O, N, 0);
        parts.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findTier(parts.lines, O, strict, cursor, ch.eof ? (s) => s + O.length === parts.lines.length : undefined);
        if (found === null) throw new Fail('no-match', p);
        const pos = found.at[0]!;
        const repl = buildN(parts.lines, pos, O, N, found.tier);
        parts.lines.splice(pos, O.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const out = joinFile(parts);
    if (dest !== p) {
      tree.now.set(dest, out);
      tree.now.set(p, null);
      tree.moves.push([p, dest]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = n - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  interface Raw {
    text: string;
    line: number;
  }
  interface RawSec {
    kind: 'add' | 'del' | 'upd';
    path: string;
    line: number;
    raw: Raw[];
  }
  const rawSecs: RawSec[] = [];
  let cur: RawSec | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const head = line.startsWith('*** Add File: ')
      ? (['add', '*** Add File: '] as const)
      : line.startsWith('*** Delete File: ')
        ? (['del', '*** Delete File: '] as const)
        : line.startsWith('*** Update File: ')
          ? (['upd', '*** Update File: '] as const)
          : null;
    if (head !== null) {
      cur = { kind: head[0], path: line.slice(head[1].length).trim(), line: i + 1, raw: [] };
      rawSecs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: line, line: i + 1 });
  }
  const sections: VSection[] = rawSecs.map((rs) => {
    const raw = [...rs.raw];
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (rs.kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
      return { kind: 'add', path: rs.path, addLines, moveTo: null, chunks: [] };
    }
    if (rs.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
      return { kind: 'del', path: rs.path, addLines: [], moveTo: null, chunks: [] };
    }
    let idx = 0;
    let moveTo: string | null = null;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.text.slice(13).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    for (; idx < raw.length; idx++) {
      const r = raw[idx]!;
      const text = r.text;
      if (text.startsWith('@@')) {
        const anchor = text.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        chunks.push(chunk);
        continue;
      }
      if (text === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${r.line}`);
        chunk.eof = true;
        chunk = null;
        continue;
      }
      const c = text.charAt(0);
      if (text === '' || c === ' ' || c === '-' || c === '+') {
        if (chunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.line}`);
          chunk = { anchor: null, eof: false, body: [] };
          chunks.push(chunk);
        }
        chunk.body.push({ k: text === '' || c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: text === '' ? '' : text.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${r.line}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${rs.line}`);
    return { kind: 'upd', path: rs.path, addLines: [], moveTo, chunks };
  });
  return sections.map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [o, nw] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.has(o) ? tree.now.get(o)! : wasO;
    const wasN = tree.original(nw);
    const nowN = tree.now.has(nw) ? tree.now.get(nw)! : wasN;
    if (wasO !== null && nowO === null && wasN === null && nowN !== null && !covered.has(o) && !covered.has(nw)) {
      covered.add(o);
      covered.add(nw);
      rows.push({ key: nw, text: `R ${o} -> ${nw}` });
    }
  }
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (!covered.has(p)) rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
