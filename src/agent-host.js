'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('./agent-presets.json');
const { writeJson } = require('./json-store');
const { AgentTaskStatus } = require('./agent-task-status');

class AgentHost {
  constructor(executable, window, onState, onShortcut, configPath) {
    this.executable = executable;
    this.window = window;
    this.onState = onState;
    this.onShortcut = onShortcut;
    this.configPath = configPath;
    this.recoveryPath = configPath.replace(/agents\.json$/, 'agent-windows.json');
    let saved = [];
    this.configError = null;
    try {
      if (fs.existsSync(configPath)) {
        saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (!Array.isArray(saved)) throw new Error('Agent 配置必须是列表。');
      }
    } catch (error) {
      saved = [];
      this.configError = `读取 Agent 配置失败，原文件保留：${error.message}`;
    }
    this.presets = defaults.map((preset) => {
      const previous = saved.find((item) => item.id === preset.id);
      return { ...preset, launchPath: previous?.launchPath || preset.launchPath,
        selectedWindow: previous?.selectedWindow || preset.selectedWindow,
        protectedWindows: [...(preset.protectedWindows || []), ...(previous?.protectedWindows || [])]
          .filter((ref, index, refs) => refs.findIndex((other) => other.pid === ref.pid && other.startTicks === ref.startTicks && other.hwnd === ref.hwnd) === index) };
    });
    this.process = null;
    this.ready = null;
    this.sequence = 0;
    this.pending = new Map();
    this.agents = this.presets.map(({ id, name }) => ({ id, name, attached: false, error: null }));
    this.layout = null;
    this.layoutFlight = null;
    this.stopping = false;
    this.focusFlight = null;
    this.observer = null;
    this.observations = new Map();
    this.observationExpiry = null;
    this.taskStatus = new AgentTaskStatus();
    this.observationFlights = new Set();
  }

  get observedAgents() {
    return this.agents.map((agent) => {
      const observation = this.observations.get(agent.id);
      const stopped = observation?.running === false;
      const taskState = observation?.running === true ? observation.taskState || 'unknown' : 'unknown';
      const reason = stopped ? '没有该预设对应的进程。' : observation?.running === true ?
        observation.reason || '进程已运行，正在读取任务状态。' :
        '运行状态尚未确认或进程信息不可读取。';
      return { ...agent, processRunning: observation?.running ?? null, taskState,
        canLaunch: Boolean(this.presets.find(preset => preset.id === agent.id)?.launchPath?.trim()),
        activity: stopped ? 'stopped' : taskState, activityReason: reason, activitySource: observation?.source };
    });
  }

