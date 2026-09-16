import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionDisplayTitle } from './sessionTitle.ts';

/**
 * The naming precedence every conversation surface shares: an operator-chosen
 * name, else the gateway's preview of the first user message, else the raw
 * session id. The gateway withholds `preview` when `name` is set, but the rule
 * is asserted against both being present so a future backend change cannot
 * silently flip which one the UI shows.
 */
test('an explicit name outranks the derived preview', () => {
  assert.equal(
    sessionDisplayTitle({ name: 'Desk ops', preview: 'hello there', session_id: 'gw_1' }),
    'Desk ops',
  );
});

test('the preview labels a session with no name', () => {
  assert.equal(
    sessionDisplayTitle({ preview: 'планета айфон на Таганке', session_id: 'gw_1' }),
    'планета айфон на Таганке',
  );
});

test('the session id is the last resort when there is nothing to show', () => {
  assert.equal(sessionDisplayTitle({ session_id: 'gw_1' }), 'gw_1');
  assert.equal(sessionDisplayTitle({ name: '   ', session_id: 'gw_1' }), 'gw_1');
  assert.equal(sessionDisplayTitle({ preview: '  ', session_id: 'gw_1' }), 'gw_1');
});
