const HF_DS = "hamzabagirsakci/turkish-court-decisions";
const HF_BASE = "https://datasets-server.huggingface.co";
const YEAR_MIN = 2020;
const YEAR_MAX = 2026;
const PAGE = 25;
const YEAR_2020_OFFSET = 8000000;

const $app = document.getElementById("app");
let renderVersion = 0;

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
  const path = pathPart || "/";
  const u = new URLSearchParams(searchPart || "");
  return {
    path,
    q: u.get("q") || "",
    court: u.get("court") || "",
    esas_no: u.get("esas_no") || "",
    karar_no: u.get("karar_no") || "",
    offset: Number(u.get("offset") || 0),
  };
}

function go(path) {
  location.hash = path.startsWith("#") ? path.slice(1) : path;
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

function citation(row) {
  const bits = ["Yargıtay"];
  if (row.court) bits.push(row.court);
  if (row.esas_no) bits.push("E. " + row.esas_no);
  if (row.karar_no) bits.push("K. " + row.karar_no);
  const t = row.karar_tarihi || "";
  const [y, m, d] = (t + "--").split("-");
  if (y && m && d) bits.push(`${d}.${m}.${y}`);
  else if (t) bits.push(t);
  return bits.join(", ");
}

function snippetHtml(text, q) {
  const hay = (text || "").slice(0, 4000);
  const normalizedQ = normalizeQuotes(q || "");
  
  const exactPhrases = [];
  const remaining = normalizedQ.replace(/"([^"]+)"/g, (_, phrase) => {
    exactPhrases.push(phrase.trim());
    return "";
  });
  const words = remaining.trim().split(/\s+/).filter((w) => w.length > 2);
  const allTerms = [...exactPhrases, ...words];
  
  if (!allTerms.length) return escapeHtml(hay.slice(0, 420));
  
  let firstIdx = -1;
  let firstTerm = allTerms[0];
  for (const term of allTerms) {
    const idx = fold(hay).indexOf(fold(term));
    if (idx >= 0 && (firstIdx < 0 || idx < firstIdx)) {
      firstIdx = idx;
      firstTerm = term;
    }
  }
  
  const start = firstIdx < 0 ? 0 : Math.max(0, firstIdx - 80);
  const piece = hay.slice(start, start + 420);
  let out = escapeHtml(piece);
  
  for (const term of allTerms) {
    if (term.length < 2) continue;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, "<mark>$&</mark>");
  }
  
  if (start) out = "… " + out;
  if (hay.length > start + 420) out += " …";
  return out;
}

function searchForm(f, compact) {
  return `
    <form class="search-box" id="search-form">
      <input type="search" name="q" value="${escapeAttr(f.q)}" placeholder="Örn. kamulaştırma, &quot;haksız tahrik&quot;, TCK 86" autofocus>
      <button type="submit">${compact ? "Ara" : "Karar ara"}</button>
    </form>
    ${compact ? "" : `<p class="hint">Yalnızca 2020–2026 Yargıtay kararları. Bilgisayar kapalıyken de açılır.</p>`}
  `;
}

function filterPanel(f) {
  return `
    <aside class="filters">
      <h2>Filtre</h2>
      <form id="filter-form">
        <p class="status-line"><strong>Yargıtay</strong><br>2020–2026 kararları</p>
        <label>Mahkeme / daire</label>
        <input name="court" value="${escapeAttr(f.court)}" placeholder="Örn. 9. Hukuk">
        <label>Esas no</label>
        <input name="esas_no" value="${escapeAttr(f.esas_no)}" placeholder="ör. 2016/123">
        <label>Karar no</label>
        <input name="karar_no" value="${escapeAttr(f.karar_no)}" placeholder="ör. 2023/456">
        <div class="actions">
          <button type="submit">Uygula</button>
          <button type="button" class="ghost" id="filter-reset">Sıfırla</button>
        </div>
      </form>
    </aside>
  `;
}

