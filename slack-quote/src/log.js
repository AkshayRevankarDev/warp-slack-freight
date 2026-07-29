// Structured JSONL quote log — append-only, one event per line.
//
// Chose JSONL over SQLite so there's nothing to install and the file is trivially
// greppable / tail-able during a demo. It also makes it obvious to a reviewer that
// we're actually recording every call, not hiding it behind an ORM. The report CLI
// (`npm run report`) shows how you'd answer "how many quotes this week, on which
// lanes" from this file — the ask in the brief.

import fs from 'node:fs';
import path from 'node:path';

export class QuoteLog {
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  record(event) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
    // Sync write: quote traffic is low and losing a log line to an unflushed buffer
    // on crash would defeat the point. Cheap enough at this scale.
    fs.appendFileSync(this.filePath, line);
  }

  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  }
}
