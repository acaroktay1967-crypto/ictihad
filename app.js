// ============================================
// İÇTİHAT ARAMA - Modern UI
// ============================================

const CONFIG = {
  dataset: "Alptekinege/turkish-court-decisions",
  apiBase: "https://datasets-server.huggingface.co",
  configs: {
    yargitay: { name: "Yargıtay", start: 9500000, end: 9820000 },
    danistay: { name: "Danıştay", start: 0, end: 386608 },
  },
  yearMin: 2025,
  yearMax: 2026,
  defaultPageSize: 10,
  batchSize: 100,
  localBatches: 20,
  globalBatches: 50,
  retryCount: 3,
};

let settings = {
  pageSize: 10,
  searchMode: "local",
  courtFilter: "yargitay",
};

let localCache = null;
let cacheLoading = false;

// ============================================
// HELPERS
// ============================================

const fmt = n => new Intl.NumberFormat("tr-TR").format(n || 0);

function fold(text) {
  return String(text || "")
    .replaceAll("İ", "i").replaceAll("I", "ı")
    .toLocaleLowerCase("tr")
    .replaceAll("ç", "c").replaceAll("ğ", "g").replaceAll("ı", "i")
    .replaceAll("ö", "o").replaceAll("ş", "s").replaceAll("ü", "u");
}

function normalizeQuotes(s) {
  return (s || "").replace(/[""„‟«»]/g, '"').replace(/[''‚‛]/g, "'");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============================================
// API
// ============================================

async function apiRequest(config, offset, length) {
  const url = `${CONFIG.apiBase}/rows?` + new URLSearchParams({
    dataset: CONFIG.dataset, config, split: "train",
    offset: String(offset), length: String(length),
  });

  for (let i = 1; i <= CONFIG.retryCount; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json.rows || [];
    } catch (e) {
      if (i >= CONFIG.retryCount) return [];
      await new Promise(r => setTimeout(r, 1000 * i));
    }
  }
  return [];
}

// ============================================
// CACHE
// ============================================

async function loadCache(progressCb) {
  if (localCache) return localCache;
  if (cacheLoading) {
    while (cacheLoading) await new Promise(r => setTimeout(r, 100));
    return localCache;
  }
  cacheLoading = true;

  const rows = [];
  const cfg = CONFIG.configs.yargitay;
  const range = cfg.end - cfg.start;
  const step = Math.floor(range / CONFIG.localBatches);

  for (let i = 0; i < CONFIG.localBatches; i++) {
    if (progressCb) progressCb(Math.round((i / CONFIG.localBatches) * 100));
    const data = await apiRequest("yargitay", cfg.start + i * step, CONFIG.batchSize);
    for (const item of data) {
      const r = item.row || {};
      if (Number(r.year) >= CONFIG.yearMin && Number(r.year) <= CONFIG.yearMax) {
        rows.push({ idx: item.row_idx, ...r, _folded: fold(r.text || "") });
      }
    }
  }

  localCache = rows;
  cacheLoading = false;
  return rows;
}

// ============================================
// SEARCH
// ============================================

function textMatches(haystack, query) {
  if (!query || query.length < 2) return true;
  const normalized = normalizeQuotes(query);
  const phrases = [];
  const rest = normalized.replace(/"([^"]+)"/g, (_, p) => { phrases.push(fold(p.trim())); return " "; });
  for (const p of phrases) if (!haystack.includes(p)) return false;
  for (const w of rest.split(/\s+/).filter(x => x.length >= 2)) if (!haystack.includes(fold(w))) return false;
  return true;
}

const CEZA = ["tck","ceza","suç","sanık","hırsızlık","kasten","uyuşturucu","silah","gasp","terör","5237","5271","7258","olası kast"];
const HUKUK = ["tazminat","alacak","sözleşme","kira","boşanma","nafaka","miras","tapu","icra","iflas","6098","4721"];

function detectCourt(q) {
  const f = fold(normalizeQuotes(q));
  let c = 0, h = 0;
  for (const k of CEZA) if (f.includes(fold(k))) c++;
  for (const k of HUKUK) if (f.includes(fold(k))) h++;
  return c > h ? "ceza" : h > c ? "hukuk" : null;
}

