// LineEditor: raw-mode editing logic (no TTY needed — feed key buffers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineEditor } from '../src/lineeditor.js';

function editor(overrides = {}) {
  const submitted = [];
  const e = new LineEditor({
    onSubmit: (l) => submitted.push(l),
    onExit: () => {},
    onCancel: () => {},
    ...overrides,
  });
  return { e, submitted };
}

const keys = {
  enter: '\r',
  bs: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  home: '\x1b[H',
  end: '\x1b[F',
  del: '\x1b[3~',
  ctrlW: '\x17',
  ctrlU: '\x15',
  ctrlA: '\x01',
  ctrlE: '\x05',
  ctrlC: '\x03',
  ctrlD: '\x04',
};

test('typing + submit', () => {
  const { e, submitted } = editor();
  for (const ch of 'hello world') e.handleKey(ch);
  assert.equal(e.handleKey(keys.enter), 'submit');
  assert.deepEqual(submitted, ['hello world']);
  assert.equal(e.buffer, '');
});

test('cursor movement + insert in middle', () => {
  const { e } = editor();
  for (const ch of 'abcd') e.handleKey(ch);
  e.handleKey(keys.left); e.handleKey(keys.left); // ab|cd
  assert.equal(e.cursor, 2);
  e.handleKey('X'); // abX|cd
  assert.equal(e.buffer, 'abXcd');
  assert.equal(e.cursor, 3);
});

test('backspace and delete', () => {
  const { e } = editor();
  for (const ch of 'abcd') e.handleKey(ch);
  e.handleKey(keys.bs); // abc
  assert.equal(e.buffer, 'abc');
  e.handleKey(keys.home);
  e.handleKey(keys.del); // bc
  assert.equal(e.buffer, 'bc');
  assert.equal(e.cursor, 0);
});

test('ctrl+W deletes word back', () => {
  const { e } = editor();
  for (const ch of 'hello  world') e.handleKey(ch);
  e.handleKey(keys.ctrlW); // remove 'world'
  assert.equal(e.buffer, 'hello  ');
  e.handleKey(keys.ctrlW); // remove trailing spaces + 'hello'
  assert.equal(e.buffer, '');
});

test('ctrl+U clears from cursor to line start', () => {
  const { e } = editor();
  for (const ch of 'hello') e.handleKey(ch);
  e.handleKey(keys.ctrlU); // cursor at end -> clears all
  assert.equal(e.buffer, '');
  for (const ch of 'hello') e.handleKey(ch);
  e.handleKey(keys.ctrlA); // cursor 0
  e.handleKey(keys.ctrlU); // nothing before cursor
  assert.equal(e.buffer, 'hello');
});

test('history up/down with draft restore', () => {
  const { e, submitted } = editor({ history: ['one', 'two'] });
  e.handleKey(keys.up); // 'two'
  assert.equal(e.buffer, 'two');
  e.handleKey(keys.up); // 'one'
  assert.equal(e.buffer, 'one');
  e.handleKey(keys.down); // 'two'
  assert.equal(e.buffer, 'two');
  e.handleKey(keys.down); // draft (empty)
  assert.equal(e.buffer, '');
  // draft saved while browsing
  for (const ch of 'draft') e.handleKey(ch);
  e.handleKey(keys.up);
  assert.equal(e.buffer, 'two');
  e.handleKey(keys.down);
  assert.equal(e.buffer, 'draft');
  assert.equal(submitted.length, 0);
});

test('submit pushes to history, no consecutive dup', () => {
  const { e } = editor();
  for (const ch of 'abc') e.handleKey(ch);
  e.handleKey(keys.enter);
  for (const ch of 'abc') e.handleKey(ch);
  e.handleKey(keys.enter);
  assert.deepEqual(e.history, ['abc']);
});

test('trailing backslash continues multi-line', () => {
  const { e, submitted } = editor();
  for (const ch of 'line1\\') e.handleKey(ch);
  assert.equal(e.handleKey(keys.enter), null); // no submit
  assert.equal(e.multiline, true);
  assert.equal(e.buffer, 'line1\n');
  for (const ch of 'line2') e.handleKey(ch);
  assert.equal(e.handleKey(keys.enter), 'submit');
  assert.deepEqual(submitted, ['line1\nline2']);
});

test('ctrl+C cancels non-empty line, exits on empty', () => {
  let exited = 0, cancelled = 0;
  const { e } = editor({ onExit: () => exited++, onCancel: () => cancelled++ });
  for (const ch of 'x') e.handleKey(ch);
  assert.equal(e.handleKey(keys.ctrlC), 'cancel');
  assert.equal(cancelled, 1);
  assert.equal(e.buffer, '');
  assert.equal(e.handleKey(keys.ctrlC), 'exit');
  assert.equal(exited, 1);
});

test('multi-line paste inserts verbatim', () => {
  const { e, submitted } = editor();
  e.handleKey('first line\nsecond line');
  assert.equal(e.buffer, 'first line\nsecond line');
  e.handleKey(keys.enter);
  assert.deepEqual(submitted, ['first line\nsecond line']);
});

test('ctrl+D exits on empty, deletes forward otherwise', () => {
  let exited = 0;
  const { e } = editor({ onExit: () => exited++ });
  assert.equal(e.handleKey(keys.ctrlD), 'exit');
  assert.equal(exited, 1);
  const { e: e2 } = editor();
  for (const ch of 'ab') e2.handleKey(ch);
  e2.handleKey(keys.ctrlA);
  e2.handleKey(keys.ctrlD);
  assert.equal(e2.buffer, 'b');
});