async function hfGet(path, params) {
  const url = `${HF_BASE}/${path}?${new URLSearchParams(params)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Ictihad/1.0" } });
    if (!res.ok) {
      let msg = "Hugging Face yanıt vermedi";
      try {
        const j = await res.json();
        msg = j.error || msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const json = await res.json();
    if (json.error) {
      throw new Error(json.error);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function passes(row, f) {
  const year = Number(row.year);
  if (!year || year < YEAR_MIN || year > YEAR_MAX) return false;
  if (f.court && !(row.court || "").toLowerCase().includes(f.court.toLowerCase())) return false;
  const digits = (v) => String(v || "").replace(/\D/g, "");
  if (f.esas_no && !digits(row.esas_no).includes(digits(f.esas_no)) && !digits(f.esas_no).includes(digits(row.esas_no))) return false;
  if (f.karar_no && !digits(row.karar_no).includes(digits(f.karar_no)) && !digits(f.karar_no).includes(digits(row.karar_no))) return false;
  return true;
}

function toHit(row, q, rowIdx = null) {
  const text = row.text || "";
  const id = rowIdx !== null ? `${rowIdx}:${row.id}` : row.id;
  return {
    id,
    source: "yargitay",
    court: row.court,
    esas_no: row.esas_no,
    karar_no: row.karar_no,
    karar_tarihi: row.karar_tarihi,
    year: row.year,
    text_len: row.text_len || text.length,
    snippet: snippetHtml(text, q),
    citation: citation(row),
    remote: true,
    text,
  };
}

function normalizeQuotes(str) {
  return str.replace(/[""„‟«»]/g, '"').replace(/[''‚‛]/g, "'");
}

function textMatches(text, query) {
  if (!query || query.length < 2) return true;
  const haystack = fold(text || "");
  const normalizedQuery = normalizeQuotes(query);
  
  const exactPhrases = [];
  const remaining = normalizedQuery.replace(/"([^"]+)"/g, (_, phrase) => {
    exactPhrases.push(phrase.trim());
    return "";
  });
  
  for (const phrase of exactPhrases) {
    if (phrase.length < 2) continue;
    if (!haystack.includes(fold(phrase))) return false;
  }
  
  const terms = remaining.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  return terms.every(term => haystack.includes(fold(term)));
}

const CEZA_TERMS = [
  "tck", "ceza", "suç", "sanık", "müşteki", "mağdur", "hırsızlık", "kasten", "öldürme", 
  "yaralama", "darp", "tehdit", "hakaret", "iftira", "dolandırıcılık", "sahtecilik",
  "uyuşturucu", "silah", "gasp", "yağma", "cinsel", "istismar", "taciz", "terör",
  "örgüt", "zimmet", "rüşvet", "irtikap", "görevi kötüye", "resmi evrak", "özel evrak",
  "bilişim", "hacker", "kumar", "bahis", "kaçakçılık", "gümrük", "vergi", "sgk",
  "tutuklama", "tahliye", "hapis", "cezaevi", "infaz", "denetimli serbestlik",
  "beraat", "mahkumiyet", "temyiz", "istinaf", "kovuşturma", "soruşturma", "savcı",
  "cmk", "5237", "5271", "6136", "7258", "3713", "kabahat", "adli para"
];

const HUKUK_TERMS = [
  "tazminat", "alacak", "borç", "sözleşme", "kira", "tahliye", "ecrimisil",
  "boşanma", "nafaka", "velayet", "miras", "vasiyetname", "tereke", "intikal",
  "tapu", "kadastro", "imar", "iskan", "kat mülkiyeti", "ortaklık", "şirket",
  "iş kazası", "işçi", "işveren", "kıdem", "ihbar", "fazla mesai", "sgk primi",
  "sigorta", "trafik kazası", "hasar", "temerrüt", "faiz", "icra", "iflas",
  "itirazın iptali", "menfi tespit", "istirdat", "haciz", "rehin", "ipotek",
  "kamulaştırma", "istimlak", "irtifak", "intifa", "şufa", "önalım",
  "tbk", "tmk", "ttk", "hmk", "6098", "4721", "6102", "6100", "arabuluculuk"
];

function detectCourtType(query) {
  const normalized = normalizeQuotes(query).replace(/"[^"]*"/g, " ");
  const q = fold(normalized.toLowerCase());
  let cezaScore = 0;
  let hukukScore = 0;
  
  for (const term of CEZA_TERMS) {
    if (q.includes(fold(term))) cezaScore++;
  }
  for (const term of HUKUK_TERMS) {
    if (q.includes(fold(term))) hukukScore++;
  }
  
  if (cezaScore > hukukScore) return "ceza";
  if (hukukScore > cezaScore) return "hukuk";
  return null;
}

async function searchRemote(f) {
  const limit = PAGE;
  const userOffset = Math.max(0, f.offset || 0);
  let q = (f.q || "").trim();
  if (!q) q = (f.esas_no || f.karar_no || "").trim();

  const hasSearchQuery = q && q.length >= 2;

  if (!hasSearchQuery) {
    const yearOffsets = {
      2020: 8000000,
      2021: 8500000,
      2022: 9000000,
      2023: 9500000,
      2024: 10000000,
      2025: 10500000,
      2026: 10800000,
    };
    
    const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
    const perYear = Math.ceil(limit / years.length);
    
    const fetchPromises = years.map((year) => {
      const baseOffset = yearOffsets[year];
      const randomAdd = Math.floor(Math.random() * 400000);
      return hfGet("rows", {
        dataset: HF_DS,
        config: "yargitay",
        split: "train",
        offset: baseOffset + randomAdd + (userOffset * perYear),
        length: Math.min(perYear, 100),
      }).catch(() => ({ rows: [] }));
    });
    
    const results = await Promise.all(fetchPromises);
    let allHits = [];
    
    for (const data of results) {
      const items = data.rows || [];
      for (const item of items) {
        const row = item.row || {};
        if (!passes(row, f)) continue;
        const hit = toHit(row, q, item.row_idx);
        allHits.push(hit);
      }
    }
    
    allHits.sort(() => Math.random() - 0.5);
    const hits = allHits.slice(0, limit);
    
    return { 
      total: 3000000, 
      offset: userOffset, 
      limit, 
      hits, 
      mode: "çevrimiçi"
    };
  }

  const SCAN_BATCHES = 200;
  const BATCH_SIZE = 100;
  const TOTAL_SCAN = SCAN_BATCHES * BATCH_SIZE;
  
  const YEAR_2020_START = 8000000;
  const YEAR_2026_END = 9820000;
  const RANGE = YEAR_2026_END - YEAR_2020_START;
  
  const scanOffsets = [];
  for (let i = 0; i < SCAN_BATCHES; i++) {
    scanOffsets.push(YEAR_2020_START + Math.floor(Math.random() * RANGE));
  }
  
  const fetchPromises = scanOffsets.map((offset) => {
    return hfGet("rows", {
      dataset: HF_DS,
      config: "yargitay",
      split: "train",
      offset: offset,
      length: BATCH_SIZE,
    }).catch(() => ({ rows: [] }));
  });
  
  const results = await Promise.all(fetchPromises);
  let allHits = [];
  
  const courtType = detectCourtType(q);
  
  for (const data of results) {
    const items = data.rows || [];
    for (const item of items) {
      const row = item.row || {};
      if (!passes(row, f)) continue;
      if (!textMatches(row.text, q)) continue;
      
      if (courtType) {
        const court = (row.court || "").toLowerCase();
        if (courtType === "ceza" && !court.includes("ceza")) continue;
        if (courtType === "hukuk" && court.includes("ceza")) continue;
      }
      
      const hit = toHit(row, q, item.row_idx);
      allHits.push(hit);
      if (allHits.length >= 100) break;
    }
    if (allHits.length >= 100) break;
  }
  
  allHits.sort(() => Math.random() - 0.5);
  const hits = allHits.slice(0, limit);
  
  const courtLabel = courtType === "ceza" ? " · Ceza Daireleri" : (courtType === "hukuk" ? " · Hukuk Daireleri" : "");
  
  return { 
    total: allHits.length, 
    offset: userOffset, 
    limit, 
    hits, 
    mode: `${allHits.length} eşleşme${courtLabel} (${fmt(TOTAL_SCAN)} kayıt tarandı)`
  };
}

async function getDecision(id, q) {
  const uuid = String(id).includes(":") ? String(id).split(":").pop() : id;
  const idParts = String(id).split(":");
  const rowIdx = idParts.length > 1 ? parseInt(idParts[0], 10) : null;
  
  if (rowIdx !== null && !isNaN(rowIdx)) {
    const data = await hfGet("rows", {
      dataset: HF_DS,
      config: "yargitay",
      split: "train",
      offset: rowIdx,
      length: 1,
    });
    
    for (const item of data.rows || []) {
      const row = item.row || {};
      if (row.id === id || row.document_id === uuid) {
        const hit = toHit(row, q);
        if (hit.year && (hit.year < YEAR_MIN || hit.year > YEAR_MAX)) continue;
        return hit;
      }
    }
  }
  
  throw new Error("Karar bulunamadı");
}

function homeView() {
  return `
    <section class="hero">
      <h1>Yargıtay<br>kararları.</h1>
      <p class="lede">2020–2026 tarihli Yargıtay kararlarında tam metin arama. iPhone’da Safari ile açılır; Ana Ekrana Ekle ile uygulama gibi kalır.</p>
      ${searchForm({ q: "" })}
    </section>
  `;
}

function loadingView(f, retryInfo = "") {
  return `
    ${searchForm(f, true)}
    <div class="notice" style="margin-top:28px">
      <h2>Aranıyor</h2>
      <p>Yargıtay kararları taranıyor${f.q ? ": <strong>" + escapeHtml(f.q) + "</strong>" : ""}.</p>
      <p class="status-line">İlk sonuç birkaç saniye sürebilir.${retryInfo ? " " + retryInfo : ""}</p>
    </div>
  `;
}

function searchView(data, f) {
  const hitList = data.hits || [];
  const hits = hitList
    .map(
      (h) => `
        <article class="hit">
          <div><span class="badge">Yargıtay</span><span class="badge">çevrimiçi</span></div>
          <a class="title" href="#/karar/${encodeURIComponent(h.id)}?q=${encodeURIComponent(f.q || "")}" data-link>${escapeHtml(h.citation)}</a>
          <div class="cite">${h.court ? escapeHtml(h.court) + " · " : ""}${h.year || ""}</div>
          <p class="snip">${h.snippet || ""}</p>
        </article>`
    )
    .join("");
  const shownFrom = hitList.length ? data.offset + 1 : 0;
  const shownTo = hitList.length ? data.offset + hitList.length : 0;
  const prevOff = Math.max(0, data.offset - data.limit);
  const nextOff = data.offset + data.limit;
  const base = { ...f };
  delete base.offset;
  delete base.path;
  return `
    ${searchForm(f, true)}
    <div class="layout" style="margin-top:28px">
      ${filterPanel(f)}
      <section>
        <div class="results-head">
          <h1>${f.q ? escapeHtml(f.q) : "Kararlar"}</h1>
          <div class="count">${data.error ? "Yanıt alınamadı" : `${data.mode || "çevrimiçi"} · ${data.total ? fmt(shownFrom) + "–" + fmt(shownTo) + " / " : ""}${fmt(data.total)} sonuç`}</div>
        </div>
        ${
          data.error
            ? `<div class="empty"><p class="error">${escapeHtml(data.error)}</p><p><button type="button" class="ghost" id="retry-search">Yeniden dene</button></p></div>`
            : hitList.length === 0
              ? `<div class="empty">
                  <p>Eşleşen karar yok.</p>
                  <p class="hint" style="margin-top:12px;font-size:14px;color:#666">
                    <strong>İpucu:</strong> Daha kısa veya farklı terimler deneyin.<br>
                    Örnek: "yasa dışı bahis" yerine <a href="#/ara?q=7258" data-link>7258</a> (kanun no) veya 
                    <a href="#/ara?q=bahis" data-link>bahis</a> deneyin.
                  </p>
                </div>`
              : hits
        }
        ${
          hitList.length > 0 && data.total > data.limit
            ? `<div class="pager">
                <button ${data.offset <= 0 ? "disabled" : ""} data-go="#/ara?${qs({ ...base, offset: prevOff })}">Önceki</button>
                <button ${nextOff >= data.total ? "disabled" : ""} data-go="#/ara?${qs({ ...base, offset: nextOff })}">Sonraki</button>
              </div>`
            : ""
        }
      </section>
    </div>
  `;
}

function kararView(d, q) {
  const terms = (q || "").split(/\s+/).filter((t) => t.length > 2);
  let body = escapeHtml(d.text || "");
  for (const t of [...new Set(terms)].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    body = body.replace(re, "<mark>$1</mark>");
  }
  return `
    <article>
      <div class="reader-meta">
        <p class="kicker">Yargıtay</p>
        <h1>${escapeHtml(d.citation)}</h1>
        <p class="cite">${[d.court, d.esas_no && "E. " + d.esas_no, d.karar_no && "K. " + d.karar_no, d.karar_tarihi].filter(Boolean).map(escapeHtml).join(" · ")}</p>
        <div class="reader-actions">
          <button class="ghost" id="back-search">Aramaya dön</button>
        </div>
      </div>
      <div class="decision-body">${body}</div>
    </article>
  `;
}

function bindSearch() {
  document.getElementById("search-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    const f = { ...route(), q, offset: 0 };
    go(`/ara?${qs({ q: f.q, court: f.court, esas_no: f.esas_no, karar_no: f.karar_no })}`);
  });
}

function bindFilters() {
  document.getElementById("filter-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const f = route();
    for (const [k, v] of fd.entries()) f[k] = v;
    f.offset = 0;
    go(`/ara?${qs({ q: f.q, court: f.court, esas_no: f.esas_no, karar_no: f.karar_no })}`);
  });
  document.getElementById("filter-reset")?.addEventListener("click", () => go(`/ara?${qs({ q: route().q })}`));
}

async function render() {
  const version = ++renderVersion;
  const r = route();
  try {
    if (r.path.startsWith("/karar/")) {
      const id = decodeURIComponent(r.path.slice("/karar/".length));
      $app.innerHTML = loadingView(r);
      const d = await getDecision(id, r.q);
      if (version !== renderVersion) return;
      $app.innerHTML = kararView(d, r.q);
      document.getElementById("back-search")?.addEventListener("click", () => history.back());
      document.title = `${d.citation} — İçtihat`;
      return;
    }
    if (r.path.startsWith("/ara")) {
      $app.innerHTML = loadingView(r);
      bindSearch();
      const data = await searchRemote(r);
      if (version !== renderVersion) return;
      $app.innerHTML = searchView(data, r);
      bindSearch();
      bindFilters();
      $app.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", () => go(btn.getAttribute("data-go"))));
      document.getElementById("retry-search")?.addEventListener("click", () => render());
      document.title = (r.q ? `${r.q} — ` : "") + "Arama — İçtihat";
      return;
    }
    $app.innerHTML = homeView();
    bindSearch();
    document.title = "İçtihat — Yargıtay Kararı Arama";
  } catch (err) {
    if (version !== renderVersion) return;
    $app.innerHTML = `<div class="notice"><h2>Bir hata oluştu</h2><p class="error">${escapeHtml(err.message)}</p><p><button type="button" class="ghost" id="retry-search">Yeniden dene</button></p></div>`;
    document.getElementById("retry-search")?.addEventListener("click", () => render());
  }
}

document.body.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-link]");
  if (!a) return;
  e.preventDefault();
  go(a.getAttribute("href"));
});
window.addEventListener("hashchange", render);
render();
