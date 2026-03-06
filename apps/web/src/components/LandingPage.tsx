import { useState, useEffect } from 'react';
import { useAuth } from '../store';
import { formatRelativeTime } from '../utils/helpers';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

interface ActiveRoom {
  id: string;
  channel_login: string;
  request_count: number;
  pending_count: number;
  updated_at: string;
  avatar_url: string | null;
  banner_url: string | null;
  status: 'offline' | 'online' | 'live';
  is_live: boolean;
  thumbnail_url: string | null;
  viewer_count: number | null;
}

function ConnectButton() {
  const { isAuthenticated, user, login } = useAuth();

  if (isAuthenticated && user) {
    return (
      <a className="btn btn-primary landing-cta" href={`#/${user.login.toLowerCase()}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
        </svg>
        Começar minha fila
      </a>
    );
  }

  return (
    <button className="btn btn-primary landing-cta" onClick={login}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
      </svg>
      Conectar com Twitch
    </button>
  );
}

function LiveChannels() {
  const [rooms, setRooms] = useState<ActiveRoom[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/rooms/active`)
      .then(r => r.json())
      .then((data: { rooms: ActiveRoom[] }) => setRooms(data.rooms))
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="landing-channels-grid">
        {[1, 2].map(i => (
          <div key={i} className="landing-channel-card skeleton" />
        ))}
      </div>
    );
  }

  if (rooms.length === 0) {
    return <p className="landing-channels-empty">Nenhum canal ativo no momento</p>;
  }

  return (
    <div className={`landing-channels-grid${rooms.length === 1 ? ' single' : ''}`}>
      {rooms.map(room => (
        <a key={room.id} className="landing-channel-card" href={`#/${room.channel_login}`}>
          <div className="landing-channel-thumb">
            {(room.thumbnail_url || room.banner_url) ? (
              <img src={(room.thumbnail_url || room.banner_url)!} alt={room.channel_login} />
            ) : (
              <img className="landing-channel-thumb-placeholder" src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.png`} alt="" />
            )}
            {room.is_live && <span className="landing-channel-live">AO VIVO</span>}
          </div>
          <div className="landing-channel-info">
            <div className="landing-channel-card-header">
              {room.avatar_url && <img className="landing-channel-avatar" src={room.avatar_url} alt="" />}
              <span className="landing-channel-name">{room.channel_login}</span>
              {room.status !== 'offline' && <span className="landing-channel-status">Fila aberta</span>}
            </div>
            <div className="landing-channel-stats">
              <span className="landing-channel-pending">
                {room.pending_count} pedido{room.pending_count !== 1 ? 's' : ''} na fila
              </span>
              <span className="landing-channel-meta">
                {room.viewer_count != null && <span>{room.viewer_count} viewers</span>}
                <span>{formatRelativeTime(new Date(room.updated_at + 'Z'))}</span>
              </span>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

const FEATURES = [
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
    title: 'Detecção automática',
    desc: 'Captura pedidos de donates, resubs e comandos de chat automaticamente.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
        <circle cx="12" cy="17" r="0.5" fill="currentColor" />
      </svg>
    ),
    title: 'Identificação de personagens com IA',
    desc: 'Usa inteligência artificial para reconhecer personagens, mesmo com nomes errados ou apelidos.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    ),
    title: 'Sync em tempo real',
    desc: 'Viewers acompanham a fila ao vivo. Streamer gerencia de qualquer dispositivo.',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    title: 'Gratuito',
    desc: 'Sem assinatura, sem limite de uso. Funciona para qualquer canal.',
  },
];

const STEPS = [
  { num: '1', title: 'Conecte sua Twitch', desc: 'Faça login com sua conta da Twitch para começar' },
  { num: '2', title: 'Configure as fontes', desc: 'Ative donates, resubs, chat e ajuste filtros' },
  { num: '3', title: 'Gerencie a fila', desc: 'Reordene, marque como feito, adicione manualmente' },
];

export function LandingPage() {
  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="landing-hero-content">
          <div className="landing-brand">
            <img src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.png`} alt="DBD" />
          </div>
          <h1>Fila <span>DBD</span></h1>
          <p className="landing-tagline">
            Gerencie pedidos de personagens de Dead by Daylight durante suas streams na Twitch.
          </p>
          <ConnectButton />
        </div>
        <div className="landing-hero-glow" />
      </section>

      <section className="landing-section landing-section-channels">
        <h2>Canais ativos</h2>
        <LiveChannels />
      </section>

      <section className="landing-section">
        <h2>Como funciona</h2>
        <div className="landing-features">
          {FEATURES.map((f, i) => (
            <div key={i} className="landing-feature" style={{ animationDelay: `${i * 0.1}s` }}>
              <div className="landing-feature-icon">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <h2>Comece em 3 passos</h2>
        <div className="landing-steps">
          {STEPS.map((s, i) => (
            <div key={i} className="landing-step" style={{ animationDelay: `${i * 0.1 + 0.3}s` }}>
              <div className="landing-step-num">{s.num}</div>
              <div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="landing-disclaimer">
        <p>Seus dados de fila ficam salvos nos nossos servidores para que você não perca nada entre sessões.</p>
        <p>Fila DBD é um projeto de código aberto e não tem nenhuma relação com a Behaviour Interactive.</p>
        <p>Feito com ❤️ por <a href="https://github.com/macecchi" target="_blank">macecchi</a> para a <a href="https://twitch.tv/mandymess" target="_blank">@MandyMess</a>.</p>
      </div>
      <footer className="landing-footer">
        <span>Fila DBD</span>
        <a href="https://github.com/macecchi/dbd-utils" target="_blank">GitHub</a>
      </footer>
    </div>
  );
}
