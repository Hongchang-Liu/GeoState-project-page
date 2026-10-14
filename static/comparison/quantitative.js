// Paper Tables 1 and 2, with no averaging across forecast horizons or datasets.
const $ = selector => document.querySelector(selector);
const container = $('#chart-all');
const ns = 'http://www.w3.org/2000/svg';
let results, lastWidth = 0;

function element(tag, attributes = {}, text) {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function text(group, x, y, value, className, anchor = 'middle') {
  group.append(element('text', {x, y, class: className, 'text-anchor': anchor}, value));
}

function plot(svg, dataset, box, maximum, tick) {
  const {x, y, width, height} = box;
  const group = element('g', {'data-dataset': dataset.label});
  svg.append(group);
  const compact = width < 440;
  const left = x + (compact ? 43 : 52), right = x + width - 12;
  const top = y + 53, bottom = y + height - 49;
  const plotHeight = bottom - top, plotWidth = right - left;
  text(group, x + width / 2, y + 22, dataset.label, 'plot-title');
  if (dataset.zero_shot) text(group, x + width / 2, y + 39, 'Zero-shot', 'plot-subtitle');
  text(group, left, top - 8, 'AbsRel ↓', 'axis-caption', 'start');
  for (let value = 0; value <= maximum + 1e-8; value += tick) {
    const row = bottom - value / maximum * plotHeight;
    group.append(element('line', {x1: left, y1: row, x2: right, y2: row, class: value === 0 ? 'chart-baseline' : 'chart-grid'}));
    text(group, left - 9, row + 4, value.toFixed(2), 'axis-tick', 'end');
  }
  const step = plotWidth / dataset.horizons.length;
  const barGap = compact ? 2.5 : 5;
  const barWidth = Math.min(43, (step * .8 - 3 * barGap) / 4);
  const groupWidth = 4 * barWidth + 3 * barGap;
  dataset.horizons.forEach((seconds, index) => {
    const center = left + step * (index + .5);
    results.methods.forEach((method, order) => {
      const value = dataset.values[method.id][index], barHeight = value / maximum * plotHeight;
      const bx = center - groupWidth / 2 + order * (barWidth + barGap), by = bottom - barHeight;
      const label = `${dataset.label}, ${method.label}, t + ${seconds} s: AbsRel ${value.toFixed(3)}`;
      const bar = element('rect', {
        x: bx, y: by, width: barWidth, height: barHeight, rx: 2.5,
        fill: method.color, class: 'chart-bar', tabindex: 0, role: 'img',
        'aria-label': label, 'data-method': method.id, 'data-horizon': seconds, 'data-value': value.toFixed(3)
      });
      // Native tooltips expose exact values even on compact screens.
      bar.append(element('title', {}, label));
      group.append(bar);
      if (barWidth >= 26) text(group, bx + barWidth / 2, by - 7, value.toFixed(3), method.id === 'ours' ? 'bar-value ours-value' : 'bar-value');
      else if (barWidth >= 14) {
        const tx = bx + barWidth / 2, ty = by - 5;
        group.append(element('text', {x: tx, y: ty, transform: `rotate(-60 ${tx} ${ty})`, 'text-anchor': 'start', class: method.id === 'ours' ? 'bar-value compact-value ours-value' : 'bar-value compact-value'}, value.toFixed(3)));
      }
    });
    const horizon = Number.isInteger(seconds) ? seconds.toFixed(1) : String(seconds);
    text(group, center, bottom + 22, `t + ${horizon} s`, 'horizon-label');
  });
  text(group, left + plotWidth / 2, y + height - 4, 'Forecast horizon', 'axis-caption');
}

function chart(container, datasets) {
  const width = Math.max(300, Math.round(container.clientWidth));
  const stacked = width < 960;
  const panelHeight = stacked ? 300 : 350;
  const gap = stacked ? 20 : 24;
  const height = stacked ? panelHeight * datasets.length + gap * (datasets.length - 1) : panelHeight;
  const svg = element('svg', {viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `${datasets.map(d => d.label).join(' and ')} predicted-camera AbsRel; lower is better`});
  svg.append(element('title', {}, `${datasets.map(d => d.label).join(' and ')} · AbsRel (lower is better)`));
  // Shared zero-based axes keep bar heights comparable, including across datasets.
  const horizons = datasets.reduce((total, dataset) => total + dataset.horizons.length, 0);
  let offset = 0;
  datasets.forEach((dataset, index) => {
    const panelWidth = stacked ? width : (width - gap * (datasets.length - 1)) * dataset.horizons.length / horizons;
    plot(svg, dataset, {x: stacked ? 0 : offset, y: stacked ? index * (panelHeight + gap) : 0, width: panelWidth, height: panelHeight}, .32, .08);
    offset += panelWidth + gap;
  });
  container.replaceChildren(svg);
}

function redraw() {
  if (!results) return;
  chart(container, [results.datasets.waymo, results.datasets.kitti, results.datasets.nuscenes]);
}
new ResizeObserver(() => {
  const width = container.clientWidth;
  if (!width || width === lastWidth) return;
  lastWidth = width; redraw();
}).observe(container);

try {
  const response = await fetch('quantitative.json', {cache: 'no-store'});
  if (!response.ok) throw new Error('Missing quantitative results');
  results = await response.json();
  for (const dataset of Object.values(results.datasets)) for (const method of results.methods) {
    const values = dataset.values[method.id];
    if (values.length !== dataset.horizons.length || values.some(value => !Number.isFinite(value) || value < 0 || value > .32)) throw new Error('Invalid quantitative results');
  }
  for (const method of results.methods) {
    const item = document.createElement('span');
    const swatch = document.createElement('i'); swatch.style.background = method.color;
    item.append(swatch, document.createTextNode(method.label));
    if (method.id === 'ours') item.classList.add('ours-legend');
    $('#chart-legend').append(item);
  }
  for (const dataset of Object.values(results.datasets)) {
    const table = document.createElement('table'), caption = document.createElement('caption');
    caption.textContent = `${dataset.label} · Predicted-camera AbsRel`; table.append(caption);
    const heading = document.createElement('tr');
    for (const label of ['Method', ...dataset.horizons.map(seconds => `t + ${seconds} s`)]) {const th = document.createElement('th'); th.textContent = label; heading.append(th);}
    table.append(heading);
    for (const method of results.methods) {
      const row = document.createElement('tr'), label = document.createElement('th'); label.textContent = method.label; row.append(label);
      for (const value of dataset.values[method.id]) {const cell = document.createElement('td'); cell.textContent = value.toFixed(3); row.append(cell);}
      table.append(row);
    }
    $('#chart-data-table').append(table);
  }
  redraw();
} catch (error) {$('#chart-error').hidden = false; console.error(error);}
