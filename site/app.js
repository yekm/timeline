import { Timeline } from './timeline.js';

const copy = {
  en: {
    wordmark: 'TIME ATLAS', language: 'Catalogue language', eyebrow: 'THE INTERACTIVE CHRONOLOGY',
    title: 'Atlas of Time', intro: "Explore Earth's eras, historical events, and the lives that overlap them.",
    era: 'Era', interval: 'Interval', point: 'Point event', symbols: 'Timeline symbols',
    catalogue: 'WIKIDATA CATALOGUE', filters: 'Layers', filterHint: 'Choose what appears on the timeline.',
    clear: 'Clear', visibleRange: 'VISIBLE RANGE', reset: 'Reset view', retry: 'Retry',
    gestures: 'Wheel to zoom · Drag or Shift + wheel to pan', footer: 'A timeline built from linked open data.',
    demo: 'Demo catalogue', snapshot: 'Wikidata snapshot', sample: 'Partial snapshot', selected: 'Layers enabled',
    loading: 'Loading catalogue…', choose: 'Choose a layer to display entries.',
    empty: 'No matching entries in this range.', visible: 'Entries in range',
    partial: 'Some data could not be loaded.', unavailable: 'The catalogue could not be loaded.',
    expand: 'Expand', collapse: 'Collapse', bce: 'BCE', million: 'Ma', billion: 'Ga',
  },
  ru: {
    wordmark: 'АТЛАС ВРЕМЕНИ', language: 'Язык каталога', eyebrow: 'ИНТЕРАКТИВНАЯ ХРОНОЛОГИЯ',
    title: 'Атлас времени', intro: 'Геологические эпохи, исторические события и жизни людей на одной шкале.',
    era: 'Эпоха', interval: 'Интервал', point: 'Точечное событие', symbols: 'Обозначения на шкале',
    catalogue: 'КАТАЛОГ WIKIDATA', filters: 'Слои', filterHint: 'Выберите данные для отображения на шкале.',
    clear: 'Сбросить', visibleRange: 'ВИДИМЫЙ ПЕРИОД', reset: 'Сбросить вид', retry: 'Повторить',
    gestures: 'Колесо — зум · Перетаскивание или Shift + колесо — сдвиг', footer: 'Хронология на основе открытых связанных данных.',
    demo: 'Демокаталог', snapshot: 'Снимок Wikidata', sample: 'Часть снимка', selected: 'Включено слоёв',
    loading: 'Загрузка каталога…', choose: 'Выберите слой, чтобы увидеть записи.',
    empty: 'В выбранном диапазоне записей нет.', visible: 'Записей в диапазоне',
    partial: 'Часть данных не удалось загрузить.', unavailable: 'Каталог не удалось загрузить.',
    expand: 'Раскрыть', collapse: 'Свернуть', bce: 'до н. э.', million: 'млн лет назад', billion: 'млрд лет назад',
  },
};

const tree = document.getElementById('category-tree');
const rangeLabel = document.getElementById('range-label');
const status = document.getElementById('data-status');
const retry = document.getElementById('retry-load');
const select = document.getElementById('language');
const clear = document.getElementById('clear-filters');
const reset = document.getElementById('reset-range');
const explorer = document.getElementById('explorer');
const sidebar = document.getElementById('filters');
const toggle = document.getElementById('toggle-filters');
const selectedCount = document.getElementById('selected-count');
const datasetLabel = document.getElementById('dataset-label');

function currentYear() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  return year + (now - start) / (end - start);
}

const year = currentYear();
const initialRange = [year - 300, year];
const baseLanguage = 'en';
let language = baseLanguage;
let range = initialRange;
let manifest;
let manifestURL;
let epochs = [];
let ready = false;
let usingDemo = false;
let interacted = false;
let request = 0;
let timer;
let treeSequence = 0;

const categories = new Map();
const children = new Map();
const selectableTargets = new Map();
const categoryNodes = new Map();
const selected = new Set();
const expanded = new Set();
const chunks = new Map();

const timeline = new Timeline(document.getElementById('timeline'), {
  onRangeChange(nextRange) {
    range = nextRange;
    updateRangeLabel();
    if (ready) queueLoad(85);
  },
});

function uiLanguage() {
  return language === 'ru' ? 'ru' : 'en';
}

function strings() {
  return copy[uiLanguage()];
}

function number(value, options) {
  return value.toLocaleString(uiLanguage(), options);
}

function formatYear(value) {
  const elapsed = 1 - value;
  if (elapsed >= 1e9) return `${number(elapsed / 1e9, { maximumFractionDigits: 2 })} ${strings().billion}`;
  if (elapsed >= 1e6) return `${number(elapsed / 1e6, { maximumFractionDigits: 2 })} ${strings().million}`;
  const rounded = Math.floor(value);
  return rounded < 1 ? `${1 - rounded} ${strings().bce}` : String(rounded);
}

function updateRangeLabel() {
  const start = formatYear(range[0]);
  const end = formatYear(range[1]);
  rangeLabel.textContent = start === end ? start : `${start} — ${end}`;
}

