'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const https = require('node:https');
const readline = require('node:readline');

const unknown = (reason, source) => ({ taskState: 'unknown', reason, source });

// Only the inspected read-only handshake and single-session method can be called from FS.
function dshReader(endpoint) {
  const socket = net.createConnection({ host: '127.0.0.1', port: endpoint.port });
  const lines = readline.createInterface({ input: socket });
  const pending = new Map();
  let sequence = 0;
  const fail = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('DSH 状态接口不可读取。')); }
    pending.clear();
  };
  socket.on('error', fail);
  socket.on('close', fail);
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(); socket.destroy(); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    message.error ? entry.reject(new Error('DSH 状态接口拒绝读取。')) : entry.resolve(message.result);
  });
  return {
    request(method, params) {
      if (!['initialize', 'session.getState'].includes(method)) throw new Error('只允许读取 DSH 状态。');
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('DSH 状态读取超时。'));
        }, 2500);
        pending.set(id, { resolve, reject, timer });
        socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    close() { lines.close(); socket.destroy(); fail(); },
  };
}

// The inspected Antigravity service uses a local self-signed certificate.
// TLS relaxation applies only to this 127.0.0.1 request, never Electron browsing.
function readTrajectories(port, token) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: '127.0.0.1', port,
      path: '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
      method: 'POST', rejectUnauthorized: false,
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-codeium-csrf-token': token },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error('Antigravity 状态接口不可读取。'));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Antigravity 状态响应不可读取。')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Antigravity 状态读取超时。')), 2500);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end('{}');
  });
}

class AgentTaskStatus {
  constructor() {
    this.dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    this.dshIdentity = null;
    this.dshSessions = new Set();
    this.dshWatcher = null;
    this.dshDiscoveryValid = false;
    this.dshReader = null;
    this.antigravityPorts = new Map();
    this.closed = false;
  }

  async discoverDshSessions(identity, startedAt) {
    if (this.dshIdentity === identity) return;
    this.dshWatcher?.close();
    this.dshIdentity = identity;
    this.dshSessions.clear();
    this.dshDiscoveryValid = false;
    const directory = path.join(this.dshHome, 'sessions');
    // One metadata pass per backend process; subsequent discovery uses Win32 file events.
    // Modification times only discover IDs, never establish task state.
    this.dshWatcher = fs.watch(directory, { recursive: true }, (_event, filename) => {
      const id = filename?.toString().match(/(?:^|[\\/])(session-[^\\/]+)[\\/]session(?:\.v\d+)?\.jsonl\.zstd$/)?.[1];
      if (id) this.dshSessions.add(id);
    });
    this.dshWatcher.on('error', () => { this.dshDiscoveryValid = false; });
    for (const cwd of await fsp.readdir(directory, { withFileTypes: true })) {
      if (!cwd.isDirectory()) continue;
      const cwdPath = path.join(directory, cwd.name);
      for (const session of await fsp.readdir(cwdPath, { withFileTypes: true })) {
        if (!session.isDirectory() || !session.name.startsWith('session-')) continue;
        const sessionPath = path.join(cwdPath, session.name);
        for (const file of await fsp.readdir(sessionPath)) {
          if (!/^session(?:\.v\d+)?\.jsonl\.zstd$/.test(file)) continue;
          if ((await fsp.stat(path.join(sessionPath, file))).mtimeMs >= startedAt) this.dshSessions.add(session.name);
        }
      }
    }
    this.dshDiscoveryValid = true;
  }

