#!/usr/bin/env npx tsx
/**
 * Ingestion crawler for the Portuguese Data Protection Authority
 * (CNPD — Comissão Nacional de Proteção de Dados).
 *
 * Crawls decisions (deliberações, pareceres, diretrizes) and guidance
 * (orientações) from cnpd.pt and stores them in the SQLite database
 * used by the MCP server.
 *
 * Data sources:
 *   - https://www.cnpd.pt/decisoes/historico-de-decisoes/   (decisions search)
 *   - https://www.cnpd.pt/decisoes/deliberacoes/             (current deliberations)
 *   - https://www.cnpd.pt/decisoes/pareceres/                (current opinions)
 *   - https://www.cnpd.pt/decisoes/diretrizes/               (directives)
 *   - https://www.cnpd.pt/organizacoes/orientacoes-e-recomendacoes/  (guidance)
 *
 * Usage:
 *   npx tsx scripts/ingest-cnpd.ts                  # full crawl
 *   npx tsx scripts/ingest-cnpd.ts --resume         # skip already-ingested references
 *   npx tsx scripts/ingest-cnpd.ts --dry-run        # crawl + parse but do not write DB
 *   npx tsx scripts/ingest-cnpd.ts --force          # drop existing data, re-ingest
 *   npx tsx scripts/ingest-cnpd.ts --resume --limit 50
 *   npx tsx scripts/ingest-cnpd.ts --year-start 2020 --year-end 2024
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["CNPD_PT_DB_PATH"] ?? "data/cnpd.db";
const RATE_LIMIT_MS = 1_500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3_000;
const PAGE_SIZE = 40; // CNPD returns 40 results per page
const REQUEST_TIMEOUT_MS = 30_000;

const BASE_URL = "https://www.cnpd.pt";

/** Historical decision search endpoint. Accepts year, type, entity, page params. */
const HISTORY_SEARCH_PATH = "/decisoes/historico-de-decisoes/";

/** Current-year listing pages (each shows only the current year). */
const CURRENT_PAGES = {
  deliberacoes: "/decisoes/deliberacoes/",
  pareceres: "/decisoes/pareceres/",
  diretrizes: "/decisoes/diretrizes/",
} as const;

/** Guidance topic sub-pages under /organizacoes/orientacoes-e-recomendacoes/. */
const ORIENTACOES_BASE = "/organizacoes/orientacoes-e-recomendacoes/";
const ORIENTACOES_TOPICS = [
  { slug: "saude/", topicId: "saude" },
  { slug: "trabalho/", topicId: "empregados" },
  { slug: "educacao/", topicId: "educacao" },
  { slug: "encarregado-de-protecao-de-dados/", topicId: "epd" },
  { slug: "disponibilizacao-de-dados/", topicId: "direitos_titulares" },
  { slug: "difusao-na-internet/", topicId: "privacidade_design" },
  { slug: "historico-de-orientacoes/", topicId: null },
] as const;

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FLAG_RESUME = args.includes("--resume");
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_FORCE = args.includes("--force");

const FLAG_LIMIT = (() => {
  const idx = args.indexOf("--limit");
  if (idx !== -1 && args[idx + 1]) {
    const n = parseInt(args[idx + 1]!, 10);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  }
  return Infinity;
})();

const FLAG_YEAR_START = (() => {
  const idx = args.indexOf("--year-start");
  if (idx !== -1 && args[idx + 1]) {
    const n = parseInt(args[idx + 1]!, 10);
    return Number.isFinite(n) ? n : 2018;
  }
  return 2018; // GDPR took effect 2018; CNPD decisions before that follow a different regime
})();

