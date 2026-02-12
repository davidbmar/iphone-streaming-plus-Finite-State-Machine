/**
 * Session-to-JSONL indexer for self-referential meta-knowledge.
 * Reads session docs and ADRs from docs/project-memory/,
 * chunks by ## heading, and outputs PackItem-compatible JSONL.
 *
 * Usage: npx tsx scripts/index-sessions.ts > web-app/public/conversation_pack/meta_knowledge.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SESSIONS_DIR = path.join(ROOT, 'docs', 'project-memory', 'sessions');
const ADR_DIR = path.join(ROOT, 'docs', 'project-memory', 'adr');

const MAX_CHUNK_CHARS = 600;

interface PackItem {
  id: string;
  kind: 'explanation';
  intent: string[];
  tone: string[];
  length: string;
  domain: string[];
  usage: string;
  text: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Detect domain tags from content */
function detectDomains(text: string): string[] {
  const domains = new Set<string>(['meta']);
  const lower = text.toLowerCase();

  if (/\brag\b|retriev|vector|embed|rerank/.test(lower)) domains.add('architecture');
  if (/\bfsm\b|state\s+machine|turn\s+manage/.test(lower)) domains.add('architecture');
  if (/\btts\b|speech|voice|speak/.test(lower)) domains.add('tts');
  if (/\bstt\b|speech.to.text|listen/.test(lower)) domains.add('stt');
  if (/\bllm\b|model|webgpu|web-llm/.test(lower)) domains.add('llm');
  if (/\bplaywright\b|test|automat/.test(lower)) domains.add('testing');
  if (/\bpipeline\b|compose|lane/.test(lower)) domains.add('architecture');
  if (/\bbias\b|adapt|warmth|verbos/.test(lower)) domains.add('behavior');
  if (/\bpersona\b|character|iris/.test(lower)) domains.add('persona');

  return [...domains];
}

/** Split markdown by ## headings into chunks, capped at MAX_CHUNK_CHARS */
function chunkByHeading(content: string, sourceId: string): { heading: string; text: string }[] {
  const lines = content.split('\n');
  const chunks: { heading: string; text: string }[] = [];
  let currentHeading = 'header';
  let currentLines: string[] = [];

  function flush() {
    const text = currentLines.join('\n').trim();
    if (text.length > 0) {
      // Split long chunks
      if (text.length > MAX_CHUNK_CHARS) {
        const sentences = text.split(/(?<=[.!?])\s+/);
        let buf = '';
        let part = 1;
        for (const s of sentences) {
          if (buf.length + s.length > MAX_CHUNK_CHARS && buf.length > 0) {
            chunks.push({ heading: `${currentHeading} (part ${part})`, text: buf.trim() });
            buf = '';
            part++;
          }
          buf += s + ' ';
        }
        if (buf.trim()) {
          chunks.push({
            heading: part > 1 ? `${currentHeading} (part ${part})` : currentHeading,
            text: buf.trim(),
          });
        }
      } else {
        chunks.push({ heading: currentHeading, text });
      }
    }
    currentLines = [];
  }

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      currentHeading = line.replace(/^##\s*/, '');
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return chunks;
}

function processFile(filePath: string, prefix: string): PackItem[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath, '.md');
  const chunks = chunkByHeading(content, filename);

  return chunks.map((chunk, i) => ({
    id: `${prefix}-${slugify(filename)}-${slugify(chunk.heading)}-${i}`,
    kind: 'explanation' as const,
    intent: ['question'],
    tone: ['noir-dry', 'calm'],
    length: chunk.text.length > 300 ? 'medium' : 'short',
    domain: detectDomains(chunk.text),
    usage: 'paraphrase',
    text: `[${filename} — ${chunk.heading}] ${chunk.text}`,
  }));
}

// ── Main ────────────────────────────────────────────────────────────

const items: PackItem[] = [];

// Process sessions
if (fs.existsSync(SESSIONS_DIR)) {
  const sessionFiles = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.startsWith('S-') && f.endsWith('.md'));

  for (const file of sessionFiles) {
    items.push(...processFile(path.join(SESSIONS_DIR, file), 'meta-session'));
  }
}

// Process ADRs
if (fs.existsSync(ADR_DIR)) {
  const adrFiles = fs.readdirSync(ADR_DIR)
    .filter(f => f.startsWith('ADR-') && f.endsWith('.md'));

  for (const file of adrFiles) {
    items.push(...processFile(path.join(ADR_DIR, file), 'meta-adr'));
  }
}

// Output JSONL to stdout
for (const item of items) {
  process.stdout.write(JSON.stringify(item) + '\n');
}

process.stderr.write(`Indexed ${items.length} meta-knowledge chunks from ${items.length > 0 ? 'sessions + ADRs' : 'no files found'}\n`);
