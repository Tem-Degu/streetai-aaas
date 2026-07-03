import React, { useState, useEffect } from 'react';
import { Routes, Route, NavLink, useParams, useNavigate, useLocation } from 'react-router-dom';
import { WorkspaceContext, useResolveUrl } from './hooks/useApi.js';
import { withBase, AGENT_BASE } from './base.js';
import { ThemeContext, useThemeState } from './hooks/useTheme.js';
import { NavModeContext, useNavModeStore, useNavMode } from './hooks/useNavMode.js';
import Overview from './pages/Overview.jsx';
import Skill from './pages/Skill.jsx';
import Soul from './pages/Soul.jsx';
import Data from './pages/Data.jsx';
import Transactions from './pages/Transactions.jsx';
import Extensions from './pages/Extensions.jsx';
import Memory from './pages/Memory.jsx';
import Chat from './pages/Chat.jsx';
import Settings from './pages/Settings.jsx';
import Deploy from './pages/Deploy.jsx';
import Notifications from './pages/Notifications.jsx';
import Payments from './pages/Payments.jsx';
import Hub from './pages/Hub.jsx';
import GetStarted from './pages/GetStarted.jsx';
import Guide from './pages/Guide.jsx';
import SetupGuide from './pages/SetupGuide.jsx';
import { useUnseenTransactions } from './hooks/useUnseenTransactions.js';
import { useAgentHealth } from './hooks/useAgentHealth.js';
import AgentDownAlert from './components/AgentDownAlert.jsx';
import { isMuted, setMuted, playChime, SOUND_PREF_EVENT } from './utils/notificationSound.js';

function Logo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="logo-svg">
      <rect x="2" y="2" width="28" height="28" rx="8" className="logo-bg" />
      <circle cx="16" cy="12" r="4" className="logo-fg" />
      <path d="M9 23c0-3.866 3.134-7 7-7s7 3.134 7 7" className="logo-fg-stroke" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      <path d="M22 10l3-3m0 0v2.5m0-2.5h-2.5" className="logo-accent" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 10l-3-3m0 0v2.5m0-2.5h2.5" className="logo-accent" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function workspaceNav(prefix) {
  return [
    {
      section: '',
      items: [
        { path: `${prefix}/setup`, label: 'Setup Guide', icon: <IconBook />, highlight: true },
      ]
    },
    {
      section: 'Monitor',
      items: [
        { path: `${prefix}`, label: 'Overview', icon: <IconGrid /> },
        { path: `${prefix}/transactions`, label: 'Transactions', icon: <IconReceipt /> },
        { path: `${prefix}/chat`, label: 'Chat', icon: <IconChat /> },
      ]
    },
    {
      section: 'Configure',
      items: [
        { path: `${prefix}/skill`, label: 'Skill', icon: <IconDoc /> },
        { path: `${prefix}/soul`, label: 'Soul', icon: <IconStar /> },
        { path: `${prefix}/extensions`, label: 'Extensions', icon: <IconPlug /> },
      ]
    },
    {
      section: 'Storage',
      items: [
        { path: `${prefix}/data`, label: 'Data', icon: <IconDB /> },
        { path: `${prefix}/memory`, label: 'Memory', icon: <IconBrain /> },
      ]
    },
    {
      section: 'Runtime',
      items: [
        { path: `${prefix}/deploy`, label: 'Deploy', icon: <IconRocket /> },
        { path: `${prefix}/notifications`, label: 'Notifications', icon: <IconBell /> },
        { path: `${prefix}/payments`, label: 'Payments', icon: <IconCard /> },
        { path: `${prefix}/settings`, label: 'Settings', icon: <IconGear /> },
      ]
    },
  ];
}

/**
 * Simplified flat nav for non-technical roles (e.g. restaurant operators).
 * No section headers; only day-to-day pages plus Settings so the user can
 * always switch back to admin nav.
 *
 * Setup Guide, Skill/Soul/Extensions, Data/Memory, and Deploy are all
 * hidden — they're owner/setup-time concerns. Notifications and Payments
 * stay because operators do consult them.
 */
