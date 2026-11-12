import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, type RuntimeConfig } from '../rules';
import { parseScenario, toScenario } from '../scenario';

describe('scenario files', () => {
  it('reads back what it wrote', () => {
    const config: RuntimeConfig = { ...DEFAULT_CONFIG, seed: 5, rules: [{ id: 'r', match: { moqt: { groupMin: 1 } }, action: { type: 'drop' } }] };
    expect(parseScenario(JSON.stringify(toScenario(config)))).toEqual({ ok: true, config });
  });

  it('reads the file of the Playwright example', () => {
    expect(parseScenario(readFileSync('examples/playwright/lossy.scenario.json', 'utf8')).ok).toBe(true);
  });

  it.each([
    ['{', 'not JSON'],
    ['null', 'not a Sluice scenario'],
    ['[]', 'not a Sluice scenario'],
    ['{"format":"other"}', 'not a Sluice scenario'],
    ['{"format":"sluice-scenario","version":2,"config":{}}', 'version 2'],
  ])('refuses %s', (text, message) => {
    const result = parseScenario(text);
    expect(result.ok === false && result.errors[0]).toContain(message);
  });

  it('refuses a config that the validator refuses', () => {
    const bad = { ...toScenario(DEFAULT_CONFIG), config: { ...DEFAULT_CONFIG, rules: [{ id: 'r', action: { type: 'run-code' } }] } };
    expect(parseScenario(JSON.stringify(bad)).ok).toBe(false);
    expect(parseScenario('{"format":"sluice-scenario","version":1}').ok).toBe(false);
  });
});
