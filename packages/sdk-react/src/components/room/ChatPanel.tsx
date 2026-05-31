import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useLocalParticipant, useLocalParticipantPermissions, useParticipants } from '@livekit/components-react';
import { useChat } from '../../hooks/useChat.js';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';

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
}

function ChatBubble({ identity, name, text, localName }: { identity: string; name: string; text: string; localName: string }) {
  const avatar = useHiveAvatar(identity, 'small');
  const segments = parseMentions(text);
  // Highlight this bubble if the local user is mentioned (match on display name or identity)
  const isMentioned = localName && segments.some(
    s => s.type === 'mention' && s.value.toLowerCase() === `@${localName.toLowerCase()}`,
  );

  return (
    <div className={`hh-chat__msg${isMentioned ? ' hh-chat__msg--mentioned' : ''}`}>
      <img className="hh-chat__msg-avatar" src={avatar} alt={name} />
      <div>
        <span className="hh-chat__msg-name">{name}</span>
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

export function ChatPanel({ onClose, isGuest = false }: ChatPanelProps = {}) {
  const { messages, sendMessage } = useChat();
  const permissions = useLocalParticipantPermissions();
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const canChat = permissions ? (permissions.canPublishData ?? false) : !isGuest;

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
    if (!input.trim()) return;
    sendMessage(input);
    setInput('');
  };

  return (
    <div className="hh-chat">
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
          <ChatBubble key={msg.id} identity={msg.identity} name={msg.name} text={msg.text} localName={localName} />
        ))}
        <div ref={bottomRef} />
      </div>
      {!canChat ? (
        <div className="hh-chat__guest-prompt">
          🔒 Sign in with Hive to chat.
        </div>
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
