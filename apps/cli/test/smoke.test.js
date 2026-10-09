import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('cli skeleton loads', () => {
  assert.strictEqual(NAME, '@asynx6/cli');
});
