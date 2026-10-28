'use strict';

const fs = require('node:fs/promises');

// One writer owns the temp files. Pending preference updates coalesce; an
// acknowledged edit is durable before its caller returns. A failed write never
// replaces the last complete file and remains retryable through flush().
class ConfigWriter {
  constructor(file, { delay = 80, onError = () => {} } = {}) {
    this.file = file;
    this.delay = delay;
    this.onError = onError;
    this.pending = null;
    this.flight = null;
    this.timer = null;
    this.lastError = null;
    this.sequence = 0;
  }

  schedule(value) {
    this.pending = { text: JSON.stringify(value, null, 2), sequence: ++this.sequence };
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(this.onError);
    }, this.delay);
  }

  async write(value) {
    this.schedule(value);
    await this.flush();
  }

  async replace(text) {
    const temporary = `${this.file}.tmp`;
    const backupTemporary = `${this.file}.bak.tmp`;
    const handle = await fs.open(temporary, 'w');
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await fs.copyFile(this.file, backupTemporary);
      await fs.rename(backupTemporary, `${this.file}.bak`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, this.file);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.flight) { await this.flight; if (!this.pending) return; }
    if (!this.pending) return;
    this.flight = (async () => {
      while (this.pending) {
        const next = this.pending;
        this.pending = null;
        try { await this.replace(next.text); this.lastError = null; }
        catch (error) {
          if (!this.pending) this.pending = next;
          this.lastError = error;
          throw error;
        }
      }
    })();
    try { await this.flight; }
    finally { this.flight = null; }
  }
}

module.exports = { ConfigWriter };
