import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as Avatar from '@radix-ui/react-avatar';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

const hostOf = (url) => new URL(url).hostname.replace(/^www\./, '');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const SiteCover = memo(function SiteCover({ site, Icon }) {
  const source = site.coverUrl || site.faviconUrl || new URL('/favicon.ico', site.url).href;
  return <Avatar.Root className={`site-cover${site.coverUrl ? ' is-custom-cover' : ' is-site-logo'}`}>
    <Avatar.Image className="site-cover-image" src={source} alt="" referrerPolicy="no-referrer" draggable={false} />
    <Avatar.Fallback className="site-cover-fallback"><Icon name="web" size={42} /></Avatar.Fallback>
  </Avatar.Root>;
});
// A finite, staggered lattice. Each site appears once; no cloned filler cards.
function cardPositions(count) {
  if (count === 2) return [{ x: -185, y: 0 }, { x: 185, y: 0 }];
  const coords = [{ x: 0, y: 0 }];
  const steps = [[0, -1], [-1, 0], [-1, 1], [0, 1], [1, 0], [1, -1]];
  for (let ring = 1; coords.length < count; ring++) {
    let q = ring, r = 0;
    for (const [dq, dr] of steps) for (let step = 0; step < ring && coords.length < count; step++) {
      coords.push({ x: (q + r / 2) * 370, y: r * 425 });
      q += dq; r += dr;
    }
  }
  return coords.slice(0, count);
}

