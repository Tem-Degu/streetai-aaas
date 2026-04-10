import React, { useState, useContext } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch, WorkspaceContext } from '../hooks/useApi.js';

const STEPS = [
  {
    num: 1,
    title: 'Define your service',
    desc: 'Think about what service your agent will provide. What problem does it solve? Who are the customers? What are the deliverables and pricing? You don\'t need to write anything yet, just have a clear picture.',
    tip: 'Examples: a used phone marketplace, a travel concierge, a tutoring service, a matchmaker, a food ordering agent, a freelance consulting service.',
    action: null,
  },
  {
    num: 2,
    title: 'Prepare your data',
    desc: 'Gather the files, images, documents, and structured data your agent needs to provide the service. This includes product listings, menus, course materials, photos, PDFs, or any other reference material.',
    tip: 'You can add data now or later. Use the Data tab to upload files, create JSON records, or import external files. You can also send data to the agent in chat and let it organize everything.',
    action: { label: 'Open Data', path: '/data' },
  },
  {
    num: 3,
    title: 'Set up external services',
    desc: 'If your agent needs to call external APIs (payments, shipping, weather, email) or delegate to other agents, register them as extensions. Each extension becomes a tool the agent can use during conversations.',
    tip: 'You can always add extensions later as your service evolves.',
    action: { label: 'Open Extensions', path: '/extensions' },
  },
  {
    num: 4,
    title: 'Populate your service',
    desc: 'Use the chat interface, the CLI, or the Data tab to build your service database with natural language. Tell the agent about your products, rules, and processes and it will structure and store everything for you.',
    tip: 'Try chatting in Admin mode: "Add a new product: iPhone 15 Pro, 256GB, Excellent condition, $950". The agent creates the database entry automatically.',
    action: { label: 'Open Chat', path: '/chat' },
  },
  {
    num: 5,
    title: 'Write the SKILL',
    desc: 'Define how the agent should behave and deliver the service. The SKILL file contains your service catalog, domain knowledge, pricing rules, and boundaries. You can write it yourself or use the chat interface to have the LLM generate it from your description.',
    tip: 'In Chat, try: "Write me a SKILL.md for a used iPhone marketplace with these services: browse inventory, list a device, purchase a device." The agent will draft the whole file.',
    action: { label: 'Edit Skill', path: '/skill' },
  },
  {
    num: 6,
    title: 'Test and improve',
    desc: 'Chat with your agent as both a customer and an admin to test how it handles real requests. Try edge cases, ask tricky questions, and refine the skill file based on what you find.',
    tip: 'Use User mode to simulate a real customer experience. Switch to Admin mode when you need to fix data, update rules, or debug behavior. You can also test via the CLI with "aaas chat".',
    action: { label: 'Open Chat', path: '/chat' },
  },
  {
    num: 7,
    title: 'Choose platforms and connect',
    desc: 'Pick where your agent will be available: Truuze, HTTP API, Telegram, Discord, Slack, WhatsApp, or a combination. Each platform has its own setup flow in the Deploy tab.',
    tip: 'Start with one platform to validate, then add more later. The HTTP API is the simplest to set up. Use the Relay if you don\'t have a public server.',
    action: { label: 'Open Deploy', path: '/deploy' },
  },
  {
    num: 8,
    title: 'Go live',
    desc: 'Run your agent and it starts serving on all connected platforms. Monitor transactions, review memory, and keep improving the service over time.',
    tip: 'Use "aaas run" from the CLI or click Start in the Deploy tab. Check the Overview tab for stats and the Transactions tab to track service delivery.',
    action: { label: 'Open Overview', path: '' },
  },
];

export default function SetupGuide() {
  const navigate = useNavigate();
  const workspace = useContext(WorkspaceContext);
  const prefix = workspace ? `/ws/${workspace}` : '';
  const { data: overview } = useFetch('/api/overview');
  const { data: connections } = useFetch('/api/connections');
  const { data: deployStatus } = useFetch('/api/deploy/status');

  const [completed, setCompleted] = useState(() => {
    try {
      const key = `aaas-setup-progress${workspace ? `-${workspace}` : ''}`;
      return JSON.parse(localStorage.getItem(key) || '[]');
    } catch { return []; }
  });

  const toggleStep = (num) => {
    const next = completed.includes(num)
      ? completed.filter(n => n !== num)
      : [...completed, num];
    setCompleted(next);
    const key = `aaas-setup-progress${workspace ? `-${workspace}` : ''}`;
    localStorage.setItem(key, JSON.stringify(next));
  };

  const progress = Math.round((completed.length / STEPS.length) * 100);

  const getAutoHint = (num) => {
    switch (num) {
      case 2: {
        const count = overview?.data?.files || 0;
        return count > 0 ? `${count} data file${count !== 1 ? 's' : ''} found` : null;
      }
      case 3: {
        const count = overview?.extensions || 0;
        return count > 0 ? `${count} extension${count !== 1 ? 's' : ''} registered` : null;
      }
      case 5:
        return overview?.skill?.exists ? `Skill configured (${Math.round((overview.skill.size || 0) / 1024)}KB)` : null;
      case 7: {
        const conns = connections || [];
        return conns.length > 0 ? `Connected: ${conns.map(c => c.platform).join(', ')}` : null;
      }
      case 8:
        return deployStatus?.daemonRunning ? 'Agent is running' : null;
      default:
        return null;
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Setup Guide</h1>
        <p className="page-desc">Follow these steps to get your agent up and running</p>
      </div>

      <div className="setup-progress">
        <div className="setup-progress-bar">
          <div className="setup-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="setup-steps">
        {STEPS.map((step) => {
          const done = completed.includes(step.num);
          const hint = getAutoHint(step.num);
          return (
            <div key={step.num} className={`setup-step ${done ? 'setup-step-done' : ''}`}>
              <div className="setup-step-header">
                <button
                  className={`setup-check ${done ? 'setup-check-done' : ''}`}
                  onClick={() => toggleStep(step.num)}
                  title={done ? 'Mark as incomplete' : 'Mark as complete'}
                >
                  {done ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 7l3 3 5-5" />
                    </svg>
                  ) : (
                    <span className="setup-check-num">{step.num}</span>
                  )}
                </button>
                <div className="setup-step-title">{step.title}</div>
                {hint && <span className="setup-step-hint">{hint}</span>}
              </div>
              <div className="setup-step-body">
                <p className="setup-step-desc">{step.desc}</p>
                <div className="setup-step-tip">{step.tip}</div>
                {step.action && (
                  <button
                    className="btn btn-sm"
                    onClick={() => navigate(`${prefix}${step.action.path}`)}
                  >
                    {step.action.label} &rarr;
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="setup-footer">
        <p>Need more detail? Check the <button className="link-btn" onClick={() => navigate('/guide')}>full reference guide</button> for in-depth documentation on every feature.</p>
      </div>
    </div>
  );
}
