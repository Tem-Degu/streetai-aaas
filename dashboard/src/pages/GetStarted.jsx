import React from 'react';
import { useNavigate } from 'react-router-dom';

const BENEFITS = [
  {
    title: 'No Code Required',
    desc: 'Describe your service, add your data, and your agent is ready. No programming, no frameworks — just plain text and files.',
  },
  {
    title: 'Real Business, Not a Chatbot',
    desc: 'Your agent manages inventory, tracks transactions, connects to external services, and delivers results — a full service operation.',
  },
  {
    title: 'Gets Smarter Over Time',
    desc: 'Built-in memory lets your agent learn from every interaction. It remembers user preferences, past orders, and context.',
  },
  {
    title: 'Multi-Platform Deployment',
    desc: 'Deploy to Truuze, Telegram, Discord, Slack, WhatsApp, or expose as an HTTP API — all from one workspace.',
  },
  {
    title: 'Your Data, Your Control',
    desc: 'Everything runs locally. Your service database, customer data, and agent memory stay on your machine.',
  },
  {
    title: 'Works With Any LLM',
    desc: 'Use Anthropic, OpenAI, Google, or run locally with Ollama. Switch providers without changing your service.',
  },
];

const STEPS = [
  { num: '1', title: 'Create an agent', desc: 'Give your agent a name and describe what service it provides.' },
  { num: '2', title: 'Configure your LLM', desc: 'Add your API key for Anthropic, OpenAI, Google, or use a local model with Ollama.' },
  { num: '3', title: 'Add your data', desc: 'Upload products, menus, documents, images — whatever your agent needs to do its job.' },
  { num: '4', title: 'Define the service', desc: 'Write your service catalog, pricing, domain knowledge, and rules in the SKILL file.' },
  { num: '5', title: 'Test and deploy', desc: 'Chat with your agent to test it, then connect to any platform to go live.' },
];

export default function GetStarted() {
  const navigate = useNavigate();

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Agent as a Service</h1>
        <p className="page-desc">Turn your expertise into an AI-powered service business</p>
      </div>

      <div className="gs-hero">
        <p className="gs-hero-text">
          AaaS lets you turn expertise into an AI-powered service business. Add your data,
          define your service, and your agent handles conversations, manages inventory, tracks
          transactions, and deploys to any platform — no code required.
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => navigate('/')}>
          Create an Agent
        </button>
      </div>

      <h3 className="gs-section-title">Why Agent as a Service?</h3>
      <div className="gs-benefits">
        {BENEFITS.map((b, i) => (
          <div key={i} className="gs-benefit">
            <div className="gs-benefit-title">{b.title}</div>
            <div className="gs-benefit-desc">{b.desc}</div>
          </div>
        ))}
      </div>

      <h3 className="gs-section-title">How It Works</h3>
      <div className="gs-steps">
        {STEPS.map((s, i) => (
          <div key={i} className="gs-step">
            <div className="gs-step-num">{s.num}</div>
            <div>
              <div className="gs-step-title">{s.title}</div>
              <div className="gs-step-desc">{s.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="gs-cta">
        <p>Ready to build your first agent?</p>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" onClick={() => navigate('/')}>Create an Agent</button>
          <button className="btn" onClick={() => navigate('/guide')}>Read the Guide</button>
        </div>
      </div>
    </div>
  );
}
