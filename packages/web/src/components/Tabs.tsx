import { Fragment, useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './Tabs.module.css';

export interface Tab {
  id: string;
  label: ReactNode;
  content: ReactNode;
  /** The module the tab belongs to, e.g. "Firewall"; shown once before its first tab. */
  group?: string;
}

interface TabsProps {
  tabs: readonly Tab[];
  active: string;
  onChange(id: string): void;
  label: string;
}

/**
 * WAI-ARIA tabs: arrow keys move between tabs, only the active panel is
 * rendered. Group captions only sort the tabs for the eye; to assistive
 * technology the list is one row of tabs, named by `label`.
 */
export function Tabs({ tabs, active, onChange, label }: TabsProps) {
  const list = useRef<HTMLDivElement>(null);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  function onKeyDown(event: KeyboardEvent) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 || current === undefined) return;
    event.preventDefault();
    const index = (tabs.indexOf(current) + step + tabs.length) % tabs.length;
    onChange(tabs[index]!.id);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();
  }

  return (
    <div className={styles.tabs}>
      <div ref={list} role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
        {tabs.map((tab, index) => (
          <Fragment key={tab.id}>
            {tab.group !== undefined && tab.group !== tabs[index - 1]?.group && (
              <span className={styles.group} aria-hidden="true">
                {tab.group}
              </span>
            )}
            <button
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={tab.id === current?.id}
              aria-controls={`panel-${tab.id}`}
              tabIndex={tab.id === current?.id ? 0 : -1}
              className={styles.tab}
              onClick={() => onChange(tab.id)}
            >
              {tab.label}
            </button>
          </Fragment>
        ))}
      </div>
      {current !== undefined && (
        <div role="tabpanel" id={`panel-${current.id}`} aria-labelledby={`tab-${current.id}`} className={styles.panel}>
          {current.content}
        </div>
      )}
    </div>
  );
}
