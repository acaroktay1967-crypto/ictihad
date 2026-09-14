// ============================================
// İÇTİHAT - Yargıtay Karar Arama
// Lokal + Global Arama Destekli
// ============================================

const CONFIG = {
  dataset: "Alptekinege/turkish-court-decisions",
  apiBase: "https://datasets-server.huggingface.co",
  config: "yargitay",
  split: "train",
  startOffset: 9500000,
  endOffset: 9820000,
  yearMin: 2025,
  yearMax: 2026,
  defaultPageSize: 10,
  batchSize: 100,
  localBatches: 20,    // Lokal önbellek için
  globalBatches: 50,   // Global arama için
  retryCount: 3,
  retryDelay: 1000,
};

const $app = document.getElementById("app");

// Kullanıcı ayarları
let settings = {
  pageSize: CONFIG.defaultPageSize,
  searchMode: "local", // "local" veya "global"
};

// ============================================
// VERİ ÖNBELLEĞİ (LOKAL ARAMA İÇİN)
// ============================================

let localCache = null;
let cacheLoading = false;

async function loadLocalCache(progressCallback) {
  if (localCache) return localCache;
  if (cacheLoading) {
    while (cacheLoading) await new Promise(r => setTimeout(r, 100));
    return localCache;
  }

  cacheLoading = true;
  
  try {
    const allRows = [];
    const range = CONFIG.endOffset - CONFIG.startOffset;
    const step = Math.floor(range / CONFIG.localBatches);

    for (let i = 0; i < CONFIG.localBatches; i++) {
      const offset = CONFIG.startOffset + (i * step);
      if (progressCallback) progressCallback(Math.round((i / CONFIG.localBatches) * 100));
      
      const rows = await apiRequest(offset, CONFIG.batchSize);
      for (const item of rows) {
        const row = item.row || {};
        const year = Number(row.year);
        if (year >= CONFIG.yearMin && year <= CONFIG.yearMax) {
          allRows.push({
            idx: item.row_idx,
            ...row,
            textFolded: fold(row.text || ""),
          });
        }
      }
    }

    localCache = allRows;
    cacheLoading = false;
    console.log(`Lokal önbellek: ${allRows.length} karar yüklendi`);
    return allRows;
  } catch (err) {
    cacheLoading = false;
    throw err;
  }
}

// ============================================
// YARDIMCI FONKSİYONLAR
// ============================================

function fmt(n) {
  return new Intl.NumberFormat("tr-TR").format(n || 0);
}

function fold(text) {
  return String(text || "")
    .replaceAll("İ", "i")
    .replaceAll("I", "ı")
    .toLocaleLowerCase("tr")
    .replaceAll("ç", "c")
    .replaceAll("ğ", "g")
    .replaceAll("ı", "i")
    .replaceAll("ö", "o")
    .replaceAll("ş", "s")
    .replaceAll("ü", "u");
}

function normalizeQuotes(str) {
  return (str || "").replace(/[""„‟«»]/g, '"').replace(/[''‚‛]/g, "'");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

// ============================================
// API İSTEK FONKSİYONU
// ============================================

async function apiRequest(offset, length) {
  const url = `${CONFIG.apiBase}/rows?` + new URLSearchParams({
    dataset: CONFIG.dataset,
    config: CONFIG.config,
    split: CONFIG.split,
    offset: String(offset),
    length: String(length),
  });

  for (let attempt = 1; attempt <= CONFIG.retryCount; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      
      const res = await fetch(url, { 
        signal: controller.signal,
        headers: { "User-Agent": "Ictihad/1.0" }
      });
      clearTimeout(timeout);

      if (!res.ok) {
        if (attempt < CONFIG.retryCount && res.status >= 500) {
          await new Promise(r => setTimeout(r, CONFIG.retryDelay * attempt));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json.rows || [];
    } catch (err) {
      if (attempt >= CONFIG.retryCount) return [];
      await new Promise(r => setTimeout(r, CONFIG.retryDelay * attempt));
    }
  }
  return [];
}

// ============================================
// METİN EŞLEŞME FONKSİYONLARI
// ============================================

function textMatches(haystack, query) {
  if (!query || query.length < 2) return true;
  
  const normalized = normalizeQuotes(query);
  const exactPhrases = [];
  const remaining = normalized.replace(/"([^"]+)"/g, (_, phrase) => {
    if (phrase.trim().length >= 2) exactPhrases.push(fold(phrase.trim()));
    return " ";
  });

  for (const phrase of exactPhrases) {
    if (!haystack.includes(phrase)) return false;
  }

  const words = remaining.split(/\s+/).filter(w => w.length >= 2);
  for (const word of words) {
    if (!haystack.includes(fold(word))) return false;
  }
  return true;
}