  observe() {
    if (this.observer || process.platform !== 'win32') return;
    // Independent from start()/command(): observing never creates the HWND host,
    // restores a journal, attaches an Agent, or invokes any Agent action.
    const script = fs.readFileSync(path.join(__dirname, 'agent-observer.ps1'), 'utf8');
    const child = spawn(path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.observer = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let snapshot;
      try {
        snapshot = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (!Array.isArray(snapshot) || snapshot.some(item => !item || typeof item.id !== 'string')) throw new Error('invalid observation');
      } catch {
        this.observations.clear();
        this.onState();
        return;
      }
      const before = JSON.stringify(this.observedAgents);
      const next = new Map(snapshot.map((item) => {
        const previous = this.observations.get(item.id);
        // A replacement backend invalidates its predecessor's task status immediately.
        const same = previous?.running === item.running && Date.now() - (previous?.taskObservedAt || 0) < 25000 &&
          JSON.stringify([previous?.instances, previous?.services]) === JSON.stringify([item.instances, item.services]);
        return [item.id, { ...item, ...(same ? { taskState: previous.taskState, reason: previous.reason, source: previous.source,
          taskObservedAt: previous.taskObservedAt } : {}) }];
      }));
      this.observations = next;
      clearTimeout(this.observationExpiry);
      // A missing snapshot becomes unknown rather than retaining a stale result.
      this.observationExpiry = setTimeout(() => { this.observations.clear(); this.onState(); }, 25000);
      this.observationExpiry.unref();
      if (before !== JSON.stringify(this.observedAgents)) this.onState();
      for (const preset of this.presets) {
        if (this.observationFlights.has(preset.id)) continue;
        const observation = next.get(preset.id);
        if (!observation || observation.running !== true) continue;
        this.observationFlights.add(preset.id);
        // Separate asynchronous reads: a slow DSH response never blocks Antigravity or navigation.
        const agent = this.agents.find((item) => item.id === preset.id);
        this.taskStatus.read(preset, observation, agent).then((result) => {
          if (this.observer !== child || this.observations.get(preset.id) !== observation) return;
          const before = JSON.stringify(this.observedAgents);
          Object.assign(observation, result, { taskObservedAt: Date.now() });
          if (before !== JSON.stringify(this.observedAgents)) this.onState();
        }).catch(() => {
          if (this.observer === child && this.observations.get(preset.id) === observation) {
            Object.assign(observation, { taskState: 'unknown', reason: '任务状态暂不可读取。', taskObservedAt: Date.now() });
            this.onState();
          }
        }).finally(() => this.observationFlights.delete(preset.id));
      }
    });
    const ended = () => {
      if (this.observer !== child) return;
      this.observer = null;
      clearTimeout(this.observationExpiry);
      this.observations.clear();
      this.onState();
    };
    child.once('error', ended);
    child.once('exit', ended);
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(this.presets.map(({ id, processName, executableContains }) =>
      ({ id, processName, executableContains }))) + '\n');
  }

  stopObserving() {
    clearTimeout(this.observationExpiry);
    const child = this.observer;
    this.observer = null;
    this.taskStatus.close();
    // This is only FS's own read-only observer, never an Agent process.
    if (child) child.kill();
  }

  start() {
    if (this.ready) return this.ready;
    const buffer = this.window.getNativeWindowHandle();
    const hwnd = buffer.readBigUInt64LE().toString(16);
    this.ready = new Promise((resolve, reject) => {
      let readyExpired = false;
      const readyTimer = setTimeout(() => { readyExpired = true; reject(new Error('原生宿主启动或恢复窗口暂未完成。请等待目标应用恢复响应后重试。')); }, 8000);
      const child = spawn(this.executable, [hwnd, String(process.pid), this.recoveryPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = child;
      child.stderr.on('data', (data) => console.error('[Agents]', data.toString().trim()));
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const message = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (message.agents?.length && JSON.stringify(message.agents) !== JSON.stringify(this.agents)) {
          this.agents = message.agents;
          this.onState();
        }
        if (message.eventName === 'ready') {
          clearTimeout(readyTimer);
          if (readyExpired && !this.stopping) this.ready = this.request('configure', { presets: this.presets });
          else resolve();
        }
        else if (message.eventName === 'shortcut') this.onShortcut(message.shortcut);
        else if (message.eventName === 'canvas-focus') this.onShortcut('focus-agent');
        else if (message.eventName === 'fatal' || message.eventName === 'restore-error') { clearTimeout(readyTimer); reject(new Error(message.error)); }
        else if (this.pending.has(message.id)) {
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          message.ok ? request.resolve(message) : request.reject(new Error(message.error));
        }
      });
      const failed = (error) => {
        clearTimeout(readyTimer);
        this.process = null;
        this.ready = null;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
        this.pending.clear();
        this.agents = this.agents.map((agent) => ({ ...agent, attached: false,
          connectionStage: this.stopping ? 'unselected' : 'failed', phase: this.stopping ? 'detached' : 'failed',
          error: this.stopping ? null : error.message }));
        this.onState();
        reject(error);
      };
      child.once('error', failed);
      child.once('exit', (code) => failed(new Error(`原生辅助进程已退出（${code}）。`)));
    }).then(() => this.stopping ? null : this.request('configure', { presets: this.presets }));
    return this.ready;
  }

  async command(cmd, payload = {}) {
    if (this.stopping && !['exit', 'cancel-wait'].includes(cmd)) throw new Error('正在恢复 Agent 窗口并退出。');
    if (cmd === 'exit' && this.process) return this.request(cmd, payload);
    await this.start();
    if (this.stopping && !['exit', 'cancel-wait'].includes(cmd)) throw new Error('正在恢复 Agent 窗口并退出。');
    return this.request(cmd, payload);
  }

  request(cmd, payload = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(cmd === 'exit' || cmd === 'restore' || cmd === 'detach' ?
          'Agent 窗口恢复暂未完成，已保留宿主和 Agent 进程。请待应用恢复响应后重试。' :
          '原生窗口暂未响应，可以切换其他入口或恢复为独立窗口。'));
      }, cmd === 'launch' ? 35000 : 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n', (error) => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  savePresets() {
    if (this.configError) return;
    writeJson(this.configPath, this.presets);
  }

  async connect(agent, window = null, allowLaunch = false) {
    const preset = this.presets.find(item => item.id === agent);
    if (allowLaunch && !preset?.launchPath?.trim())
      throw new Error('请先在 Windows 中打开这个应用，再选择窗口。启动路径可在本机 agents.json 中配置。');
    const reference = window ? { hwnd: window.hwnd, pid: window.pid, startTicks: window.startTicks } : null;
    const result = await this.command(allowLaunch ? 'launch' : 'switch', { agent, ...(reference ? { window: reference } : {}) });
    const connected = result.agents.find((item) => item.id === agent);
    if (connected?.attached) {
      this.presets.find((item) => item.id === agent).selectedWindow = {
        hwnd: connected.hwnd, pid: connected.pid, startTicks: connected.startTicks,
      };
      this.savePresets();
    }
    return result;
  }

  resize(layout) {
    this.layout = layout;
    if (this.layoutFlight) return this.layoutFlight;
    this.layoutFlight = (async () => {
      let sent;
      do {
        sent = this.layout;
        await this.command('resize', sent);
      } while (sent !== this.layout);
    })().finally(() => { this.layoutFlight = null; });
    return this.layoutFlight;
  }

  hide() { return this.process ? this.command('hide') : Promise.resolve(); }
  show() { return this.process ? this.command('show') : Promise.resolve(); }
  cancelWait() { return this.process ? this.command('cancel-wait') : Promise.resolve(); }
  focus() {
    if (!this.process || this.stopping) return Promise.resolve();
    if (!this.focusFlight) this.focusFlight = this.command('focus').finally(() => { this.focusFlight = null; });
    return this.focusFlight;
  }
  detach(agent, show = false) { return this.command('detach', { agent, show }); }
  sync(agent) { return this.command('sync', { agent }); }

  discover(agent) {
    const preset = this.presets.find((item) => item.id === agent);
    if (!preset) return Promise.reject(new Error('未知 Agent。'));
    const state = this.agents.find((item) => item.id === agent);
    const current = state?.restoreNeeded || state?.attached ? state.window || state : null;
    // This mode never starts the embedding host or recovers its journal.
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['--discover'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output += chunk; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('窗口发现暂未完成，请重试刷新。')); }, 6000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(output.trim().replace(/^\uFEFF/, ''));
          if (!result.ok) throw new Error(result.error || '窗口发现失败。');
          resolve(result.windows);
        } catch (error) { reject(error); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ preset, current: current ? { hwnd: current.hwnd, pid: current.pid, startTicks: current.startTicks } : null }) + '\n');
    });
  }
  get hasRecovery() { return fs.existsSync(this.recoveryPath); }

  async exit() {
    if (!this.process && this.hasRecovery) await this.start();
    if (!this.process) return;
    this.stopping = true;
    const child = this.process;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try { await this.command('exit'); await exited; }
    catch (error) { this.stopping = false; throw error; }
  }
}

module.exports = { AgentHost };
