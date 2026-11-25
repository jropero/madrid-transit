import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.tsx';

export type BarAction = {
  icon: IconName;
  label: string;
  text?: string; // shorter visible label when the accessible name is longer
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
};
export type BarMenuItem = { label: string; onClick: () => void; disabled?: boolean };

// Windows Phone app bar: round outlined buttons; "..." reveals their labels and the menu.
// Portalled to <body> so it stays fixed even while a pane's turnstile transform runs.
export default function AppBar({
  actions,
  menu = [],
}: {
  actions: BarAction[];
  menu?: BarMenuItem[];
}) {
  const [expanded, setExpanded] = useState(false);
  return createPortal(
    <nav className={expanded ? 'appbar open' : 'appbar'} aria-label="Actions">
      {expanded && menu.length > 0 && (
        <ul className="bar-menu">
          {menu.map(m => (
            <li key={m.label}>
              <button
                disabled={m.disabled}
                onClick={() => {
                  setExpanded(false);
                  m.onClick();
                }}
              >
                {m.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="bar-row">
        {actions.map(a => (
          <button
            key={a.label}
            className="bar-btn tilt"
            aria-label={a.label}
            aria-expanded={a.expanded}
            disabled={a.disabled}
            onClick={a.onClick}
          >
            <span className="bar-circle">
              <Icon name={a.icon} />
            </span>
            <span className="bar-label" aria-hidden="true">
              {a.text ?? a.label}
            </span>
          </button>
        ))}
        <button
          className="bar-more"
          aria-label="More"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="more" />
        </button>
      </div>
    </nav>,
    document.body,
  );
}