function basicNav(prefix) {
  return [
    {
      section: '',
      items: [
        { path: `${prefix}`, label: 'Overview', icon: <IconGrid /> },
        { path: `${prefix}/transactions`, label: 'Transactions', icon: <IconReceipt /> },
        { path: `${prefix}/chat`, label: 'Chat', icon: <IconChat /> },
        { path: `${prefix}/notifications`, label: 'Notifications', icon: <IconBell /> },
        { path: `${prefix}/payments`, label: 'Payments', icon: <IconCard /> },
        { path: `${prefix}/settings`, label: 'Settings', icon: <IconGear /> },
      ],
    },
  ];
}

function hubNav(hasAgents) {
  const items = hasAgents
    ? [
        { path: '/', label: 'Agents', icon: <IconGrid /> },
        { path: '/get-started', label: 'Get Started', icon: <IconRocket /> },
        { path: '/guide', label: 'Guide', icon: <IconBook /> },
        { path: '/settings', label: 'Settings', icon: <IconGear /> },
      ]
    : [
        { path: '/', label: 'Get Started', icon: <IconRocket /> },
        { path: '/agents', label: 'Agents', icon: <IconGrid /> },
        { path: '/guide', label: 'Guide', icon: <IconBook /> },
        { path: '/settings', label: 'Settings', icon: <IconGear /> },
      ];
  return [{ section: '', items }];
}

/** Turn a workspace slug into a display name: "centro_restaurant" -> "Centro Restaurant". */
function prettifyName(slug) {
  return (String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())) || 'Agent';
}

/** Agent brand: the workspace photo (falls back to the hub logo) + business name. */
function WorkspaceBrand({ workspaceName, health }) {
  const resolve = useResolveUrl();
  const [imgOk, setImgOk] = useState(true);
  const name = prettifyName(workspaceName);
  return (
    <div className="sidebar-logo">
      {imgOk
        ? <img className="sidebar-avatar" src={resolve('/api/avatar')} alt={name} onError={() => setImgOk(false)} />
        : <Logo />}
      <span className="sidebar-agent-name">{name}<AgentStatusDot health={health} /></span>
    </div>
  );
}

/**
 * Agent health LED shown at the end of the agent name. Color carries the
 * state (green live, amber reconnecting, red down, grey offline); the word is
 * available on hover. Calm pulse when active.
 */
function AgentStatusDot({ health }) {
  if (!health || health.state === 'unknown') return null;
  const map = {
    online: { color: 'var(--green)', label: 'online', pulse: true },
    reconnecting: { color: 'var(--yellow)', label: 'reconnecting', pulse: true },
    error: { color: 'var(--red)', label: 'stopped', pulse: true },
    stopped: { color: 'var(--text-muted)', label: 'offline', pulse: false },
  };
  const s = map[health.state] || map.stopped;
  return (
    <span
      className={`status-led status-led-inline ${s.pulse ? 'status-led-pulse' : ''}`}
      style={{ color: s.color }}
      title={`Agent ${s.label}`}
    />
  );
}

