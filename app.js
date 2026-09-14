// ============================================
// İÇTİHAT - Yargıtay Karar Arama
// Bağımsız Arama Modülü
// ============================================

const CONFIG = {
  dataset: "Alptekinege/turkish-court-decisions",
  apiBase: "https://datasets-server.huggingface.co",
  config: "yargitay",
  split: "train",
  startOffset: 9500000,  // 2025 başlangıcı
  endOffset: 9820000,    // 2026 sonu
  yearMin: 2025,
  yearMax: 2026,
  pageSize: 25,
  batchSize: 100,
  maxBatches: 32,
  retryCount: 3,
  retryDelay: 1000,
};

const $app = document.getElementById("app");

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
// API İSTEK FONKSİYONU (Retry destekli)
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
      if (json.error) {
        if (attempt < CONFIG.retryCount) {
          await new Promise(r => setTimeout(r, CONFIG.retryDelay * attempt));
          continue;
        }
        throw new Error(json.error);
      }

      return json.rows || [];
    } catch (err) {
      if (attempt >= CONFIG.retryCount) {
        console.error("API request failed:", err.message);
        return [];
      }
      await new Promise(r => setTimeout(r, CONFIG.retryDelay * attempt));
    }
  }
  return [];
}

// ============================================
// METİN EŞLEŞME FONKSİYONU
// ============================================

function textMatches(text, query) {
  if (!query || query.length < 2) return true;
  
  const haystack = fold(text || "");
  const normalized = normalizeQuotes(query);
  
  // Tırnak içindeki ifadeleri çıkar
  const exactPhrases = [];
  const remaining = normalized.replace(/"([^"]+)"/g, (_, phrase) => {
    if (phrase.trim().length >= 2) {
      exactPhrases.push(phrase.trim());
    }
    return " ";
  });

  // Tırnak içi ifadeleri kontrol et
  for (const phrase of exactPhrases) {
    if (!haystack.includes(fold(phrase))) {
      return false;
    }
  }

  // Kalan kelimeleri kontrol et
  const words = remaining.split(/\s+/).filter(w => w.length >= 2);
  for (const word of words) {
    if (!haystack.includes(fold(word))) {
      return false;
    }
  }

  return true;
}

// ============================================
// DAİRE TESPİT FONKSİYONU
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
// ANA ARAMA FONKSİYONU
// ============================================

async function search(query, filters = {}) {
  const q = (query || "").trim();
  if (q.length < 2) {
    return { hits: [], total: 0, scanned: 0, courtType: null };
  }

  const courtType = detectCourtType(q);
  const range = CONFIG.endOffset - CONFIG.startOffset;
  const step = Math.floor(range / CONFIG.maxBatches);
  
  const hits = [];
  let scanned = 0;

  for (let i = 0; i < CONFIG.maxBatches; i++) {
    // Yeterli sonuç varsa dur
    if (hits.length >= CONFIG.pageSize) break;

    const offset = CONFIG.startOffset + (i * step);
    const rows = await apiRequest(offset, CONFIG.batchSize);
    scanned += rows.length;

    for (const item of rows) {
      const row = item.row || {};
      
      // Yıl filtresi
      const year = Number(row.year);
      if (!year || year < CONFIG.yearMin || year > CONFIG.yearMax) continue;
      
      // Metin eşleşmesi
      if (!textMatches(row.text, q)) continue;
      
      // Daire filtresi
      if (courtType) {
        const court = (row.court || "").toLowerCase();
        if (courtType === "ceza" && !court.includes("ceza")) continue;
        if (courtType === "hukuk" && court.includes("ceza")) continue;
      }
      
      // Ek filtreler
      if (filters.court && !(row.court || "").toLowerCase().includes(filters.court.toLowerCase())) continue;
      
      hits.push({
        id: item.row_idx + ":" + row.id,
        court: row.court,
        esas_no: row.esas_no,
        karar_no: row.karar_no,
        karar_tarihi: row.karar_tarihi,
        year: row.year,
        text: row.text,
        citation: formatCitation(row),
        snippet: createSnippet(row.text, q),
      });

      if (hits.length >= CONFIG.pageSize * 2) break;
    }
  }

  return {
    hits: hits.slice(0, CONFIG.pageSize),
    total: hits.length,
    scanned,
    courtType,
  };
}

// ============================================
// FORMAT FONKSİYONLARI
// ============================================

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
  
  // Arama terimlerini çıkar
  const phrases = [];
  const remaining = normalized.replace(/"([^"]+)"/g, (_, p) => {
    phrases.push(p.trim());
    return "";
  });
  const words = remaining.split(/\s+/).filter(w => w.length > 2);
  const terms = [...phrases, ...words];
  
  if (!terms.length) return escapeHtml(hay.slice(0, 350));

  // İlk eşleşmeyi bul
  let firstIdx = -1;
  for (const term of terms) {
    const idx = fold(hay).indexOf(fold(term));
    if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) {
      firstIdx = idx;
    }
  }

  const start = firstIdx < 0 ? 0 : Math.max(0, firstIdx - 60);
  const piece = hay.slice(start, start + 350);
  let out = escapeHtml(piece);

  // Terimleri vurgula
  for (const term of terms) {
    if (term.length < 2) continue;
    const re = new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
    out = out.replace(re, "<mark>$1</mark>");
  }

  return (start ? "… " : "") + out + (hay.length > start + 350 ? " …" : "");
}

