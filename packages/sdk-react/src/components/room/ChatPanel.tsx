import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useLocalParticipant, useLocalParticipantPermissions, useParticipants } from '@livekit/components-react';
import { useChat } from '../../hooks/useChat.js';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';
import { useHostControls } from '../../hooks/useHostControls.js';
import { useStreamContext } from './StandaloneWatch.js';

const QUICK_EMOJIS = ['👍','❤️','😂','🔥','👏','😮','🙌','💯','🎉','🤔','😎','✋'];

/** Split a message into plain-text and @mention segments for rendering. */
function parseMentions(text: string): Array<{ type: 'text' | 'mention'; value: string }> {
  return text.split(/(@\S+)/).map(part =>
    /^@\S+$/.test(part) ? { type: 'mention', value: part } : { type: 'text', value: part },
  );
}

export interface ChatPanelProps {
  /** Called when the user clicks the collapse button in the chat header. */
  onClose?: () => void;
  /** Listen-only guest — render the chat in read-only mode. Server
   *  blocks data publishing for guest identities anyway, but hiding
   *  the input keeps the UI honest. */
  isGuest?: boolean;
  /** Force read-only regardless of the LiveKit publish permission. Use for
   *  watch-page embeds where anonymous viewers may hold a chat-capable guest
   *  token but shouldn't be able to post (e.g. "sign in to chat"). */
  readOnly?: boolean;
  /** Message shown in place of the composer when chat is read-only. */
  readOnlyNotice?: string;
  /** Fired after a message is sent, so an integrator can mirror it elsewhere
   *  (3Speak posts each line as a timecoded Hive comment). Must not throw —
   *  it is intentionally not awaited, so chat never waits on a network call. */
  onMessageSent?: (text: string) => void;
}

