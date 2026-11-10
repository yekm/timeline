const DAY = 1 / 366;
const EARTH_START = -4_567_000_000;
const HUMAN_START = -3_000_000;
const HISTORY_DETAIL_START = -9_999;
const LANE_HEIGHT = 37;
const ERA_ROW = 24;
const BLOCK_GAP = 5;
const FADE_WIDTH = 66;
const POINT_WIDTH = 12;

const translations = {
  en: {
    overview: ["Earth history", "Period overview", "Date selection"],
    human: "Human history", timeline: "Timeline", present: "Present",
    empty: "No items in this range. Move the timeline or choose a category.",
    brush: "Selected range", start: "Start", end: "End", bce: "BCE",
    born: "Born", died: "Died", unknown: "date unknown", ga: "Ga", ma: "Ma",
    source: "Source",
  },
  ru: {
    overview: ["История Земли", "Обзор периода", "Выбор дат"],
    human: "История человечества", timeline: "Хронология", present: "Сегодня",
    empty: "В этом диапазоне нет записей. Сдвиньте шкалу или выберите категорию.",
    brush: "Выбранный диапазон", start: "Начало", end: "Конец", bce: "до н. э.",
    born: "Рождение", died: "Смерть", unknown: "дата неизвестна", ga: "млрд л.", ma: "млн л.",
    source: "Источник",
  },
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function currentYear() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  return year + (now.getTime() - start) / (Date.UTC(year + 1, 0, 1) - start);
}

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const span = ([start, end]) => end - start;
const center = ([start, end]) => start + (end - start) / 2;
const contains = (outer, inner) => outer[0] <= inner[0] && inner[1] <= outer[1];
const shift = (range, delta) => range.map((value) => value + delta);

function fitRange(range, domain) {
  const width = Math.min(span(domain), Math.max(DAY, span(range)));
  if (width === span(domain)) return [...domain];
  const start = clamp(center(range) - width / 2, domain[0], domain[1] - width);
  return [start, Math.min(domain[1], start + width)];
}

function enclose(parent, child, domain) {
  if (contains(parent, child)) return parent;
  const width = Math.min(span(domain), Math.max(span(parent), span(child) * 1.4));
  const start = clamp(parent[0], child[1] - width, child[0]);
  return fitRange([start, start + width], domain);
}

function around(value, width, domain) {
  return fitRange([value - width / 2, value + width / 2], domain);
}

function niceStep(approximate) {
  const power = 10 ** Math.floor(Math.log10(approximate));
  const ratio = approximate / power;
  return power * (ratio >= Math.sqrt(50) ? 10 : ratio >= Math.sqrt(10) ? 5 : ratio >= Math.sqrt(2) ? 2 : 1);
}

function ticks(range, width) {
  const step = Math.max(DAY, niceStep(span(range) / clamp(width / 100, 2, 12)));
  const first = Math.ceil(range[0] / step - 1e-8);
  const last = Math.floor(range[1] / step + 1e-8);
  return Array.from({length: Math.max(0, last - first + 1)}, (_, index) => ({
    year: (first + index) * step,
    step,
  }));
}

function dateParts(year) {
  const integer = Math.floor(year + 1e-10);
  const leap = integer % 4 === 0 && (integer % 100 !== 0 || integer % 400 === 0);
  const months = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let days = clamp(Math.floor((year - integer) * (leap ? 366 : 365) + 1e-7), 0, leap ? 365 : 364);
  let month = 0;
  while (days >= months[month]) {
    days -= months[month];
    month += 1;
  }
  return {year: integer, month, day: days + 1};
}

function toX(year, range, width) {
  return (year - range[0]) / span(range) * width;
}

function fromX(x, range, width) {
  return range[0] + x / width * span(range);
}

class MinHeap {
  constructor(compare) {
    this.values = [];
    this.compare = compare;
  }

  peek() {
    return this.values[0];
  }

