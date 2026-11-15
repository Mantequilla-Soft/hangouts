import { useEffect, useMemo, useState, type ReactNode } from 'react';
import './styles.css';
import { Markdown, sections, type LinkResolver } from './Markdown.js';
// The site shows the repo's own docs, so it can never drift from them.
import guideMd from '../../docs/integrator-guide.md?raw';
import routesMd from '../../docs/api-routes.md?raw';
import livekitMd from '../../docs/livekit-server-setup.md?raw';

const REPO = 'https://github.com/Mantequilla-Soft/hangouts';

/** Which nav group each integrator-guide section goes in (by heading slug).
 *  A new section in the guide shows up under "More" until it is listed here. */
const GROUP_OF: Record<string, string> = {
  'quick-start-embed-openpods-in-your-hive-app': 'Getting Started',
  architecture: 'Getting Started',
  auth: 'Core',
  'sdk-packages': 'Core',
  'rooms-roles-and-identities': 'Core',
  theming: 'Core',
  'the-studio': 'Streams',
  'watching-a-stream': 'Streams',
  'hls-delivery': 'Streams',
  'recording-vod-dvr-clips-and-rewind': 'Streams',
  'templates-and-headless-obs-streams': 'Streams',
  boosts: 'Live features',
  'record-as-podcast': 'Live features',
  'events-and-presence': 'Live features',
  'room-metadata': 'Realtime',
  'data-channel-topics': 'Realtime',
  'pro-and-quotas': 'Server',
  'server-configuration': 'Server',
  'mongo-collections': 'Server',
};
const GROUPS = ['Getting Started', 'Core', 'Streams', 'Live features', 'Realtime', 'Server', 'More', 'Advanced'];

/** Shorter nav labels for long headings. */
const LABEL_OF: Record<string, string> = {
  'quick-start-embed-openpods-in-your-hive-app': 'Quick start',
  'recording-vod-dvr-clips-and-rewind': 'Recording, VOD, DVR',
  'templates-and-headless-obs-streams': 'Templates and OBS',
  'rooms-roles-and-identities': 'Rooms and identities',
};

interface Page { id: string; label: string; group: string; render: (onLink: LinkResolver) => ReactNode }

function buildPages(): Page[] {
  const guide = sections(guideMd).map((s): Page => ({
    id: s.slug,
    label: LABEL_OF[s.slug] ?? s.title,
    group: GROUP_OF[s.slug] ?? 'More',
    render: (onLink) => <><h1 className="docs__h1">{s.title}</h1><Markdown source={s.body} onLink={onLink} /></>,
  }));
  return [
    ...guide,
    { id: 'games', label: 'Games', group: 'Live features', render: () => <Games /> },
    { id: 'hand-raise-chimes', label: 'Hand-raise chimes', group: 'Live features', render: () => <HandRaiseChimes /> },
    { id: 'api-routes', label: 'API routes', group: 'Server', render: (onLink) => <Markdown source={routesMd} onLink={onLink} /> },
    { id: 'livekit-setup', label: 'LiveKit, egress, ingress', group: 'Server', render: (onLink) => <Markdown source={livekitMd} onLink={onLink} /> },
    { id: 'ai-agents', label: 'AI agent guide', group: 'Advanced', render: () => <AiAgents /> },
  ];
}

