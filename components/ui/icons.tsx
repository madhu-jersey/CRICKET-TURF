/** Small inline icon set (stroke icons, inherit currentColor). Decorative unless a label is given. */
type P = React.SVGProps<SVGSVGElement> & { label?: string };

function Svg({ label, children, ...p }: P & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} {...p}>
      {children}
    </svg>
  );
}

export const CricketIcon = (p: P) => (
  <Svg {...p}>
    <g transform="rotate(40 12 12)">
      <rect x="9.3" y="1.5" width="5.4" height="13.5" rx="2" />
      <path d="M12 15v7" strokeWidth={2.4} />
    </g>
    <circle cx="5" cy="6" r="2.4" />
  </Svg>
);
export const PaddleIcon = (p: P) => (
  <Svg {...p}>
    <ellipse cx="10" cy="9" rx="5.8" ry="7" transform="rotate(-38 10 9)" />
    <path d="M14.2 14.6l5.3 6" strokeWidth={2.4} />
    <circle cx="19.5" cy="4.8" r="1.9" />
  </Svg>
);
export const SunriseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M17 18a5 5 0 00-10 0M12 2v7M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1M8 6l4-4 4 4" />
  </Svg>
);
export const SunIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.5" />
    <path d="M12 1.5v2M12 20.5v2M4.6 4.6L6 6M18 18l1.4 1.4M1.5 12h2M20.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
  </Svg>
);
export const SunsetIcon = (p: P) => (
  <Svg {...p}>
    <path d="M17 18a5 5 0 00-10 0M12 9V2M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1M16 5l-4 4-4-4" />
  </Svg>
);
export const MoonIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
  </Svg>
);
export const CalendarIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="17" rx="2.5" />
    <path d="M16 2.5v4M8 2.5v4M3 10h18" />
  </Svg>
);
export const ClockIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9.5" />
    <path d="M12 6.5V12l3.5 2" />
  </Svg>
);
export const UserIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0116 0" />
  </Svg>
);
export const PhoneIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <path d="M11 18h2" />
  </Svg>
);
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12.5l5 5 10-11" />
  </Svg>
);
export const XIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const ShieldIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </Svg>
);
export const CourtIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <path d="M12 4v16M3 12h18" />
  </Svg>
);
export const ArrowDownIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);
export const GiftIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="8" width="18" height="5" rx="1" />
    <path d="M5 13v8h14v-8M12 8v13M12 8S10.5 3 8 3.5 7.5 8 12 8zm0 0s1.5-5 4-4.5S16.5 8 12 8z" />
  </Svg>
);
