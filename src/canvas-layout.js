'use strict';

const HEADER = 34;
const GAP = 8;

function layoutCanvas(canvas, { width, height, left, right, top, immersive = false }) {
  const area = immersive ? { x: 0, y: 0, width, height } : {
    x: left + GAP, y: top + GAP,
    width: Math.max(1, width - left - right - GAP * 2),
    height: Math.max(1, height - top - GAP * 2),
  };
  const expanded = immersive ? canvas.activeKey : canvas.expanded;
  const visible = expanded ? canvas.panes.filter(p => p.key === expanded) : canvas.panes;
  let divider = null;
  const panels = visible.map((pane, index) => {
    const rect = { ...area };
    if (visible.length === 2) {
      const vertical = canvas.direction === 'vertical';
      const length = Math.max(1, (vertical ? area.height : area.width) - GAP);
      const first = Math.round(length * Math.max(.2, Math.min(.8, canvas.ratio)));
      if (vertical) { rect.y += index ? first + GAP : 0; rect.height = index ? length - first : first; }
      else { rect.x += index ? first + GAP : 0; rect.width = index ? length - first : first; }
      divider = vertical ? { x: area.x, y: area.y + first, width: area.width, height: GAP } :
        { x: area.x + first, y: area.y, width: GAP, height: area.height };
    }
    const header = immersive ? 0 : HEADER;
    return { ...pane, rect, content: { x: rect.x, y: rect.y + header, width: rect.width, height: Math.max(1, rect.height - header) } };
  });
  return { area, panels, divider };
}

module.exports = { layoutCanvas };
