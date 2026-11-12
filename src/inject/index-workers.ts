// MAIN world entry of a site with the worker switch on (ADR-14).
import { start } from './start';
import { installWorkers } from './workers';

declare const __SLUICE_WORKER_RUNTIME__: string;

start((channel) => installWorkers(globalThis as Parameters<typeof installWorkers>[0], channel, __SLUICE_WORKER_RUNTIME__));
