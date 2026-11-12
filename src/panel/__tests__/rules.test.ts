import { describe, expect, it } from 'vitest';
import { readableError } from '../rules';

describe('readableError', () => {
  it.each([
    ['rules[0].match.minSize: must be a whole number', 0, 'minSize', 'Rule 1, Min size: must be a whole number'],
    ['rules[2].probability: must be between 0 and 1', 2, 'probability', 'Rule 3, Only this % of the time: must be between 0 and 100'],
    ['rules[1].action.ops[0].find: must not be empty', 1, 'find', 'Rule 2, Find: must not be empty'],
    ['rules[0].match.contains[0]: must not be empty', 0, 'contains', 'Rule 1, Payload contains: must not be empty'],
    ['rules[0].on: must have at least 1 item(s)', 0, 'on', 'Rule 1, Traffic kinds: choose at least one'],
  ])('%s', (error, ruleIndex, field, text) => {
    expect(readableError(error)).toEqual({ ruleIndex, field, text });
  });

  it('keeps a message that it does not know', () => {
    expect(readableError('value cannot be read')).toEqual({ ruleIndex: null, field: null, text: 'value cannot be read' });
  });
});