function Sidebar({ navItems, mode, onLogoClick, workspaceName, health }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand" onClick={onLogoClick} style={{ cursor: 'pointer' }}>
        {workspaceName ? (
          <WorkspaceBrand workspaceName={workspaceName} health={health} />
        ) : (
          <>
            <div className="sidebar-logo">
              <Logo />
              <span className="sidebar-logo-text">AaaS<AgentStatusDot health={health} /></span>
            </div>
            <div className="sidebar-tagline">Agent as a Service</div>
          </>
        )}
      </div>

      {mode === 'hub' && workspaceName && (
        <div style={{ padding: '0 16px 8px' }}>
          <NavLink to="/" style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none' }}>
            &larr; All Agents
          </NavLink>
        </div>
      )}

      {navItems.map(({ section, items }) => (
        <div key={section || '_root'}>
          {section && <div className="sidebar-section">{section}</div>}
          <ul className="sidebar-nav">
            {items.map(({ path, label, icon, highlight, badge }) => (
              <li key={path}>
                <NavLink to={path} end={path === '/' || path.match(/^\/ws\/[^/]+$/)} className={({ isActive }) => `${isActive ? 'active' : ''}${highlight ? ' nav-highlight' : ''}`}>
                  <span className="nav-icon">{icon}</span>
                  <span style={{ flex: 1 }}>{label}</span>
                  {typeof badge === 'number' && badge > 0 && (
                    <span
                      style={{
                        background: 'var(--accent, #4ec5ca)',
                        color: '#fff',
                        fontSize: 11,
                        fontWeight: 600,
                        lineHeight: 1,
                        padding: '3px 7px',
                        borderRadius: 10,
                        minWidth: 18,
                        textAlign: 'center',
                      }}
                    >
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div style={{ flex: 1 }} />
      <div className="sidebar-footer">
        <SoundToggle />
        <span className="sidebar-footer-meta">
          <a href="https://github.com/Tem-Degu/streetai-aaas" target="_blank" rel="noreferrer">GitHub</a>
          {' \u00b7 '}
          <span>v0.1.0</span>
        </span>
      </div>
    </aside>
  );
}

/**
 * Mute/unmute the new-transaction chime. Persists to localStorage via the
 * notificationSound util; clicking unmute also unlocks the AudioContext and
 * plays a confirmation ping so the operator hears it works.
 */
function SoundToggle() {
  const [muted, setMutedState] = useState(() => isMuted());
  useEffect(() => {
    const onChange = (e) => setMutedState(!!e?.detail?.muted);
    window.addEventListener(SOUND_PREF_EVENT, onChange);
    return () => window.removeEventListener(SOUND_PREF_EVENT, onChange);
  }, []);
  const toggle = () => {
    const next = !muted;
    setMuted(next);
    if (!next) playChime(); // confirm audio works on enable
  };
  return (
    <button
      onClick={toggle}
      title={muted ? 'Transaction sound off \u2014 click to enable' : 'Transaction sound on \u2014 click to mute'}
      aria-label={muted ? 'Enable transaction sound' : 'Mute transaction sound'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        color: 'inherit', font: 'inherit',
      }}
    >
      {muted ? (
        // speaker-muted
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
      ) : (
        // speaker-on
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
      )}
      <span>Sound</span>
    </button>
  );
}

/** Wraps workspace pages with the WorkspaceContext for hub mode */
function WorkspaceView() {
  const { wsName } = useParams();
  const prefix = `/ws/${wsName}`;
  const { navMode } = useNavMode(wsName);
  const navItems = navMode === 'basic' ? basicNav(prefix) : workspaceNav(prefix);

  return (
    <WorkspaceContext.Provider value={wsName}>
      <WorkspaceLayout navItems={navItems} wsName={wsName} prefix={prefix} navMode={navMode} />
    </WorkspaceContext.Provider>
  );
}

function withTransactionsBadge(navItems, count, prefix) {
  if (!count) return navItems;
  const target = `${prefix}/transactions`;
  return navItems.map(section => ({
    ...section,
    items: section.items.map(item =>
      item.path === target ? { ...item, badge: count } : item
    ),
  }));
}

function WorkspaceLayout({ navItems, wsName, prefix, navMode }) {
  const navigate = useNavigate();
  const unseenTxns = useUnseenTransactions();
  const health = useAgentHealth();
  const decoratedNav = withTransactionsBadge(navItems, unseenTxns, prefix);

  return (
    <div className="layout">
      <AgentDownAlert health={health} basic={navMode === 'basic'} />
      <Sidebar
        navItems={decoratedNav}
        mode="hub"
        workspaceName={wsName}
        onLogoClick={() => navigate('/')}
        health={health}
      />
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/skill" element={<Skill />} />
          <Route path="/soul" element={<Soul />} />
          <Route path="/data" element={<Data />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/extensions" element={<Extensions />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/deploy" element={<Deploy />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/setup" element={<SetupGuide />} />
        </Routes>
      </main>
    </div>
  );
}

// Hosted (in-account) entry: the container holds a single workspace, so open it
// directly instead of showing the hub. Falls back to a message if none is found.
function HostedEntry() {
  const navigate = useNavigate();
  const [msg, setMsg] = useState('Opening…');
  useEffect(() => {
    fetch(withBase('/api/hub/workspaces'))
      .then(r => r.json())
      .then(d => {
        const list = d.workspaces || [];
        if (list.length) navigate(`/ws/${list[0].directory}`, { replace: true });
        else setMsg('No workspace found for this assistant.');
      })
      .catch(() => setMsg('Could not open the assistant. Please refresh.'));
  }, [navigate]);
  return <div className="page-loading">{msg}</div>;
}

function HubLayout() {
  const navigate = useNavigate();
  const [hasAgents, setHasAgents] = useState(null);

  useEffect(() => {
    fetch(withBase('/api/hub/workspaces'))
      .then(r => r.json())
      .then(d => setHasAgents((d.workspaces || []).length > 0))
      .catch(() => setHasAgents(false));
  }, []);

  if (hasAgents === null) return <div className="page-loading">Loading...</div>;

  const navItems = hubNav(hasAgents);

  return (
    <div className="layout">
      <Sidebar
        navItems={navItems}
        mode="hub"
        onLogoClick={() => navigate('/')}
      />
      <main className="main">
        {hasAgents ? (
          <Routes>
            <Route path="/" element={<Hub />} />
            <Route path="/get-started" element={<GetStarted />} />
            <Route path="/guide" element={<Guide />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<GetStarted />} />
            <Route path="/agents" element={<Hub />} />
            <Route path="/guide" element={<Guide />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function StandaloneLayout() {
  const navigate = useNavigate();
  // Standalone mode has no workspace name — uses the synthetic _standalone key.
  const { navMode } = useNavMode(null);
  const navItems = navMode === 'basic' ? basicNav('') : workspaceNav('');
  const unseenTxns = useUnseenTransactions();
  const health = useAgentHealth();
  const decoratedNav = withTransactionsBadge(navItems, unseenTxns, '');

  return (
    <div className="layout">
      <AgentDownAlert health={health} basic={navMode === 'basic'} />
      <Sidebar
        navItems={decoratedNav}
        mode="workspace"
        onLogoClick={() => navigate('/')}
        health={health}
      />
      <main className="main">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/skill" element={<Skill />} />
          <Route path="/soul" element={<Soul />} />
          <Route path="/data" element={<Data />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/extensions" element={<Extensions />} />
          <Route path="/memory" element={<Memory />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/deploy" element={<Deploy />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/setup" element={<SetupGuide />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState(null);
  const themeState = useThemeState();
  const navModeStore = useNavModeStore();

  useEffect(() => {
    fetch(withBase('/api/mode'))
      .then(r => r.json())
      .then(d => setMode(d.mode))
      .catch(() => setMode('workspace'));
  }, []);

  if (!mode) return <div className="page-loading">Loading...</div>;

  const content = mode === 'hub' ? (
    <Routes>
      <Route path="/ws/:wsName/*" element={<WorkspaceView />} />
      {/* Hosted (in-account) dashboards open straight into their workspace,
          skipping the hub. Self-hosted/local keeps the hub as the landing. */}
      <Route path="/*" element={AGENT_BASE ? <HostedEntry /> : <HubLayout />} />
    </Routes>
  ) : (
    <StandaloneLayout />
  );

  return (
    <ThemeContext.Provider value={themeState}>
      <NavModeContext.Provider value={navModeStore}>
        {content}
      </NavModeContext.Provider>
    </ThemeContext.Provider>
  );
}

/* ─── Nav Icons (inline SVGs for zero deps) ─── */

function IconGrid() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="2" width="5.5" height="5.5" rx="1.5" />
      <rect x="10.5" y="2" width="5.5" height="5.5" rx="1.5" />
      <rect x="2" y="10.5" width="5.5" height="5.5" rx="1.5" />
      <rect x="10.5" y="10.5" width="5.5" height="5.5" rx="1.5" />
    </svg>
  );
}

function IconReceipt() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 2h10a1 1 0 011 1v13l-2-1.5L11 16l-2-1.5L7 16l-2-1.5L3 16V3a1 1 0 011-1z" />
      <line x1="6" y1="6" x2="12" y2="6" />
      <line x1="6" y1="9" x2="10" y2="9" />
    </svg>
  );
}

function IconDoc() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 2H5a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V6l-4-4z" />
      <polyline points="10,2 10,6 14,6" />
      <line x1="6.5" y1="9.5" x2="11.5" y2="9.5" />
      <line x1="6.5" y1="12" x2="9.5" y2="12" />
    </svg>
  );
}

function IconStar() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M9 2l2.1 4.3 4.7.7-3.4 3.3.8 4.7L9 12.8 4.8 15l.8-4.7L2.2 7l4.7-.7L9 2z" />
    </svg>
  );
}

function IconPlug() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M7 2v4M11 2v4" />
      <path d="M4 6h10v3a5 5 0 01-10 0V6z" />
      <path d="M9 14v2" />
    </svg>
  );
}

function IconDB() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="9" cy="5" rx="6" ry="2.5" />
      <path d="M3 5v8c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V5" />
      <path d="M3 9c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5" />
    </svg>
  );
}

function IconChat() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13.5V15l2.5-1.5H14a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v8.5z" />
      <line x1="6" y1="7.5" x2="12" y2="7.5" />
      <line x1="6" y1="10" x2="10" y2="10" />
    </svg>
  );
}

function IconBrain() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 16V9" />
      <path d="M6.5 3.5a3 3 0 00-3 3c0 1-.5 2.5.5 3.5s2 1 3 1" />
      <path d="M11.5 3.5a3 3 0 013 3c0 1 .5 2.5-.5 3.5s-2 1-3 1" />
      <path d="M6 3.5a3 3 0 013-1.5 3 3 0 013 1.5" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="9" r="2.5" />
      <path d="M7.5 2h3l.4 1.9a5.5 5.5 0 011.3.7L14 4l1.5 2.6-1.4 1.3a5.6 5.6 0 010 1.4l1.4 1.3L14 13.2l-1.8-.6a5.5 5.5 0 01-1.3.7L10.5 16h-3l-.4-1.7a5.5 5.5 0 01-1.3-.7L4 14.2 2.5 11.6l1.4-1.3a5.6 5.6 0 010-1.4L2.5 7.6 4 5l1.8.6a5.5 5.5 0 011.3-.7L7.5 3z" />
    </svg>
  );
}

function IconRocket() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14l-2 2-1-3-3-1 2-2" />
      <path d="M14.5 3.5s-2-.5-5.5 3-3.5 5.5-3.5 5.5l3 3s2-.5 5.5-3.5 3-5.5 3-5.5l-2.5-2.5z" />
      <circle cx="11.5" cy="6.5" r="1" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h5a2 2 0 012 2v10a1.5 1.5 0 00-1.5-1.5H2V3z" />
      <path d="M16 3h-5a2 2 0 00-2 2v10a1.5 1.5 0 011.5-1.5H16V3z" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 13H4l1.5-2V8a3.5 3.5 0 117 0v3l1.5 2z" />
      <path d="M7.5 15.5a1.5 1.5 0 003 0" />
    </svg>
  );
}

function IconCard() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="14" height="10" rx="1.5" />
      <path d="M2 7.5h14" />
      <path d="M5 11h2" />
    </svg>
  );
}
