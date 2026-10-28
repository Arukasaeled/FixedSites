import { useRef, useState } from 'react';

const api = window.fixedSites;

export default function CanvasShell({ state, appRef, sidebarRef, searchRef, siteQuery, setSiteQuery, matchingSites,
  agentList, editor, setEditor, error, saving, perform, openEditor, saveSite, clearDrag, dragStart, dragOver, drop,
  draggingId, dropSpot, libraryMode, exploring, Icon, SiteRow, AgentRow, SiteForm, library }) {
  const [resizing, setResizing] = useState(false);
  const resizeRef = useRef(null);
  const draggedPane = useRef(null);
  const frame = useRef(0);
  const dragCleanup = useRef(() => {});
  const model = state.canvas || { panels: [], panes: [], ratio: .5, direction: 'horizontal' };
  const active = model.panes.find(p => p.key === model.activeKey);
  const action = (name, value) => perform(() => api.canvasAction(name, value));

  function finishResize() {
    if (!resizeRef.current && !draggedPane.current) return;
    dragCleanup.current(); dragCleanup.current = () => {};
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const ratio = resizeRef.current?.ratio;
    resizeRef.current = null; setResizing(false);
    perform(() => api.resizeCanvas('end', ratio));
  }
  function startResize(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = { area: model.area, vertical: model.direction === 'vertical', ratio: model.ratio };
    // Native child windows can release element capture while hiding. Listen
    // across the renderer until release instead of tying the drag to one node.
    const listeners = [['pointermove', moveResize], ['pointerup', finishResize], ['pointercancel', finishResize], ['blur', finishResize]];
    for (const [type, listener] of listeners) window.addEventListener(type, listener);
    document.documentElement.addEventListener('mouseleave', finishResize);
    dragCleanup.current = () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener);
      document.documentElement.removeEventListener('mouseleave', finishResize);
    };
    setResizing(true); perform(() => api.resizeCanvas('begin'));
  }
  function moveResize(event) {
    const drag = resizeRef.current;
    if (!drag) return;
    const coordinate = drag.vertical ? event.clientY - drag.area.y : event.clientX - drag.area.x;
    const size = drag.vertical ? drag.area.height : drag.area.width;
    drag.ratio = Math.max(.2, Math.min(.8, coordinate / Math.max(1, size - 8)));
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (resizeRef.current) api.resizeCanvas('move', resizeRef.current.ratio);
    });
  }
  function Tool({ id, icon, label, disabled, onClick, title = label, selected }) {
    return <button type="button" id={id} className={`canvas-tool${selected ? ' is-selected' : ''}`} disabled={disabled}
      aria-label={label} title={title} onClick={onClick}><Icon name={icon} size={16} /><span>{label}</span></button>;
  }
  const focus = key => action('focus', key);
  const navigate = (pane, name) => perform(async () => { await api.canvasAction('focus', pane.key); return api[name](); });

  return <div ref={appRef} className={`app canvas-shell${state.sidebarCollapsed ? ' is-collapsed' : ''}${state.agentSidebarCollapsed ? ' is-agent-collapsed' : ''}${state.immersive ? ' is-immersive' : ''}${libraryMode ? ' is-library' : ''}`}
    style={{ '--toolbar-height': `${state.toolbarHeight}px`, '--agent-sidebar-width': state.agentSidebarCollapsed ? '56px' : '224px' }}>
    <aside className="sidebar web-sidebar" ref={sidebarRef} aria-label="网站导航" inert={libraryMode}>
      <header className="canvas-rail-heading"><button className="canvas-rail-title" title="打开网站目录" onClick={() => perform(() => api.setSection('library'))}><Icon name="web" /><span>Web</span></button><button id="btn-sidebar" className="canvas-icon" aria-label={state.sidebarCollapsed ? '展开网站栏' : '收起网站栏'} title="展开 / 收起网站栏" onClick={() => perform(() => api.toggleSidebar())}><Icon name="sidebar" size={16} /></button></header>
      <div className="site-search" role="search"><button className="search-icon" title="搜索网站" aria-label="搜索网站" onClick={async () => { if (state.sidebarCollapsed) await api.setSidebarCollapsed(false); searchRef.current?.focus(); }}><Icon name="search" size={16} /></button>
        <input ref={searchRef} type="search" value={siteQuery} tabIndex={state.sidebarCollapsed ? -1 : 0} placeholder="搜索网站…" aria-label="搜索收藏网站" onChange={e => { clearDrag(); setSiteQuery(e.target.value); }} onKeyDown={e => { if (e.key === 'Escape') setSiteQuery(''); if (e.key === 'Enter' && matchingSites[0]) perform(() => api.selectSite(matchingSites[0].id)); }} />
        {siteQuery && <button className="search-clear" aria-label="清除搜索" onClick={() => setSiteQuery('')}><Icon name="close" size={13} /></button>}
      </div>
      <div className="site-list" id="site-list" role="list" aria-label="常用网站" onDragOver={dragOver} onDrop={drop}>
        {matchingSites.map(site => <SiteRow key={site.id} site={site} index={state.sites.indexOf(site)} active={model.panes.some(p => p.kind === 'web' && p.id === site.id)}
          collapsed={state.sidebarCollapsed} sortable={!siteQuery.trim()} sidebarRef={sidebarRef} onSelect={id => perform(() => api.selectSite(id))} onEdit={openEditor}
          onDelete={id => perform(() => api.deleteSite(id))} onChooseCover={id => perform(() => api.chooseSiteCover(id))} onClearCover={id => perform(() => api.clearSiteCover(id))}
          onDragStart={dragStart} onDragEnd={clearDrag} dragging={draggingId === site.id} drop={dropSpot?.id === site.id ? dropSpot.after ? 'after' : 'before' : null} />)}
        {!matchingSites.length && !state.sidebarCollapsed && <p className="canvas-list-empty">{siteQuery ? '没有匹配的网站' : '添加常用网站，开始使用。'}</p>}
      </div>
      <footer className="sidebar-foot">
        {editor && !libraryMode && <SiteForm key={editor.id || 'new'} editor={editor} collapsed={state.sidebarCollapsed} onCancel={() => setEditor(null)} onSave={saveSite} saving={saving} error={error} />}
        {!editor && <button className="btn add-button" id="add-button" title="添加网站" aria-label="添加网站" onClick={() => openEditor()}><Icon name="plus" /><span>添加网站</span></button>}
        <button className="btn explore-link" title="网站目录" aria-label="网站目录" onClick={() => perform(() => api.setSection('library'))}><Icon name="explore" /><span>网站目录</span></button>
      </footer>
    </aside>

    <main className="canvas-main" inert={libraryMode}>
      <header className="canvas-toolbar" aria-label="画布布局和恢复">
        <Tool id="canvas-horizontal" icon="columns" label="左右" selected={!model.expanded && model.direction === 'horizontal' && model.panes.length === 2} onClick={() => action('horizontal')} />
        <Tool id="canvas-vertical" icon="rows" label="上下" selected={!model.expanded && model.direction === 'vertical' && model.panes.length === 2} onClick={() => action('vertical')} />
        <Tool id="canvas-swap" icon="swap" label="换位" disabled={model.panes.length < 2} onClick={() => action('swap')} />
        <Tool id="canvas-expand" icon="expand" label={model.expanded ? '还原' : '铺满'} disabled={!active || active.kind === 'empty'} onClick={() => action('expand', active.key)} />
        <span className="canvas-toolbar-rule" />
        <Tool id="canvas-undo" icon="undo" label="撤销" disabled={!state.undoLabel} title={state.undoLabel ? `撤销：${state.undoLabel}（仅上一步）` : '当前没有可撤销的清单或布局操作'} onClick={() => perform(() => api.undo())} />
        <span className="canvas-toolbar-spacer" />
        <Tool id="canvas-save-snapshot" icon="snapshot" label="保存快照" onClick={() => perform(() => api.saveSnapshot())} title="手动保存当前页面、布局与窗口位置" />
        <Tool id="canvas-restore-snapshot" icon="restore" label="恢复" disabled={!state.snapshotSavedAt} onClick={() => perform(() => api.restoreSnapshot())} title={state.snapshotSavedAt ? `恢复快照：${new Date(state.snapshotSavedAt).toLocaleString()}` : '尚未保存手动快照'} />
        <button className="canvas-icon" title="窗口与托盘设置" aria-label="窗口与托盘设置" onClick={() => perform(() => api.showWindowMenu())}><Icon name="more" /></button>
      </header>
      {(error || state.configError || state.snapshotError) && <div className="canvas-error" role="alert">{error || state.configError || state.snapshotError}</div>}
      {!libraryMode && model.panels.map(pane => {
        const site = state.sites.find(s => s.id === pane.id);
        const agent = agentList.find(a => a.id === pane.id);
        const page = model.pages?.find(p => p.id === pane.id);
        const selected = pane.key === model.activeKey;
        return <section key={pane.key} className={`canvas-pane${selected ? ' is-active' : ''}`} data-pane-key={pane.key} data-kind={pane.kind}
          style={{ left: pane.rect.x, top: pane.rect.y, width: pane.rect.width, height: pane.rect.height }} aria-label={site?.name || agent?.name || '空面板'}>
          <header className="canvas-pane-heading" draggable={!state.immersive}
            onDragStart={e => { if (e.target.closest('button')) { e.preventDefault(); return; } draggedPane.current = pane.key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-fs-pane', pane.key); api.resizeCanvas('begin'); }}
            onDragEnd={() => { finishResize(); draggedPane.current = null; }}
            onDragOver={e => { if (draggedPane.current) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } }}
            onDrop={e => { if (!draggedPane.current) return; e.preventDefault(); if (draggedPane.current !== pane.key) action('swap'); }} onPointerDown={() => focus(pane.key)}>
            <span className="canvas-pane-label" title={page?.currentUrl || agent?.name || '从两侧选择内容'}><Icon name={pane.kind === 'agent' ? 'agents' : pane.kind === 'web' ? 'web' : 'plus'} size={14} /><span>{site?.name || agent?.name || '选择内容'}</span></span>
            {pane.kind === 'web' && <div className="canvas-pane-actions">
              <button className="canvas-icon" disabled={!page?.canGoBack} title="返回" aria-label="返回" onClick={() => navigate(pane, 'goBack')}><Icon name="back" size={15} /></button>
              <button className="canvas-icon" disabled={!page?.canGoForward} title="前进" aria-label="前进" onClick={() => navigate(pane, 'goForward')}><Icon name="forward" size={15} /></button>
              <button className="canvas-icon" title="刷新" aria-label="刷新" onClick={() => navigate(pane, 'reload')}><Icon name="reload" size={15} /></button>
              <button className="canvas-icon" title="在系统浏览器打开" aria-label="在系统浏览器打开" onClick={() => navigate(pane, 'openExternal')}><Icon name="external" size={14} /></button>
            </div>}
            {pane.kind === 'agent' && <button className="canvas-icon" title="选择或管理 Agent 窗口" aria-label="管理 Agent 窗口" onClick={() => perform(() => api.openAgentPicker(pane.id))}><Icon name="window" size={15} /></button>}
            <button className="canvas-icon" title="铺满 / 还原" aria-label="铺满或还原面板" disabled={pane.kind === 'empty'} onClick={() => action('expand', pane.key)}><Icon name="expand" size={14} /></button>
            <button className="canvas-icon" title="收起面板，内容保留在后台" aria-label="收起面板" onClick={() => action('close', pane.key)}><Icon name="close" size={14} /></button>
          </header>
          <div className="canvas-pane-body" onClick={() => focus(pane.key)}>
            {pane.kind === 'empty' ? <div className="canvas-placeholder"><Icon name="plus" size={26} /><h2>把内容放进来</h2><p>从左侧选择网站，或从右侧选择 Agent。</p></div> :
              pane.kind === 'agent' ? <div className="canvas-placeholder"><h2>{agent?.name}</h2><p>{state.agentBusy ? '正在连接窗口…' : state.agentError || agent?.error || (agent?.attached ? '窗口已接入' : '连接已运行的桌面应用，在这里继续工作。')}</p>
                {!state.agentBusy && <div className="canvas-placeholder-actions"><button onClick={() => perform(() => api.openAgentPicker(pane.id))}>选择窗口</button>{agent?.canLaunch && <button onClick={() => perform(() => api.startAgent(pane.id))}>启动并连接</button>}{agent?.attached && <button onClick={() => perform(() => api.detachAgent())}>独立显示</button>}</div>}
              </div> : <div className="canvas-placeholder"><h2>{site?.name}</h2><p>{page?.error || (model.resizing ? '调整布局中' : '正在准备网页…')}</p>{page?.error && <button onClick={() => navigate(pane, 'reload')}>重试</button>}</div>}
          </div>
        </section>;
      })}
      {!libraryMode && !model.panels.length && <div className="canvas-welcome"><Icon name="window" size={34} /><h1>在这里展开工作</h1><p>左边打开网站，右边连接 Agent。</p><p>用顶部的左右、上下布局，把两份内容放在一起。</p></div>}
      {!libraryMode && model.divider && <div className={`canvas-divider ${model.direction}`} style={{ left: model.divider.x, top: model.divider.y, width: model.divider.width, height: model.divider.height }}
        role="separator" tabIndex={0} aria-label="调整面板大小" aria-orientation={model.direction === 'vertical' ? 'horizontal' : 'vertical'} aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(model.ratio * 100)}
        onPointerDown={startResize}
        onKeyDown={e => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); perform(async () => { await api.resizeCanvas('begin'); return api.resizeCanvas('end', model.ratio + (['ArrowRight', 'ArrowDown'].includes(e.key) ? .025 : -.025)); }); }} />}
      {resizing && <div className="canvas-resize-hint" role="status">拖动调整大小</div>}
    </main>

    <aside className="sidebar agent-sidebar" aria-label="Agent 导航" inert={libraryMode}>
      <header className="canvas-rail-heading"><button className="canvas-icon" id="btn-agent-sidebar" title="展开 / 收起 Agent 栏" aria-label={state.agentSidebarCollapsed ? '展开 Agent 栏' : '收起 Agent 栏'} onClick={() => perform(() => api.toggleAgentSidebar())}><Icon name="sidebar" size={16} /></button><span className="canvas-rail-title"><Icon name="agents" /><span>Agents</span></span></header>
      <div className="site-list" id="agent-list" role="list" aria-label="桌面 Agents">{agentList.map(agent => <AgentRow key={agent.id} agent={agent} active={model.panes.some(p => p.kind === 'agent' && p.id === agent.id)} onSelect={id => { setEditor(null); perform(() => api.selectAgent(id)); }} />)}</div>
      {!state.agentSidebarCollapsed && <p className="canvas-agent-note">连接现有桌面窗口。<br />进程、任务和对话保持原样。</p>}
    </aside>
    {library}
  </div>;
}