const FLAG_YEAR_END = (() => {
  const idx = args.indexOf("--year-end");
  if (idx !== -1 && args[idx + 1]) {
    const n = parseInt(args[idx + 1]!, 10);
    return Number.isFinite(n) ? n : new Date().getFullYear();
  }
  return new Date().getFullYear();
})();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] ${msg}\n`);
}

function progress(current: number, total: number, label: string): void {
  const pct = total > 0 ? ((current / total) * 100).toFixed(1) : "?";
  log(`  ${label}: ${current}/${total} (${pct}%)`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  retries = MAX_RETRIES,
): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "AnsvarMCP/1.0 (portuguese-data-protection-mcp; contact: hello@ansvar.ai)",
          Accept: "text/html,application/xhtml+xml,application/pdf,*/*",
          "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.5",
        },
      });
      clearTimeout(timeout);

      if (res.ok) return res;

      if (res.status >= 500 && attempt < retries) {
        log(`  HTTP ${res.status} for ${url} — retry ${attempt}/${retries}`);
        await sleep(RETRY_BACKOFF_MS * attempt);
        continue;
      }

      throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
    } catch (err) {
      if (attempt === retries) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log(`  Fetch error (attempt ${attempt}/${retries}): ${msg}`);
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new Error(`Exhausted retries for ${url}`);
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  return res.text();
}

// ---------------------------------------------------------------------------
// PDF text extraction (naive, for text-based PDFs)
// ---------------------------------------------------------------------------

function extractTextFromPdfBuffer(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const chunks: string[] = [];

  // Tj operator: (text) Tj
  const tjRegex = /\(([^)]*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tjRegex.exec(raw)) !== null) {
    if (m[1]) chunks.push(decodePdfString(m[1]));
  }

  // TJ array: [(text) num (text) ...] TJ
  const tjArrayRegex = /\[((?:\([^)]*\)|[^\]])*)\]\s*TJ/gi;
  while ((m = tjArrayRegex.exec(raw)) !== null) {
    if (!m[1]) continue;
    const partRe = /\(([^)]*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(m[1])) !== null) {
      if (pm[1]) chunks.push(decodePdfString(pm[1]));
    }
  }

  if (chunks.length === 0) {
    return "";
  }

  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function decodePdfString(s: string): string {
  return s
    .replace(/\\(\d{3})/g, (_, oct: string) =>
      String.fromCharCode(parseInt(oct, 8)),
    )
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")");
}

async function fetchPdfText(url: string): Promise<string> {
  const res = await fetchWithRetry(url);
  const contentType = res.headers.get("content-type") ?? "";

  // Some PDF URLs serve HTML pages instead
  if (contentType.includes("text/html")) {
    const html = await res.text();
    const $ = cheerio.load(html);
    // Extract main content from HTML fallback
    const mainText =
      $("article").text() ||
      $(".content").text() ||
      $("main").text() ||
      $("body").text();
    return mainText.replace(/\s+/g, " ").trim();
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const text = extractTextFromPdfBuffer(buf);
  return text;
}

async function fetchDecisionContent(url: string): Promise<string> {
  try {
    const text = await fetchPdfText(url);
    if (text.length < 50) {
      return `[Conteúdo PDF disponível em ${url} — extração pendente]`;
    }
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Falha ao obter PDF: ${msg} — URL: ${url}]`;
  }
}

// ---------------------------------------------------------------------------
// Parsing: historical decision search results
// ---------------------------------------------------------------------------

interface DecisionListEntry {
  title: string;
  type: string; // raw type from listing: "Deliberação", "Parecer", "Diretriz", etc.
  downloadPath: string;
  subject: string;
}

/**
 * Parse the historical decision search results page.
 *
 * The CNPD site (Umbraco CMS) renders decision listings as linked cards.
 * Each entry typically appears as a clickable block with:
 *   - The decision reference (e.g. "Parecer 58/2024")
 *   - The recipient/entity
 *   - The subject description
 *   - A link to /umbraco/surface/cnpdDecision/download/NNNNN
 */
function parseDecisionSearchResults(html: string): {
  entries: DecisionListEntry[];
  totalResults: number;
  totalPages: number;
} {
  const $ = cheerio.load(html);
  const entries: DecisionListEntry[] = [];

  // Total results: look for "NN registos encontrados"
  let totalResults = 0;
  const bodyText = $("body").text();
  const countMatch = bodyText.match(/(\d+)\s*registos?\s*encontrados?/i);
  if (countMatch?.[1]) {
    totalResults = parseInt(countMatch[1], 10);
  }

  // Each decision entry links to /umbraco/surface/cnpdDecision/download/NNNNN
  $('a[href*="/umbraco/surface/cnpdDecision/download/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    const fullText = $a.text().trim();
    if (!fullText) return;

    // Split the link text into lines to extract parts
    const lines = fullText
      .split(/\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    // First line is typically the reference: "Parecer 58/2024" or "Deliberação 279/2024"
    const refLine = lines[0] ?? fullText;
    // Remaining lines form the subject/description
    const subject = lines.slice(1).join(" — ").trim();

    // Detect type from the reference line
    const type = classifyEntryType(refLine);

    entries.push({
      title: refLine,
      type,
      downloadPath: href,
      subject,
    });
  });

  const totalPages = totalResults > 0 ? Math.ceil(totalResults / PAGE_SIZE) : 1;

  return { entries, totalResults, totalPages };
}

