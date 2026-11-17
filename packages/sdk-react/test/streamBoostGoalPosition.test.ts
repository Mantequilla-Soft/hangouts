import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The goal bar takes the host's position as a class (hh-boost-goal--pos-*), so
// the stylesheet can place it: a band along the bottom or top, or a corner card.
const state = vi.hoisted(() => ({ goal: null as null | Record<string, unknown> }));
vi.mock('../src/hooks/useRoomBoost.js', () => ({
  useRoomBoost: () => ({ goal: state.goal, stats: { count: 0, totalHbd: 0, goalHbd: 0, supporters: [] }, loaded: true }),
  useGoalCelebration: () => false,
}));
const { StreamBoostGoal } = await import('../src/components/room/StreamBoostGoal.js');

const goal = (position: string) => ({ title: 'mic', targetHbd: 50, progressHbd: 10, fraction: 0.2, reached: false, position });

describe('StreamBoostGoal position', () => {
  it('puts the position on the overlay', () => {
    for (const p of ['bottom', 'top', 'top-right', 'bottom-right', 'bottom-left']) {
      state.goal = goal(p);
      expect(renderToStaticMarkup(h(StreamBoostGoal, { variant: 'overlay' }))).toContain(`hh-boost-goal--pos-${p}`);
    }
  });

  it('an inline goal (in a panel) has no position', () => {
    state.goal = goal('top-right');
    expect(renderToStaticMarkup(h(StreamBoostGoal, { variant: 'inline' }))).not.toContain('--pos-');
  });
});