  push(value) {
    const values = this.values;
    let index = values.length;
    values.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(values[parent], value) <= 0) break;
      values[index] = values[parent];
      index = parent;
    }
    values[index] = value;
  }

  pop() {
    const values = this.values;
    const first = values[0];
    const last = values.pop();
    if (values.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < values.length) {
      let child = index * 2 + 1;
      const other = child + 1;
      if (other < values.length && this.compare(values[other], values[child]) < 0) child = other;
      if (this.compare(last, values[child]) <= 0) break;
      values[index] = values[child];
      index = child;
    }
    values[index] = last;
    return first;
  }
}

function stack(blocks, gap = BLOCK_GAP) {
  blocks.sort((a, b) => a.left - b.left || a.right - b.right || a.item.id.localeCompare(b.item.id));
  const active = new MinHeap((a, b) => a.right - b.right);
  const available = new MinHeap((a, b) => a - b);
  const lanes = [];
  for (const block of blocks) {
    while (active.peek() && active.peek().right + gap <= block.left) {
      available.push(active.pop().lane);
    }
    const lane = available.peek() === undefined ? lanes.length : available.pop();
    if (lane === lanes.length) lanes.push([]);
    lanes[lane].push(block);
    active.push({right: block.right, lane});
  }
  return lanes;
}

function itemBounds(item, range, width) {
  if (Number.isFinite(item.start) && Number.isFinite(item.end)) {
    const left = toX(Math.min(item.start, item.end), range, width);
    const right = toX(Math.max(item.start, item.end), range, width);
    if (right - left >= 3) return {left, right, style: "interval"};
    const anchor = (left + right) / 2;
    return {left: anchor - POINT_WIDTH / 2, right: anchor + POINT_WIDTH / 2, style: "point", anchor};
  }
  if (Number.isFinite(item.point)) {
    const anchor = toX(item.point, range, width);
    return {left: anchor - POINT_WIDTH / 2, right: anchor + POINT_WIDTH / 2, style: "point", anchor};
  }
  if (Number.isFinite(item.start)) {
    const left = toX(item.start, range, width);
    return {left, right: left + FADE_WIDTH, style: "fade-right"};
  }
  if (Number.isFinite(item.end)) {
    const right = toX(item.end, range, width);
    return {left: right - FADE_WIDTH, right, style: "fade-left"};
  }
  return null;
}

function urlFor(item) {
  if (typeof item.url !== "string") return null;
  try {
    const url = new URL(item.url);
    if (url.protocol === "https:" && /^(?:[a-z0-9-]+\.)*wikipedia\.org$/.test(url.hostname)) return url.href;
  } catch {
    return null;
  }
  return null;
}

export class Timeline {
  constructor(root, {onRangeChange = () => {}, onItemSelect = () => {}} = {}) {
    this.root = root;
    this.onRangeChange = onRangeChange;
    this.onItemSelect = onItemSelect;
    this.now = currentYear();
    this.domain = [EARTH_START, this.now];
    this.views = [this.domain, [HUMAN_START, this.now], [HISTORY_DETAIL_START, this.now], [this.now - 300, this.now]];
    this.epochs = [];
    this.items = [];
    this.lanes = [];
    this.nodes = new Map();
    this.listeners = new AbortController();
    this.frame = 0;
    this.drag = null;
    this.language = "en";
    this.words = translations.en;
    this.root.classList.add("timeline");
    this.root.replaceChildren();
    this.overviews = Array.from({length: 3}, (_, index) => this.makeOverview(index));
    this.makeMain();
    this.setLanguage("en");
    this.resize = new ResizeObserver(() => this.requestRender());
    this.resize.observe(root);
    this.resize.observe(this.scroll);
  }

  listen(node, type, listener, options = {}) {
    node.addEventListener(type, listener, {...options, signal: this.listeners.signal});
  }

  setEpochs(items) {
    this.epochs = items.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
    this.requestRender();
  }

  setItems(items) {
    this.items = items;
    this.requestRender();
  }