/**
 * Parse guidance/orientacoes pages.
 *
 * Orientacoes pages list documents as links to PDF files under /media/.
 * Each entry has a title and sometimes a date.
 */
interface OrientacaoEntry {
  title: string;
  pdfUrl: string;
  date: string | null;
  topicId: string | null;
}

function parseOrientacoesPage(
  html: string,
  topicId: string | null,
): OrientacaoEntry[] {
  const $ = cheerio.load(html);
  const entries: OrientacaoEntry[] = [];

  // Links to PDF files
  $('a[href*="/media/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;
    // Only include PDF links
    if (!href.toLowerCase().endsWith(".pdf")) return;

    const title = $a.text().trim();
    if (!title || title.length < 5) return;

    // Try to find a date near the link
    let date: string | null = null;
    const parentText = $a.parent().text();
    const dateMatch = parentText.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dateMatch?.[1] && dateMatch[2] && dateMatch[3]) {
      const day = dateMatch[1].padStart(2, "0");
      const month = dateMatch[2].padStart(2, "0");
      date = `${dateMatch[3]}-${month}-${day}`;
    }

    const pdfUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    entries.push({ title, pdfUrl, date, topicId });
  });

  // Also check for /umbraco/surface/cnpdDecision/download/ links on this page
  $('a[href*="/umbraco/surface/cnpdDecision/download/"]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr("href");
    if (!href) return;

    const title = $a.text().trim();
    if (!title || title.length < 5) return;

    const pdfUrl = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    entries.push({ title, pdfUrl, date: null, topicId });
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function classifyEntryType(refLine: string): string {
  const lower = refLine.toLowerCase();
  if (lower.startsWith("deliberação") || lower.includes("deliberação"))
    return "deliberacao";
  if (lower.startsWith("parecer") || lower.includes("parecer"))
    return "parecer";
  if (lower.startsWith("diretriz") || lower.includes("diretriz"))
    return "diretriz";
  if (lower.startsWith("autorização") || lower.includes("autorização"))
    return "autorizacao";
  if (lower.startsWith("regulamento") || lower.includes("regulamento"))
    return "regulamento";
  if (lower.startsWith("registo") || lower.includes("registo"))
    return "registo";
  return "decisao";
}

/**
 * Map CNPD decision types to the DB schema categories.
 * Decisions table: deliberações, pareceres, coimas, diretrizes
 * Guidelines table: orientações, recomendações
 */
function isDecisionType(type: string): boolean {
  return [
    "deliberacao",
    "parecer",
    "diretriz",
    "autorizacao",
    "regulamento",
    "registo",
    "decisao",
  ].includes(type);
}

/**
 * Extract a stable reference identifier from the title/reference line.
 *
 * Patterns:
 *   "Deliberação 279/2024"  → "CNPD-DELIB-2024-279"
 *   "Parecer 58/2024"       → "CNPD-PAR-2024-058"
 *   "Diretriz 1/2023"       → "CNPD-DIR-2023-001"
 *   "Deliberação 137/2024"  → "CNPD-DELIB-2024-137"
 */
function extractReference(title: string, type: string): string {
  const prefixMap: Record<string, string> = {
    deliberacao: "CNPD-DELIB",
    parecer: "CNPD-PAR",
    diretriz: "CNPD-DIR",
    autorizacao: "CNPD-AUT",
    regulamento: "CNPD-REG",
    registo: "CNPD-REGISTO",
    decisao: "CNPD-DEC",
  };

  const prefix = prefixMap[type] ?? "CNPD-DEC";

  // Match "NNN/YYYY" pattern
  const numYearMatch = title.match(/(\d{1,4})\s*\/\s*(\d{4})/);
  if (numYearMatch?.[1] && numYearMatch[2]) {
    const num = numYearMatch[1].padStart(3, "0");
    return `${prefix}-${numYearMatch[2]}-${num}`;
  }

  // Match "n.º N/YYYY" or "nº N/YYYY"
  const nrMatch = title.match(/n[.º°]+\s*(\d{1,4})\s*\/\s*(\d{4})/i);
  if (nrMatch?.[1] && nrMatch[2]) {
    const num = nrMatch[1].padStart(3, "0");
    return `${prefix}-${nrMatch[2]}-${num}`;
  }

  // Fallback: slug from title
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 60)
    .replace(/-$/, "");
  return `${prefix}-${slug}`;
}