async function searchLocal(query, progressCb) {
  const data = await loadCache(progressCb);
  const courtType = detectCourt(query);
  const hits = [];

  for (const row of data) {
    if (!textMatches(row._folded, query)) continue;
    if (courtType) {
      const c = (row.court || "").toLowerCase();
      if (courtType === "ceza" && !c.includes("ceza")) continue;
      if (courtType === "hukuk" && c.includes("ceza")) continue;
    }
    hits.push(formatHit(row, query));
    if (hits.length >= settings.pageSize * 2) break;
  }

  return { hits: hits.slice(0, settings.pageSize), total: hits.length, mode: "local", cacheSize: data.length, courtType };
}

async function searchGlobal(query, progressCb) {
  const courtType = detectCourt(query);
  const cfg = CONFIG.configs.yargitay;
  const range = cfg.end - cfg.start;
  const step = Math.floor(range / CONFIG.globalBatches);
  const hits = [];
  let scanned = 0;

  for (let i = 0; i < CONFIG.globalBatches && hits.length < settings.pageSize; i++) {
    if (progressCb) progressCb(Math.round((i / CONFIG.globalBatches) * 100));
    const data = await apiRequest("yargitay", cfg.start + i * step, CONFIG.batchSize);
    scanned += data.length;
    for (const item of data) {
      const r = item.row || {};
      if (Number(r.year) < CONFIG.yearMin || Number(r.year) > CONFIG.yearMax) continue;
      if (!textMatches(fold(r.text || ""), query)) continue;
      if (courtType) {
        const c = (r.court || "").toLowerCase();
        if (courtType === "ceza" && !c.includes("ceza")) continue;
        if (courtType === "hukuk" && c.includes("ceza")) continue;
      }
      hits.push(formatHit({ idx: item.row_idx, ...r }, query));
      if (hits.length >= settings.pageSize * 2) break;
    }
  }

  return { hits: hits.slice(0, settings.pageSize), total: hits.length, mode: "global", scanned, courtType };
}

async function search(query, progressCb) {
  return settings.searchMode === "global" ? searchGlobal(query, progressCb) : searchLocal(query, progressCb);
}

// ============================================
// FORMAT
// ============================================

function formatHit(row, query) {
  return {
    id: row.idx + ":" + row.id,
    court: row.court,
    esas_no: row.esas_no,
    karar_no: row.karar_no,
    karar_tarihi: row.karar_tarihi,
    year: row.year,
    text: row.text,
    citation: formatCitation(row),
    snippet: createSnippet(row.text, query),
  };
}

function formatCitation(row) {
  const p = ["Yargıtay"];
  if (row.court) p.push(row.court);
  if (row.esas_no) p.push("E. " + row.esas_no);
  if (row.karar_no) p.push("K. " + row.karar_no);
  const t = row.karar_tarihi || "";
  const [y, m, d] = (t + "--").split("-");
  if (y && m && d) p.push(`${d}.${m}.${y}`);
  return p.join(", ");
}

function createSnippet(text, query) {
  const hay = (text || "").slice(0, 3000);
  const norm = normalizeQuotes(query || "");
  const phrases = [];
  const rest = norm.replace(/"([^"]+)"/g, (_, p) => { phrases.push(p.trim()); return ""; });
  const terms = [...phrases, ...rest.split(/\s+/).filter(w => w.length > 2)];
  if (!terms.length) return escapeHtml(hay.slice(0, 250));

  let idx = -1;
  for (const t of terms) {
    const i = fold(hay).indexOf(fold(t));
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }

  const start = idx < 0 ? 0 : Math.max(0, idx - 40);
  let out = escapeHtml(hay.slice(start, start + 250));
  for (const t of terms) {
    if (t.length < 2) continue;
    const re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }
  return (start ? "…" : "") + out + (hay.length > start + 250 ? "…" : "");
}

async function getDecision(id) {
  const idx = parseInt(String(id).split(":")[0], 10);
  if (isNaN(idx)) throw new Error("Geçersiz ID");
  const rows = await apiRequest("yargitay", idx, 1);
  if (!rows.length) throw new Error("Karar bulunamadı");
  const r = rows[0].row || {};
  return { id, court: r.court, esas_no: r.esas_no, karar_no: r.karar_no, karar_tarihi: r.karar_tarihi, year: r.year, text: r.text, citation: formatCitation(r) };
}

// ============================================
// ROUTING
// ============================================

