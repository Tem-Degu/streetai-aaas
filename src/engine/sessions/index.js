import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from '../../utils/workspace.js';

/**
 * Manages per-user per-platform conversation sessions.
 * Sessions are stored in .aaas/sessions/<platform>_<userId>.json
 */
export class SessionManager {
  constructor(workspace) {
    this.sessionsDir = path.join(workspace, '.aaas', 'sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  _sessionPath(platformId, userId) {
    const safe = `${platformId}_${userId}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
    return path.join(this.sessionsDir, `${safe}.json`);
  }

  getSession(platformId, userId) {
    const fp = this._sessionPath(platformId, userId);
    const data = readJson(fp);
    if (data) return data;

    return {
      platformId,
      userId,
      messages: [],
      summary: null,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
    };
  }

  addMessage(platformId, userId, message) {
    const session = this.getSession(platformId, userId);
    session.messages.push({
      ...message,
      at: new Date().toISOString(),
    });
    session.lastActive = new Date().toISOString();
    this._save(platformId, userId, session);
    return session;
  }

  /**
   * Replace old messages with a summary, keeping the last N messages verbatim.
   */
  applySummary(platformId, userId, summary, keepLast = 3) {
    const session = this.getSession(platformId, userId);
    const kept = session.messages.slice(-keepLast);
    session.messages = kept;
    session.summary = summary;
    this._save(platformId, userId, session);
    return session;
  }

  setSessionMeta(platformId, userId, key, value) {
    const session = this.getSession(platformId, userId);
    if (!session.meta) session.meta = {};
    session.meta[key] = value;
    this._save(platformId, userId, session);
  }

  getSessionMeta(platformId, userId, key) {
    const session = this.getSession(platformId, userId);
    return session.meta?.[key] ?? null;
  }

  clearSession(platformId, userId) {
    const fp = this._sessionPath(platformId, userId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }

  listSessions() {
    if (!fs.existsSync(this.sessionsDir)) return [];
    return fs.readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const data = readJson(path.join(this.sessionsDir, f));
        return data ? { file: f, ...data } : null;
      })
      .filter(Boolean);
  }

  _save(platformId, userId, session) {
    const fp = this._sessionPath(platformId, userId);
    writeJson(fp, session);
  }
}
