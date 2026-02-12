/**
 * Generate a Markdown comparison report from model test results.
 * Reads JSON files from test-results/model-comparison/ and outputs comparison.md.
 *
 * Usage: npx tsx scripts/generate-report.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'test-results', 'model-comparison');
const OUTPUT_FILE = path.join(RESULTS_DIR, 'comparison.md');

interface PromptResult {
  promptId: string;
  promptText: string;
  category: string;
  responseText: string;
  latencyMs: number | null;
  llmUsed: boolean;
  intent: string;
}

interface ModelResult {
  modelId: string;
  loadTimeMs: number;
  prompts: PromptResult[];
  avgLatencyMs: number;
  llmUsageRate: number;
}

function loadResults(): ModelResult[] {
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('-results.json'));
  return files.map(f => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')));
}

function formatMs(ms: number | null): string {
  if (ms === null) return 'N/A';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function generateReport(results: ModelResult[]): string {
  const lines: string[] = [];

  lines.push('# Model Comparison Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Models tested: ${results.length}`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Model | Load Time | Avg Latency | LLM Usage % |');
  lines.push('|-------|-----------|-------------|-------------|');
  for (const r of results) {
    lines.push(
      `| ${r.modelId} | ${formatMs(r.loadTimeMs)} | ${formatMs(r.avgLatencyMs)} | ${Math.round(r.llmUsageRate * 100)}% |`,
    );
  }
  lines.push('');

  // Per-prompt comparison
  if (results.length > 0) {
    const prompts = results[0].prompts;

    lines.push('## Per-Prompt Comparison');
    lines.push('');

    for (const prompt of prompts) {
      lines.push(`### ${prompt.promptId}: "${prompt.promptText}"`);
      lines.push(`Category: ${prompt.category}`);
      lines.push('');

      for (const model of results) {
        const p = model.prompts.find(mp => mp.promptId === prompt.promptId);
        if (!p) continue;

        lines.push(`**${model.modelId}** (${formatMs(p.latencyMs)}, LLM: ${p.llmUsed ? 'yes' : 'no'}):`);
        lines.push(`> ${p.responseText.replace(/\n/g, '\n> ')}`);
        lines.push('');
      }

      lines.push('---');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────

if (!fs.existsSync(RESULTS_DIR)) {
  console.error(`No results directory found at ${RESULTS_DIR}`);
  console.error('Run tests first: npm run test:baseline or npm run test:models');
  process.exit(1);
}

const results = loadResults();
if (results.length === 0) {
  console.error('No result files found. Run tests first.');
  process.exit(1);
}

const report = generateReport(results);
fs.writeFileSync(OUTPUT_FILE, report);
console.log(`Report written to ${OUTPUT_FILE}`);
console.log(`Models: ${results.map(r => r.modelId).join(', ')}`);
