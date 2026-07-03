import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AGENT_BASE } from './base.js';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <BrowserRouter basename={AGENT_BASE || undefined}>
    <App />
  </BrowserRouter>
);