/**
 * Extract a reference for orientation documents.
 */
function extractOrientacaoReference(title: string, pdfUrl: string): string {
  // Try to extract from the PDF filename
  const filenameMatch = pdfUrl.match(/\/([^/]+)\.pdf$/i);
  const filename = filenameMatch?.[1] ?? "";

  // Try deliberation/orientation number from title
  const numMatch = title.match(
    /(?:Deliberação|Orientaç|Princípios)\s+(?:n[.º°]+\s*)?(\d+)/i,
  );
  if (numMatch?.[1]) {
    return `CNPD-ORIENT-${numMatch[1]}`;
  }

  // Use cleaned filename as fallback
  const slug = filename
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 60)
    .replace(/-$/, "");
  return `CNPD-ORIENT-${slug || "unknown"}`;
}

/**
 * Extract a date from a decision title.
 *
 * Patterns:
 *   "de 12 de março de 2024" → "2024-03-12"
 *   Just the year "2024" from "Parecer 58/2024" → "2024-01-01"
 */
function parseDateFromTitle(title: string): string | null {
  const MONTHS_PT: Record<string, string> = {
    janeiro: "01",
    fevereiro: "02",
    março: "03",
    marco: "03",
    abril: "04",
    maio: "05",
    junho: "06",
    julho: "07",
    agosto: "08",
    setembro: "09",
    outubro: "10",
    novembro: "11",
    dezembro: "12",
  };

  // Match "de DD de mês de YYYY"
  const fullMatch = title.match(
    /(?:de\s+)?(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})/i,
  );
  if (fullMatch?.[1] && fullMatch[2] && fullMatch[3]) {
    const day = fullMatch[1].padStart(2, "0");
    const monthStr = fullMatch[2].toLowerCase();
    const month = MONTHS_PT[monthStr];
    if (month) {
      return `${fullMatch[3]}-${month}-${day}`;
    }
  }

  // Match "DD/MM/YYYY"
  const slashMatch = title.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch?.[1] && slashMatch[2] && slashMatch[3]) {
    const day = slashMatch[1].padStart(2, "0");
    const month = slashMatch[2].padStart(2, "0");
    return `${slashMatch[3]}-${month}-${day}`;
  }

  // Extract year from reference pattern "NNN/YYYY"
  const yearMatch = title.match(/\/(\d{4})/);
  if (yearMatch?.[1]) {
    return `${yearMatch[1]}-01-01`;
  }

  return null;
}

/**
 * Try to extract a fine amount from text.
 * Patterns: "600.000 euros", "EUR 250.000", "250 000 €", "coima de 150000 euros"
 */
function extractFineAmount(text: string): number | null {
  const patterns = [
    /coima\s+de\s+(\d[\d.\s]*\d)\s*(?:euros?|EUR|€)/i,
    /(\d[\d.\s]*\d)\s*(?:euros?|EUR|€)/i,
    /(?:euros?|EUR|€)\s*(\d[\d.\s]*\d)/i,
    /sanção\s+pecuniária[^.]{0,40}?(\d[\d.\s]*\d)\s*(?:euros?|EUR|€)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const numStr = match[1].replace(/\s/g, "").replace(/\./g, "");
      const amount = parseInt(numStr, 10);
      if (Number.isFinite(amount) && amount > 0) {
        return amount;
      }
    }
  }
  return null;
}

/**
 * Extract GDPR article references from text.
 * Returns JSON array string or null.
 */
function extractGdprArticles(text: string): string | null {
  const articles = new Set<string>();

  // "art. 5", "artigo 17", "art. 6.º", "artigos 5.º e 6.º"
  const re =
    /(?:art(?:igo)?s?\.?\s*)(\d{1,3})[.º]*(?:\s*(?:,|e)\s*(?:art(?:igo)?s?\.?\s*)?(\d{1,3})[.º]*)?/gi;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match[1]) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= 99) articles.add(match[1]);
    }
    if (match[2]) {
      const num = parseInt(match[2], 10);
      if (num >= 1 && num <= 99) articles.add(match[2]);
    }
  }

  // "RGPD" + article number
  const rgpdRe = /RGPD\s*[,-]?\s*art(?:igo)?s?\.?\s*(\d{1,3})/gi;
  while ((match = rgpdRe.exec(text)) !== null) {
    if (match[1]) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= 99) articles.add(match[1]);
    }
  }

  if (articles.size === 0) return null;
  return JSON.stringify(
    [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
  );
}

