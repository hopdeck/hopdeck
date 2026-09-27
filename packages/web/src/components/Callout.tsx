// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Mateusz T (Tenir)

import type { ReactNode } from 'react';

export type CalloutTone = 'info' | 'ok' | 'warn' | 'danger';

interface CalloutProps {
  tone: CalloutTone;
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  role?: 'alert' | 'status';
}

export function Callout({ tone, icon, title, children, role }: CalloutProps) {
  return (
    <div className={`callout callout-${tone}`} role={role}>
      {icon}
      <div className="callout-title">{title}</div>
      {children !== undefined && <div className="callout-body">{children}</div>}
    </div>
  );
}
