// Raw-mode line editor, zero deps (Fase 3). Feed key Buffers via handleKey();
// state is inspectable for tests. The host wires stdin/stdout.
//
// Keys: printable insert at cursor, Backspace, Ctrl+W (delete word back),
// Ctrl+U (clear), Ctrl+A/E + Home/End, Left/Right, Up/Down (history),
// Enter (submit; trailing `\` continues multi-line input), Ctrl+C (cancel
// line; empty line -> exit signal), multi-line paste inserts verbatim.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const HISTORY_FILE = join(homedir(), '.nexus', 'history');
const HISTORY_MAX = 500;

export function loadHistory() {
  try {
    return readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_MAX);
  } catch { return []; }
}

export function saveHistory(entries) {
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    writeFileSync(HISTORY_FILE, entries.slice(-HISTORY_MAX).join('\n') + '\n');
  } catch { /* history is best-effort */ }
}

export class LineEditor {
  /** @param {{ onSubmit: (line: string) => void, onExit: () => void,
   *    onCancel: () => void, history?: string[] }} opts */
  // callbacks are PUBLIC so the host can rewire them after construction
  onSubmit = () => {};
  onExit = () => {};
  onCancel = () => {};

  constructor({ onSubmit, onExit, onCancel, history = [] } = {}) {
    if (onSubmit) this.onSubmit = onSubmit;
    if (onExit) this.onExit = onExit;
    if (onCancel) this.onCancel = onCancel;
    this.#history = [...history];
    this.#histIdx = this.#history.length;
    this.#draft = '';
    this.reset();
  }

  #history; #histIdx; #draft = '';
  buffer = '';
  cursor = 0;
  multiline = false; // last submit was a `\` continuation

  reset() {
    this.buffer = '';
    this.cursor = 0;
    this.multiline = false;
    this.#histIdx = this.#history.length;
  }

  get history() { return [...this.#history]; }

  /** Feed one key chunk (Buffer/string). A chunk may be a single keystroke,
   *  an escape sequence, or a terminal paste (multiple lines at once).
   *  Returns 'submit' | 'cancel' | 'exit' | null. */
  handleKey(chunk) {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // multi-line paste: a newline with content after it (typing never does this)
    const nl = s.indexOf('\n');
    if (nl >= 0 && s.slice(nl + 1).trim().length > 0 && !s.startsWith('\x1b')) {
      this.#insert(s.replace(/\r\n/g, '\n'));
      return null;
    }
    // otherwise: process unit by unit (escape sequences stay whole)
    const units = s.match(/\x1b\[[A-Za-z0-9~]+|\x1b[A-Za-z]|[\s\S]/g) ?? [];
    let last = null;
    for (const u of units) last = this.#handleUnit(u);
    return last;
  }

  #handleUnit(s) {
    if (s.startsWith('\x1b')) return this.#handleEscape(s);
    const c = s.charCodeAt(0);
    if (c === 0x0d || c === 0x0a) return this.#submit(); // Enter (\r or \n)
    if (c === 0x7f || c === 0x08) return this.#backspace(); // Backspace
    if (c === 0x03) { // Ctrl+C
      if (this.buffer.length === 0) { this.onExit?.(); return 'exit'; }
      this.reset();
      this.onCancel?.();
      return 'cancel';
    }
    if (c === 0x17) return this.#deleteWordBack(); // Ctrl+W
    if (c === 0x15) { this.buffer = this.buffer.slice(this.cursor); this.cursor = 0; return null; } // Ctrl+U
    if (c === 0x01) { this.cursor = 0; return null; } // Ctrl+A
    if (c === 0x05) { this.cursor = this.buffer.length; return null; } // Ctrl+E
    if (c === 0x04) { // Ctrl+D: EOF on empty line
      if (this.buffer.length === 0) { this.onExit?.(); return 'exit'; }
      return this.#deleteForward();
    }
    if (c < 0x20) return null; // other control chars ignored
    this.#insert(s);
    return null;
  }

  #handleEscape(s) {
    if (s === '\x1b[A') return this.#historyPrev(); // Up
    if (s === '\x1b[B') return this.#historyNext(); // Down
    if (s === '\x1b[C') { if (this.cursor < this.buffer.length) this.cursor++; return null; } // Right
    if (s === '\x1b[D') { if (this.cursor > 0) this.cursor--; return null; } // Left
    if (s === '\x1b[H' || s === '\x1b[1~') { this.cursor = 0; return null; } // Home
    if (s === '\x1b[F' || s === '\x1b[4~') { this.cursor = this.buffer.length; return null; } // End
    if (s === '\x1b[3~') return this.#deleteForward(); // Delete
    return null;
  }

  #submit() {
    let line = this.buffer;
    if (line.endsWith('\\')) { // continuation: keep editing, keep newline
      this.buffer = line.slice(0, -1) + '\n';
      this.cursor = this.buffer.length;
      this.multiline = true;
      return null;
    }
    this.#pushHistory(line);
    this.reset();
    this.onSubmit?.(line);
    return 'submit';
  }

  #pushHistory(line) {
    const clean = line.trim();
    if (!clean) return;
    if (this.#history[this.#history.length - 1] === clean) return; // no dup of last
    this.#history.push(clean);
    if (this.#history.length > HISTORY_MAX) this.#history.shift();
    this.#histIdx = this.#history.length;
  }

  #historyPrev() {
    if (this.#histIdx <= 0) return null;
    if (this.#histIdx === this.#history.length) this.#draft = this.buffer; // save draft
    this.#histIdx--;
    this.buffer = this.#history[this.#histIdx] ?? '';
    this.cursor = this.buffer.length;
    return null;
  }

  #historyNext() {
    if (this.#histIdx >= this.#history.length) return null;
    this.#histIdx++;
    this.buffer = this.#histIdx === this.#history.length ? this.#draft : (this.#history[this.#histIdx] ?? '');
    this.cursor = this.buffer.length;
    return null;
  }

  #insert(text) {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    return null;
  }

  #backspace() {
    if (this.cursor === 0) return null;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
    return null;
  }

  #deleteForward() {
    if (this.cursor >= this.buffer.length) return null;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    return null;
  }

  #deleteWordBack() {
    if (this.cursor === 0) return null;
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cursor);
    this.cursor = i;
    return null;
  }
}