function ChatBubble({ identity, name, text, localName, onModerate }: {
  identity: string; name: string; text: string; localName: string;
  onModerate?: (target: { identity: string; name: string }) => void;
}) {
  const avatar = useHiveAvatar(identity, 'small');
  const segments = parseMentions(text);
  // Highlight this bubble if the local user is mentioned (match on display name or identity)
  const isMentioned = localName && segments.some(
    s => s.type === 'mention' && s.value.toLowerCase() === `@${localName.toLowerCase()}`,
  );

  return (
    <div className={`hh-chat__msg${isMentioned ? ' hh-chat__msg--mentioned' : ''}`}>
      <img className="hh-chat__msg-avatar" src={avatar} alt={name} />
      <div className="hh-chat__msg-body">
        {onModerate ? (
          <button
            type="button"
            className="hh-chat__msg-name hh-chat__msg-name--tappable"
            onClick={() => onModerate({ identity, name })}
            title={`Moderate ${name}`}
          >
            {name}
          </button>
        ) : (
          <span className="hh-chat__msg-name">{name}</span>
        )}
        <span className="hh-chat__msg-text">
          {segments.map((seg, i) =>
            seg.type === 'mention'
              ? <span key={i} className="hh-chat__mention">{seg.value}</span>
              : seg.value
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Moderation actions for one chatter, opened by tapping their name.
 *
 * Host-only. Kick removes them from this stream (they can come back); ban is
 * persistent for the room. Both are destructive and easy to mis-tap on a phone
 * held one-handed while streaming, so ban asks for a second tap to confirm.
 */
function ModerationPopup({ target, roomName, onClose }: {
  target: { identity: string; name: string };
  roomName: string;
  onClose: () => void;
}) {
  const { kick, ban, pending } = useHostControls(roomName);
  const [confirmBan, setConfirmBan] = useState(false);
  const [error, setError] = useState('');
  const busy = pending.has(target.identity);

  const run = async (action: () => Promise<void>) => {
    setError('');
    try { await action(); onClose(); }
    catch (err) { setError(err instanceof Error ? err.message : 'That did not work'); }
  };

  return (
    <div className="hh-modsheet" role="dialog" aria-label={`Moderate ${target.name}`}>
      <div className="hh-modsheet__backdrop" onClick={onClose} />
      <div className="hh-modsheet__panel">
        <div className="hh-modsheet__head">
          <strong>@{target.name}</strong>
          <button className="hh-modsheet__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <p className="hh-modsheet__error">{error}</p>}

        <button
          className="hh-modsheet__action"
          disabled={busy}
          onClick={() => void run(() => kick(target.identity))}
        >
          👢 Remove from this stream
          <em>They can rejoin if they still have the link.</em>
        </button>

        <button
          className={`hh-modsheet__action hh-modsheet__action--danger${confirmBan ? ' is-confirming' : ''}`}
          disabled={busy}
          onClick={() => {
            if (!confirmBan) { setConfirmBan(true); return; }
            void run(() => ban(target.identity));
          }}
        >
          {confirmBan ? '⛔ Tap again to confirm ban' : '⛔ Ban from this room'}
          <em>Blocks them for the rest of the session.</em>
        </button>
      </div>
    </div>
  );
}

export function ChatPanel({ onClose, isGuest = false, readOnly = false, readOnlyNotice, onMessageSent }: ChatPanelProps = {}) {
  const { messages, sendMessage } = useChat();
  const permissions = useLocalParticipantPermissions();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  // Moderation is offered only to the stream's host, and never on their own
  // messages. Outside a stream context (a plain conference) there is no host
  // identity, so names stay inert.
  const { hostIdentity, roomName: streamRoom } = useStreamContext();
  const isHost = !!hostIdentity && !!localParticipant
    && localParticipant.identity === hostIdentity;
  const [modTarget, setModTarget] = useState<{ identity: string; name: string } | null>(null);
  const canChat = readOnly ? false : (permissions ? (permissions.canPublishData ?? false) : !isGuest);

  // The name to match against incoming @mentions for highlight
  const localName = localParticipant
    ? (localParticipant.name || localParticipant.identity)
    : '';

  // Autocomplete: detect a trailing @query in the input
  const [input, setInput] = useState('');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const mentionQuery = useMemo(() => {
    const m = input.match(/(?:^|\s)@(\S*)$/);
    return m ? m[1] : null;
  }, [input]);

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return participants
      .filter(p => p.identity !== localParticipant?.identity)
      .map(p => ({ identity: p.identity, name: p.name || p.identity }))
      .filter(p => p.name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionQuery, participants, localParticipant]);

  const insertMention = useCallback((name: string) => {
    // Replace the trailing @query with the selected @name
    setInput(prev => prev.replace(/(?:^|(\s))@\S*$/, (_, space) => `${space ?? ''}@${name} `));
    inputRef.current?.focus();
  }, []);

  const insertEmoji = useCallback((emoji: string) => {
    setInput(prev => prev + emoji);
    setEmojiOpen(false);
    inputRef.current?.focus();
  }, []);

  // Mounted only when the chat is visible — the parent (HangoutsRoom)
  // unmounts us when the user collapses the panel via the toggle in the
  // controls bar, so isOpen state lives one level up.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    sendMessage(input);
    setInput('');
    // Deliberately not awaited: mirroring to Hive is slow and must never hold
    // up the in-stream message.
    try { onMessageSent?.(text); } catch { /* integrator's problem, not chat's */ }
  };

  return (
    <div className="hh-chat">
      {modTarget && streamRoom && (
        <ModerationPopup
          target={modTarget}
          roomName={streamRoom}
          onClose={() => setModTarget(null)}
        />
      )}
      <div className="hh-chat__header">
        <span className="hh-chat__title">Chat</span>
        {onClose && (
          <button
            className="hh-chat__collapse"
            onClick={onClose}
            aria-label="Collapse chat"
            title="Collapse chat"
          >
            ›
          </button>
        )}
      </div>
      <div className="hh-chat__messages">
        {messages.length === 0 && (
          <div className="hh-chat__empty">No messages yet</div>
        )}
        {messages.map((msg) => (
          <ChatBubble
            key={msg.id}
            identity={msg.identity}
            name={msg.name}
            text={msg.text}
            localName={localName}
            onModerate={isHost && msg.identity !== hostIdentity ? setModTarget : undefined}
          />
        ))}
        <div ref={bottomRef} />
      </div>
      {!canChat ? (
        /* An EMPTY notice means "render nothing" — `??` only falls back on
           undefined, so passing '' previously produced an empty prompt box
           that still carried its border and read as an input field. */
        readOnlyNotice === '' ? null : (
          <div className="hh-chat__guest-prompt">
            {readOnlyNotice ?? '🔒 Sign in with Hive to chat.'}
          </div>
        )
      ) : (
        <div className="hh-chat__compose">
          {mentionCandidates.length > 0 && (
            <div className="hh-chat__mention-tray">
              {mentionCandidates.map(p => (
                <button
                  key={p.identity}
                  type="button"
                  className="hh-chat__mention-candidate"
                  onClick={() => insertMention(p.name)}
                >
                  @{p.name}
                </button>
              ))}
            </div>
          )}
          {emojiOpen && (
            <div className="hh-chat__emoji-tray">
              {QUICK_EMOJIS.map(e => (
                <button
                  key={e}
                  className="hh-chat__emoji-btn"
                  onClick={() => insertEmoji(e)}
                  type="button"
                  aria-label={e}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          <form className="hh-chat__input-row" onSubmit={handleSend}>
            <button
              type="button"
              className="hh-chat__emoji-toggle"
              onClick={() => setEmojiOpen(v => !v)}
              aria-label="Emoji"
              title="Emoji"
            >
              😊
            </button>
            <input
              ref={inputRef}
              className="hh-chat__input"
              type="text"
              placeholder="Say something..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <button className="hh-btn hh-btn--primary hh-btn--small" type="submit" disabled={!input.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
