import { test } from 'node:test';
import assert from 'node:assert';
import { NAME } from '../index.js';

test('sandbox-runtime skeleton loads', () => {
  assert.strictEqual(NAME, '@asynx6/nexus-sandbox-runtime');
});
