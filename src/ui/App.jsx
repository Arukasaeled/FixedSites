import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Avatar from '@radix-ui/react-avatar';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Button, MantineProvider, TextInput, createTheme } from '@mantine/core';
import presets from './presets.json';
import agentPresets from '../agent-presets.json';
import SiteLibrary from './SiteLibrary';
import WindowPicker from './WindowPicker';
import CanvasShell from './CanvasShell';

const api = window.fixedSites;
const theme = createTheme({
  fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
  defaultRadius: 'md',
  primaryColor: 'gray',
});

function Icon({ name, size = 18 }) {
  const paths = {
    columns: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></>,
    rows: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 12h18" /></>,
    swap: <path d="M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4" />,
    undo: <path d="M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12" />,
    snapshot: <><rect x="3" y="5" width="18" height="15" rx="2" /><circle cx="12" cy="12" r="4" /><path d="M8 5V3h8v2" /></>,
    restore: <><path d="M3 4v6h6M3 10a9 9 0 1 1 1 8" /><path d="M12 7v6l4 2" /></>,
    back: <path d="m14 5-7 7 7 7M7 12h13" />,
    forward: <path d="m10 5 7 7-7 7M4 12h13" />,
    reload: <><path d="M20 11a8 8 0 1 0-2 6" /><path d="M20 4v7h-7" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M10 4H4v16h16v-6" /></>,
    plus: <path d="M12 4v16M4 12h16" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    edit: <><path d="m16 3 5 5-12 12-6 1 1-6ZM13 6l5 5" /></>,
    image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="2" /><path d="m3 18 6-6 4 4 4-7 4 7" /></>,
    delete: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></>,
    grip: <><path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" /></>,
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M9 4v16" /></>,
    expand: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />,
    explore: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    web: <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></>,
    agents: <><rect x="4" y="7" width="16" height="13" rx="2" /><path d="M12 3v4M8 12h.01M16 12h.01M8 16h8" /></>,
    window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'grip' ? 3 : 1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

function hostname(url) {
  return url ? new URL(url).hostname.replace(/^www\./, '') : '';
}

const agentActivityLabels = { stopped: '未运行', working: '工作中', idle: '空闲', unknown: '任务未知' };
const connectionLabels = { unselected: '尚未选择', attaching: '正在接入', connected: '已接入', failed: '接入失败' };

function AgentRow({ agent, active, onSelect }) {
  const activity = agentActivityLabels[agent.activity] ? agent.activity : 'unknown';
  const label = agentActivityLabels[activity];
  const connection = connectionLabels[agent.connectionStage] || (agent.attached ? '已接入' : '尚未选择');
  const description = `${agent.name} · ${label}${connection ? ` · ${connection}` : ''}`;
  const processLabel = agent.processRunning === true ? '已运行' : agent.processRunning === false ? '未运行' : '未知';
  const taskLabel = agent.taskState === 'working' ? '工作中' : agent.taskState === 'idle' ? '空闲' : '未知';
  const details = `${description}\n进程：${processLabel}；窗口：${connection}；任务：${taskLabel}\n${agent.activityReason || '任务状态暂不可确认。'}${agent.activitySource ? `\n来源：${agent.activitySource}` : ''}`;
  return <div className={`site-row agent-row${active ? ' is-active' : ''}`} role="listitem" data-activity={activity}>
    <button type="button" className="site-open" data-agent-id={agent.id} aria-label={description} title={details} onClick={() => onSelect(agent.id)}>
      <span className="site-copy"><span className="site-heading">
        <span className="site-icon agent-icon"><span className="agent-monogram" aria-hidden="true">{{ dsh: 'D', antigravity: 'A', claude: 'C', codex: 'CX' }[agent.id] || 'A'}</span><span className="agent-status-dot agent-rail-status" aria-hidden="true" /></span>
        <span className="site-name agent-name"><span className="agent-name-text">{agent.name}</span><span className="agent-status-dot" aria-hidden="true" /></span>
      </span><span className="site-domain agent-status-text">{label}{connection && <span className="agent-connection"> · {connection}</span>}</span></span>
    </button>
  </div>;
}

function SiteRow({ site, index, active, collapsed, sortable, sidebarRef, onSelect, onEdit, onDelete, onChooseCover, onClearCover, onDragStart, onDragEnd, drop, dragging }) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { if (collapsed) setMenuOpen(false); }, [collapsed]);
  return (
    <div className={`site-row${active ? ' is-active' : ''}${dragging ? ' is-dragging' : ''}${drop ? ` drop-${drop}` : ''}`} data-site-id={site.id} role="listitem" onContextMenu={(event) => { event.preventDefault(); api.showSiteMenu(site.id); }}>
      <button type="button" className="site-open" onClick={() => onSelect(site.id)} aria-current={active ? 'page' : undefined} aria-label={site.name} title={site.name}>
        <span className="site-number">{String(index + 1).padStart(2, '0')}</span>
        <span className="site-copy">
          <span className="site-heading">
            <Avatar.Root className="site-icon">
              {site.faviconUrl && <Avatar.Image className="site-icon-image" src={site.faviconUrl} alt="" referrerPolicy="no-referrer" />}
              <Avatar.Fallback className="site-icon-fallback">{Array.from(site.name.trim())[0]}</Avatar.Fallback>
            </Avatar.Root>
            <span className="site-name">{site.name}</span>
          </span>
          <span className="site-domain">{hostname(site.url)}</span>
        </span>
      </button>
      <div className="site-controls">
        <DropdownMenu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="site-action" disabled={collapsed} title="网站操作" aria-label={`${site.name} 操作`}><Icon name="more" size={17} /></button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="site-menu" align="end" sideOffset={4} collisionBoundary={sidebarRef.current} collisionPadding={8} onCloseAutoFocus={(event) => event.preventDefault()}>
              <DropdownMenu.Label className="site-menu-label">网站操作</DropdownMenu.Label>
              <DropdownMenu.Item className="site-menu-item" onSelect={() => onEdit(site)}><Icon name="edit" size={15} />修改网站</DropdownMenu.Item>
              <DropdownMenu.Item className="site-menu-item" onSelect={() => onChooseCover(site.id)}><Icon name="image" size={15} />选择封面图片…</DropdownMenu.Item>
              <DropdownMenu.Item className="site-menu-item" disabled={!site.coverUrl} onSelect={() => onClearCover(site.id)}><Icon name="web" size={15} />恢复网站图标</DropdownMenu.Item>
              <DropdownMenu.Separator className="site-menu-rule" />
              <DropdownMenu.Item className="site-menu-item site-menu-delete" onSelect={() => onDelete(site.id)}><Icon name="delete" size={15} />删除网站</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button type="button" className="site-drag-handle" disabled={collapsed || !sortable} draggable={!collapsed && sortable} title={sortable ? '拖拽调整顺序' : '清除搜索后可调整顺序'} aria-label={`${site.name} 拖拽调整顺序`} onDragStart={(event) => onDragStart(event, site.id)} onDragEnd={onDragEnd}><Icon name="grip" size={14} /></button>
      </div>
    </div>
  );
}

