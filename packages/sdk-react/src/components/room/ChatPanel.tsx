import { useRef, useEffect, useState } from 'react';
import { useLocalParticipantPermissions } from '@livekit/components-react';
import { useChat } from '../../hooks/useChat.js';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';

export interface ChatPanelProps {
  /** Called when the user clicks the collapse button in the chat header. */
  onClose?: () => void;
  /** Listen-only guest — render the chat in read-only mode. Server
   *  blocks data publishing for guest identities anyway, but hiding
   *  the input keeps the UI honest. */
  isGuest?: boolean;
}

function ChatBubble({ identity, name, text }: { identity: string; name: string; text: string }) {
  const avatar = useHiveAvatar(identity, 'small');

  return (
    <div className="hh-chat__msg">
      <img className="hh-chat__msg-avatar" src={avatar} alt={name} />
      <div>
        <span className="hh-chat__msg-name">{name}</span>
        <span className="hh-chat__msg-text">{text}</span>
      </div>
    </div>
  );
}

export function ChatPanel({ onClose, isGuest = false }: ChatPanelProps = {}) {
  const { messages, sendMessage } = useChat();
  const permissions = useLocalParticipantPermissions();
  // Use actual LiveKit canPublishData when available; fall back to isGuest prop.
  // Guests now have canPublishData:true from the server, so this correctly
  // enables chat for them without needing a Hive account.
  const canChat = permissions ? (permissions.canPublishData ?? false) : !isGuest;
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

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
          <ChatBubble key={msg.id} identity={msg.identity} name={msg.name} text={msg.text} />
        ))}
        <div ref={bottomRef} />
      </div>
      {!canChat ? (
        <div className="hh-chat__guest-prompt">
          🔒 Sign in with Hive to chat.
        </div>
      ) : (
        <form className="hh-chat__input-row" onSubmit={handleSend}>
          <input
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
      )}
    </div>
  );
}