export default function App() {
  const pages = useMemo(buildPages, []);
  const ids = useMemo(() => new Set(pages.map((p) => p.id)), [pages]);
  const fromHash = () => {
    const h = decodeURIComponent(window.location.hash.slice(1));
    return ids.has(h) ? h : pages[0].id;
  };
  const [active, setActive] = useState<string>(fromHash);
  useEffect(() => {
    const onHash = () => setActive(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  });
  const go = (id: string) => {
    window.location.hash = id;
    setActive(id);
    window.scrollTo(0, 0);
  };

  // Links between the docs open the matching page; anything else opens the repo.
  const onLink: LinkResolver = (href) => {
    if (/^https?:/.test(href)) return href;
    const [file, anchor] = href.split('#');
    const name = file.split('/').pop() ?? '';
    if (name === 'api-routes.md') return () => go('api-routes');
    if (name === 'livekit-server-setup.md') return () => go('livekit-setup');
    if ((name === '' || name === 'integrator-guide.md') && anchor) {
      const page = ids.has(anchor) ? anchor : null;
      if (page) return () => go(page);
      return () => document.getElementById(anchor)?.scrollIntoView();
    }
    return `${REPO}/blob/main/docs/${file}`;
  };

  const page = pages.find((p) => p.id === active) ?? pages[0];
  return (
    <div className="docs">
      <nav className="docs__nav">
        <div className="docs__logo">OpenPods</div>
        <div className="docs__subtitle">Developer Docs</div>
        {GROUPS.filter((g) => pages.some((p) => p.group === g)).map((group) => (
          <div key={group}>
            <div className="docs__nav-group">{group}</div>
            {pages.filter((p) => p.group === group).map((item) => (
              <button
                key={item.id}
                className={`docs__nav-item ${active === item.id ? 'docs__nav-item--active' : ''}`}
                onClick={() => go(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
        <div className="docs__nav-footer">
          <a href={REPO} target="_blank" rel="noopener">GitHub</a>
          <a href="https://www.npmjs.com/package/@snapie/hangouts-react" target="_blank" rel="noopener">npm</a>
        </div>
      </nav>
      <main className="docs__content">{page.render(onLink)}</main>
    </div>
  );
}

// ─── Utility Components ────────────────────────────────────────────

function Code({ children }: { children: string; lang?: string }) {
  return <pre className="docs__code"><code>{children.trim()}</code></pre>;
}

function H1({ children }: { children: ReactNode }) {
  return <h1 className="docs__h1">{children}</h1>;
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="docs__h2">{children}</h2>;
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="docs__h3">{children}</h3>;
}

function P({ children }: { children: ReactNode }) {
  return <p className="docs__p">{children}</p>;
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <table className="docs__table">
      <thead>
        <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Hand-written pages ────────────────────────────────────────────

function AiAgents() {
  return (
    <>
      <H1>AI agent guide</H1>
      <P>
        Point your assistant at <a href={`${REPO}/blob/main/docs/llms.txt`} target="_blank" rel="noopener">docs/llms.txt</a>.
        It holds the integrator guide and the full route reference in one file, written from the code.
      </P>
      <H2>Rules that save the most time</H2>
      <Table
        headers={['Rule', 'Why']}
        rows={[
          ['Wrap everything in HangoutsProvider', 'Every component and hook reads the API client, session and LiveKit URL from it.'],
          ['Use HangoutsRoom for a room, StandaloneWatch for a stream player', 'Both join LiveKit themselves and pick the right UI for host, guest and viewer.'],
          ['Hooks that touch LiveKit need a LiveKitRoom above them', 'HangoutsRoom and StandaloneWatch provide one.'],
          ['Import @snapie/hangouts-react/src/styles/hangouts.css once', 'The package has no exports map; that one file pulls in all styles.'],
          ['Guests can chat', 'Pass readOnly to ChatPanel if your product wants sign-in to chat.'],
          ['Live state is room metadata', 'Read it with useRoomInfo or the SDK hooks; only the server writes it.'],
          ['Check routes in docs/api-routes.md', 'Its table is generated from the Fastify routes and checked in CI.'],
        ]}
      />
    </>
  );
}

function HandRaiseChimes() {
  return (
    <>
      <H1>Hand-Raise Chimes (Notifications)</H1>
      <P>
        When another participant raises their hand, the host hears a subtle two-note chime
        (C6 → E6). This is local-only client-side audio, no recording leakage, no server overhead.
      </P>

      <H2>How it works</H2>
      <Code>{`
Participant A raises hand
  ↓
LiveKit data channel broadcasts hand_raise event
  ↓
Participant B (host) receives event
  ↓
Client-side Web Audio synth plays: C6 (1046.5 Hz) + E6 (1318.5 Hz)
  ↓
Only Participant B hears it (local browser speaker)
  ↓
Recording never hears it (recordings run in separate browser, don't mount this hook)
      `}</Code>

      <H2>Features</H2>
      <ul className="docs__list">
        <li>✅ Web Audio API synth (no audio asset files)</li>
        <li>✅ 2-second throttle (prevents chime spam on hand-raise bursts)</li>
        <li>✅ Identity filtering (ignores local user's own raises)</li>
        <li>✅ Graceful fallback on autoplay block (no JS errors)</li>
        <li>✅ Configurable volume (default: 0.3)</li>
      </ul>

      <H2>Default behavior</H2>
      <Code>{`
<HangoutsRoom
  roomName="my-room"
  notificationSounds={true}    // default; set to false to disable
  embedded
/>
      `}</Code>

      <H2>Using the hook directly</H2>
      <Code>{`
import { useHandRaiseChime } from '@snapie/hangouts-react';

function MyComponent() {
  // Play chime at 50% volume when enabled
  useHandRaiseChime(true, 0.5);

  return <div>Chime enabled at 50% volume</div>;
}
      `}</Code>

      <H2>When chimes DON'T play</H2>
      <ul className="docs__list">
        <li>❌ Autoplay policy blocks audio context (browser security)</li>
        <li>❌ Audio context suspended (user hasn't interacted with page yet)</li>
        <li>❌ Hand-raise lowering event (only raised: true triggers chime)</li>
        <li>❌ Local user's own hand-raise (identity filtering)</li>
        <li>❌ Within 2 seconds of previous chime (throttling)</li>
      </ul>
      <P>
        In all these cases, the chime is silently skipped, no JS errors, no console warnings.
      </P>

      <H2>Browser compatibility</H2>
      <Table
        headers={['Browser', 'Support', 'Notes']}
        rows={[
          ['Chrome', '✅', 'Full Web Audio API support'],
          ['Safari', '✅', 'Full Web Audio API support (iOS 14.5+)'],
          ['Firefox', '✅', 'Full Web Audio API support'],
          ['Edge', '✅', 'Full Web Audio API support'],
        ]}
      />
    </>
  );
}


function Games() {
  return (
    <>
      <H1>Games &amp; Results</H1>
      <p>
        Hangouts ships three built-in game plugins that run inside any live room.
        Games are started by the host; all active speakers play automatically while
        audience members spectate. When a game is active, the room layout shifts
        automatically: the board occupies the center stage and speakers shrink to
        a compact avatar strip above it. No extra props are needed to trigger this.
      </p>

      <H2>Available games</H2>
      <table className="docs__table">
        <thead>
          <tr><th>gameId</th><th>Name</th><th>Players</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>chess</code></td><td>Chess</td><td>2</td><td>Standard chess. Move until checkmate, stalemate, or a player resigns.</td></tr>
          <tr><td><code>fast-draw</code></td><td>Fast Draw</td><td>2–8</td><td>Pictionary-style. One player draws, others guess. First to a score threshold wins.</td></tr>
          <tr><td><code>word-guess</code></td><td>Word Guess</td><td>2–8</td><td>Hangman-style cooperative word guessing with themed word packs.</td></tr>
        </tbody>
      </table>

      <H2>Receiving results: onGameEnd</H2>
      <p>
        Add <code>onGameEnd</code> to <code>&lt;HangoutsRoom&gt;</code> to receive a structured
        snapshot when any game session ends (win, resign, or host abort). Use it to post results
        to the Hive blockchain, create a snap, update a leaderboard, etc.
      </p>
      <Code lang="tsx">{`
import type { GameResultPayload, ChessGameResult, FastDrawGameResult } from '@snapie/hangouts-react';

<HangoutsRoom
  roomName={roomName}
  onGameEnd={(result) => {
    console.log(result.gameId);   // 'chess' | 'fast-draw' | 'word-guess'
    console.log(result.players);  // ['alice', 'bob']  ← Hive usernames; not spectators
    console.log(result.startedAt); // Unix ms
    console.log(result.endedAt);   // Unix ms
    console.log(result.duration);  // seconds
    console.log(result.result);    // game-specific state: cast based on gameId
  }}
/>
      `}</Code>

      <H2>GameResultPayload shape</H2>
      <Code lang="typescript">{`
interface GameResultPayload {
  gameId: string;       // 'chess' | 'fast-draw' | 'word-guess'
  players: string[];    // Hive usernames of players (not spectators)
  startedAt: number;    // Unix ms
  endedAt: number;      // Unix ms
  duration: number;     // seconds
  result: unknown;      // game-specific: cast based on gameId
}
      `}</Code>

      <H3>Chess result (gameId === 'chess')</H3>
      <Code lang="typescript">{`
import type { ChessGameResult } from '@snapie/hangouts-react';

// Inside onGameEnd:
if (result.gameId === 'chess') {
  const chess = result.result as ChessGameResult;
  // chess.fen          → final board position (FEN string)
  // chess.players      → { w: 'alice', b: 'bob' }
  // chess.status       → 'checkmate' | 'resigned' | 'draw' | 'stalemate'
  // chess.winner       → 'alice' or null for draw
  // chess.moveHistory  → ['e4', 'e5', 'Nf3', 'Nc6', ...] (SAN notation)
}
      `}</Code>

      <H3>Fast Draw result (gameId === 'fast-draw')</H3>
      <Code lang="typescript">{`
import type { FastDrawGameResult } from '@snapie/hangouts-react';

if (result.gameId === 'fast-draw') {
  const fd = result.result as FastDrawGameResult;
  // fd.winners  → ['alice']  (Hive usernames)
  // fd.scores   → { alice: 3, bob: 1 }
  // fd.phase    → 'game_over'
  // fd.roundNumber → how many rounds were played
}
      `}</Code>

      <H2>Post results to Hive blockchain</H2>
      <p>
        Pass the result to Aioha, Hive Keychain, or any signing library to broadcast
        a <code>custom_json</code> operation. The example below uses Aioha.
      </p>
      <Code lang="tsx">{`
<HangoutsRoom
  onGameEnd={async (result) => {
    if (result.gameId === 'chess') {
      const chess = result.result as ChessGameResult;

      await aioha.broadcastCustomJson(
        'active',               // or 'posting'
        'hangouts_chess_result',
        {
          app: 'snapie/1.0',
          room: roomName,
          players: result.players,
          winner: chess.winner,
          status: chess.status,
          pgn: chess.moveHistory.join(' '),
          duration: result.duration,
        }
      );
    }

    if (result.gameId === 'fast-draw') {
      const fd = result.result as FastDrawGameResult;

      await aioha.broadcastCustomJson(
        'active',
        'hangouts_fastdraw_result',
        {
          app: 'snapie/1.0',
          room: roomName,
          players: result.players,
          winners: fd.winners,
          scores: fd.scores,
          duration: result.duration,
        }
      );
    }
  }}
/>
      `}</Code>

      <H2>Create a snap from game results</H2>
      <Code lang="tsx">{`
<HangoutsRoom
  onGameEnd={(result) => {
    if (result.gameId === 'chess') {
      const chess = result.result as ChessGameResult;
      const body = chess.winner
        ? \`@\${chess.winner} wins by \${chess.status}! PGN: \${chess.moveHistory.slice(0, 6).join(' ')}...\`
        : \`Chess ended in a \${chess.status}.\`;
      postSnap(body); // your snap creation function
    }
  }}
/>
      `}</Code>

      <H2>Direct hook access</H2>
      <p>
        For custom in-room game UI, mount the game hooks inside a component that lives
        within <code>&lt;HangoutsRoom&gt;</code> (they require a LiveKit room context):
      </p>
      <Code lang="typescript">{`
import { useChess, useFastDraw, useWordGuess } from '@snapie/hangouts-react';

function MyChessPanel({ roomName }: { roomName: string }) {
  const {
    active, fen, myColor, players, status, winner,
    moveHistory, isMyTurn, makeMove, resign, isSpectator,
  } = useChess({ roomName });

  if (!active) return null;
  // render your custom chess board...
}

function MyFastDrawPanel({ roomName }: { roomName: string }) {
  const {
    active, phase, isDrawer, word, wordLength, scores,
    winners, submitGuess, syncCanvas,
  } = useFastDraw({ roomName });

  // render your custom drawing canvas...
}
      `}</Code>
      <p>
        Hooks hydrate from the server on mount, so late joiners and spectators
        automatically receive the current game state without needing to catch
        up on missed events.
      </p>

      <H2>Server API</H2>
      <table className="docs__table">
        <thead>
          <tr><th>Method</th><th>Path</th><th>Auth</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td>/games</td><td>Public</td><td>List available game plugins</td></tr>
          <tr><td>GET</td><td>/game-collections</td><td>Public</td><td>List word collections for Word Guess</td></tr>
          <tr><td>GET</td><td>/rooms/:name/game</td><td>Required</td><td>Active game state (per-participant view)</td></tr>
          <tr><td>POST</td><td>/rooms/:name/game/start</td><td>Required (host)</td><td>Start a game. Body: <code>&#123; gameId, config? &#125;</code></td></tr>
          <tr><td>POST</td><td>/rooms/:name/game/action</td><td>Required</td><td>Submit a game action. Body: <code>&#123; action &#125;</code></td></tr>
          <tr><td>DELETE</td><td>/rooms/:name/game</td><td>Required (host)</td><td>End the active game</td></tr>
        </tbody>
      </table>

      <H2>Gotchas</H2>
      <ul>
        <li>
          <strong><code>onGameEnd</code> is not called if the server has no session data</strong>{' '}
          (e.g., the game:ended message arrived without a payload: possible with older server
          versions). Always guard against missing fields.
        </li>
        <li>
          <strong>Host abort sends the mid-game state as <code>result</code></strong>, not a
          terminal game-over state. Check <code>status</code> (chess) or <code>phase</code>{' '}
          (fast-draw) to distinguish a natural end from an abort.
        </li>
        <li>
          <strong>The game board stays visible for ~6 seconds after <code>onGameEnd</code> fires</strong>{' '}
         : the layout exit is intentionally delayed so players can read the final result.
          If you start async blockchain work in <code>onGameEnd</code>, it runs during this
          window: no need to rush.
        </li>
        <li>
          <strong>Chess <code>moveHistory</code> is in SAN notation</strong>: e.g.{' '}
          <code>['e4', 'e5', 'Nf3']</code>. Use it as a PGN move list for replays or analysis.
        </li>
      </ul>
    </>
  );
}
