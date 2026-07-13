// reader-engine.js — book-agnostic reader engine for the place-linked-book format.
// Loads a book from ./content/<book_id>/, renders chapters with clickable place
// links, and shows a synced Leaflet map with points and polygons.

(function () {
  'use strict';

  const PARAMS = new URLSearchParams(window.location.search);
  const BOOK_ID = PARAMS.get('book') || 'always_with_honor';
  const CONTENT_BASE = `./content/${BOOK_ID}`;

  const state = {
    book: null,
    gazetteer: null,
    polygons: {},        // place_id -> GeoJSON Feature
    currentChapter: null,
    map: null,
    layers: {
      points: null,
      polygons: null,
      labels: null,
      highlight: null,
      measure: null,
    },
    polygonLayers: {},   // place_id -> Leaflet layer
    activeLinks: [],
    measure: {
      active: false,
      points: [],
      line: null,
      markers: [],
      panel: null,
      toggle: null,
      total: null,
      last: null,
      hint: null,
    },
  };

  // ============ DATA LOADING ============

  async function loadJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    return r.json();
  }

  async function loadText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
    return r.text();
  }

  async function loadBook() {
    state.book = await loadJSON(`${CONTENT_BASE}/book.json`);
    state.gazetteer = await loadJSON(`${CONTENT_BASE}/gazetteer.json`);
    // Pre-load polygons referenced by gazetteer.
    // Build filename -> place_id map from the gazetteer itself (single source of truth)
    // rather than relying on a `properties.place_id` baked into the GeoJSON, which
    // QGIS-exported files don't carry.
    const fileToPlaceId = {};
    for (const [pid, place] of Object.entries(state.gazetteer.places)) {
      if (place.polygon_file) fileToPlaceId[place.polygon_file] = pid;
    }
    const polygonFiles = Object.keys(fileToPlaceId);
    await Promise.all(polygonFiles.map(async (fname) => {
      try {
        const geo = await loadJSON(`${CONTENT_BASE}/polygons/${fname}`);
        state.polygons[fileToPlaceId[fname]] = geo;
      } catch (e) {
        console.warn(`Polygon load failed: ${fname}`, e);
      }
    }));
  }

  async function loadChapter(chapterId) {
    const md = await loadText(`${CONTENT_BASE}/chapters/${chapterId}.md`);
    return md;
  }

  // ============ MARKDOWN RENDERING ============
  // Tiny renderer: handles front-matter, h1/h2/h3, paragraphs, italics, and [[id|text|ord]] links.

  function renderMarkdown(md) {
    // Strip YAML front-matter
    md = md.replace(/^---[\s\S]*?---\n/, '');
    const lines = md.split('\n');
    let html = '';
    let paraBuffer = [];
    const flushPara = () => {
      if (paraBuffer.length) {
        const joined = paraBuffer.join(' ').trim();
        if (joined) html += `<p>${processInline(joined)}</p>\n`;
        paraBuffer = [];
      }
    };
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.startsWith('# ')) {
        flushPara();
        html += `<h1>${escapeHTML(line.slice(2))}</h1>\n`;
      } else if (line.startsWith('## ')) {
        flushPara();
        html += `<h2>${escapeHTML(line.slice(3))}</h2>\n`;
      } else if (line.startsWith('### ')) {
        flushPara();
        html += `<h3>${escapeHTML(line.slice(4))}</h3>\n`;
      } else if (line.trim() === '') {
        flushPara();
      } else if (line.startsWith('*') && line.endsWith('*') && line.length > 2) {
        flushPara();
        html += `<p style="text-align:center;font-style:italic;">${processInline(line.slice(1, -1))}</p>\n`;
      } else {
        paraBuffer.push(line);
      }
    }
    flushPara();
    return html;
  }

  function escapeHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function chapterMatches(value) {
    return String(value ?? '').padStart(2, '0') === String(state.currentChapter ?? '').padStart(2, '0');
  }

  function firstMentionInCurrentChapter(place) {
    return (place.mentions || []).find((m) => chapterMatches(m.chapter));
  }

  function processInline(text) {
    // Place links: [[place_id|display|ordinal]]  (ordinal optional, defaults to 1)
    text = text.replace(/\[\[([^\]|]+)\|([^\]|]+)(?:\|(\d+))?\]\]/g, (_, id, display, ord) => {
      const ordinal = ord || '1';
      const place = state.gazetteer.places[id];
      if (!place) {
        console.warn(`Unknown place_id in text: ${id}`);
        return escapeHTML(display);
      }
      // Determine class from the specific mention
      const mention = (place.mentions || []).find(
        (m) => chapterMatches(m.chapter) && String(m.ordinal) === String(ordinal)
      );
      const mentionType = mention ? mention.mention_type || 'narrative' : 'narrative';
      const cls = mentionType === 'narrative' ? 'place' : `place ${mentionType}`;
      return `<a class="${cls}" data-place-id="${id}" data-mention-ord="${ordinal}">${escapeHTML(display)}</a>`;
    });
    return text;
  }

  // ============ MAP SETUP ============

  function initMap() {
    const view = state.book.initial_map_view || { center: [48, 30], zoom: 5 };
    state.map = L.map('map', {
      center: view.center,
      zoom: view.zoom,
      zoomControl: true,
      worldCopyJump: true,
    });

    // Voyager: Latin-labeled worldwide, good default for a readable book reader
    const voyager = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    });
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> | DEM: SRTM, Sonny | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    });
    const positron = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    });

    voyager.addTo(state.map);

    L.control.layers(
      { 'Voyager (recommended)': voyager, 'Topographic': topo, 'Light': positron },
      {},
      { position: 'topright', collapsed: true }
    ).addTo(state.map);

    state.layers.polygons = L.layerGroup().addTo(state.map);
    state.layers.points = L.layerGroup().addTo(state.map);
    state.layers.labels = L.layerGroup().addTo(state.map);
    state.layers.highlight = L.layerGroup().addTo(state.map);
    state.layers.measure = L.layerGroup().addTo(state.map);

    renderAllPlaces();
    initMeasurementControl();
  }

  // Returns the set of place_ids mentioned in the current chapter
  function placesInCurrentChapter() {
    const set = new Set();
    if (!state.currentChapter) return set;
    for (const [pid, place] of Object.entries(state.gazetteer.places)) {
      if ((place.mentions || []).some(m => chapterMatches(m.chapter))) {
        set.add(pid);
      }
    }
    return set;
  }

  // Determine effective color + opacity for a place, based on whether it's active in current chapter
  function styleFor(place, pid, activeSet) {
    const active = activeSet.has(pid);
    const mentions = place.mentions || [];
    const types = new Set(mentions.map(m => m.mention_type || 'narrative'));
    let color = '#8b3a2f', opacity = 0.65;
    if (!types.has('narrative')) {
      if (types.has('biographical')) { color = '#4a6b7c'; opacity = 0.4; }
      else if (types.has('reference')) { color = '#8a7a5c'; opacity = 0.4; }
    }
    if (!active) {
      color = '#9a948a';
      opacity = 0.35;
    }
    return { color, opacity, active };
  }

  function geometryType(geo) {
    let type = (geo.geometry && geo.geometry.type) || '';
    if (!type && geo.features && geo.features.length) {
      type = (geo.features[0].geometry && geo.features[0].geometry.type) || '';
    }
    return type;
  }

  function mapClickForPlace(pid, place, latlng) {
    if (state.measure.active) {
      addMeasurePoint(latlng);
      return;
    }
    const mention = firstMentionInCurrentChapter(place) || (place.mentions || [])[0];
    showPlace(pid, mention ? mention.ordinal : 1, { fromMap: true });
  }

  function renderAllPlaces() {
    state.layers.points.clearLayers();
    state.layers.polygons.clearLayers();
    state.layers.labels.clearLayers();
    state.polygonLayers = {};

    const activeSet = placesInCurrentChapter();

    for (const [pid, geo] of Object.entries(state.polygons)) {
      const place = state.gazetteer.places[pid];
      if (!place) continue;
      const s = styleFor(place, pid, activeSet);
      const geomType = geometryType(geo);
      const isLine = geomType === 'LineString' || geomType === 'MultiLineString';
      const style = isLine
        ? {
            color: '#2390ff',
            weight: s.active ? 4 : 3,
            opacity: s.active ? 1.0 : 0.7,
            fill: false,
          }
        : {
            color: s.color,
            weight: s.active ? 1.8 : 1,
            dashArray: '6, 4',
            fillColor: s.color,
            fillOpacity: s.active ? 0.09 : 0.04,
          };
      const layer = L.geoJSON(geo, {
        style,
        bubblingMouseEvents: false,
      }).bindTooltip(place.name_in_text[0], { sticky: true });
      layer.on('click', (e) => mapClickForPlace(pid, place, e.latlng));
      layer.addTo(state.layers.polygons);
      state.polygonLayers[pid] = layer;
    }

    for (const [pid, place] of Object.entries(state.gazetteer.places)) {
      const s = styleFor(place, pid, activeSet);
      const isAreaLike = place.feature_type === 'region' || place.feature_type === 'river_sector';
      const hasGeometry = Boolean(state.polygonLayers[pid]);

      if (!(isAreaLike && hasGeometry)) {
        const radius = isAreaLike ? 7 : (s.active ? 5 : 4);
        const marker = L.circleMarker([place.lat, place.lon], {
          radius,
          color: s.color,
          weight: 1,
          fillColor: s.color,
          fillOpacity: s.opacity,
          bubblingMouseEvents: false,
        }).bindTooltip(place.name_in_text[0], { direction: 'top' });
        marker.on('click', (e) => mapClickForPlace(pid, place, e.latlng));
        marker.addTo(state.layers.points);
      }

      // Geometry-backed rivers and regions need labels too; the anchor is a label/focus point,
      // not a substitute for their actual mapped geometry.
      if (s.active) {
        const labelIcon = L.divIcon({
          className: 'place-label',
          html: `<span>${escapeHTML(place.name_in_text[0])}</span>`,
          iconSize: [null, null],
          iconAnchor: [0, -6],
        });
        const labelLat = place.label_lat ?? place.lat;
        const labelLon = place.label_lon ?? place.lon;
        L.marker([labelLat, labelLon], { icon: labelIcon, interactive: false }).addTo(state.layers.labels);
      }
    }
  }

  // ============ DISTANCE MEASUREMENT ============

  function formatDistance(metres) {
    if (!Number.isFinite(metres) || metres <= 0) return '0 m / 0 mi';
    const metric = metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`;
    const miles = metres / 1609.344;
    return `${metric} / ${miles.toFixed(miles < 10 ? 2 : 1)} mi`;
  }

  function measuredTotal() {
    let metres = 0;
    for (let i = 1; i < state.measure.points.length; i += 1) {
      metres += state.map.distance(state.measure.points[i - 1], state.measure.points[i]);
    }
    return metres;
  }

  function updateMeasureGeometry() {
    if (state.measure.line) state.layers.measure.removeLayer(state.measure.line);
    state.measure.markers.forEach((marker) => state.layers.measure.removeLayer(marker));
    state.measure.line = null;
    state.measure.markers = [];

    if (state.measure.points.length >= 2) {
      state.measure.line = L.polyline(state.measure.points, {
        color: '#24211d',
        weight: 3,
        opacity: 0.9,
        dashArray: '7, 5',
        interactive: false,
      }).addTo(state.layers.measure);
    }
    state.measure.points.forEach((point, index) => {
      const marker = L.circleMarker(point, {
        radius: index === state.measure.points.length - 1 ? 5 : 4,
        color: '#24211d',
        weight: 2,
        fillColor: '#faf7f2',
        fillOpacity: 1,
        interactive: false,
      }).addTo(state.layers.measure);
      state.measure.markers.push(marker);
    });

    const total = measuredTotal();
    let last = 0;
    if (state.measure.points.length >= 2) {
      const n = state.measure.points.length;
      last = state.map.distance(state.measure.points[n - 2], state.measure.points[n - 1]);
    }
    if (state.measure.total) state.measure.total.textContent = formatDistance(total);
    if (state.measure.last) state.measure.last.textContent = formatDistance(last);
    if (state.measure.hint) {
      state.measure.hint.textContent = state.measure.points.length
        ? `${state.measure.points.length} point${state.measure.points.length === 1 ? '' : 's'} · click map to continue`
        : 'Click the map to place the first point';
    }
  }

  function addMeasurePoint(latlng) {
    state.measure.points.push(L.latLng(latlng.lat, latlng.lng));
    updateMeasureGeometry();
  }

  function setMeasuring(active) {
    state.measure.active = active;
    state.map.getContainer().classList.toggle('is-measuring', active);
    if (state.measure.toggle) {
      state.measure.toggle.classList.toggle('active', active);
      state.measure.toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
      state.measure.toggle.title = active ? 'Finish measuring' : 'Measure distance';
    }
    if (state.measure.panel) state.measure.panel.hidden = false;
    if (state.measure.hint && !active && state.measure.points.length) {
      state.measure.hint.textContent = 'Measurement finished · choose Resume to add segments';
    }
    const resume = state.measure.panel && state.measure.panel.querySelector('[data-action="resume"]');
    if (resume) resume.textContent = active ? 'Done' : 'Resume';
  }

  function undoMeasurePoint() {
    state.measure.points.pop();
    updateMeasureGeometry();
  }

  function clearMeasurement() {
    state.measure.points = [];
    if (state.measure.line) state.layers.measure.removeLayer(state.measure.line);
    state.measure.markers.forEach((marker) => state.layers.measure.removeLayer(marker));
    state.measure.line = null;
    state.measure.markers = [];
    updateMeasureGeometry();
  }

  function closeMeasurement() {
    setMeasuring(false);
    if (state.measure.panel) state.measure.panel.hidden = true;
  }

  function initMeasurementControl() {
    const MeasureControl = L.Control.extend({
      options: { position: 'topleft' },
      onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-control measure-control');
        const toggle = L.DomUtil.create('button', 'measure-toggle', wrap);
        toggle.type = 'button';
        toggle.title = 'Measure distance';
        toggle.setAttribute('aria-label', 'Measure distance');
        toggle.setAttribute('aria-pressed', 'false');
        toggle.innerHTML = '<span aria-hidden="true">↔</span><span>Measure</span>';

        const panel = L.DomUtil.create('div', 'measure-panel', wrap);
        panel.hidden = true;
        panel.innerHTML = `
          <div class="measure-title">Distance measurement</div>
          <div class="measure-readout"><span>Total</span><strong data-readout="total">0 m / 0 mi</strong></div>
          <div class="measure-readout"><span>Last segment</span><strong data-readout="last">0 m / 0 mi</strong></div>
          <div class="measure-hint">Click the map to place the first point</div>
          <div class="measure-actions">
            <button type="button" data-action="undo">Undo point</button>
            <button type="button" data-action="resume">Done</button>
            <button type="button" data-action="clear">Clear</button>
            <button type="button" data-action="close" aria-label="Close measurement panel">Close</button>
          </div>`;

        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);
        state.measure.panel = panel;
        state.measure.toggle = toggle;
        state.measure.total = panel.querySelector('[data-readout="total"]');
        state.measure.last = panel.querySelector('[data-readout="last"]');
        state.measure.hint = panel.querySelector('.measure-hint');

        toggle.addEventListener('click', () => {
          if (panel.hidden) panel.hidden = false;
          setMeasuring(!state.measure.active);
        });
        panel.querySelector('[data-action="undo"]').addEventListener('click', undoMeasurePoint);
        panel.querySelector('[data-action="resume"]').addEventListener('click', () => setMeasuring(!state.measure.active));
        panel.querySelector('[data-action="clear"]').addEventListener('click', clearMeasurement);
        panel.querySelector('[data-action="close"]').addEventListener('click', closeMeasurement);
        return wrap;
      },
    });

    new MeasureControl().addTo(state.map);
    state.map.on('click', (e) => {
      if (state.measure.active) addMeasurePoint(e.latlng);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.measure.active) setMeasuring(false);
    });
  }

  // ============ CHAPTER NAVIGATION ============

  function buildChapterNav() {
    const sel = document.getElementById('chapter-select');
    sel.innerHTML = '';
    state.book.chapters.forEach((ch) => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `Ch. ${ch.number} — ${ch.title}`;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => loadAndRenderChapter(sel.value));
    document.getElementById('prev-chapter').addEventListener('click', () => {
      const idx = state.book.chapters.findIndex((c) => c.id === state.currentChapter);
      if (idx > 0) loadAndRenderChapter(state.book.chapters[idx - 1].id);
    });
    document.getElementById('next-chapter').addEventListener('click', () => {
      const idx = state.book.chapters.findIndex((c) => c.id === state.currentChapter);
      if (idx >= 0 && idx < state.book.chapters.length - 1) {
        loadAndRenderChapter(state.book.chapters[idx + 1].id);
      }
    });
  }

  function updateNavButtons() {
    const idx = state.book.chapters.findIndex((c) => c.id === state.currentChapter);
    document.getElementById('prev-chapter').disabled = idx <= 0;
    document.getElementById('next-chapter').disabled = idx >= state.book.chapters.length - 1;
    document.getElementById('chapter-select').value = state.currentChapter;
  }

  async function loadAndRenderChapter(chapterId) {
    state.currentChapter = chapterId;
    let md;
    try {
      md = await loadChapter(chapterId);
    } catch (e) {
      document.getElementById('reader-body').innerHTML =
        `<p style="color:var(--muted);font-style:italic;">Chapter ${chapterId} is not yet available in this build. Check back as content is added.</p>`;
      updateNavButtons();
      return;
    }
    const html = renderMarkdown(md);
    document.getElementById('reader-body').innerHTML = html;
    addParagraphNumbers();
    updateNavButtons();
    document.querySelector('.reader').scrollTop = 0;
    resetInfoBox();
    if (state.map) renderAllPlaces();
  }

  function addParagraphNumbers() {
    const body = document.getElementById('reader-body');
    const paras = body.querySelectorAll('p');
    let n = 0;
    paras.forEach(p => {
      // Skip centered/italic paragraphs (typically epigraphs or footnote-ish)
      if (p.style && p.style.textAlign === 'center') return;
      n += 1;
      const tag = document.createElement('span');
      tag.className = 'para-num';
      tag.textContent = `¶${n}`;
      p.insertBefore(tag, p.firstChild);
    });
  }

  // ============ INTERACTION ============

  function showPlace(placeId, ordinal, opts = {}) {
    const place = state.gazetteer.places[placeId];
    if (!place) return;

    // Reset prior active state
    state.activeLinks.forEach((el) => el.classList.remove('active'));
    state.activeLinks = Array.from(
      document.querySelectorAll(`a.place[data-place-id="${placeId}"][data-mention-ord="${ordinal}"]`)
    );
    state.activeLinks.forEach((el) => el.classList.add('active'));

    // Highlight the real feature geometry when available. The gazetteer lat/lon remains
    // a focus and label anchor, not a claim that a river or region is a point.
    state.layers.highlight.clearLayers();
    const geo = state.polygons[placeId];
    const geomType = geo ? geometryType(geo) : '';
    const isLine = geomType === 'LineString' || geomType === 'MultiLineString';
    if (geo) {
      L.geoJSON(geo, {
        style: isLine
          ? { color: '#8b3a2f', weight: 6, opacity: 0.9, fill: false }
          : { color: '#8b3a2f', weight: 2.5, fillColor: '#8b3a2f', fillOpacity: 0.10 },
        interactive: false,
      }).addTo(state.layers.highlight);
      if (isLine) {
        state.map.flyTo([place.lat, place.lon], 7, { duration: 0.7 });
      } else {
        const bounds = state.polygonLayers[placeId] && state.polygonLayers[placeId].getBounds();
        if (bounds && bounds.isValid()) state.map.flyToBounds(bounds, { padding: [30, 30], maxZoom: 7, duration: 0.7 });
      }
    } else {
      const targetZoom = place.feature_type === 'region' ? 6 : 9;
      state.map.flyTo([place.lat, place.lon], targetZoom, { duration: 0.7 });
      L.circleMarker([place.lat, place.lon], {
        radius: 14,
        color: '#8b3a2f',
        weight: 2.5,
        fillOpacity: 0,
      }).addTo(state.layers.highlight);
    }

    // Info box
    const mention = (place.mentions || []).find(
      (m) => chapterMatches(m.chapter) && String(m.ordinal) === String(ordinal)
    );
    renderInfoBox(place, mention);

    // Scroll text link into view if click came from map
    if (opts.fromMap && state.activeLinks.length) {
      state.activeLinks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function renderInfoBox(place, mention) {
    const box = document.getElementById('info-box');
    box.classList.remove('empty');
    const featureLabel = (place.feature_type || '').replace(/_/g, ' ');
    const country = place.country_modern ? ` · ${place.country_modern}` : '';
    let mentionHTML = '';
    if (mention) {
      const meta = `Chapter ${parseInt(mention.chapter, 10)} · mention ${mention.ordinal} · ${mention.mention_type || 'narrative'}`;
      mentionHTML = `
        <div class="mention-meta">${meta}</div>
        <div class="mention-context">${escapeHTML(mention.context || '')}</div>
      `;
    }
    const sourceForms = (place.name_in_text || []).join(' · ');
    const confidence = (place.confidence || 'unspecified').replace(/_/g, ' ');
    const coordinates = `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
    box.innerHTML = `
      <h4 class="place-name">${escapeHTML(place.name_in_text[0])}<span class="feature-tag">${escapeHTML(featureLabel)}</span></h4>
      <div class="modern-name">${escapeHTML(place.modern_name || '')}${escapeHTML(country)}</div>
      <div class="place-audit-meta"><span>Text forms: ${escapeHTML(sourceForms)}</span><span>Confidence: ${escapeHTML(confidence)}</span><span>Anchor: ${escapeHTML(coordinates)}</span></div>
      <p class="historical-note">${escapeHTML(place.historical_note || '')}</p>
      ${mentionHTML}
    `;
  }

  function resetInfoBox() {
    const box = document.getElementById('info-box');
    box.classList.add('empty');
    box.innerHTML = `<p>Click a highlighted place name in the text to locate it on the map. Solid red links are narrative action; blue dashed links are biographical references; tan dashed links are passing mentions.</p>`;
    state.layers.highlight && state.layers.highlight.clearLayers();
  }

  function attachReaderClicks() {
    document.getElementById('reader-body').addEventListener('click', (e) => {
      const link = e.target.closest('a.place');
      if (!link) return;
      e.preventDefault();
      const pid = link.dataset.placeId;
      const ord = link.dataset.mentionOrd || '1';
      showPlace(pid, ord);
    });
  }

  // ============ INIT ============

  async function init() {
    try {
      await loadBook();
    } catch (e) {
      document.body.innerHTML = `<div style="padding:2rem;font-family:Georgia,serif;">
        <h2>Could not load book</h2>
        <p style="color:#8b3a2f;">${e.message}</p>
        <p>This reader needs to be served over HTTP (not opened as a local file) so it can fetch the book content. Try running <code>python3 -m http.server</code> in this folder and visiting <code>http://localhost:8000</code>.</p>
      </div>`;
      return;
    }

    // Header
    document.getElementById('book-title').textContent = state.book.title;
    document.getElementById('book-author').textContent = state.book.author;
    document.title = `${state.book.title} — Reader's Atlas`;

    buildChapterNav();
    initMap();
    attachReaderClicks();
    resetInfoBox();

    // Load first available chapter
    const startChapter = PARAMS.get('chapter') || state.book.chapters[0].id;
    await loadAndRenderChapter(startChapter);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
