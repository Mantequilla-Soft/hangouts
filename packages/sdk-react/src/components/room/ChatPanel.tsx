import { useState, useRef, useEffect } from 'react';
import { useChat } from '../../hooks/useChat.js';
import { useHiveAvatar } from '../../hooks/useHiveAvatar.js';

function ChatBubble({ identity, text }: { identity: string; text: string }) {
  const avatar = useHiveAvatar(identity, 'small');

  return (
    <div className="hh-chat__msg">
      <img className="hh-chat__msg-avatar" src={avatar} alt={identity} />
      <div>
        <span className="hh-chat__msg-name">{identity}</span>
        <span className="hh-chat__msg-text">{text}</span>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const { messages, sendMessage } = useChat();
  const [input, setInput] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [unread, setUnread] = useState(0);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setUnread(0);
    } else if (messages.length > 0) {
      setUnread((prev) => prev + 1);
    }
  }, [messages.length, isOpen]);

  // Reset unread when opening
  useEffect(() => {
    if (isOpen) setUnread(0);
  }, [isOpen]);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage(input);
    setInput('');
  };

  return (
    <>
      <button
        className={`hh-btn hh-btn--secondary hh-chat__toggle`}
        onClick={() => setIsOpen(!isOpen)}
      >
        💬 {isOpen ? 'Close' : 'Chat'}
        {!isOpen && unread > 0 && (
          <span className="hh-chat__badge">{unread}</span>
        )}
      </button>

      {isOpen && (
        <div className="hh-chat">
          <div className="hh-chat__messages">
            {messages.length === 0 && (
              <div className="hh-chat__empty">No messages yet</div>
            )}
            {messages.map((msg) => (
              <ChatBubble key={msg.id} identity={msg.identity} text={msg.text} />
            ))}
            <div ref={bottomRef} />
          </div>
          <form className="hh-chat__input-row" onSubmit={handleSend}>
            <input
              className="hh-chat__input"
              type="text"
              placeholder="Say something..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoFocus
            />
            <button className="hh-btn hh-btn--primary hh-btn--small" type="submit" disabled={!input.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