/**
 * Attempt to classify topics from text content.
 * Returns JSON array string of topic IDs.
 */
function classifyTopics(text: string): string | null {
  const topics: string[] = [];
  const lower = text.toLowerCase();

  const TOPIC_KEYWORDS: Record<string, string[]> = {
    consentimento: ["consentimento", "consentir", "consentida"],
    cookies: ["cookies", "rastreador", "rastreamento", "rastreio"],
    transferencias: [
      "transferência internacional",
      "transferências internacionais",
      "países terceiros",
      "cláusulas contratuais",
      "schrems",
    ],
    avaliacao_impacto: [
      "avaliação de impacto",
      "aipd",
      "dpia",
      "impacto sobre a proteção",
    ],
    violacao_dados: [
      "violação de dados",
      "violações de dados",
      "data breach",
      "notificação de violação",
      "incidente de segurança",
    ],
    privacidade_design: [
      "privacidade desde a conceção",
      "privacy by design",
      "proteção desde a conceção",
    ],
    empregados: [
      "trabalhador",
      "trabalhadores",
      "empregado",
      "laboral",
      "teletrabalho",
      "local de trabalho",
    ],
    saude: [
      "dados de saúde",
      "saúde",
      "hospital",
      "clínico",
      "doente",
      "paciente",
      "farmaco",
    ],
    direitos_titulares: [
      "direito de acesso",
      "direito de oposição",
      "direito ao apagamento",
      "portabilidade",
      "retificação",
      "direitos dos titulares",
    ],
    videovigilancia: [
      "videovigilância",
      "câmara",
      "câmaras",
      "vídeo vigilância",
      "cctv",
    ],
  };

  for (const [topicId, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        topics.push(topicId);
        break;
      }
    }
  }

  if (topics.length === 0) return null;
  return JSON.stringify(topics);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function openDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    log(`Deleted existing database at ${DB_PATH}`);
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

