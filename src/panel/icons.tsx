// Line icons of the panel: 24 × 24, a 1.75 px stroke in the current color, round ends. Drawn for Sluice.
import type { ComponentChildren, JSX } from 'preact';

function Icon({ children, label }: { children: ComponentChildren; label?: string }) {
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
    >
      {children}
    </svg>
  );
}

/** A speed gauge. `level` from 0 (slow) to 1 (fast) turns the needle. */
export function GaugeIcon({ level }: { level: number }) {
  const angle = Math.PI * (1 - Math.max(0, Math.min(1, level)));
  const x = 12 + 7 * Math.cos(angle);
  const y = 16 - 7 * Math.sin(angle);
  return (
    <Icon>
      <path d="M3.5 16a8.5 8.5 0 0 1 17 0" />
      <line x1="12" y1="16" x2={x.toFixed(2)} y2={y.toFixed(2)} />
      <circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export const ICONS: Record<string, () => JSX.Element> = {
  // Network
  none: () => (
    <Icon>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.8-5" />
    </Icon>
  ),
  wifi: () => (
    <Icon>
      <path d="M4 9.5a12 12 0 0 1 16 0" />
      <path d="M7 12.8a7.5 7.5 0 0 1 10 0" />
      <path d="M10 16a3 3 0 0 1 4 0" />
      <circle cx="12" cy="19" r="0.9" fill="currentColor" stroke="none" />
    </Icon>
  ),
  mobile: () => (
    <Icon>
      <rect x="7" y="3" width="10" height="18" rx="2.5" />
      <path d="M11 17.5h2" />
    </Icon>
  ),
  slow: () => (
    <Icon>
      <path d="M4 18h16" />
      <path d="M6 18V14M10 18v-6M14 18v-3M18 18v-1" />
    </Icon>
  ),
  bad: () => (
    <Icon>
      <path d="M7 16.5a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17 8.6a3.6 3.6 0 0 1 .4 7.2" />
      <path d="m12.5 12-2 3.5h3l-2 3.5" />
    </Icon>
  ),
  // Quick tests
  'lose-frames': () => (
    <Icon>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M8 5v14M16 5v14" stroke-dasharray="2 2" />
      <path d="m10.5 10 3 4M13.5 10l-3 4" />
    </Icon>
  ),
  'drop-key': () => (
    <Icon>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H20M17 12v3M20 12v2.5" />
      <path d="M4 20 20 4" />
    </Icon>
  ),
  'delay-track': () => (
    <Icon>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9v4l2.5 2" />
      <path d="M9.5 3h5" />
    </Icon>
  ),
  'mute-track': () => (
    <Icon>
      <path d="M4 9.5h3L11.5 6v12L7 14.5H4z" />
      <path d="m15.5 9.5 5 5M20.5 9.5l-5 5" />
    </Icon>
  ),
  rebuffer: () => (
    <Icon>
      <path d="M12 3.5a8.5 8.5 0 1 1-8.2 6.3" />
      <path d="M10 9.5v5M14 9.5v5" />
    </Icon>
  ),
  reconnect: () => (
    <Icon>
      <path d="M19.5 9A8 8 0 0 0 5.2 7.4L4 9" />
      <path d="M4 4.5V9h4.5" />
      <path d="M4.5 15a8 8 0 0 0 14.3 1.6L20 15" />
      <path d="M20 19.5V15h-4.5" />
    </Icon>
  ),
  'hold-catalog': () => (
    <Icon>
      <path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" />
      <path d="M14 3.5V8h4" />
      <path d="M9 13h6M9 16.5h4" />
    </Icon>
  ),
  'lose-datagrams': () => (
    <Icon>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="10" cy="12" r="1.6" />
      <path d="m14 10 4 4M18 10l-4 4" />
    </Icon>
  ),
  custom: () => (
    <Icon>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </Icon>
  ),
};
