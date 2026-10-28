import { useEffect, useRef, useState } from 'react';

const api = window.fixedSites;
const stages = { unselected: '尚未选择', attaching: '正在接入', connected: '已接入', failed: '接入失败' };

export default function WindowPicker({ agentId, Icon }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const choices = useRef([]);

  async function refresh() {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const result = await api.getAgentWindows();
      if (request !== generation.current || result.cancelled) return;
      if (!result.ok) throw new Error(result.error);
      setData(result);
      document.title = `${result.name} · 窗口接入`;
    } catch (failure) { if (request === generation.current) setError(failure.message); }
    finally { if (request === generation.current) setLoading(false); }
  }

  useEffect(() => { refresh(); return () => { ++generation.current; }; }, []);

  async function connect(candidate) {
    setBusy(candidate.hwnd); setError('');
    try {
      const result = await api.chooseAgentWindow({ hwnd: candidate.hwnd, pid: candidate.pid, startTicks: candidate.startTicks });
      if (result.current) setData((previous) => ({ ...previous, current: result.current }));
      if (!result.ok) throw new Error(result.error);
      if (result.cancelled) setError('接入已取消，目标进程继续运行。');
    } catch (failure) { setError(failure.message); }
    finally { setBusy(null); }
  }

  async function manage(action) {
    setBusy(action); setError('');
    try {
      const result = await api.manageAgentWindow(action);
      if (!result.ok) throw new Error(result.error);
      await refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(null); }
  }

  const current = data?.current;
  const owned = Boolean(current?.restoreNeeded || current?.attached);
  const rows = data?.windows || [];
  const disabled = loading || Boolean(busy);

  function moveFocus(event, index) {
    const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    for (let step = 1; step <= rows.length; step++) {
      const next = (index + direction * step + rows.length) % rows.length;
      if (rows[next]?.eligible) { choices.current[next]?.focus(); break; }
    }
  }

  return <main className="window-picker" onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) api.closeAgentPicker();
  }}>
    <header className="window-picker-header">
      <div><h1>{data?.name || agentId} <span>窗口接入</span></h1><p>按画面选择窗口，接入前不会移动或唤醒候选应用。</p></div>
      <button type="button" className="btn window-action" disabled={disabled} onClick={refresh}><Icon name="reload" size={16} /><span>{loading ? '读取中…' : '刷新预览'}</span></button>
    </header>
    <div className="window-picker-content" aria-busy={disabled}>
      {owned && <section className="window-current" aria-label="当前接入窗口">
        <div className="window-current-copy"><span className="window-stage" data-stage={current.connectionStage}>{stages[current.connectionStage] || '接入待确认'}</span>
          <strong>{current.window?.title || data.name}</strong><span>PID {current.window?.pid || current.pid} · {current.window?.hwnd || current.hwnd}</span>
          <p>{current.error || '确认原生窗口关系与布局；Chromium 实际画面请在主窗口查看。'}</p>
        </div>
        <div className="window-current-actions">
          <button type="button" className="btn window-action" disabled={disabled || !current.attached} onClick={() => manage('sync')} title="重新同步原生窗口与右侧区域，不重启应用"><Icon name="reload" size={15} />同步区域</button>
          <button type="button" className="btn window-action" disabled={disabled} onClick={() => manage('detach')} title="解除接入，还原接入前的位置、样式及最小化或最大化状态">断开并还原</button>
          <button type="button" className="btn window-action" disabled={disabled} onClick={() => manage('show')} title="解除接入并在桌面独立显示，进程和任务继续运行"><Icon name="external" size={15} />独立显示</button>
        </div>
      </section>}
      {error && <p className="window-picker-error" role="alert">{error}</p>}
      {data?.captureError && <p className="window-picker-note">{data.captureError}</p>}
      <div className="window-grid" role="list" aria-label="候选窗口">
        {rows.map((candidate, index) => <article key={`${candidate.hwnd}:${candidate.startTicks}`} className={`window-card${candidate.current ? ' is-current' : ''}${!candidate.eligible ? ' is-unavailable' : ''}`} role="listitem">
          <button ref={(element) => { choices.current[index] = element; }} type="button" className="window-choice" disabled={disabled || !candidate.eligible}
            onClick={() => connect(candidate)} onKeyDown={(event) => moveFocus(event, index)}
            aria-label={`接入 ${candidate.title}，${candidate.identity}，PID ${candidate.pid}`} title={candidate.unavailableReason || `接入此窗口 · PID ${candidate.pid}`}>
            <div className="window-preview">
              {candidate.thumbnail ? <img src={candidate.thumbnail} alt={`${candidate.title} 的系统窗口预览`} draggable={false} /> :
                <div className="window-preview-missing"><Icon name="window" size={30} /><span>{candidate.previewNote}</span></div>}
              {(candidate.current || candidate.protectedWindow || candidate.minimized || !candidate.visible) && <span className="window-preview-badge">
                {candidate.protectedWindow ? '受保护' : candidate.current ? 'FS 已托管' : candidate.minimized ? '最小化' : '隐藏窗口'}
              </span>}
            </div>
            <div className="window-caption"><div className="window-card-title">{candidate.icon ? <img src={candidate.icon} width="22" height="22" alt="" /> : <Icon name="window" size={22} />}<strong>{candidate.title || '无标题窗口'}</strong></div>
              <span className="window-identity" title={candidate.identityEvidence}>{candidate.identity}</span>
              <div className="window-process"><span>{candidate.processName || '未知进程'}{candidate.processName ? '.exe' : ''} · PID {candidate.pid}</span><span className="window-connect-label">{busy === candidate.hwnd ? '正在接入…' : candidate.current ? '重新确认接入' : candidate.eligible ? '点击接入' : '不可接入'}</span></div>
            </div>
          </button>
          <details className="window-tech"><summary>窗口信息</summary><div><span>{candidate.width} × {candidate.height} · {candidate.hwnd}</span><span title={candidate.executablePath}>{candidate.executablePath || '程序路径不可读取'}</span><span>{candidate.identityEvidence}</span><span>{candidate.previewNote}</span>{candidate.unavailableReason && <span>{candidate.unavailableReason}</span>}</div></details>
        </article>)}
      </div>
      {!rows.length && <div className="window-picker-empty"><Icon name="window" size={32} /><h2>{loading ? '正在发现窗口' : '未发现可选择的窗口'}</h2><p>{loading ? '读取系统窗口信息与一次性预览。' : '可在原应用打开一个独立窗口，再刷新预览。FS 不会自动创建或启动窗口。'}</p></div>}
    </div>
    <footer className="window-picker-footer"><span>{rows.length ? `${rows.length} 个候选 · ` : ''}只读发现，预览不代表已接入</span><button type="button" className="btn window-action" disabled={Boolean(busy)} onClick={() => api.closeAgentPicker()}>完成 / 返回</button></footer>
  </main>;
}