// ============================================
// KARAR DETAY FONKSİYONU
// ============================================

async function getDecision(id) {
  const parts = String(id).split(":");
  const rowIdx = parseInt(parts[0], 10);
  
  if (isNaN(rowIdx)) {
    throw new Error("Geçersiz karar ID");
  }

  const rows = await apiRequest(rowIdx, 1);
  if (!rows.length) {
    throw new Error("Karar bulunamadı");
  }

  const row = rows[0].row || {};
  return {
    id,
    court: row.court,
    esas_no: row.esas_no,
    karar_no: row.karar_no,
    karar_tarihi: row.karar_tarihi,
    year: row.year,
    text: row.text,
    citation: formatCitation(row),
  };
}

// ============================================
// UI FONKSİYONLARI
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
    court: u.get("court") || "",
    offset: Number(u.get("offset") || 0),
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
        <button type="submit">Karar ara</button>
      </form>
      <p class="hint">Büyük/küçük harf fark etmez. Tırnak içi tam ifade arar.</p>
    </section>
  `;
}

function loadingView(query) {
  return `
    <div class="notice" style="margin-top:28px">
      <h2>Aranıyor</h2>
      <p>${query ? `<strong>${escapeHtml(query)}</strong> için kararlar taranıyor...` : "Kararlar yükleniyor..."}</p>
    </div>
  `;
}

function searchView(query, results) {
  const { hits, total, scanned, courtType } = results;
  const courtLabel = courtType === "ceza" ? "Ceza Daireleri" : (courtType === "hukuk" ? "Hukuk Daireleri" : "Tüm Daireler");
  
  const hitList = hits.map(h => `
    <article class="hit">
      <div><span class="badge">Yargıtay</span><span class="badge">${escapeHtml(h.court || "")}</span></div>
      <a class="title" href="#/karar/${encodeURIComponent(h.id)}?q=${encodeURIComponent(query)}" data-link>${escapeHtml(h.citation)}</a>
      <p class="snip">${h.snippet}</p>
    </article>
  `).join("");

  return `
    <form class="search-box" id="search-form">
      <input type="search" name="q" value="${escapeAttr(query)}" placeholder="Arama..." autofocus>
      <button type="submit">Ara</button>
    </form>
    <div class="results-head" style="margin-top:20px">
      <h1>${escapeHtml(query)}</h1>
      <div class="count">${total} sonuç · ${courtLabel} · ${fmt(scanned)} kayıt tarandı</div>
    </div>
    ${hits.length === 0 
      ? `<div class="empty">
          <p>Eşleşen karar bulunamadı.</p>
          <p class="hint">Farklı kelimeler veya daha kısa ifadeler deneyin.</p>
        </div>`
      : hitList
    }
  `;
}

function decisionView(decision, query) {
  let body = escapeHtml(decision.text || "");
  
  // Arama terimlerini vurgula
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
// ANA RENDER FONKSİYONU
// ============================================

let currentRender = 0;

async function render() {
  const version = ++currentRender;
  const r = route();

  try {
    // Karar detay sayfası
    if (r.path.startsWith("/karar/")) {
      const id = decodeURIComponent(r.path.slice(7));
      $app.innerHTML = loadingView();
      
      const decision = await getDecision(id);
      if (version !== currentRender) return;
      
      $app.innerHTML = decisionView(decision, r.q);
      document.getElementById("back-btn")?.addEventListener("click", () => history.back());
      document.title = `${decision.citation} — İçtihat`;
      return;
    }

    // Arama sayfası
    if (r.path.startsWith("/ara") && r.q) {
      $app.innerHTML = loadingView(r.q);
      
      const results = await search(r.q, { court: r.court });
      if (version !== currentRender) return;
      
      $app.innerHTML = searchView(r.q, results);
      bindSearchForm();
      document.title = `${r.q} — Arama — İçtihat`;
      return;
    }

    // Ana sayfa
    $app.innerHTML = homeView();
    bindSearchForm();
    document.title = "İçtihat — Yargıtay Kararı Arama";

  } catch (err) {
    if (version !== currentRender) return;
    $app.innerHTML = errorView(err.message);
    document.getElementById("retry-btn")?.addEventListener("click", render);
  }
}

function bindSearchForm() {
  document.getElementById("search-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) go(`/ara?q=${encodeURIComponent(q)}`);
  });
}

// ============================================
// BAŞLAT
// ============================================

document.body.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (a) {
    e.preventDefault();
    go(a.getAttribute("href"));
  }
});

window.addEventListener("hashchange", render);
render();
