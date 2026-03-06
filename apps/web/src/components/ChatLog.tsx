import { useEffect, useRef } from 'react';
import { useChat } from '../store';

export function ChatLog() {
  const messages = useChat((s) => s.messages);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current?.parentElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  if (messages.length === 0) {
    return <div className="empty">Mensagens do chat aparecerão aqui...</div>;
  }

  return (
    <div ref={containerRef}>
      {messages.map((m, i) => (
        <div key={i} className={`chat-msg${m.isDonate ? ' donate' : ''}`}>
          <span
            className={`chat-user${m.isDonate ? ' donate' : ''}`}
            style={!m.isDonate && m.color ? { color: m.color } : undefined}
          >
            {m.user}:
          </span>
          <span className="chat-text">{m.message}</span>
        </div>
      ))}
    </div>
  );
}