function SiteForm({ editor, onCancel, onSave, saving, error, collapsed }) {
  const [name, setName] = useState(editor.name);
  const [url, setUrl] = useState(editor.url);
  const nameRef = useRef(null);
  useLayoutEffect(() => { nameRef.current.focus({ preventScroll: true }); nameRef.current.select(); }, []);
  return (
    <form id="site-form" className="site-form" inert={collapsed} onSubmit={(event) => { event.preventDefault(); onSave({ id: editor.id, name, url }); }}>
      <div className="form-heading"><span className="eyebrow">{editor.id ? 'EDIT THE INDEX' : 'A NEW ADDITION'}</span><span className="form-title">{editor.id ? '修改网站' : '添加网站'}</span></div>
      <TextInput ref={nameRef} id="form-name" label="网站名称" value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="例如：Hacker News" autoComplete="off" spellCheck={false} required classNames={{ root: 'editor-field', label: 'editor-label', input: 'editor-input' }} />
      <TextInput id="form-url" label="URL" value={url} onChange={(event) => setUrl(event.currentTarget.value)} placeholder="example.com" autoComplete="off" spellCheck={false} required classNames={{ root: 'editor-field', label: 'editor-label', input: 'editor-input' }} />
      {error && <p id="form-error" className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><Button type="submit" id="form-save" disabled={saving} classNames={{ root: 'editor-save' }}>{saving ? '保存中…' : '保存网站'}</Button><button type="button" id="form-cancel" className="btn cancel-button" onClick={onCancel}>取消</button></div>
    </form>
  );
}

function EmptyEdition({ onAdd, onExplore }) {
  return (
    <div className="empty-edition" id="empty-state">
      <div className="edition-strip"><span>THE PERSONAL EDITION</span><span>由你选刊</span></div>
      <div className="edition-story">
        <span className="edition-section eyebrow">A QUIETER WAY TO BROWSE</span>
        <h1>A smaller<br />corner of<br />the <em>internet.</em></h1>
        <div className="edition-bottom">
          <div className="edition-intro"><h2>值得打开的网站，由你决定。</h2><p>添加一个网站开始使用。<br />把常用的网站放在左侧，一键回到原始页面。</p><div className="empty-actions"><button type="button" className="btn edition-add" onClick={onAdd}>添加第一个网站<Icon name="forward" size={19} /></button><button type="button" className="btn edition-explore" onClick={onExplore}>Explore Sites</button></div></div>
          <img className="edition-art" src="brand/fixed-sites.png" alt="" width="166" height="166" draggable={false} />
        </div>
      </div>
      <div className="edition-colophon"><span>少一点噪声，多一点选择。</span><span>FIXED SITES — YOUR OWN INDEX</span></div>
    </div>
  );
}

const categories = [
  { id: 'ai', label: 'AI' }, { id: 'development', label: '开发' },
  { id: 'learning', label: '学习' }, { id: 'design', label: '设计' }, { id: 'news', label: '资讯' },
];

function App() {
  const [state, setState] = useState({ sites: [], activeSiteId: null, activePage: null, section: 'my', workspace: 'web', activeAgentId: 'dsh', agents: [], agentBusy: false, agentError: null, sidebarCollapsed: false, immersive: false, sidebarWidth: 224, sidebarTargetWidth: 224, toolbarHeight: 48 });
  const [stateReady, setStateReady] = useState(false);
  const [editor, setEditor] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [draggingId, setDraggingId] = useState(null);
  const [dropSpot, setDropSpot] = useState(null);
  const [addingPreset, setAddingPreset] = useState(null);
  const [siteQuery, setSiteQuery] = useState('');
  const searchRef = useRef(null);
  const dragIdRef = useRef(null);
  const sidebarRef = useRef(null);
  const appRef = useRef(null);
  const sidebarWidthRef = useRef(null);

  useEffect(() => {
    const receiveState = (next) => { setState(next); setStateReady(true); };
    const unsubscribe = api.onStateChanged(receiveState);
    const unsubscribeEdit = api.onEditRequested(async (id) => {
      const current = await api.getState();
      const site = current.sites.find((item) => item.id === id);
      if (site) { await api.setSidebarCollapsed(false); setError(''); setEditor({ ...site }); }
    });
    api.getState().then(receiveState);
    return () => { unsubscribe(); unsubscribeEdit(); };
  }, []);

  useEffect(() => {
    if (editor?.id && !state.sites.some((site) => site.id === editor.id)) setEditor(null);
  }, [state.sites, editor?.id]);

  useLayoutEffect(() => {
    if (!stateReady) return;
    const root = appRef.current;
    const target = state.sidebarTargetWidth;
    const firstLayout = sidebarWidthRef.current === null;
    const from = firstLayout ? state.sidebarWidth : sidebarWidthRef.current;
    const distance = target - from;
    let frame = 0;

    function commit(width) {
      const pixel = Math.round(width);
      const progress = Math.max(0, Math.min(1, (pixel - 56) / (224 - 56)));
      root.style.setProperty('--sidebar-width', `${pixel}px`);
      root.style.setProperty('--sidebar-progress', progress);
      root.style.setProperty('--sidebar-label-opacity', Math.max(0, (progress - 0.25) / 0.75));
      root.style.setProperty('--sidebar-rail-opacity', 1 - progress);
      root.style.setProperty('--sidebar-controls-pointer', progress > 0.8 ? 'auto' : 'none');
      // The native bounds are committed before this DOM frame can paint.
      // There is one animation clock, no competing CSS transition or IPC queue.
      api.commitSidebarFrame(pixel);
      sidebarWidthRef.current = pixel;
    }

    if (firstLayout || state.immersive || !distance || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      commit(target);
      if (state.sidebarCollapsed) setEditor(null);
      return;
    }
    const duration = Math.max(80, 220 * Math.abs(distance) / (224 - 56));
    const started = performance.now();
    function tick(now) {
      const t = Math.max(0, Math.min(1, (now - started) / duration));
      const eased = 1 - Math.pow(1 - t, 3);
      commit(from + distance * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else if (state.sidebarCollapsed) setEditor(null);
    }
    frame = requestAnimationFrame(tick);
    // Reverse from the last committed width rather than restarting at an edge.
    return () => cancelAnimationFrame(frame);
  }, [stateReady, state.sidebarCollapsed, state.sidebarTargetWidth, state.immersive]);

  async function perform(action) {
    setError('');
    try {
      const result = await action();
      if (result?.ok === false) { setError(result.error); return false; }
      return true;
    } catch (err) { setError(err.message); return false; }
  }

  async function openEditor(site = null) {
    if (state.sidebarCollapsed && !await perform(() => api.setSidebarCollapsed(false))) return;
    setError('');
    setEditor(site ? { id: site.id, name: site.name, url: site.url } : { id: null, name: '', url: '' });
  }

  async function addPreset(site) {
    setAddingPreset(site.url);
    await perform(() => api.addSite({ name: site.name, url: site.url, activate: false }));
    setAddingPreset(null);
  }

  async function saveSite(payload) {
    setSaving(true);
    const saved = await perform(() => payload.id ? api.updateSite(payload) : api.addSite(payload));
    setSaving(false);
    if (saved) setEditor(null);
  }

  function clearDrag() {
    dragIdRef.current = null;
    setDraggingId(null);
    setDropSpot(null);
  }

  function dragStart(event, id) {
    dragIdRef.current = id;
    setDraggingId(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }

  function targetSpot(event) {
    const row = event.target.closest('.site-row');
    if (!row) return { index: state.sites.length, id: null, after: true };
    const bounds = row.getBoundingClientRect();
    const index = state.sites.findIndex((site) => site.id === row.dataset.siteId);
    const after = event.clientY >= bounds.top + bounds.height / 2;
    return { index: index + (after ? 1 : 0), id: row.dataset.siteId, after };
  }

  function dragOver(event) {
    if (!dragIdRef.current || siteQuery.trim()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropSpot(targetSpot(event));
  }

  function drop(event) {
    if (!dragIdRef.current || siteQuery.trim()) return;
    event.preventDefault();
    const ids = state.sites.map((site) => site.id);
    const from = ids.indexOf(dragIdRef.current);
    const target = targetSpot(event).index;
    const [moved] = ids.splice(from, 1);
    ids.splice(from < target ? target - 1 : target, 0, moved);
    clearDrag();
    if (ids.some((id, index) => id !== state.sites[index].id)) perform(() => api.reorderSites(ids));
  }

  const activeSite = state.sites.find((site) => site.id === state.activeSiteId);
  const query = siteQuery.trim().toLocaleLowerCase();
  const matchingSites = state.sites.filter((site) => !query || `${site.name} ${hostname(site.url)} ${site.url}`.toLocaleLowerCase().includes(query));
  const agentsMode = state.workspace === 'agents';
  const agentList = agentPresets.map(({ id, name }) => state.agents.find((agent) => agent.id === id) || { id, name, attached: false });
  const activeAgent = agentList.find((agent) => agent.id === state.activeAgentId);
  const agentStopped = !state.agentBusy && activeAgent?.phase === 'stopped';
  const agentNoWindow = !state.agentBusy && activeAgent?.phase === 'no-window';
  const agentHidden = activeAgent?.phase === 'hidden';
  const currentAgentError = state.agentError || activeAgent?.error;
  const exploring = !agentsMode && state.section === 'explore';
  const libraryMode = !agentsMode && (state.section === 'library' || exploring);
  const page = state.activePage;
  const agentProgress = activeAgent?.phase === 'starting' ? '正在启动应用…' : activeAgent?.phase === 'waiting' ? '正在等待应用窗口…' : '正在接入并确认窗口布局…';
  const status = agentsMode ? state.agentBusy ? agentProgress : currentAgentError || error || state.agentConfigError || (agentStopped ? '无进程运行' : agentNoWindow ? '未找到窗口' : agentHidden ? '窗口已隐藏' : connectionLabels[activeAgent?.connectionStage] || '尚未选择') : exploring ? `${presets.length} 个精选入口` : page?.error || (page?.loading ? '加载中…' : activeSite ? `${page?.zoomFactor && page.zoomFactor !== 1 ? `${Math.round(page.zoomFactor * 100)}% · ` : ''}原始网页` : '未选择网站');

  const library = <SiteLibrary visible={libraryMode} exploring={exploring} sites={state.sites} presets={presets} categories={categories} activeSiteId={state.activeSiteId} query={siteQuery} onQuery={setSiteQuery} onOpen={(id) => { setEditor(null); perform(() => api.selectSite(id)); }} onAdd={addPreset} onEdit={openEditor} onDelete={(id) => perform(() => api.deleteSite(id))} onChooseCover={(id) => perform(() => api.chooseSiteCover(id))} onClearCover={(id) => perform(() => api.clearSiteCover(id))} onReorder={(ids) => perform(() => api.reorderSites(ids))} onLibrary={() => { setEditor(null); setSiteQuery(''); perform(() => api.setSection('library')); }} onExplore={() => { setEditor(null); setSiteQuery(''); perform(() => api.setSection('explore')); }} onAgents={() => { setEditor(null); perform(() => api.setWorkspace('agents')); }} onResume={() => { setEditor(null); perform(() => api.setSection('my')); }} adding={addingPreset} error={error} Icon={Icon} editor={libraryMode && editor ? <div className="library-editor-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) { setEditor(null); setError(''); } }} onKeyDown={(event) => { if (event.key === 'Escape') { setEditor(null); setError(''); } }}><section className="library-editor" role="dialog" aria-modal="true" aria-label={editor.id ? '修改网站' : '添加网站'}><button className="library-editor-close" aria-label="关闭表单" onClick={() => { setEditor(null); setError(''); }}><Icon name="close" size={18} /></button><SiteForm key={editor.id || 'new'} editor={editor} collapsed={false} onCancel={() => { setEditor(null); setError(''); }} onSave={saveSite} saving={saving} error={error} /></section></div> : null} />;
  return <CanvasShell state={state} appRef={appRef} sidebarRef={sidebarRef} searchRef={searchRef}
    siteQuery={siteQuery} setSiteQuery={setSiteQuery} matchingSites={matchingSites} agentList={agentList}
    editor={editor} setEditor={setEditor} error={error} saving={saving} perform={perform} openEditor={openEditor} saveSite={saveSite}
    clearDrag={clearDrag} dragStart={dragStart} dragOver={dragOver} drop={drop} draggingId={draggingId} dropSpot={dropSpot}
    libraryMode={libraryMode} exploring={exploring} Icon={Icon} SiteRow={SiteRow} AgentRow={AgentRow} SiteForm={SiteForm} library={library} />;
}

const pickerId = new URLSearchParams(window.location.search).get('windowPicker');
createRoot(document.getElementById('root')).render(<MantineProvider theme={theme} forceColorScheme="dark">{pickerId ? <WindowPicker agentId={pickerId} Icon={Icon} /> : <App />}</MantineProvider>);