// ============================================
// DAİRE TESPİT
// ============================================

const CEZA_KEYWORDS = ["tck","ceza","suç","sanık","müşteki","mağdur","hırsızlık","kasten","öldürme","yaralama","tehdit","hakaret","dolandırıcılık","uyuşturucu","silah","gasp","cinsel","terör","tutuklama","hapis","beraat","mahkumiyet","savcı","cmk","5237","5271","7258","olası kast","taksir"];
const HUKUK_KEYWORDS = ["tazminat","alacak","borç","sözleşme","kira","boşanma","nafaka","velayet","miras","tapu","iş kazası","işçi","kıdem","icra","iflas","haciz","kamulaştırma","tbk","tmk","hmk","6098","4721"];

function detectCourtType(query) {
  const q = fold(normalizeQuotes(query));
  let ceza = 0, hukuk = 0;
  for (const k of CEZA_KEYWORDS) if (q.includes(fold(k))) ceza++;
  for (const k of HUKUK_KEYWORDS) if (q.includes(fold(k))) hukuk++;
  if (ceza > hukuk) return "ceza";
  if (hukuk > ceza) return "hukuk";
  return null;
}

// ============================================
// LOKAL ARAMA (ÖNBELLEKTEN)
// ============================================

async function searchLocal(query, progressCallback) {
  const q = (query || "").trim();
  if (q.length < 2) return { hits: [], total: 0, mode: "local" };

  const data = await loadLocalCache(progressCallback);
  const courtType = detectCourtType(q);
  const hits = [];

  for (const row of data) {
    if (!textMatches(row.textFolded, q)) continue;
    
    if (courtType) {
      const court = (row.court || "").toLowerCase();
      if (courtType === "ceza" && !court.includes("ceza")) continue;
      if (courtType === "hukuk" && court.includes("ceza")) continue;
    }
    
    hits.push(formatHit(row, q));
    if (hits.length >= settings.pageSize * 2) break;
  }

  return {
    hits: hits.slice(0, settings.pageSize),
    total: hits.length,
    mode: "local",
    courtType,
    cacheSize: data.length,
  };
}

// ============================================
// GLOBAL ARAMA (TÜM VERİTABANI)
// ============================================

async function searchGlobal(query, progressCallback) {
  const q = (query || "").trim();
  if (q.length < 2) return { hits: [], total: 0, mode: "global" };

  const courtType = detectCourtType(q);
  const range = CONFIG.endOffset - CONFIG.startOffset;
  const step = Math.floor(range / CONFIG.globalBatches);
  const hits = [];
  let scanned = 0;

  for (let i = 0; i < CONFIG.globalBatches; i++) {
    if (hits.length >= settings.pageSize) break;
    
    const offset = CONFIG.startOffset + (i * step);
    if (progressCallback) progressCallback(Math.round((i / CONFIG.globalBatches) * 100));
    
    const rows = await apiRequest(offset, CONFIG.batchSize);
    scanned += rows.length;

    for (const item of rows) {
      const row = item.row || {};
      const year = Number(row.year);
      if (year < CONFIG.yearMin || year > CONFIG.yearMax) continue;
      
      const textFolded = fold(row.text || "");
      if (!textMatches(textFolded, q)) continue;
      
      if (courtType) {
        const court = (row.court || "").toLowerCase();
        if (courtType === "ceza" && !court.includes("ceza")) continue;
        if (courtType === "hukuk" && court.includes("ceza")) continue;
      }
      
      hits.push(formatHit({ idx: item.row_idx, ...row }, q));
      if (hits.length >= settings.pageSize * 2) break;
    }
  }

  return {
    hits: hits.slice(0, settings.pageSize),
    total: hits.length,
    mode: "global",
    courtType,
    scanned,
  };
}

// ============================================
// ANA ARAMA FONKSİYONU
// ============================================

async function search(query, progressCallback) {
  if (settings.searchMode === "global") {
    return searchGlobal(query, progressCallback);
  }
  return searchLocal(query, progressCallback);
}

// ============================================
// FORMAT FONKSİYONLARI
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
  const parts = ["Yargıtay"];
  if (row.court) parts.push(row.court);
  if (row.esas_no) parts.push("E. " + row.esas_no);
  if (row.karar_no) parts.push("K. " + row.karar_no);
  const t = row.karar_tarihi || "";
  const [y, m, d] = (t + "--").split("-");
  if (y && m && d) parts.push(`${d}.${m}.${y}`);
  return parts.join(", ");
}

