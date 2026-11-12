// A scenario is a file with the whole config of a site: rules, simulated network, seed. It goes through the same validator as any
// config, so a file cannot do more than the panel can.
import type { RuntimeConfig } from './rules';
import { validateConfig } from './validate';

const SCENARIO_FORMAT = 'sluice-scenario';
const SCENARIO_VERSION = 1;
export const MAX_SCENARIO_BYTES = 2 * 1024 * 1024;

interface ScenarioFile {
  format: typeof SCENARIO_FORMAT;
  version: typeof SCENARIO_VERSION;
  config: RuntimeConfig;
}

export const toScenario = (config: RuntimeConfig): ScenarioFile => ({ format: SCENARIO_FORMAT, version: SCENARIO_VERSION, config });

type ParsedScenario = { ok: true; config: RuntimeConfig } | { ok: false; errors: string[] };

export function parseScenario(text: string): ParsedScenario {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['This file is not JSON.'] };
  }
  const file = value as Partial<ScenarioFile> | null;
  if (typeof file !== 'object' || file === null || file.format !== SCENARIO_FORMAT) return { ok: false, errors: ['This file is not a Sluice scenario.'] };
  if (file.version !== SCENARIO_VERSION) return { ok: false, errors: [`This scenario has version ${String(file.version)}. This Sluice reads version ${SCENARIO_VERSION}.`] };
  const result = validateConfig(file.config);
  return result.ok ? { ok: true, config: result.value } : { ok: false, errors: result.errors };
}
