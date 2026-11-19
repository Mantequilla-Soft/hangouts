export interface StudioSubtab<T extends string> {
  id: T;
  label: string;
  /** A dot on the tab: something there wants a look (a battle on air, a weak upload). */
  dot?: boolean;
}

/**
 * The row of sub-tabs at the top of a studio panel (Live, Overlays, Boosts,
 * Settings, Post). The first tab holds what the host needs most.
 */
export function StudioSubtabs<T extends string>({ tabs, active, onChange, label }: {
  tabs: StudioSubtab<T>[];
  active: T;
  onChange: (id: T) => void;
  /** The tab list's accessible name, e.g. "Live". */
  label: string;
}) {
  return (
    <div className="hh-subtabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={`hh-subtabs__tab${active === t.id ? ' is-active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.dot && <span className="hh-subtabs__dot" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}
