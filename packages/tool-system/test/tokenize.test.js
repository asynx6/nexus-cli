// tokenizeCommand: quote-aware argv tokenizer for terminal.exec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeCommand } from '../src/tools/terminal.js';

test('simple command', () => {
  assert.deepEqual(tokenizeCommand('npm test'), ['npm', 'test']);
});

test('double-quoted arg with spaces', () => {
  assert.deepEqual(tokenizeCommand('python -c "print(6*7)"'), ['python', '-c', 'print(6*7)']);
});

test('single-quoted arg', () => {
  assert.deepEqual(tokenizeCommand("echo 'single quoted arg'"), ['echo', 'single quoted arg']);
});

test('escaped quote inside double quotes', () => {
  assert.deepEqual(tokenizeCommand('git commit -m "fix: \\"quoted\\" inside"'), ['git', 'commit', '-m', 'fix: "quoted" inside']);
});

test('empty and whitespace-only', () => {
  assert.deepEqual(tokenizeCommand(''), []);
  assert.deepEqual(tokenizeCommand('   '), []);
});

test('multiple spaces collapse', () => {
  assert.deepEqual(tokenizeCommand('a   b\t c'), ['a', 'b', 'c']);
});

test('adjacent quotes make empty arg', () => {
  assert.deepEqual(tokenizeCommand('echo "" x'), ['echo', '', 'x']);
});
