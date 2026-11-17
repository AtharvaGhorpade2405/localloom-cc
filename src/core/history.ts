import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Mode, SessionSnapshot } from './session.js';

/**
 * Local chat history. Every conversation is one JSON file in the history folder
 * (default `~/.localloom/sessions`). Nothing is uploaded anywhere.
 */

export const HISTORY_VERSION = 1;

/** A chat item as stored on disk (UI ids are reassigned on load). */
export type StoredItem = { kind: string } & Record<string, unknown>;

export interface SessionRecord extends SessionSnapshot {
  version: number;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Directory LocalLoom was started in. */
  cwd: string;
  mode: Mode;
  items: StoredItem[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  projectName?: string;
  messages: number;
}

export function defaultHistoryDir(): string {
  const custom = process.env.LOCALLOOM_HISTORY_DIR?.trim();
  return path.resolve(custom || path.join(os.homedir(), '.localloom', 'sessions'));
}

export function historyDisabled(): boolean {
  return process.env.LOCALLOOM_NO_HISTORY === '1';
}

export function newSessionId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

const ID_RE = /^[\w-]+$/;

export function titleFor(items: StoredItem[]): string {
  const first = items.find((i) => i.kind === 'user' && typeof i.text === 'string');
  const text = first ? String(first.text).replace(/\s+/g, ' ').trim() : '';
  if (!text) return '(empty chat)';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export class HistoryStore {
  readonly dir: string;

  constructor(dir: string = defaultHistoryDir()) {
    this.dir = dir;
  }

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid session id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  /** Write a session atomically (temp file + rename) so a crash never leaves a half-written file. */
  save(record: SessionRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.file(record.id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  }

  load(id: string): SessionRecord {
    const raw = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as SessionRecord;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) throw new Error(`Session ${id} is not a valid LocalLoom session file.`);
    return { ...raw, memory: Array.isArray(raw.memory) ? raw.memory : [] };
  }

  delete(id: string): boolean {
    try {
      fs.unlinkSync(this.file(id));
      return true;
    } catch {
      return false;
    }
  }

  /** All saved sessions, most recently updated first. Unreadable files are skipped. */
  list(): SessionSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const name of names) {
      try {
        const r = this.load(name.slice(0, -5));
        out.push({
          id: r.id,
          title: r.title || titleFor(r.items),
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          cwd: r.cwd,
          projectName: r.project?.name,
          messages: r.items.filter((i) => i.kind === 'user').length,
        });
      } catch {
        // ignore corrupt or foreign files
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Find a session by its 1-based position in `list()` or by (a prefix of) its id. */
  resolve(ref: string): SessionSummary | undefined {
    const all = this.list();
    const q = ref.trim();
    if (/^\d+$/.test(q) && q.length < 6) return all[Number(q) - 1];
    return all.find((s) => s.id === q) ?? all.find((s) => s.id.startsWith(q));
  }
}
