import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StreamingPanel, StopStreamingPanel, customStreamTarget } from '../src/components/room/StreamingPanel.js';
import { STREAM_PERKS } from '../src/lib/proBenefits.js';

const noop = () => {};

describe('restream panel', () => {
  it('offers YouTube, Twitch and Other', () => {
    const html = renderToStaticMarkup(h(StreamingPanel, { videoEnabled: true, isLoading: false, error: null, onStart: noop, onClose: noop }));
    expect(html).toContain('>YouTube</button>');
    expect(html).toContain('>Twitch</button>');
    expect(html).toContain('>Other</button>');
    expect(html).toContain('YouTube Stream Key');
  });

  it('a custom destination is the server URL and key joined like OBS does', () => {
    expect(customStreamTarget(' rtmp://live.restream.io/live/ ', ' re_123 ')).toBe('rtmp://live.restream.io/live/re_123');
    expect(customStreamTarget('rtmps://fa723fc1b171.global-contribute.live-video.net/app', 'sk_1')).toBe('rtmps://fa723fc1b171.global-contribute.live-video.net/app/sk_1');
    expect(customStreamTarget('https://live.restream.io/live', 'k')).toBeNull();
    expect(customStreamTarget('rtmp://live.restream.io/live', '  ')).toBeNull();
    expect(customStreamTarget('', 'k')).toBeNull();
  });

  it('while live it names the destination, not the raw platform id', () => {
    const html = renderToStaticMarkup(h(StopStreamingPanel, { platform: 'custom', viewerUrl: '', isLoading: false, error: null, onStop: noop, onClose: noop }));
    expect(html).toContain('LIVE on your own server');
  });
});

describe('Pro perk', () => {
  it('restreaming is offered without naming the protocol', () => {
    const perk = STREAM_PERKS.find((p) => p.icon === '📡');
    expect(perk?.title).toBe('Restream to other platforms');
    expect(STREAM_PERKS.some((p) => /RTMP/.test(p.title + p.body))).toBe(false);
  });
});
