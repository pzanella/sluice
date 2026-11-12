// Ready rules for common tests. Each one opens as a normal rule in the form, so the user sees and can change every field.
import type { RuleDraft } from './rule-draft';

export interface RuleTemplate {
  id: string;
  label: string;
  /** Fields that differ from a new rule. */
  draft: Partial<RuleDraft>;
}

const UNI_ONLY = { datagram: false, uni: true, bidi: false };

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  { id: 'drop-key', label: 'MoQ: drop every key frame of a track', draft: { action: 'drop', kinds: UNI_ONLY, track: 'video', keyframe: 'key' } },
  { id: 'lose-frames', label: 'MoQ: lose 10% of the frames of a track', draft: { action: 'drop', kinds: UNI_ONLY, track: 'video', percent: '10' } },
  { id: 'delay-track', label: 'MoQ: delay a track by 500 ms', draft: { action: 'delay', kinds: UNI_ONLY, track: 'audio', delayMs: '500' } },
  { id: 'mute-track', label: 'MoQ: drop all frames of a track (a missing track)', draft: { action: 'drop', kinds: UNI_ONLY, track: 'audio' } },
  { id: 'hold-catalog', label: 'MoQ: hold the catalog, to edit it by hand', draft: { action: 'hold', kinds: UNI_ONLY, track: 'catalog.json', holdSeconds: '30', onTimeout: 'forward' } },
  { id: 'stall-key', label: 'MoQ: stall the session for 3 s at each key frame', draft: { action: 'stall', kinds: UNI_ONLY, track: 'video', keyframe: 'key', stallSeconds: '3' } },
  { id: 'close-sometimes', label: 'MoQ: close the session now and then (1% of video frames)', draft: { action: 'close-session', kinds: UNI_ONLY, track: 'video', percent: '1' } },
  { id: 'lose-datagrams', label: 'Lose 5% of datagrams', draft: { action: 'drop', kinds: { datagram: true, uni: false, bidi: false }, percent: '5' } },
  { id: 'log-sent', label: 'Log what the app sends', draft: { action: 'log', direction: 'out' } },
  { id: 'replace-text', label: 'Replace a text in the payload', draft: { action: 'modify-replace', find: 'old', replaceWith: 'new' } },
];