function route() {
  const raw = (location.hash || "#/").replace(/^#/, "") || "/";
  const [path, search] = raw.split("?");
  const u = new URLSearchParams(search || "");
  return { path: path || "/", q: u.get("q") || "" };
}

function go(path) {
  location.hash = path.startsWith("#") ? path.slice(1) : path;
}

// ============================================
// VIEWS
// ============================================

function headerView() {
  const modeClass = settings.searchMode === "local" ? "local" : "corpus";
  const modeText = settings.searchMode === "local" ? "📱 Yerel" : "🌐 Corpus";
  return `
    <header class="header">
      <div class="header-left">
        <div class="logo">⚖️</div>
        <span class="header-title">İçtihat Arama</span>
      </div>
      <div class="header-right">
        <button class="mode-btn ${modeClass}" id="toggle-mode">${modeText}</button>
        <button class="theme-btn">☀️</button>
      </div>
    </header>
  `;
}

function searchBoxView(query = "") {
  return `
    <div class="search-container">
      <form class="search-box" id="search-form">
        <span class="icon">🔍</span>
        <input type="search" name="q" value="${escapeHtml(query)}" placeholder="Karar ara... (örn: TCK 102, 2023/1234)">
        <button type="submit">Ara</button>
      </form>
    </div>
  `;
}

function filtersView() {
  return `
    <div class="filters-bar">
      <button class="filter-btn active" data-filter="all">Tümü</button>
      <button class="filter-btn" data-filter="yargitay">Yargıtay</button>
      <button class="filter-btn" data-filter="danistay">Danıştay</button>
      <button class="filter-btn" data-filter="aym">AYM Norm</button>
    </div>
  `;
}

function infoBarView(results = null) {
  const left = results ? `${results.total} sonuç` : "0 sonuç";
  const right = settings.searchMode === "local" 
    ? `Veritabanı: ${fmt(localCache?.length || 0)} karar` 
    : `Corpus: 11M+ karar`;
  return `<div class="info-bar"><span>${left}</span><span>${right}</span></div>`;
}

function settingsView() {
  return `
    <div class="settings-panel">
      <div class="settings-row">
        <label>
          Sonuç sayısı:
          <select id="page-size">
            <option value="10" ${settings.pageSize === 10 ? "selected" : ""}>10</option>
            <option value="25" ${settings.pageSize === 25 ? "selected" : ""}>25</option>
            <option value="50" ${settings.pageSize === 50 ? "selected" : ""}>50</option>
          </select>
        </label>
      </div>
    </div>
  `;
}

function localBannerView() {
  if (settings.searchMode !== "local") return "";
  return `<div class="local-banner">📱 Yerel mod: İndirilen kararlarda arama</div>`;
}

function tabBarView(active = "search") {
  return `
    <nav class="tab-bar">
      <button class="tab-item ${active === "search" ? "active" : ""}" data-tab="search">
        <span class="icon">🔍</span>
        Arama
      </button>
      <button class="tab-item ${active === "favorites" ? "active" : ""}" data-tab="favorites">
        <span class="icon">🔖</span>
        Favoriler
      </button>
      <button class="tab-item ${active === "history" ? "active" : ""}" data-tab="history">
        <span class="icon">🕐</span>
        Geçmiş
      </button>
      <button class="tab-item ${active === "about" ? "active" : ""}" data-tab="about">
        <span class="icon">ℹ️</span>
        Hakkında
      </button>
    </nav>
  `;
}

function emptyStateView() {
  return `
    <div class="empty-state">
      <div class="icon">🔍</div>
      <h2>Aramaya Başlayın</h2>
      <p>11 milyon+ kararda doğrudan arama yapın.<br>Kelime veya karar numarası girin.</p>
    </div>
  `;
}

function loadingView(query, progress = null) {
  const pct = progress !== null ? progress : 0;
  return `
    <div class="loading">
      <h2>${localCache ? "Aranıyor..." : "Veritabanı Hazırlanıyor"}</h2>
      <p>${escapeHtml(query)}</p>
      <div class="progress-bar"><div class="fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

function resultsView(query, results) {
  const { hits, total, mode, cacheSize, scanned, courtType } = results;
  const courtLabel = courtType === "ceza" ? "Ceza" : courtType === "hukuk" ? "Hukuk" : "Tümü";
  const modeInfo = mode === "local" ? `${fmt(cacheSize)} kayıt` : `${fmt(scanned)} tarandı`;

  const hitsHtml = hits.map(h => `
    <article class="hit">
      <div class="hit-badges">
        <span class="badge">Yargıtay</span>
        <span class="badge court">${escapeHtml(h.court || "")}</span>
        <span class="badge">${h.year}</span>
      </div>
      <a class="hit-title" href="#/karar/${encodeURIComponent(h.id)}?q=${encodeURIComponent(query)}" data-link>${escapeHtml(h.citation)}</a>
      <p class="hit-snippet">${h.snippet}</p>
    </article>
  `).join("");

  return `
    <div class="results-header">
      <h1>${escapeHtml(query)}</h1>
      <div class="meta">${total} sonuç · ${courtLabel} daireleri · ${modeInfo}</div>
    </div>
    ${hits.length ? hitsHtml : `<div class="empty-state"><h2>Sonuç bulunamadı</h2><p>${mode === "local" ? "Corpus modunu deneyin" : "Farklı kelimeler deneyin"}</p></div>`}
  `;
}

function decisionView(decision, query) {
  let body = escapeHtml(decision.text || "");
  for (const t of (query || "").split(/\s+/).filter(x => x.length > 2)) {
    const re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    body = body.replace(re, "<mark>$1</mark>");
  }

  return `
    <div class="decision-header">
      <div class="kicker">Yargıtay</div>
      <h1>${escapeHtml(decision.citation)}</h1>
      <div class="cite">${[decision.court, decision.esas_no && "E. " + decision.esas_no, decision.karar_no && "K. " + decision.karar_no].filter(Boolean).join(" · ")}</div>
      <button class="back-btn" id="back-btn">← Aramaya dön</button>
    </div>
    <div class="decision-body">${body}</div>
  `;
}

// ============================================
// RENDER
// ============================================

const $app = document.getElementById("app");
let currentRender = 0;

async function render() {
  const version = ++currentRender;
  const r = route();

  // Karar görüntüleme
  if (r.path.startsWith("/karar/")) {
    $app.innerHTML = headerView() + loadingView("Karar yükleniyor...") + tabBarView();
    const decision = await getDecision(decodeURIComponent(r.path.slice(7)));
    if (version !== currentRender) return;
    $app.innerHTML = headerView() + decisionView(decision, r.q) + tabBarView();
    bindEvents();
    return;
  }

  // Arama sonuçları
  if (r.path.startsWith("/ara") && r.q) {
    $app.innerHTML = headerView() + searchBoxView(r.q) + filtersView() + infoBarView() + settingsView() + localBannerView() + loadingView(r.q) + tabBarView("search");
    bindEvents();
    
    const results = await search(r.q, p => {
      if (version === currentRender) {
        document.querySelector(".loading")?.remove();
        const loading = document.createElement("div");
        loading.innerHTML = loadingView(r.q, p);
        document.querySelector(".settings-panel")?.after(loading.firstElementChild);
      }
    });
    if (version !== currentRender) return;

    $app.innerHTML = headerView() + searchBoxView(r.q) + filtersView() + infoBarView(results) + settingsView() + localBannerView() + resultsView(r.q, results) + tabBarView("search");
    bindEvents();
    return;
  }

  // Ana sayfa
  $app.innerHTML = headerView() + searchBoxView() + filtersView() + infoBarView() + settingsView() + localBannerView() + emptyStateView() + tabBarView("search");
  bindEvents();
}

function bindEvents() {
  document.getElementById("search-form")?.addEventListener("submit", e => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) go(`/ara?q=${encodeURIComponent(q)}`);
  });

  document.getElementById("toggle-mode")?.addEventListener("click", () => {
    settings.searchMode = settings.searchMode === "local" ? "global" : "local";
    render();
  });

  document.getElementById("page-size")?.addEventListener("change", e => {
    settings.pageSize = parseInt(e.target.value, 10);
  });

  document.getElementById("back-btn")?.addEventListener("click", () => history.back());

  document.querySelectorAll("[data-link]").forEach(a => {
    a.addEventListener("click", e => { e.preventDefault(); go(a.getAttribute("href")); });
  });

  document.querySelectorAll(".tab-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab === "search") go("/");
    });
  });
}

// ============================================
// INIT
// ============================================

window.addEventListener("hashchange", render);
render();
