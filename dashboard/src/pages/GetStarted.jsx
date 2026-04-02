import React from 'react';
import { useNavigate } from 'react-router-dom';

const BENEFITS = [
  {
    title: 'No Code Required',
    desc: 'Define your service in plain text. Write a SKILL.md describing what your agent does, and it handles the rest.',
  },
  {
    title: 'Real Business, Not a Chatbot',
    desc: 'Your agent manages inventory, tracks transactions, handles payments, and delivers results — a full service operation.',
  },
  {
    title: 'Gets Smarter Over Time',
    desc: 'Built-in memory lets your agent learn from every interaction. It remembers user preferences, past orders, and context.',
  },
  {
    title: 'Multi-Platform Deployment',
    desc: 'Deploy to Truuze, expose as an HTTP API, or connect to multiple platforms simultaneously from one workspace.',
  },
  {
    title: 'Your Data, Your Control',
    desc: 'Everything runs locally. Your service database, customer data, and agent memory stay in your workspace.',
  },
  {
    title: 'Works With Any LLM',
    desc: 'Use Anthropic, OpenAI, Google, or run locally with Ollama. Switch providers without changing your service.',
  },
];

const STEPS = [
  { num: '1', title: 'Create a workspace', desc: 'Set up your agent with a name and service description.' },
  { num: '2', title: 'Configure your LLM', desc: 'Add your API key for Anthropic, OpenAI, Google, or Ollama.' },
  { num: '3', title: 'Write your SKILL.md', desc: 'Define your service catalog, pricing, domain knowledge, and boundaries.' },
  { num: '4', title: 'Add your data', desc: 'Seed your database with products, profiles, or any service data.' },
  { num: '5', title: 'Deploy', desc: 'Connect to Truuze, start an HTTP API, or both. Your agent goes live.' },
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
          AaaS lets you build AI agents that provide real services through conversation.
          Instead of writing code, you write a skill document that teaches your agent everything
          it needs to know. The agent handles conversations, manages data, tracks transactions,
          and deploys to any platform.
        </p>
        <button className="btn btn-primary btn-lg" onClick={() => navigate('/agents')}>
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
          <button className="btn btn-primary" onClick={() => navigate('/agents')}>Create an Agent</button>
          <button className="btn" onClick={() => navigate('/guide')}>Read the Guide</button>
        </div>
      </div>
    </div>
  );
}
