import assert from 'node:assert/strict';
import test from 'node:test';

import { stripServerEnvelopes } from './serverEnvelope.ts';

/**
 * The server-owned markers that must not reach the operator's eyes: the
 * channel orchestrator's wall-clock stamp and the agent runtime's date/time
 * envelope. Both are the model's metadata, not the operator's words.
 */
test('the runtime date/time envelope is dropped', () => {
  assert.equal(
    stripServerEnvelopes(
      '[CURRENT DATE & TIME: 2026-10-21 12:00:49 +03:00]\n\nУ сериала фонари по обложкам',
    ),
    'У сериала фонари по обложкам',
  );
});

test('the channel wall-clock marker is dropped', () => {
  assert.equal(stripServerEnvelopes('[2026-09-16 03:15:01 MSK] Привет'), 'Привет');
});

test('an operator-authored bracketed tag survives', () => {
  assert.equal(
    stripServerEnvelopes('[URGENT] deploy the fix'),
    '[URGENT] deploy the fix',
  );
  assert.equal(
    stripServerEnvelopes('[CURRENT DATE & TIME: не моё] привет'),
    '[CURRENT DATE & TIME: не моё] привет',
  );
});

test('a datetime inside the message survives', () => {
  assert.equal(
    stripServerEnvelopes('лог: [2026-09-16 03:15:01 MSK] всё ок'),
    'лог: [2026-09-16 03:15:01 MSK] всё ок',
  );
});

test('plain content is untouched', () => {
  assert.equal(stripServerEnvelopes('обычное сообщение'), 'обычное сообщение');
});