  async dsh(observation) {
    const source = 'DSH 本地 bridge / session.getState';
    let reader;
    try {
      const endpoint = JSON.parse(await fsp.readFile(path.join(this.dshHome, 'agents-anywhere', 'bridge', 'endpoint.json'), 'utf8'));
      const backend = observation.instances?.find((item) => item.pid === endpoint.pid);
      if (!backend || endpoint.version !== 1 || endpoint.host !== '127.0.0.1' || !endpoint.token) {
        return unknown('本地桥接端点尚未确认属于当前 DSH 进程。', source);
      }
      await this.discoverDshSessions(`${backend.pid}:${backend.startedAt}`, backend.startedAt);
      if (this.closed) return unknown('观察器已停止。', source);
      reader = dshReader(endpoint);
      this.dshReader = reader;
      await reader.request('initialize', {
        authToken: endpoint.token, protocolVersion: '1.0', runtime: 'dsh', sessionNamespace: 'fixed-sites-status-readonly',
      });
      const ids = [...this.dshSessions];
      let idle = 0;
      let uncertain = !this.dshDiscoveryValid;
      const deadline = Date.now() + 4000;
      for (const id of ids) {
        if (this.closed || Date.now() > deadline) { uncertain = true; break; }
        const state = await reader.request('session.getState', { externalSessionId: id });
        // Cold-history fallback "idle" is explicitly rejected. Only live registry status counts.
        if (state.metadata?.attached === true) {
          if (state.status === 'running' || state.status === 'waiting_approval') {
            return { taskState: 'working', source, reason: state.status === 'waiting_approval' ?
              'DSH 活跃任务正在等待确认或回答，任务尚未结束。' : 'DSH 当前 Host 的活跃会话明确返回 running。' };
          }
          if (state.status === 'idle') idle++;
          else uncertain = true;
        } else if (['archived', 'missing'].includes(state.sourceState?.availability)) this.dshSessions.delete(id);
        else if (state.sourceState?.availability !== 'available') uncertain = true;
      }
      // A newly written session during this read has not yet been checked.
      if (this.dshSessions.size !== ids.length) uncertain = true;
      return idle && !uncertain ? { taskState: 'idle', source, reason: `DSH 当前 Host 的 ${idle} 个可观测活跃会话明确返回 idle。` } :
        unknown('未取得完整、明确的活跃会话空闲信号；不会采用历史会话的默认 idle。', source);
    } catch {
      return unknown('DSH 本地桥接或单会话状态不可读取；不会按文件活动猜测状态。', source);
    } finally {
      reader?.close();
      if (this.dshReader === reader) this.dshReader = null;
    }
  }

  async antigravity(observation, agent) {
    const source = 'Antigravity LanguageServer / GetAllCascadeTrajectories';
    const services = agent.attached && agent.pid ? observation.services?.filter((item) => item.parentPid === agent.pid) : observation.services;
    const serviceIds = new Set((observation.services || []).map(service => service.pid));
    for (const pid of this.antigravityPorts.keys()) if (!serviceIds.has(pid)) this.antigravityPorts.delete(pid);
    if (!services?.length) return unknown('未找到该 Antigravity 实例可读取的本地任务服务。', source);
    let count = 0;
    let uncertain = false;
    for (const service of services) {
      let result;
      const saved = this.antigravityPorts.get(service.pid);
      const ports = [...new Set([saved, ...service.ports].filter(Boolean))];
      for (const port of ports) {
        try { result = await readTrajectories(port, service.token); this.antigravityPorts.set(service.pid, port); break; }
        catch { /* The LS exposes both HTTP and HTTPS ports; only its HTTPS API is used. */ }
      }
      if (!result?.trajectorySummaries || Array.isArray(result.trajectorySummaries)) { uncertain = true; continue; }
      const summaries = Object.values(result.trajectorySummaries);
      if (!summaries.length) uncertain = true;
      count += summaries.length;
      for (const summary of summaries) {
        if ([2, 3, 4, 'CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_CANCELING', 'CASCADE_RUN_STATUS_BUSY'].includes(summary.status) ||
          summary.hasActiveChildren === true || summary.notFullyIdle === true) {
          return { taskState: 'working', source, reason: 'Antigravity 本地服务明确报告执行中、取消中或仍有活动子任务。' };
        }
        if (![1, 'CASCADE_RUN_STATUS_IDLE'].includes(summary.status)) uncertain = true;
      }
    }
    return count && !uncertain ? { taskState: 'idle', source, reason: `Antigravity 本地服务的 ${count} 个会话全部明确返回 IDLE，且无活动子任务。` } :
      unknown('本地服务未给出全部会话的明确状态；缺失或 UNSPECIFIED 不视为空闲。', source);
  }

  async read(preset, observation, agent) {
    if (this.closed || observation.running !== true) return unknown('没有可确认的运行进程。');
    if (preset.id === 'dsh') return this.dsh(observation);
    if (preset.id === 'antigravity') return this.antigravity(observation, agent);
    return unknown('进程已运行，但没有已验证的只读任务状态来源。');
  }

  close() { this.closed = true; this.dshWatcher?.close(); this.dshWatcher = null; this.dshReader?.close(); }
}

module.exports = { AgentTaskStatus };