  setLanguage(lang) {
    this.language = lang.toLowerCase();
    this.uiLanguage = this.language.startsWith("ru-") || this.language === "ru" ? "ru" : "en";
    this.words = translations[this.uiLanguage];
    let locale = this.uiLanguage;
    try {
      locale = Intl.DateTimeFormat.supportedLocalesOf([this.language])[0] ?? locale;
    } catch {
      // Wikimedia site codes need not be valid language tags for Intl.
    }
    this.number = new Intl.NumberFormat(locale, {maximumFractionDigits: 2, useGrouping: false});
    const monthFormat = new Intl.DateTimeFormat(locale, {month: "short", timeZone: "UTC"});
    this.months = Array.from({length: 12}, (_, month) => monthFormat.format(Date.UTC(2024, month, 1)));
    this.overviews.forEach((overview, index) => { overview.name.textContent = this.words.overview[index]; });
    this.human.textContent = this.words.human;
    this.scroll.setAttribute("aria-label", this.words.timeline);
    this.empty.textContent = this.words.empty;
    this.requestRender();
  }

  setRange(range) {
    if (range.length === 2 && range.every(Number.isFinite) && range[0] <= range[1]) this.updateMain(range, false);
  }

  getRange() {
    return [...this.views[3]];
  }

  reset(range = [this.now - 300, this.now]) {
    this.views[1] = [HUMAN_START, this.now];
    this.views[2] = [HISTORY_DETAIL_START, this.now];
    this.scroll.scrollTop = 0;
    this.setRange(range);
  }

  destroy() {
    this.listeners.abort();
    this.resize.disconnect();
    cancelAnimationFrame(this.frame);
    this.root.replaceChildren();
    this.root.classList.remove("timeline");
  }

  formatDate(year, step = 1) {
    if (step >= 10_000 && year <= -100_000) {
      const ga = year <= -1e9;
      return `${this.number.format(-year / (ga ? 1e9 : 1e6))} ${ga ? this.words.ga : this.words.ma}`;
    }
    const date = dateParts(year);
    const label = date.year > 0 ? String(date.year) : `${1 - date.year} ${this.words.bce}`;
    if (step >= 1) return label;
    const day = step >= 0.07 ? "" : `${date.day} `;
    return `${day}${this.months[date.month]} ${label}`;
  }

  formatRange(range) {
    const step = span(range) < 1 ? DAY : span(range) / 8;
    const start = this.formatDate(range[0], step);
    const end = Math.abs(range[1] - this.now) < DAY ? this.words.present : this.formatDate(range[1], step);
    return start === end ? start : `${start} – ${end}`;
  }

  itemLabel(item) {
    const name = [item.title, item.region, this.isFallback(item) ? "EN" : ""].filter(Boolean).join(" · ");
    const format = (key) => {
      const label = item[`${key}Label`];
      if (label && this.uiLanguage === "ru") return label.replace(/\bBCE\b/g, this.words.bce);
      return label || this.formatDate(item[key]);
    };
    if (Number.isFinite(item.start) && Number.isFinite(item.end)) {
      const source = typeof item.source === "string" ? ` · ${this.words.source} — ${item.source.replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}` : "";
      return `${name} · ${format("start")} – ${format("end")}${source}`;
    }
    if (Number.isFinite(item.point)) return `${name} · ${format("point")}`;
    const hasStart = Number.isFinite(item.start);
    let known = hasStart ? this.words.start : this.words.end;
    let missing = hasStart ? this.words.end : this.words.start;
    if (item.kind === "person") {
      known = hasStart ? this.words.born : this.words.died;
      missing = hasStart ? this.words.died : this.words.born;
    }
    return `${name} · ${known} ${format(hasStart ? "start" : "end")} · ${missing.toLocaleLowerCase()} — ${this.words.unknown}`;
  }

  isFallback(item) {
    return this.language !== "en" && item.language === "en";
  }

  linkText(item) {
    return this.isFallback(item) ? `EN · ${item.title}` : item.title;
  }