function createSnippet(text, query) {
  const hay = (text || "").slice(0, 4000);
  const normalized = normalizeQuotes(query || "");
  
  const phrases = [];
  const remaining = normalized.replace(/"([^"]+)"/g, (_, p) => { phrases.push(p.trim()); return ""; });
  const words = remaining.split(/\s+/).filter(w => w.length > 2);
  const terms = [...phrases, ...words];
  
  if (!terms.length) return escapeHtml(hay.slice(0, 300));

  let firstIdx = -1;
  for (const term of terms) {
    const idx = fold(hay).indexOf(fold(term));
    if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) firstIdx = idx;
  }

  const start = firstIdx < 0 ? 0 : Math.max(0, firstIdx - 50);
  const piece = hay.slice(start, start + 300);
  let out = escapeHtml(piece);

  for (const term of terms) {
    if (term.length < 2) continue;
    const re = new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }

  return (start ? "… " : "") + out + (hay.length > start + 300 ? " …" : "");
}

// ============================================
// KARAR DETAY
// ============================================

async function getDecision(id) {
  const parts = String(id).split(":");
  const rowIdx = parseInt(parts[0], 10);
  if (isNaN(rowIdx)) throw new Error("Geçersiz karar ID");

  const rows = await apiRequest(rowIdx, 1);
  if (!rows.length) throw new Error("Karar bulunamadı");

  const row = rows[0].row || {};
  return {
    id, court: row.court, esas_no: row.esas_no, karar_no: row.karar_no,
    karar_tarihi: row.karar_tarihi, year: row.year, text: row.text,
    citation: formatCitation(row),
  };
}

// ============================================
// UI - GÖRÜNÜMLER
// ============================================

function qs(params) {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v) !== "") u.set(k, v);
  });
  return u.toString();
}

