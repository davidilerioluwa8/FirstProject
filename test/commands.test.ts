import assert from 'node:assert/strict';
import { test } from 'node:test';
import { joinLink, parseCommand } from '../src/commands.js';

test('parses join commands, tolerating case, spacing and multi-word names', () => {
  assert.deepEqual(parseCommand('JOIN newsletter'), { type: 'join', slug: 'newsletter' });
  assert.deepEqual(parseCommand('  join   Prayer Group '), { type: 'join', slug: 'prayer-group' });
  assert.deepEqual(parseCommand('Subscribe NEWS!'), { type: 'join', slug: 'news' });
  assert.deepEqual(parseCommand('join'), { type: 'join', slug: '' });
});

test('parses leave commands', () => {
  assert.deepEqual(parseCommand('STOP newsletter'), { type: 'leave', slug: 'newsletter' });
  assert.deepEqual(parseCommand('stop'), { type: 'leave_all' });
  assert.deepEqual(parseCommand('Unsubscribe'), { type: 'leave_all' });
  assert.deepEqual(parseCommand('Stop promotions'), { type: 'leave', slug: 'promotions' });
});

test('parses help, lists and unknown text', () => {
  assert.deepEqual(parseCommand('LISTS'), { type: 'my_lists' });
  assert.deepEqual(parseCommand('my lists'), { type: 'my_lists' });
  assert.deepEqual(parseCommand('help'), { type: 'help' });
  assert.deepEqual(parseCommand('thanks for the update!'), { type: 'unknown' });
  assert.deepEqual(parseCommand('   '), { type: 'unknown' });
});

test('builds a wa.me link with the join keyword pre-filled', () => {
  assert.equal(joinLink('2348012345678', 'prayer-group'), 'https://wa.me/2348012345678?text=JOIN%20prayer-group');
});