  requestRender() {
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  makeOverview(index) {
    const section = element("div", "timeline-overview");
    const bar = element("div", "timeline-overview-heading");
    const name = element("span", "timeline-overview-name");
    const readout = element("span", "timeline-range-label");
    bar.append(element("span", "timeline-overview-number", `0${index + 1}`), name, readout);
    if (index === 0) {
      this.human = element("button", "timeline-human");
      this.human.type = "button";
      this.listen(this.human, "click", () => this.focusHumanHistory());
      bar.append(this.human);
    }
    const track = element("div", "timeline-overview-track");
    const bands = element("div", "timeline-overview-bands");
    const axis = element("div", "timeline-axis timeline-overview-axis");
    bands.setAttribute("aria-hidden", "true");
    axis.setAttribute("aria-hidden", "true");
    const brush = element("div", "timeline-brush");
    const selection = element("span", "timeline-brush-selection");
    const left = element("span", "timeline-brush-handle timeline-brush-left");
    const right = element("span", "timeline-brush-handle timeline-brush-right");
    for (const node of [selection, left, right]) {
      node.tabIndex = 0;
      node.setAttribute("role", "slider");
    }
    brush.append(selection, left, right);
    track.append(bands, brush);
    section.append(bar, track, axis);
    this.root.append(section);
    this.listen(track, "pointerdown", (event) => this.beginBrush(event, index));
    this.listen(track, "pointermove", (event) => this.moveBrush(event, index));
    this.listen(track, "pointerup", (event) => this.endBrush(event, index));
    this.listen(track, "pointercancel", () => { this.drag = null; });
    this.listen(track, "keydown", (event) => this.keyBrush(event, index));
    return {track, bands, axis, brush, selection, left, right, name, readout};
  }

  makeMain() {
    const section = element("div", "timeline-main");
    this.scroll = element("div", "timeline-scroll");
    this.scroll.tabIndex = 0;
    this.content = element("div", "timeline-content");
    this.backdrop = element("div", "timeline-backdrop");
    this.grid = element("div", "timeline-grid");
    this.eraLabels = element("div", "timeline-era-labels");
    this.blocks = element("div", "timeline-blocks");
    this.empty = element("p", "timeline-empty");
    this.grid.setAttribute("aria-hidden", "true");
    this.backdrop.setAttribute("aria-hidden", "true");
    this.content.append(this.backdrop, this.grid, this.eraLabels, this.blocks, this.empty);
    this.scroll.append(this.content);
    this.axis = element("div", "timeline-axis timeline-main-axis");
    this.axis.setAttribute("aria-hidden", "true");
    this.tooltip = element("div", "timeline-tooltip");
    this.tooltip.hidden = true;
    this.tooltip.setAttribute("aria-hidden", "true");
    section.append(this.scroll, this.axis, this.tooltip);
    this.root.append(section);
    this.listen(this.scroll, "scroll", () => {
      this.tooltip.hidden = true;
      this.drawVisibleLanes();
    });
    this.listen(this.scroll, "wheel", (event) => this.onWheel(event), {passive: false});
    this.listen(this.scroll, "keydown", (event) => this.keyMain(event));
    this.listen(this.scroll, "pointerdown", (event) => this.beginPan(event));
    this.listen(this.scroll, "pointermove", (event) => this.movePan(event));
    this.listen(this.scroll, "pointerup", (event) => this.endPan(event));
    this.listen(this.scroll, "pointercancel", (event) => this.endPan(event));
    this.listen(this.scroll, "click", (event) => {
      if (event.detail > 0 && this.suppressClick) {
        event.preventDefault();
        event.stopPropagation();
        this.suppressClick = false;
      }
    }, {capture: true});
    this.listen(this.scroll, "pointerover", (event) => this.inspect(event.target));
    this.listen(this.scroll, "pointerout", (event) => {
      if (!event.target.closest("a[data-timeline-label]")?.contains(event.relatedTarget)) this.tooltip.hidden = true;
    });
    this.listen(this.scroll, "focusin", (event) => this.inspect(event.target));
    this.listen(this.scroll, "focusout", () => { this.tooltip.hidden = true; });
  }

  updateMain(range, notify = true) {
    this.views[3] = fitRange(range, this.domain);
    this.views[2] = enclose(this.views[2], this.views[3], this.domain);
    this.views[1] = enclose(this.views[1], this.views[2], this.domain);
    this.changed(notify);
  }

  changed(notify = true) {
    this.tooltip.hidden = true;
    this.requestRender();
    if (notify) this.onRangeChange(this.getRange());
  }

  focusHumanHistory() {
    const human = [HUMAN_START, this.now];
    const last = contains(human, this.views[3]) ? this.views[3] : [this.now - 300, this.now];
    this.views[1] = human;
    this.views[2] = enclose([HISTORY_DETAIL_START, this.now], last, human);
    this.views[3] = last;
    this.changed();
  }

  selectChild(index, range, move = false, baseline = this.views) {
    const previous = baseline[index + 1];
    this.views[index + 1] = fitRange(range, this.views[index]);
    const delta = move ? this.views[index + 1][0] - previous[0] : 0;
    for (let child = index + 2; child < this.views.length; child += 1) {
      this.views[child] = fitRange(shift(baseline[child], delta), this.views[child - 1]);
    }
    this.changed();
  }

  selectPeriod(year) {
    const epoch = this.epochs.find((item) => item.level === "eon" && item.start <= year && year <= item.end);
    const range = epoch ? fitRange([epoch.start, epoch.end], this.domain) : around(year, span(this.domain) / 6, this.domain);
    this.views[1] = range;
    this.views[2] = around(year, span(range) / 4, range);
    this.views[3] = around(year, span(this.views[2]) / 5, this.views[2]);
    this.changed();
  }

  beginBrush(event, index) {
    if (event.button !== 0 || !event.isPrimary) return;
    const row = this.overviews[index];
    const bounds = row.track.getBoundingClientRect();
    const mode = event.target === row.left ? "left" : event.target === row.right ? "right"
      : row.brush.contains(event.target) ? "move" : "select";
    this.drag = {
      id: event.pointerId, index, mode, bounds, startX: event.clientX, range: this.views[index + 1],
      views: [...this.views], moved: false,
    };
    row.track.setPointerCapture(event.pointerId);
    if (mode !== "select") event.target.focus({preventScroll: true});
    event.preventDefault();
  }

  moveBrush(event, index) {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId || drag.index !== index) return;
    const deltaX = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(deltaX) < 3) return;
    drag.moved = true;
    const parent = this.views[index];
    const delta = deltaX / drag.bounds.width * span(parent);
    let range = drag.range;
    if (drag.mode === "move") range = shift(range, delta);
    if (drag.mode === "left") range = [clamp(range[0] + delta, parent[0], range[1] - DAY), range[1]];
    if (drag.mode === "right") range = [range[0], clamp(range[1] + delta, range[0] + DAY, parent[1])];
    if (drag.mode === "select") {
      const origin = fromX(clamp(drag.startX - drag.bounds.left, 0, drag.bounds.width), parent, drag.bounds.width);
      const destination = clamp(origin + delta, parent[0], parent[1]);
      range = [Math.min(origin, destination), Math.max(origin, destination)];
    }
    this.selectChild(index, range, drag.mode === "move", drag.views);
  }

  endBrush(event, index) {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId || drag.index !== index) return;
    this.drag = null;
    if (drag.moved || drag.mode !== "select") return;
    const parent = this.views[index];
    const year = fromX(clamp(event.clientX - drag.bounds.left, 0, drag.bounds.width), parent, drag.bounds.width);
    if (index === 0) this.selectPeriod(year);
    else this.selectChild(index, around(year, span(drag.range), parent), true);
  }

  keyBrush(event, index) {
    const row = this.overviews[index];
    if (!row.brush.contains(event.target)) return;
    const direction = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[event.key];
    if (!direction) return;
    event.preventDefault();
    const parent = this.views[index];
    const range = this.views[index + 1];
    const delta = direction * Math.max(DAY, span(range) / (event.shiftKey ? 2 : 20));
    if (event.target === row.left) {
      this.selectChild(index, [clamp(range[0] + delta, parent[0], range[1] - DAY), range[1]]);
    } else if (event.target === row.right) {
      this.selectChild(index, [range[0], clamp(range[1] + delta, range[0] + DAY, parent[1])]);
    } else {
      this.selectChild(index, shift(range, delta), true);
    }
  }

  zoom(factor, position) {
    const range = this.views[3];
    const anchor = range[0] + position * span(range);
    const width = clamp(span(range) * factor, DAY, span(this.domain));
    this.updateMain([anchor - position * width, anchor + (1 - position) * width]);
  }

  onWheel(event) {
    if (event.ctrlKey || event.metaKey || !this.scroll.clientWidth) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scroll.clientHeight : 1;
    if (event.shiftKey || (!event.deltaY && event.deltaX)) {
      this.updateMain(shift(this.views[3], (event.deltaX || event.deltaY) * units / this.scroll.clientWidth * span(this.views[3])));
      return;
    }
    const x = event.clientX - this.scroll.getBoundingClientRect().left;
    this.zoom(Math.exp(clamp(event.deltaY * units * 0.0025, -2, 2)), clamp(x / this.scroll.clientWidth, 0, 1));
  }

  keyMain(event) {
    if (event.target !== this.scroll) return;
    const width = span(this.views[3]);
    if (event.key === "ArrowLeft") this.updateMain(shift(this.views[3], -width * 0.12));
    else if (event.key === "ArrowRight") this.updateMain(shift(this.views[3], width * 0.12));
    else if (event.key === "+" || event.key === "=") this.zoom(0.75, 0.5);
    else if (event.key === "-") this.zoom(1.33, 0.5);
    else return;
    event.preventDefault();
  }

  beginPan(event) {
    this.suppressClick = false;
    if (event.button !== 0 || !event.isPrimary) return;
    if (event.clientX - this.scroll.getBoundingClientRect().left >= this.scroll.clientWidth) return;
    this.drag = {id: event.pointerId, index: 3, startX: event.clientX, range: [...this.views[3]], moved: false};
  }

  movePan(event) {
    const drag = this.drag;
    if (!drag || drag.index !== 3 || drag.id !== event.pointerId) return;
    const pixels = event.clientX - drag.startX;
    if (!drag.moved && Math.abs(pixels) < 5) return;
    if (!drag.moved) {
      this.scroll.setPointerCapture(event.pointerId);
      this.scroll.classList.add("timeline-panning");
    }
    drag.moved = true;
    this.updateMain(shift(drag.range, -pixels / this.scroll.clientWidth * span(drag.range)));
  }

  endPan(event) {
    if (this.drag?.index !== 3 || this.drag.id !== event.pointerId) return;
    this.suppressClick = this.drag.moved;
    this.drag = null;
    this.scroll.classList.remove("timeline-panning");
  }

  inspect(target) {
    if (this.drag?.moved) return;
    const link = target.closest("a[data-timeline-label]");
    if (!link) return;
    this.tooltip.textContent = link.dataset.timelineLabel;
    this.tooltip.hidden = false;
    const area = this.tooltip.parentElement.getBoundingClientRect();
    const box = link.getBoundingClientRect();
    this.tooltip.style.left = `${clamp(box.left - area.left, 6, Math.max(6, area.width - this.tooltip.offsetWidth - 6))}px`;
    const below = box.bottom - area.top + 5;
    this.tooltip.style.top = `${below + this.tooltip.offsetHeight <= area.height ? below : Math.max(0, box.top - area.top - this.tooltip.offsetHeight - 5)}px`;
  }

  drawAxis(axis, marks, range, width) {
    const fragment = document.createDocumentFragment();
    let previousRight = -10;
    for (const {year, step} of marks) {
      const present = step >= 10_000 && range[1] === this.now && Math.abs(year - this.now) < span(range) / 100;
      const label = present ? this.words.present : this.formatDate(year, step);
      const x = present ? width : clamp(toX(year, range, width), 0, width);
      const textWidth = label.length * 7;
      const alignLeft = x < textWidth / 2;
      const alignRight = x > width - textWidth / 2;
      const left = x - (alignLeft ? 0 : alignRight ? textWidth : textWidth / 2);
      if (left - previousRight < 7) continue;
      previousRight = left + textWidth;
      const tick = element("span", "timeline-tick", label);
      tick.style.left = `${x}px`;
      if (alignLeft) tick.classList.add("timeline-tick-left");
      if (alignRight) tick.classList.add("timeline-tick-right");
      fragment.append(tick);
    }
    axis.style.width = `${width}px`;
    axis.replaceChildren(fragment);
  }

  drawOverview(index) {
    const row = this.overviews[index];
    const width = row.track.clientWidth;
    if (!width) return;
    const range = this.views[index];
    const selected = this.views[index + 1];
    const labels = [this.words.brush, this.words.start, this.words.end];
    [row.selection, row.left, row.right].forEach((node, position) => {
      node.setAttribute("aria-label", `${row.name.textContent} · ${labels[position]}`);
      node.setAttribute("aria-valuemin", range[0]);
      node.setAttribute("aria-valuemax", range[1]);
      node.setAttribute("aria-valuenow", position ? selected[position - 1] : center(selected));
      node.setAttribute("aria-valuetext", position ? this.formatDate(selected[position - 1], span(range) / 10) : this.formatRange(selected));
    });
    row.readout.textContent = this.formatRange(range);
    row.brush.title = this.formatRange(selected);
    const brushWidth = clamp(span(selected) / span(range) * width, Math.min(16, width), width);
    row.brush.style.left = `${clamp(toX(selected[0], range, width), 0, width - brushWidth)}px`;
    row.brush.style.width = `${brushWidth}px`;
    const levels = index === 0 ? ["eon"] : index === 1 ? ["era", "history"] : ["period", "history", "era"];
    const bands = [];
    for (const epoch of this.epochs) {
      if (!levels.includes(epoch.level) || epoch.end <= range[0] || epoch.start >= range[1]) continue;
      const left = Math.max(0, toX(epoch.start, range, width));
      const right = Math.min(width, toX(epoch.end, range, width));
      if (right - left < 2) continue;
      bands.push({item: epoch, left, right});
    }
    const fragment = document.createDocumentFragment();
    const lanes = stack(bands, 0);
    lanes.slice(0, 2).forEach((lane, rowIndex) => {
      for (const {item, left, right} of lane) {
        const band = element("span", "timeline-overview-band", right - left >= 28 ? item.title : "");
        band.title = this.itemLabel(item);
        band.style.left = `${left}px`;
        band.style.width = `${right - left}px`;
        band.style.top = `${rowIndex * 50}%`;
        band.style.height = lanes.length > 1 ? "50%" : "100%";
        if (item.color) band.style.setProperty("--timeline-mark", item.color);
        fragment.append(band);
      }
    });
    row.bands.replaceChildren(fragment);
    this.drawAxis(row.axis, ticks(range, width), range, width);
  }

  makeLink(item, className) {
    const url = urlFor(item);
    const node = element(url ? "a" : "span", className);
    if (url) {
      node.href = url;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      node.addEventListener("click", () => this.onItemSelect(item));
    }
    node.draggable = false;
    node.dataset.timelineLabel = this.itemLabel(item);
    node.setAttribute("aria-label", node.dataset.timelineLabel);
    if (item.color) node.style.setProperty("--timeline-mark", item.color);
    return node;
  }

  drawEpochs(range, width) {
    const blocks = [];
    const fills = document.createDocumentFragment();
    const selected = this.epochs.filter((epoch) => epoch.end > range[0] && epoch.start < range[1]);
    const byId = new Map(selected.map((epoch) => [epoch.id, epoch]));
    const obscured = new Set(selected.filter((epoch) => epoch.parent && byId.has(epoch.parent) && epoch.start <= range[0] && epoch.end >= range[1]).map((epoch) => epoch.parent));
    for (const item of selected) {
      if (obscured.has(item.id) && item.level !== "history") continue;
      const left = Math.max(0, toX(item.start, range, width));
      const right = Math.min(width, toX(item.end, range, width));
      if (right - left < 2) continue;
      const fill = element("span", "timeline-era-background");
      fill.style.left = `${left}px`;
      fill.style.width = `${right - left}px`;
      if (item.color) fill.style.setProperty("--timeline-mark", item.color);
      fills.append(fill);
      blocks.push({item, left, right: Math.min(right, left + Math.max(55, item.title.length * 7 + 19))});
    }
    const labels = document.createDocumentFragment();
    const lanes = stack(blocks);
    lanes.forEach((lane, row) => {
      for (const {item, left, right} of lane) {
        const label = this.makeLink(item, "timeline-era-label");
        label.textContent = right - left >= 22 ? this.linkText(item) : "";
        label.style.left = `${left}px`;
        label.style.top = `${row * ERA_ROW + 5}px`;
        label.style.width = `${right - left}px`;
        labels.append(label);
      }
    });
    this.backdrop.replaceChildren(fills);
    this.eraLabels.replaceChildren(labels);
    return lanes.length * ERA_ROW + 8;
  }

  drawVisibleLanes() {
    if (!this.width) return;
    const first = Math.max(0, Math.floor((this.scroll.scrollTop - this.eraHeight) / LANE_HEIGHT) - 1);
    const last = Math.min(this.lanes.length, Math.ceil((this.scroll.scrollTop + this.scroll.clientHeight - this.eraHeight) / LANE_HEIGHT) + 1);
    const visible = new Set();
    const append = document.createDocumentFragment();
    for (let lane = first; lane < last; lane += 1) {
      for (const block of this.lanes[lane]) {
        const {item, left, right, style, anchor} = block;
        const key = item.id;
        visible.add(key);
        let entry = this.nodes.get(key);
        if (!entry || entry.item !== item || entry.style !== style || entry.language !== this.language) {
          entry?.node.remove();
          const node = this.makeLink(item, `timeline-block timeline-${style}`);
          const text = element("span", "timeline-block-label", this.linkText(item));
          node.append(text);
          entry = {node, item, style, text, language: this.language};
          this.nodes.set(key, entry);
          append.append(node);
        }
        const x = clamp(left, 0, this.width);
        const clippedWidth = clamp(right, 0, this.width) - x;
        entry.node.style.left = `${x}px`;
        entry.node.style.top = `${this.eraHeight + lane * LANE_HEIGHT}px`;
        entry.node.style.width = `${clippedWidth}px`;
        if (style === "interval") {
          entry.node.classList.toggle("timeline-continues-left", left < 0);
          entry.node.classList.toggle("timeline-continues-right", right > this.width);
        }
        if (style === "point") entry.node.style.setProperty("--timeline-point-x", `${anchor - x}px`);
        if (style.startsWith("fade")) entry.node.style.setProperty("--timeline-clip", `${left - x}px`);
        entry.text.hidden = style === "point" || clippedWidth < 23;
      }
    }
    for (const [key, entry] of this.nodes) {
      if (!visible.has(key) && entry.node !== document.activeElement) {
        entry.node.remove();
        this.nodes.delete(key);
      }
    }
    this.blocks.append(append);
  }

  render() {
    for (let index = 0; index < 3; index += 1) this.drawOverview(index);
    this.width = this.scroll.clientWidth;
    if (!this.width) return;
    const range = this.views[3];
    const marks = ticks(range, this.width);
    this.drawAxis(this.axis, marks, range, this.width);
    const rules = marks.map(({year}) => {
      const rule = element("span", "timeline-grid-line");
      rule.style.left = `${clamp(toX(year, range, this.width), 0, this.width)}px`;
      return rule;
    });
    this.grid.replaceChildren(...rules);
    this.eraHeight = this.drawEpochs(range, this.width);
    this.grid.style.backgroundPositionY = `${this.eraHeight - 5}px`;
    const blocks = [];
    for (const item of this.items) {
      const bounds = itemBounds(item, range, this.width);
      if (bounds && bounds.right > 0 && bounds.left < this.width) blocks.push({item, ...bounds});
    }
    this.lanes = stack(blocks);
    this.content.style.height = `${Math.max(this.scroll.clientHeight, this.eraHeight + this.lanes.length * LANE_HEIGHT + 12)}px`;
    this.empty.hidden = this.lanes.length > 0 || this.eraHeight > 8;
    this.drawVisibleLanes();
  }
}
