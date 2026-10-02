// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { HostKind } from '@hopdeck/core';
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

/** 24×24 line icons drawn with currentColor; decorative unless given a label by the caller. */
function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

/** A shield with filter lines: the hopdeck mark. */
export const LogoIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z" />
    <path d="M8.5 10h7M9.75 13h4.5M11 16h2" />
  </Svg>
);

export const SunIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" />
  </Svg>
);

export const MoonIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" />
  </Svg>
);

export const MonitorIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8.5 20h7M12 16v4" />
  </Svg>
);

export const PlusIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const ServerIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3.5" y="4" width="17" height="7" rx="2" />
    <rect x="3.5" y="13" width="17" height="7" rx="2" />
    <path d="M7.5 7.5h.01M7.5 16.5h.01" />
  </Svg>
);

export const LaptopIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
    <path d="M2.5 19h19" />
  </Svg>
);

export const SandboxIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
  </Svg>
);

export const RefreshIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1" />
    <path d="M17.5 3v4h-4M6.5 21v-4h4" />
  </Svg>
);

export const TrashIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L17.5 7M9.5 7V4.5h5V7" />
  </Svg>
);

export const EditIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4.5 19.5l.9-3.9L15.8 5.2a1.8 1.8 0 0 1 2.6 0l.4.4a1.8 1.8 0 0 1 0 2.6L8.4 18.6z" />
    <path d="M13.8 7.2l3 3" />
  </Svg>
);

export const CopyIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
);

export const ArrowUpIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 19V5M6.5 10.5L12 5l5.5 5.5" />
  </Svg>
);

export const ArrowDownIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 5v14M6.5 13.5L12 19l5.5-5.5" />
  </Svg>
);

export const LockIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
  </Svg>
);

export const UnlockIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2" />
  </Svg>
);

export const EyeIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const EyeOffIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2M6.6 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9.3 9.3 0 0 0 4.9-1.4" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17" />
  </Svg>
);

export const AlertIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M10.3 4.2L2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Svg>
);

export const CheckIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 12.2l2.4 2.4 4.6-5" />
  </Svg>
);

export const CloseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
  </Svg>
);

export const InfoIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.5h.01" />
  </Svg>
);

export const GlobeIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" />
  </Svg>
);

export const TerminalIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
  </Svg>
);

export const RouteIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" />
  </Svg>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.5 6l6 6-6 6" />
  </Svg>
);

export function HostKindIcon({ kind, ...props }: IconProps & { kind: HostKind }) {
  if (kind === 'local') return <LaptopIcon {...props} />;
  if (kind === 'sandbox') return <SandboxIcon {...props} />;
  return <ServerIcon {...props} />;
}
