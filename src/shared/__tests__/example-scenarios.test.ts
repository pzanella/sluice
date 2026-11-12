// The scenario files of `examples/scenarios` are in the docs. They must stay valid.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../scenario';

const dir = join(__dirname, '../../../examples/scenarios');

describe('example scenarios', () => {
  it.each(readdirSync(dir).filter((name) => name.endsWith('.json')))('%s is a valid scenario', (name) => {
    const parsed = parseScenario(readFileSync(join(dir, name), 'utf8'));
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });
});