function route() {
  const raw = (location.hash || "#/").replace(/^#/, "") || "/";
  const [pathPart, searchPart] = raw.split("?");
  const u = new URLSearchParams(searchPart || "");
  return {
    path: pathPart || "/",
    q: u.get("q") || "",
  };
}

function go(path) {
  location.hash = path.startsWith("#") ? path.slice(1) : path;
}

function homeView() {
  return `
    <section class="hero">
      <h1>Yargıtay<br>kararları.</h1>
      <p class="lede">2025–2026 tarihli Yargıtay kararlarında tam metin arama.</p>
      
      <form class="search-box" id="search-form">
        <input type="search" name="q" placeholder="Örn. olası kast, hırsızlık, &quot;haksız tahrik&quot;" autofocus>
        <button type="submit">Ara</button>
      </form>
      
      <div class="settings" style="margin-top:20px; display:flex; gap:20px; justify-content:center; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:8px;">
          Sonuç sayısı:
          <select id="page-size">
            <option value="10" ${settings.pageSize === 10 ? "selected" : ""}>10</option>
            <option value="25" ${settings.pageSize === 25 ? "selected" : ""}>25</option>
            <option value="50" ${settings.pageSize === 50 ? "selected" : ""}>50</option>
          </select>
        </label>
        
        <label style="display:flex; align-items:center; gap:8px;">
          Arama modu:
          <select id="search-mode">
            <option value="local" ${settings.searchMode === "local" ? "selected" : ""}>Lokal (hızlı)</option>
            <option value="global" ${settings.searchMode === "global" ? "selected" : ""}>Global (geniş)</option>
          </select>
        </label>
      </div>
      
      <p class="hint" style="margin-top:15px;">
        <strong>Lokal:</strong> Önbelleğe alınmış ~2000 karardan arar (anlık)<br>
        <strong>Global:</strong> Tüm veritabanından arar (daha geniş ama yavaş)
      </p>
    </section>
  `;
}

function loadingView(query, progress = null) {
  const pct = progress !== null ? ` %${progress}` : "";
  const modeText = settings.searchMode === "global" ? "Tüm veritabanı taranıyor" : "Önbellek hazırlanıyor";
  return `
    <div class="notice" style="margin-top:28px">
      <h2>${localCache && settings.searchMode === "local" ? "Aranıyor" : modeText}</h2>
      <p><strong>${escapeHtml(query)}</strong>${pct}</p>
    </div>
  `;
}

function searchView(query, results) {
  const { hits, total, mode, courtType, cacheSize, scanned } = results;
  const courtLabel = courtType === "ceza" ? "Ceza" : (courtType === "hukuk" ? "Hukuk" : "Tümü");
  const modeLabel = mode === "local" ? `Lokal (${fmt(cacheSize || 0)} kayıt)` : `Global (${fmt(scanned || 0)} tarandı)`;
  
  const hitList = hits.map(h => `
    <article class="hit">
      <div><span class="badge">Yargıtay</span><span class="badge">${escapeHtml(h.court || "")}</span></div>
      <a class="title" href="#/karar/${encodeURIComponent(h.id)}?q=${encodeURIComponent(query)}" data-link>${escapeHtml(h.citation)}</a>
      <p class="snip">${h.snippet}</p>
    </article>
  `).join("");

  return `
    <form class="search-box" id="search-form">
      <input type="search" name="q" value="${escapeAttr(query)}" autofocus>
      <button type="submit">Ara</button>
    </form>
    
    <div class="settings" style="margin:15px 0; display:flex; gap:15px; flex-wrap:wrap; font-size:14px;">
      <label>
        Sonuç: 
        <select id="page-size" style="padding:4px;">
          <option value="10" ${settings.pageSize === 10 ? "selected" : ""}>10</option>
          <option value="25" ${settings.pageSize === 25 ? "selected" : ""}>25</option>
          <option value="50" ${settings.pageSize === 50 ? "selected" : ""}>50</option>
        </select>
      </label>
      <label>
        Mod: 
        <select id="search-mode" style="padding:4px;">
          <option value="local" ${settings.searchMode === "local" ? "selected" : ""}>Lokal</option>
          <option value="global" ${settings.searchMode === "global" ? "selected" : ""}>Global</option>
        </select>
      </label>
      <button type="button" id="re-search" class="ghost" style="padding:4px 12px;">Yeniden Ara</button>
    </div>
    
    <div class="results-head">
      <h1>${escapeHtml(query)}</h1>
      <div class="count">${total} sonuç · ${courtLabel} · ${modeLabel}</div>
    </div>
    
    ${hits.length === 0 
      ? `<div class="empty">
          <p>Eşleşen karar bulunamadı.</p>
          <p class="hint">${mode === "local" ? "Global arama modunu deneyin." : "Farklı kelimeler deneyin."}</p>
        </div>`
      : hitList
    }
  `;
}

function decisionView(decision, query) {
  let body = escapeHtml(decision.text || "");
  const terms = (query || "").split(/\s+/).filter(t => t.length > 2);
  for (const t of terms) {
    const re = new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    body = body.replace(re, "<mark>$1</mark>");
  }

  return `
    <article>
      <div class="reader-meta">
        <p class="kicker">Yargıtay</p>
        <h1>${escapeHtml(decision.citation)}</h1>
        <p class="cite">${[decision.court, decision.esas_no && "E. " + decision.esas_no, decision.karar_no && "K. " + decision.karar_no].filter(Boolean).map(escapeHtml).join(" · ")}</p>
        <button class="ghost" id="back-btn">← Aramaya dön</button>
      </div>
      <div class="decision-body">${body}</div>
    </article>
  `;
}

function errorView(message) {
  return `
    <div class="notice">
      <h2>Hata</h2>
      <p class="error">${escapeHtml(message)}</p>
      <button class="ghost" id="retry-btn">Yeniden dene</button>
    </div>
  `;
}

// ============================================
// RENDER VE EVENT'LER
// ============================================

let currentRender = 0;

async function render() {
  const version = ++currentRender;
  const r = route();

  try {
    if (r.path.startsWith("/karar/")) {
      const id = decodeURIComponent(r.path.slice(7));
      $app.innerHTML = loadingView("Karar yükleniyor...");
      const decision = await getDecision(id);
      if (version !== currentRender) return;
      $app.innerHTML = decisionView(decision, r.q);
      document.getElementById("back-btn")?.addEventListener("click", () => history.back());
      document.title = `${decision.citation} — İçtihat`;
      return;
    }

    if (r.path.startsWith("/ara") && r.q) {
      $app.innerHTML = loadingView(r.q);
      const results = await search(r.q, (p) => {
        if (version === currentRender) $app.innerHTML = loadingView(r.q, p);
      });
      if (version !== currentRender) return;
      $app.innerHTML = searchView(r.q, results);
      bindEvents();
      document.title = `${r.q} — İçtihat`;
      return;
    }

    $app.innerHTML = homeView();
    bindEvents();
    document.title = "İçtihat — Yargıtay Kararı Arama";
  } catch (err) {
    if (version !== currentRender) return;
    $app.innerHTML = errorView(err.message);
    document.getElementById("retry-btn")?.addEventListener("click", render);
  }
}

function bindEvents() {
  document.getElementById("search-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) go(`/ara?q=${encodeURIComponent(q)}`);
  });

  document.getElementById("page-size")?.addEventListener("change", (e) => {
    settings.pageSize = parseInt(e.target.value, 10);
  });

  document.getElementById("search-mode")?.addEventListener("change", (e) => {
    settings.searchMode = e.target.value;
  });

  document.getElementById("re-search")?.addEventListener("click", () => {
    render();
  });
}

// ============================================
// BAŞLAT
// ============================================

document.body.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a) { e.preventDefault(); go(a.getAttribute("href")); }
});

window.addEventListener("hashchange", render);
render();
