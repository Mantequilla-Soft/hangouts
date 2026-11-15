import { describe, expect, it } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RoomContext } from '@livekit/components-react';
import { Room } from 'livekit-client';
import { StreamBoostGoal, BoostTopSupporters } from '../src/components/room/StreamBoostGoal.js';

/** Render inside a LiveKit room whose metadata is `meta` (what useRoomInfo reads). */
function render(el: ReactElement, meta: Record<string, unknown> | null): string {
  const room = new Room();
  Object.defineProperty(room, 'metadata', { get: () => (meta ? JSON.stringify(meta) : undefined) });
  return renderToStaticMarkup(h(RoomContext.Provider, { value: room }, el));
}

const meta = {
  host: 'badadib',
  boost: { enabled: true, goal: { title: 'A new mic', targetHbd: 50 } },
  boostStats: {
    count: 3, totalHbd: 21, goalHbd: 20,
    supporters: [{ account: 'fan', hbd: 12, count: 2 }, { account: 'badadib', displayName: 'Bada', hbd: 9, count: 1 }],
  },
};

describe('StreamBoostGoal', () => {
  it('shows the title, the progress and a bar at the right width', () => {
    const html = render(h(StreamBoostGoal, {}), meta);
    expect(html).toContain('hh-boost-goal--overlay');
    expect(html).toContain('A new mic');
    expect(html).toContain('20 / 50 HBD');
    expect(html).toContain('width:40.0%');
    expect(html).toContain('aria-valuenow="20"');
    expect(html).not.toContain('hh-boost-goal--reached');
  });

  it('takes translated labels and a default title', () => {
    const html = render(h(StreamBoostGoal, { variant: 'inline', labels: { goalProgress: '{progress} von {target} HBD', goalDefaultTitle: 'Ziel' } }),
      { ...meta, boost: { goal: { targetHbd: 10 } } });
    expect(html).toContain('hh-boost-goal--inline');
    expect(html).toContain('Ziel');
    expect(html).toContain('20 von 10 HBD');
    expect(html).toContain('hh-boost-goal--reached');
    expect(html).toContain('width:100.0%');
  });

  it('renders nothing without a goal or before the metadata arrives', () => {
    expect(render(h(StreamBoostGoal, {}), { ...meta, boost: { enabled: true } })).toBe('');
    expect(render(h(StreamBoostGoal, {}), null)).toBe('');
  });
});

describe('BoostTopSupporters', () => {
  it('lists the supporters biggest first with their totals', () => {
    const html = render(h(BoostTopSupporters, {}), meta);
    expect(html).toContain('Top supporters');
    expect(html.indexOf('@fan')).toBeLessThan(html.indexOf('@Bada'));
    expect(html).toContain('12 HBD');
  });

  it('renders nothing before the first boost', () => {
    expect(render(h(BoostTopSupporters, {}), { host: 'badadib' })).toBe('');
  });
});