function getExistingReferences(db: Database.Database): Set<string> {
  const refs = new Set<string>();

  const decRows = db
    .prepare("SELECT reference FROM decisions")
    .all() as { reference: string }[];
  for (const r of decRows) refs.add(r.reference);

  const gRows = db
    .prepare("SELECT reference FROM guidelines WHERE reference IS NOT NULL")
    .all() as { reference: string }[];
  for (const r of gRows) {
    if (r.reference) refs.add(r.reference);
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Topic seeding
// ---------------------------------------------------------------------------

interface TopicSeed {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const TOPICS: TopicSeed[] = [
  {
    id: "consentimento",
    name_local: "Consentimento",
    name_en: "Consent",
    description:
      "Recolha, validade e revogação do consentimento para o tratamento de dados pessoais (art. 7.º RGPD).",
  },
  {
    id: "cookies",
    name_local: "Cookies e rastreadores",
    name_en: "Cookies and trackers",
    description:
      "Colocação e leitura de cookies e rastreadores no dispositivo do utilizador (Lei das Comunicações Eletrónicas).",
  },
  {
    id: "transferencias",
    name_local: "Transferências internacionais",
    name_en: "International transfers",
    description:
      "Transferência de dados pessoais para países terceiros ou organizações internacionais (art. 44.º–49.º RGPD).",
  },
  {
    id: "avaliacao_impacto",
    name_local: "Avaliação de impacto (AIPD)",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description:
      "Avaliação dos riscos para os direitos e liberdades dos titulares em tratamentos de elevado risco (art. 35.º RGPD).",
  },
  {
    id: "violacao_dados",
    name_local: "Violação de dados pessoais",
    name_en: "Data breach notification",
    description:
      "Notificação de violações de dados pessoais à CNPD e aos titulares afetados (art. 33.º–34.º RGPD).",
  },
  {
    id: "privacidade_design",
    name_local: "Privacidade desde a conceção",
    name_en: "Privacy by design",
    description:
      "Integração da proteção de dados desde a conceção e por defeito (art. 25.º RGPD).",
  },
  {
    id: "empregados",
    name_local: "Dados de trabalhadores",
    name_en: "Employee data",
    description:
      "Tratamento de dados pessoais em contexto laboral e monitorização de trabalhadores.",
  },
  {
    id: "saude",
    name_local: "Dados de saúde",
    name_en: "Health data",
    description:
      "Tratamento de dados de saúde — categorias especiais com garantias reforçadas (art. 9.º RGPD).",
  },
  {
    id: "direitos_titulares",
    name_local: "Direitos dos titulares",
    name_en: "Data subject rights",
    description:
      "Direitos dos titulares de dados: acesso, retificação, apagamento, portabilidade e oposição (art. 12.º–23.º RGPD).",
  },
  {
    id: "videovigilancia",
    name_local: "Videovigilância",
    name_en: "Video surveillance",
    description:
      "Videovigilância em espaços públicos, locais de trabalho e zonas residenciais.",
  },
  {
    id: "educacao",
    name_local: "Educação",
    name_en: "Education",
    description:
      "Tratamento de dados pessoais no setor educativo, incluindo dados de alunos e pessoal docente.",
  },
  {
    id: "epd",
    name_local: "Encarregado de proteção de dados",
    name_en: "Data Protection Officer",
    description:
      "Designação, funções e posição do encarregado de proteção de dados (art. 37.º–39.º RGPD).",
  },
  {
    id: "marketing",
    name_local: "Marketing direto",
    name_en: "Direct marketing",
    description:
      "Comunicações eletrónicas de marketing direto e prospeção comercial.",
  },
  {
    id: "biometria",
    name_local: "Dados biométricos",
    name_en: "Biometric data",
    description:
      "Tratamento de dados biométricos para controlo de acessos e assiduidade (art. 9.º RGPD).",
  },
  {
    id: "setor_publico",
    name_local: "Setor público",
    name_en: "Public sector",
    description:
      "Tratamento de dados pessoais por entidades públicas e administração pública.",
  },
  {
    id: "seguranca",
    name_local: "Segurança do tratamento",
    name_en: "Security of processing",
    description:
      "Medidas técnicas e organizacionais de segurança aplicáveis ao tratamento de dados pessoais (art. 32.º RGPD).",
  },
];

function seedTopics(db: Database.Database): void {
  log("=== Phase 0: Topics ===");

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
  );

  if (!FLAG_DRY_RUN) {
    const tx = db.transaction(() => {
      for (const t of TOPICS) {
        stmt.run(t.id, t.name_local, t.name_en, t.description);
      }
    });
    tx();
  }

  log(`  Seeded ${TOPICS.length} topics`);
}

// ---------------------------------------------------------------------------
// Phase 1: Historical decisions (deliberações + pareceres + diretrizes)
// ---------------------------------------------------------------------------

interface IngestStats {
  decisionsFound: number;
  decisionsInserted: number;
  decisionsSkipped: number;
  guidelinesFound: number;
  guidelinesInserted: number;
  guidelinesSkipped: number;
  errors: number;
}

async function ingestHistoricalDecisions(
  db: Database.Database,
  existingRefs: Set<string>,
  stats: IngestStats,
): Promise<void> {
  log("=== Phase 1: Historical decisions ===");
  log(
    `  Crawling years ${FLAG_YEAR_START}–${FLAG_YEAR_END} from ${BASE_URL}${HISTORY_SEARCH_PATH}`,
  );

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalInserted = 0;

  for (
    let year = FLAG_YEAR_END;
    year >= FLAG_YEAR_START;
    year--
  ) {
    if (totalInserted >= FLAG_LIMIT) {
      log(`  Reached --limit ${FLAG_LIMIT}, stopping`);
      break;
    }

    log(`  Year ${year}:`);

    // Fetch first page to get total count
    const firstUrl = `${BASE_URL}${HISTORY_SEARCH_PATH}?year=${year}&type=&ent=&pgd=1`;
    let firstHtml: string;
    try {
      firstHtml = await fetchHtml(firstUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    Failed to fetch year ${year}: ${msg}`);
      stats.errors++;
      continue;
    }

    const firstParsed = parseDecisionSearchResults(firstHtml);
    const totalResults = firstParsed.totalResults;
    const totalPages = firstParsed.totalPages;

    log(`    ${totalResults} records, ${totalPages} pages`);

    // Process entries from first page
    await processDecisionEntries(
      db,
      insertStmt,
      firstParsed.entries,
      existingRefs,
      stats,
      totalInserted,
    );
    totalInserted += firstParsed.entries.filter((e) => {
      const ref = extractReference(e.title, e.type);
      return !FLAG_RESUME || !existingRefs.has(ref);
    }).length;

    // Crawl remaining pages
    for (let page = 2; page <= totalPages; page++) {
      if (totalInserted >= FLAG_LIMIT) break;

      await sleep(RATE_LIMIT_MS);
      progress(page, totalPages, `year ${year} page`);

      const url = `${BASE_URL}${HISTORY_SEARCH_PATH}?year=${year}&type=&ent=&pgd=${page}`;
      try {
        const html = await fetchHtml(url);
        const parsed = parseDecisionSearchResults(html);

        if (parsed.entries.length === 0) {
          log(`    No more entries on page ${page}, stopping year ${year}`);
          break;
        }

        await processDecisionEntries(
          db,
          insertStmt,
          parsed.entries,
          existingRefs,
          stats,
          totalInserted,
        );
        totalInserted += parsed.entries.filter((e) => {
          const ref = extractReference(e.title, e.type);
          return !FLAG_RESUME || !existingRefs.has(ref);
        }).length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`    Error on page ${page}: ${msg} — continuing`);
        stats.errors++;
      }
    }

    // Rate limit between years
    await sleep(RATE_LIMIT_MS);
  }
}

async function processDecisionEntries(
  db: Database.Database,
  insertStmt: Database.Statement,
  entries: DecisionListEntry[],
  existingRefs: Set<string>,
  stats: IngestStats,
  _currentTotal: number,
): Promise<void> {
  for (const entry of entries) {
    stats.decisionsFound++;

    const reference = extractReference(entry.title, entry.type);

    if (FLAG_RESUME && existingRefs.has(reference)) {
      stats.decisionsSkipped++;
      continue;
    }

    log(`    [${stats.decisionsInserted + 1}] ${reference}: ${entry.title}`);

    // Build download URL
    const downloadUrl = entry.downloadPath.startsWith("http")
      ? entry.downloadPath
      : `${BASE_URL}${entry.downloadPath.startsWith("/") ? "" : "/"}${entry.downloadPath}`;

    // Rate limit before PDF fetch
    await sleep(RATE_LIMIT_MS);

    let fullText: string;
    try {
      fullText = await fetchDecisionContent(downloadUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`      PDF fetch error: ${msg}`);
      fullText = `[PDF indisponível — URL: ${downloadUrl}]`;
      stats.errors++;
    }

    const date = parseDateFromTitle(entry.title);
    const fineAmount =
      extractFineAmount(fullText) ?? extractFineAmount(entry.subject);
    const gdprArticles = extractGdprArticles(fullText);
    const topics =
      classifyTopics(fullText) ?? classifyTopics(entry.subject);

    if (!FLAG_DRY_RUN) {
      try {
        insertStmt.run(
          reference,
          entry.title,
          date,
          entry.type,
          null, // entity_name — not reliably extractable from listing
          fineAmount,
          entry.subject || null,
          fullText,
          topics,
          gdprArticles,
          "final",
        );
        stats.decisionsInserted++;
        existingRefs.add(reference);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`      DB insert error: ${msg}`);
        stats.errors++;
      }
    } else {
      log(
        `      [dry-run] would insert: ${reference} (type=${entry.type}, date=${date})`,
      );
      stats.decisionsInserted++;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Current-year pages
// ---------------------------------------------------------------------------

async function ingestCurrentPages(
  db: Database.Database,
  existingRefs: Set<string>,
  stats: IngestStats,
): Promise<void> {
  log("=== Phase 2: Current-year decision pages ===");

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [label, path] of Object.entries(CURRENT_PAGES)) {
    log(`  Crawling ${label} from ${BASE_URL}${path}`);

    await sleep(RATE_LIMIT_MS);

    let html: string;
    try {
      html = await fetchHtml(`${BASE_URL}${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    Failed to fetch ${label}: ${msg}`);
      stats.errors++;
      continue;
    }

    const parsed = parseDecisionSearchResults(html);
    log(`    Found ${parsed.entries.length} entries`);

    await processDecisionEntries(
      db,
      insertStmt,
      parsed.entries,
      existingRefs,
      stats,
      0,
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Orientações (guidance documents)
// ---------------------------------------------------------------------------

async function ingestOrientacoes(
  db: Database.Database,
  existingRefs: Set<string>,
  stats: IngestStats,
): Promise<void> {
  log("=== Phase 3: Orientações (guidance) ===");

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const topic of ORIENTACOES_TOPICS) {
    const url = `${BASE_URL}${ORIENTACOES_BASE}${topic.slug}`;
    log(`  Crawling orientações: ${topic.slug}`);

    await sleep(RATE_LIMIT_MS);

    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`    Failed to fetch ${topic.slug}: ${msg}`);
      stats.errors++;
      continue;
    }

    const entries = parseOrientacoesPage(html, topic.topicId);
    log(`    Found ${entries.length} documents`);
    stats.guidelinesFound += entries.length;

    for (const entry of entries) {
      const reference = extractOrientacaoReference(entry.title, entry.pdfUrl);

      if (FLAG_RESUME && existingRefs.has(reference)) {
        stats.guidelinesSkipped++;
        continue;
      }

      log(`    [${stats.guidelinesInserted + 1}] ${reference}: ${entry.title.substring(0, 80)}`);

      await sleep(RATE_LIMIT_MS);

      let fullText: string;
      try {
        fullText = await fetchDecisionContent(entry.pdfUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`      PDF fetch error: ${msg}`);
        fullText = `[PDF indisponível — URL: ${entry.pdfUrl}]`;
        stats.errors++;
      }

      const topics = entry.topicId
        ? JSON.stringify([entry.topicId])
        : classifyTopics(fullText) ?? classifyTopics(entry.title);

      if (!FLAG_DRY_RUN) {
        try {
          insertStmt.run(
            reference,
            entry.title,
            entry.date,
            "orientacao",
            null, // summary — extracted from full text if needed
            fullText,
            topics,
            "pt",
          );
          stats.guidelinesInserted++;
          existingRefs.add(reference);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`      DB insert error: ${msg}`);
          stats.errors++;
        }
      } else {
        log(
          `      [dry-run] would insert: ${reference} (date=${entry.date})`,
        );
        stats.guidelinesInserted++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("CNPD (Comissão Nacional de Proteção de Dados) ingestion crawler");
  log(`  Database: ${DB_PATH}`);
  log(
    `  Flags: resume=${FLAG_RESUME} dry-run=${FLAG_DRY_RUN} force=${FLAG_FORCE} limit=${FLAG_LIMIT === Infinity ? "none" : FLAG_LIMIT}`,
  );
  log(`  Year range: ${FLAG_YEAR_START}–${FLAG_YEAR_END}`);
  log("");

  // Always open the DB so prepare() calls work in all phases.
  // Writes are gated by FLAG_DRY_RUN inside each processing function.
  const db = openDb();

  const existingRefs = getExistingReferences(db);
  log(`  Existing references in DB: ${existingRefs.size}`);

  const stats: IngestStats = {
    decisionsFound: 0,
    decisionsInserted: 0,
    decisionsSkipped: 0,
    guidelinesFound: 0,
    guidelinesInserted: 0,
    guidelinesSkipped: 0,
    errors: 0,
  };

  try {
    seedTopics(db);

    // Phase 1: Historical decisions via search
    await ingestHistoricalDecisions(db, existingRefs, stats);

    // Phase 2: Current-year pages (catches recent decisions not yet in history)
    await ingestCurrentPages(db, existingRefs, stats);

    // Phase 3: Orientações / guidance
    await ingestOrientacoes(db, existingRefs, stats);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FATAL: ${msg}`);
    stats.errors++;
  } finally {
    log("");
    log("=== Ingestion Summary ===");
    log(`  Decisions found:     ${stats.decisionsFound}`);
    log(`  Decisions inserted:  ${stats.decisionsInserted}`);
    log(`  Decisions skipped:   ${stats.decisionsSkipped}`);
    log(`  Guidelines found:    ${stats.guidelinesFound}`);
    log(`  Guidelines inserted: ${stats.guidelinesInserted}`);
    log(`  Guidelines skipped:  ${stats.guidelinesSkipped}`);
    log(`  Errors:              ${stats.errors}`);

    if (!FLAG_DRY_RUN) {
      const decisionCount = (
        db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
          cnt: number;
        }
      ).cnt;
      const guidelineCount = (
        db.prepare("SELECT count(*) as cnt FROM guidelines").get() as {
          cnt: number;
        }
      ).cnt;
      const topicCount = (
        db.prepare("SELECT count(*) as cnt FROM topics").get() as {
          cnt: number;
        }
      ).cnt;
      log("");
      log("Database totals:");
      log(`  Topics:     ${topicCount}`);
      log(`  Decisions:  ${decisionCount}`);
      log(`  Guidelines: ${guidelineCount}`);
    }

    db.close();
    log("\nDone.");
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal: ${msg}\n`);
  process.exit(1);
});