function setStatus(message, error = false) {
  if (status.textContent !== message) status.textContent = message;
  status.toggleAttribute('data-error', error);
  retry.hidden = !error;
}

function showSidebar(visible) {
  sidebar.hidden = !visible;
  explorer.toggleAttribute('data-filters-collapsed', !visible);
  toggle.setAttribute('aria-expanded', String(visible));
}

toggle.addEventListener('click', () => showSidebar(sidebar.hidden));
showSidebar(!matchMedia('(max-width: 680px)').matches);

function overlaps(from, to, [min, max]) {
  return from <= max && to >= min;
}

function itemOverlaps(item, window) {
  return overlaps(item.start ?? item.end ?? item.point, item.end ?? item.start ?? item.point, window);
}

async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`${response.status} ${url}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function loadManifest() {
  manifestURL = new URL('./data/manifest.json', import.meta.url);
  try {
    manifest = await fetchJSON(manifestURL);
  } catch (error) {
    if (error.status !== 404) throw error;
    usingDemo = true;
    manifestURL = new URL('./demo/manifest.json', import.meta.url);
    manifest = await fetchJSON(manifestURL);
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.categories) || !Array.isArray(manifest.languages)) {
    throw new Error('Unsupported catalogue manifest');
  }
}

function loadChunk(path) {
  const url = new URL(path, manifestURL).href;
  let promise = chunks.get(url);
  if (promise) chunks.delete(url);
  else {
    promise = fetchJSON(url).then((entries) => {
      if (!Array.isArray(entries)) throw new Error(`Invalid catalogue chunk ${url}`);
      return entries;
    }).catch((error) => {
      if (chunks.get(url) === promise) chunks.delete(url);
      throw error;
    });
  }
  chunks.set(url, promise);
  if (chunks.size > 96) chunks.delete(chunks.keys().next().value);
  return promise;
}

async function itemsFor(active, window, locale) {
  const paths = new Set();
  for (const id of active) {
    for (const chunk of categories.get(id).chunks ?? []) {
      const available = chunk.language === baseLanguage || chunk.language === locale;
      if (available && overlaps(chunk.from, chunk.to, window)) paths.add(chunk.path);
    }
  }
  const results = await Promise.allSettled(Array.from(paths, loadChunk));
  const byId = new Map();
  let failed = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      failed = true;
      console.warn(result.reason);
      continue;
    }
    for (const entry of result.value) {
      const activeTag = entry.tags.find((tag) => active.has(tag));
      if (!activeTag || !itemOverlaps(entry, window)) continue;
      const previous = byId.get(entry.id);
      if (previous?.language === locale || (previous && entry.language !== locale)) continue;
      byId.set(entry.id, {
        ...entry,
        title: entry.titles?.[locale] || entry.title,
        color: categories.get(activeTag).color,
      });
    }
  }
  return { items: [...byId.values()], failed };
}

function queueLoad(delay = 0) {
  clearTimeout(timer);
  const id = ++request;
  if (!selected.size) {
    timeline.setItems([]);
    setStatus(strings().choose);
    return;
  }
  const active = new Set(selected);
  const window = range;
  const locale = language;
  setStatus(strings().loading);
  timer = setTimeout(async () => {
    try {
      const { items, failed } = await itemsFor(active, window, locale);
      if (id !== request) return;
      timeline.setItems(items);
      const message = items.length ? `${strings().visible} ${number(items.length)}` : strings().empty;
      setStatus(failed ? `${strings().partial}${items.length ? ` ${message}` : ''}` : message, failed);
    } catch (error) {
      if (id !== request) return;
      console.error(error);
      setStatus(strings().unavailable, true);
    }
  }, delay);
}

function categoryName(category) {
  return category.label[language] || category.label.en || category.id;
}

function collectTargets(id) {
  if (selectableTargets.has(id)) return selectableTargets.get(id);
  const targets = [];
  if (categories.get(id).chunks?.length) targets.push(id);
  for (const child of children.get(id) ?? []) {
    for (const target of collectTargets(child)) targets.push(target);
  }
  selectableTargets.set(id, targets);
  return targets;
}

function updateSelection() {
  for (const [id, { row, checkbox }] of categoryNodes) {
    const targets = collectTargets(id);
    const active = targets.filter((target) => selected.has(target)).length;
    checkbox.checked = active > 0 && active === targets.length;
    checkbox.indeterminate = active > 0 && active < targets.length;
    row.toggleAttribute('data-active', active > 0);
  }
  clear.disabled = selected.size === 0;
  const enabled = [...selected].filter((id) => {
    for (let parent = categories.get(id).parent; parent; parent = categories.get(parent)?.parent) {
      if (selected.has(parent)) return false;
    }
    return true;
  }).length;
  selectedCount.textContent = `${strings().selected} ${number(enabled)}`;
}

function appendCategory(container, id) {
  const category = categories.get(id);
  const name = categoryName(category);
  const branch = children.get(id) ?? [];
  const targets = collectTargets(id);
  const entry = document.createElement('li');
  const row = document.createElement('div');
  row.className = 'category-row';
  entry.append(row);

  if (branch.length) {
    const list = document.createElement('ul');
    list.id = `category-children-${++treeSequence}`;
    list.className = 'category-children';
    entry.append(list);
    const expander = document.createElement('button');
    expander.type = 'button';
    expander.className = 'category-expander';
    expander.setAttribute('aria-controls', list.id);
    expander.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
    row.append(expander);

    function showChildren(open) {
      list.hidden = !open;
      expander.setAttribute('aria-expanded', String(open));
      expander.setAttribute('aria-label', `${strings()[open ? 'collapse' : 'expand']} ${name}`);
      if (open && !list.hasChildNodes()) {
        for (const child of branch) appendCategory(list, child);
      }
    }

    expander.addEventListener('click', () => {
      const open = list.hidden;
      if (open) expanded.add(id);
      else expanded.delete(id);
      showChildren(open);
      updateSelection();
    });
    showChildren(expanded.has(id));
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'category-expander';
    spacer.setAttribute('aria-hidden', 'true');
    row.append(spacer);
  }

  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = !targets.length;
  checkbox.addEventListener('change', () => {
    interacted = true;
    for (const target of targets) {
      if (checkbox.checked) selected.add(target);
      else selected.delete(target);
    }
    updateSelection();
    queueLoad();
  });
  const swatch = document.createElement('span');
  swatch.className = 'category-swatch';
  swatch.setAttribute('aria-hidden', 'true');
  if (category.color) swatch.style.setProperty('--category-color', category.color);
  const title = document.createElement('span');
  title.className = 'category-name';
  title.textContent = name;
  label.append(checkbox, swatch, title);
  row.append(label);
  categoryNodes.set(id, { row, checkbox });
  container.append(entry);
}

function renderTree() {
  tree.replaceChildren();
  categoryNodes.clear();
  treeSequence = 0;
  for (const id of children.get(null) ?? []) appendCategory(tree, id);
  updateSelection();
}

function localEpochs() {
  return epochs.map((epoch) => ({
    ...epoch,
    end: epoch.end ?? year,
    title: epoch.titles[language] || epoch.titles.en || epoch.id,
    url: epoch.urls[language] || epoch.urls.en,
    language: epoch.urls[language] ? language : baseLanguage,
    region: typeof epoch.region === 'string' ? epoch.region : epoch.region?.[language] || epoch.region?.en,
    kind: 'epoch',
  }));
}

function updateLanguage() {
  document.documentElement.lang = uiLanguage();
  document.title = strings().title;
  for (const element of document.querySelectorAll('[data-copy]')) {
    element.textContent = strings()[element.dataset.copy];
  }
  document.getElementById('legend').setAttribute('aria-label', strings().symbols);
  const snapshotLabel = manifest.partial ? strings().sample : strings().snapshot;
  datasetLabel.textContent = usingDemo ? strings().demo : `${snapshotLabel}${manifest.snapshot ? ` ${manifest.snapshot}` : ''}`;
  datasetLabel.hidden = false;
  timeline.setLanguage(language);
  timeline.setEpochs(localEpochs());
  updateRangeLabel();
  renderTree();
}

select.addEventListener('change', () => {
  interacted = true;
  language = select.value;
  updateLanguage();
  queueLoad();
});

clear.addEventListener('click', () => {
  interacted = true;
  selected.clear();
  updateSelection();
  queueLoad();
});

reset.addEventListener('click', () => {
  timeline.reset(initialRange);
  range = timeline.getRange();
  updateRangeLabel();
  queueLoad();
});

retry.addEventListener('click', () => {
  if (ready) queueLoad();
  else window.location.reload();
});

async function chooseFeatured() {
  const candidates = [...categories.values()].filter((category) => category.featured &&
    category.chunks?.some((chunk) => chunk.language === baseLanguage && overlaps(chunk.from, chunk.to, initialRange)));
  while (candidates.length && !interacted) {
    const index = Math.floor(Math.random() * candidates.length);
    const [candidate] = candidates.splice(index, 1);
    const { items } = await itemsFor(new Set(collectTargets(candidate.id)), initialRange, baseLanguage);
    if (items.length) return candidate;
  }
  return null;
}

async function start() {
  try {
    await loadManifest();
    epochs = await fetchJSON(new URL(manifest.epochs, manifestURL));
    for (const category of manifest.categories) categories.set(category.id, category);
    for (const category of categories.values()) {
      const parent = categories.has(category.parent) ? category.parent : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(category.id);
    }
    select.replaceChildren(...manifest.languages.map(({ id, label }) => new Option(label, id)));
    select.value = baseLanguage;
    timeline.setRange(initialRange);
    range = timeline.getRange();
    updateLanguage();

    const featured = await chooseFeatured();
    if (featured && !interacted) {
      for (const target of collectTargets(featured.id)) selected.add(target);
      for (let parent = featured.parent; categories.has(parent); parent = categories.get(parent).parent) expanded.add(parent);
      renderTree();
    }
    ready = true;
    select.disabled = false;
    reset.disabled = false;
    queueLoad();
  } catch (error) {
    console.error(error);
    setStatus(strings().unavailable, true);
  }
}

start();