export default function SiteLibrary({ visible, exploring, sites, presets, categories, activeSiteId, query, onQuery, onOpen, onAdd, onEdit, onDelete, onChooseCover, onClearCover, onReorder, onExplore, onLibrary, onAgents, onResume, adding, error, editor, Icon }) {
  const [category, setCategory] = useState('all');
  const [focused, setFocused] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [dragged, setDragged] = useState(null);
  const [dropId, setDropId] = useState(null);
  const viewportRef = useRef(null);
  const stageRef = useRef(null);
  const controls = useRef(null);
  const suppressClick = useRef(false);
  const reorderTimer = useRef(null);
  const poses = useRef({ my: null, explore: null });
  const savedByUrl = new Map(sites.map((site) => [new URL(site.url).href, site]));
  const addedUrls = new Set(sites.map((site) => new URL(site.url).href));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = useMemo(() => (exploring ? presets : sites).filter((site) =>
    (!exploring || category === 'all' || site.category === category) &&
    (!normalizedQuery || `${site.name} ${site.url} ${site.description || ''}`.toLocaleLowerCase().includes(normalizedQuery))), [exploring, presets, sites, category, normalizedQuery]);
  const positions = useMemo(() => cardPositions(items.length), [items.length]);
  const itemKey = items.map((site) => site.id || site.url).join('|');
  const filterKey = `${exploring ? category : 'my'}|${normalizedQuery}`;
  useEffect(() => () => clearTimeout(reorderTimer.current), []);

  useEffect(() => {
    if (!visible || !items.length) return;
    const viewport = viewportRef.current;
    const stage = stageRef.current;
    const cards = [...stage.children];
    const mode = exploring ? 'explore' : 'my';
    const saved = poses.current[mode];
    const initial = normalizedQuery || !saved ? clamp(items.findIndex((site) => site.id === activeSiteId), 0, items.length - 1) : clamp(saved.focused, 0, items.length - 1);
    let camera = saved && saved.filterKey === filterKey ? { ...saved.camera } : { x: -positions[initial].x, y: -positions[initial].y, z: 1 };
    let target = { ...camera }, pointer = null, frame = 0, momentum = null, lastTime = 0, current = initial;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const limits = {
      minX: -Math.max(...positions.map((p) => p.x)) - 140,
      maxX: -Math.min(...positions.map((p) => p.x)) + 140,
      minY: -Math.max(...positions.map((p) => p.y)) - 110,
      maxY: -Math.min(...positions.map((p) => p.y)) + 110,
    };
    function constrain() {
      target.x = clamp(target.x, limits.minX, limits.maxX);
      target.y = clamp(target.y, limits.minY, limits.maxY);
      target.z = clamp(target.z, .62, 1.24);
    }
    function paint() {
      stage.style.transform = `translate3d(${camera.x * camera.z}px,${camera.y * camera.z}px,0) scale(${camera.z})`;
      let closest = 0, nearest = Infinity;
      const radius = Math.max(500, viewport.clientWidth * .55);
      const fit = Math.min(1, viewport.clientHeight / 530);
      cards.forEach((card, index) => {
        const p = positions[index];
        const distance = Math.hypot((p.x + camera.x) * camera.z, (p.y + camera.y) * camera.z * .85);
        const weight = clamp(1 - distance / radius, 0, 1);
        const tilt = (index % 3 - 1) * (1 - weight) * 1.5;
        card.style.transform = `translate3d(${p.x}px,${p.y}px,0) translate(-50%,-50%) rotate(${tilt}deg) scale(${(.58 + .56 * Math.pow(weight, 1.15)) * fit})`;
        card.style.opacity = .5 + .5 * Math.pow(weight, .65);
        card.style.zIndex = Math.round(weight * 20) + 1;
        card.style.setProperty('--card-focus', weight.toFixed(3));
        if (distance < nearest) { nearest = distance; closest = index; }
      });
      if (current !== closest) { current = closest; setFocused(closest); }
    }
    function tick(now) {
      const dt = Math.min(32, now - (lastTime || now - 16.7)); lastTime = now;
      if (momentum) {
        target.x += momentum.x * dt; target.y += momentum.y * dt;
        const friction = Math.pow(.93, dt / 16.7);
        momentum.x *= friction; momentum.y *= friction;
        if (Math.hypot(momentum.x, momentum.y) < .015) momentum = null;
        constrain();
      }
      const blend = pointer?.moved || reduced ? 1 : 1 - Math.pow(.76, dt / 16.7);
      camera.x += (target.x - camera.x) * blend;
      camera.y += (target.y - camera.y) * blend;
      camera.z += (target.z - camera.z) * blend;
      const moving = momentum || Math.abs(target.x - camera.x) + Math.abs(target.y - camera.y) + Math.abs(target.z - camera.z) * 300 > .25;
      if (!moving) camera = { ...target };
      paint();
      frame = moving ? requestAnimationFrame(tick) : 0;
    }
    function schedule() { if (!frame) { lastTime = 0; frame = requestAnimationFrame(tick); } }
    function focus(index) {
      stage.classList.remove('is-reordering');
      const next = clamp(index, 0, items.length - 1);
      momentum = null;
      target.x = -positions[next].x; target.y = -positions[next].y;
      schedule();
    }
    function changeZoom(amount) { target.z = clamp(target.z + amount, .62, 1.24); setZoom(Math.round(target.z * 100)); schedule(); }
    controls.current = { focus, changeZoom, home: () => { target.z = 1; setZoom(100); focus(initial); } };
    function down(event) {
      suppressClick.current = false;
      stage.classList.remove('is-reordering');
      if (event.button !== 0 || event.target.closest('[data-no-pan]')) return;
      momentum = null;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, time: performance.now(), vx: 0, vy: 0, moved: false };
    }
    function move(event) {
      if (!pointer) return;
      const now = performance.now(), dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
      if (!pointer.moved && Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 6) {
        pointer.moved = true; viewport.setPointerCapture(pointer.id); viewport.classList.add('is-panning');
      }
      if (pointer.moved) {
        event.preventDefault(); target.x += dx / camera.z; target.y += dy / camera.z; constrain();
        const dt = Math.max(8, now - pointer.time);
        pointer.vx = .35 * pointer.vx + .65 * dx / dt / camera.z;
        pointer.vy = .35 * pointer.vy + .65 * dy / dt / camera.z;
        schedule();
      }
      pointer.x = event.clientX; pointer.y = event.clientY; pointer.time = now;
    }
    function up(event) {
      if (!pointer) return;
      if (pointer.moved) {
        suppressClick.current = true;
        if (event.type !== 'pointercancel' && !reduced && performance.now() - pointer.time < 90) momentum = { x: pointer.vx, y: pointer.vy };
        if (viewport.hasPointerCapture(pointer.id)) viewport.releasePointerCapture(pointer.id);
        schedule();
      }
      pointer = null; viewport.classList.remove('is-panning');
    }
    function wheel(event) {
      stage.classList.remove('is-reordering');
      event.preventDefault(); momentum = null;
      if (event.ctrlKey) { changeZoom(-event.deltaY * .0015); return; }
      const unit = event.deltaMode === 1 ? 18 : 1;
      target.x -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit / camera.z;
      if (!event.shiftKey) target.y -= event.deltaY * unit / camera.z;
      constrain(); schedule();
    }
    function key(event) {
      if (event.target.closest('input,button,[role="menuitem"]') || event.ctrlKey || event.metaKey || event.altKey || editor || event.isComposing) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'Enter'].includes(event.key)) event.preventDefault();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') focus(current - 1);
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') focus(current + 1);
      if (event.key === 'Home') controls.current.home();
      if (event.key === 'Enter') exploring ? onAdd(items[current]) : onOpen(items[current].id);
    }
    setFocused(initial); setZoom(Math.round(camera.z * 100)); paint();
    const resize = new ResizeObserver(() => paint()); resize.observe(viewport);
    viewport.addEventListener('pointerdown', down); viewport.addEventListener('pointermove', move);
    viewport.addEventListener('pointerup', up); viewport.addEventListener('pointercancel', up);
    viewport.addEventListener('wheel', wheel, { passive: false }); viewport.addEventListener('keydown', key);
    return () => {
      poses.current[mode] = { key: itemKey, filterKey, camera: { ...camera }, focused: current };
      cancelAnimationFrame(frame); resize.disconnect(); controls.current = null;
      viewport.classList.remove('is-panning');
      viewport.removeEventListener('pointerdown', down); viewport.removeEventListener('pointermove', move);
      viewport.removeEventListener('pointerup', up); viewport.removeEventListener('pointercancel', up);
      viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('keydown', key);
    };
  }, [visible, exploring, itemKey, filterKey, positions, Boolean(editor)]);

  function reorder(event, targetId) {
    event.preventDefault();
    const fromId = event.dataTransfer.getData('text/fixed-sites-id');
    setDragged(null); setDropId(null);
    if (!fromId || fromId === targetId) return;
    const ids = sites.map((site) => site.id);
    const from = ids.indexOf(fromId), to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    stageRef.current.classList.add('is-reordering');
    clearTimeout(reorderTimer.current);
    reorderTimer.current = setTimeout(() => stageRef.current?.classList.remove('is-reordering'), 320);
    ids.splice(from, 1); ids.splice(to, 0, fromId); onReorder(ids);
  }
  const focusedSite = items[clamp(focused, 0, Math.max(0, items.length - 1))];

  return <section className={`site-library${exploring ? ' is-explore' : ''}`} hidden={!visible} aria-label={exploring ? '精选网站封面目录' : '我的网站封面目录'}>
    <div className="library-atmosphere" aria-hidden="true" />
    <header className="library-header" inert={Boolean(editor)}>
      <button className="library-brand" onClick={onLibrary} title="我的网站" aria-label="我的网站"><img src="brand/fixed-sites.png" alt="" width="38" height="38" /></button>
      <nav className="library-nav" aria-label="工作区与目录">
        <button className={!exploring ? 'is-selected' : ''} aria-pressed={!exploring} onClick={onLibrary}>My Sites<span>{sites.length}</span></button>
        <button className={exploring ? 'is-selected' : ''} aria-pressed={exploring} onClick={onExplore}>Explore</button>
        <button onClick={onAgents}>Agents<Icon name="agents" size={15} /></button>
      </nav>
      <div className="library-header-actions">{activeSiteId && <button className="library-resume" onClick={onResume} title="回到正在浏览的网页" aria-label="继续浏览"><Icon name="back" size={18} /><span>继续浏览</span></button>}<button className="library-add" onClick={() => onEdit()} title="添加网站" aria-label="添加网站"><Icon name="plus" size={22} /><span>添加网站</span></button></div>
    </header>
    <div className="library-intro" inert={Boolean(editor)}>
      <label className="library-search" data-no-pan><Icon name="search" size={17} /><input value={query} placeholder={exploring ? '查找精选网站' : '查找你的网站'} aria-label="搜索网站名称或网址" spellCheck={false} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.isComposing || event.nativeEvent.isComposing) return; if (event.key === 'Escape') onQuery(''); if (event.key === 'Enter' && items.length) exploring ? onAdd(items[0]) : onOpen(items[0].id); }} />{query && <button aria-label="清除搜索" onClick={() => onQuery('')}><Icon name="close" size={14} /></button>}</label>
    </div>
    {exploring && <nav className="library-categories" inert={Boolean(editor)} aria-label="精选网站分类">{[{ id: 'all', label: '全部' }, ...categories].map((item) => <button key={item.id} aria-pressed={category === item.id} className={category === item.id ? 'is-selected' : ''} onClick={() => setCategory(item.id)}>{item.label}</button>)}</nav>}
    <div ref={viewportRef} className="library-viewport" inert={Boolean(editor)} tabIndex={0} aria-label="拖动或滚动浏览网站；方向键选择，Enter 打开" onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; } }}>
      <div ref={stageRef} className="library-stage">
        {items.map((site, index) => {
          const saved = exploring ? savedByUrl.get(new URL(site.url).href) : site;
          const coverSite = exploring ? { ...site, coverUrl: saved?.coverUrl, faviconUrl: saved?.faviconUrl } : site;
          const originalIndex = exploring ? presets.indexOf(site) : sites.indexOf(site);
          const added = exploring && addedUrls.has(new URL(site.url).href);
          return <article key={site.id || site.url} data-card-id={site.id || site.url} className={`library-card${site.id === activeSiteId ? ' is-current' : ''}${dragged === site.id ? ' is-dragging' : ''}${dropId === site.id ? ' is-drop-target' : ''}`} onDragOver={(event) => { if (dragged && site.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropId(site.id); } }} onDrop={(event) => reorder(event, site.id)} onContextMenu={(event) => { if (!exploring) { event.preventDefault(); window.fixedSites.showSiteMenu(site.id); } }}>
            <button className="library-card-open" aria-label={exploring ? `居中查看 ${site.name}` : `打开 ${site.name}`} onClick={() => exploring ? controls.current?.focus(index) : onOpen(site.id)}>
              <div className="library-cover"><SiteCover site={coverSite} Icon={Icon} /><span className="cover-open-hint"><Icon name={exploring ? 'plus' : 'forward'} size={19} /></span></div>
              <div className="library-card-heading"><Avatar.Root className="library-favicon">{site.faviconUrl && <Avatar.Image src={site.faviconUrl} alt="" referrerPolicy="no-referrer" />}<Avatar.Fallback><Icon name="web" size={14} /></Avatar.Fallback></Avatar.Root><h2>{site.name}</h2></div>
              <span className="library-card-domain">{hostOf(site.url)}</span>
            </button>
            <div className="library-card-bottom"><span>{exploring ? categories.find((item) => item.id === site.category)?.label : site.id === activeSiteId ? <><i />正在浏览</> : `NO. ${String(originalIndex + 1).padStart(2, '0')}`}</span>
              {exploring ? <button className={`library-card-add${added ? ' is-added' : ''}`} data-no-pan disabled={added || adding === site.url} aria-label={added ? `${site.name} 已添加` : `添加 ${site.name}`} onClick={() => onAdd(site)}><Icon name={added ? 'check' : 'plus'} size={18} /></button> : <div className="library-card-tools" data-no-pan>
                <button className="library-grip" draggable={!normalizedQuery} disabled={Boolean(normalizedQuery)} aria-label={`拖拽排序 ${site.name}`} title={normalizedQuery ? '清除搜索后可排序' : '拖动到其他卡片上调整顺序'} onDragStart={(event) => { event.dataTransfer.setData('text/fixed-sites-id', site.id); event.dataTransfer.effectAllowed = 'move'; setDragged(site.id); }} onDragEnd={() => { setDragged(null); setDropId(null); }}><Icon name="grip" size={15} /></button>
                <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><button className="library-more" aria-label={`${site.name} 操作`}><Icon name="more" size={17} /></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="site-menu library-menu" align="end" sideOffset={6}><DropdownMenu.Item className="site-menu-item" onSelect={() => onEdit(site)}><Icon name="edit" size={15} />修改网站</DropdownMenu.Item><DropdownMenu.Item className="site-menu-item" onSelect={() => onChooseCover(site.id)}><Icon name="image" size={15} />选择封面图片…</DropdownMenu.Item><DropdownMenu.Item className="site-menu-item" disabled={!site.coverUrl} onSelect={() => onClearCover(site.id)}><Icon name="web" size={15} />恢复网站图标</DropdownMenu.Item><DropdownMenu.Separator className="site-menu-rule" /><DropdownMenu.Item className="site-menu-item site-menu-delete" onSelect={() => onDelete(site.id)}><Icon name="delete" size={15} />删除网站</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
              </div>}
            </div>
          </article>;
        })}
      </div>
      {!items.length && <div className="library-empty"><img src="brand/fixed-sites.png" alt="" width="100" height="100" /><h2>{normalizedQuery ? '没有找到这个地方。' : '给常去的地方，留一个位置。'}</h2><p>{normalizedQuery ? '试试网站名称或域名。' : '添加一个网址，就有了第一张封面。'}</p><button onClick={() => normalizedQuery ? onQuery('') : onEdit()}>{normalizedQuery ? '清除搜索' : '添加第一个网站'}<Icon name="plus" size={16} /></button></div>}
    </div>
    <footer className="library-footer" inert={Boolean(editor)}>
      <div className="library-zoom"><button aria-label="缩小卡片" onClick={() => controls.current?.changeZoom(-.1)}>−</button><span>{zoom}%</span><button aria-label="放大卡片" onClick={() => controls.current?.changeZoom(.1)}>+</button><span className="library-control-rule" /><button className="library-center" title="回到初始卡片并重置缩放" onClick={() => controls.current?.home()}><Icon name="expand" size={15} /></button></div>
      <div className="library-focus"><button aria-label="上一张卡片" disabled={!items.length || focused <= 0} onClick={() => controls.current?.focus(focused - 1)}><Icon name="back" size={16} /></button><span className="library-focus-count">{items.length ? String(focused + 1).padStart(2, '0') : '00'}<span> / {String(items.length).padStart(2, '0')}</span></span><span className="library-focus-name">{focusedSite?.name || 'My Sites'}</span><button aria-label="下一张卡片" disabled={!items.length || focused >= items.length - 1} onClick={() => controls.current?.focus(focused + 1)}><Icon name="forward" size={16} /></button></div>
      <span className="library-gesture-hint">拖动探索<span>·</span>滚轮滑动<span>·</span>Ctrl + 滚轮缩放</span>
    </footer>
    {exploring && focusedSite?.description && <p className="library-description">{focusedSite.description}</p>}
    {error && !editor && <p className="library-error" role="alert">{error}</p>}
    {editor}
  </section>;
}
