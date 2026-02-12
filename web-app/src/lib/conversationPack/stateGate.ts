/**
 * Retrieval Controller (formerly State Gate).
 * Classifies user intent, detects special routes, selects lanes.
 * Target: < 1ms (pure string ops, no model).
 */
import type { ConversationState, ConversationTurn, Intent, Tone, LengthBudget, SpecialRoute, Lane } from './types.js';

// ── Keyword lists ────────────────────────────────────────────────────

const QUESTION_SIGNALS = [
  'what', 'how', 'why', 'when', 'where', 'who', 'which', 'can you',
  'could you', 'tell me', 'explain', 'define', 'meaning', '?',
];

const DEBUG_SIGNALS = [
  'error', 'bug', 'broken', 'crash', 'fail', 'issue', 'debug',
  'wrong', 'not working', 'doesnt work', "doesn't work", 'stuck',
  'exception', 'trace', 'log', 'undefined', 'null',
];

const BRAINSTORM_SIGNALS = [
  'idea', 'brainstorm', 'think about', 'what if', 'maybe',
  'possibility', 'option', 'approach', 'strategy', 'alternative',
  'consider', 'explore', 'creative', 'imagine',
];

const VENT_SIGNALS = [
  'stressed', 'frustrated', 'angry', 'upset', 'worried', 'anxious',
  'scared', 'tired', 'exhausted', 'overwhelmed', 'hate', 'ugh',
  'damn', 'messed up', 'screwed', 'freaking', 'panic',
];

const DECIDE_SIGNALS = [
  'choose', 'decide', 'pick', 'option', 'versus', 'vs', 'or',
  'should i', 'which one', 'better', 'compare', 'trade-off',
  'tradeoff', 'pros', 'cons', 'fast', 'quick', 'give me two',
];

const SMALLTALK_SIGNALS = [
  'hey', 'hi', 'hello', 'sup', 'yo', 'what\'s up', 'whats up',
  'howdy', 'thanks', 'thank you', 'cool', 'nice', 'ok', 'okay',
  'sure', 'got it', 'bye', 'later', 'see ya', 'morning', 'evening',
];

const SENSITIVE_SIGNALS = [
  'hack', 'password', 'crack', 'exploit', 'ddos', 'attack',
  'steal', 'illegal', 'weapon', 'harm', 'kill', 'suicide',
  'drug', 'bomb', 'phish', 'malware', 'ransomware', 'brute force',
];

const WARM_SIGNALS = [
  'stressed', 'worried', 'anxious', 'scared', 'help', 'please',
  'messed up', 'overwhelmed', 'panic', 'confused', 'lost',
];

const BLUNT_SIGNALS = [
  'fast', 'quick', 'hurry', 'just tell me', 'short', 'tldr',
  'give me', 'now', 'asap', 'straight', 'direct',
];

// ── Special route patterns ───────────────────────────────────────────

const GREETING_PATTERNS = [
  /^hey\b/i,
  /^hi\b/i,
  /^hello\b/i,
  /^yo\b/i,
  /^sup\b/i,
  /^howdy\b/i,
  /^what'?s\s+up/i,
  /^good\s+(morning|evening|afternoon)/i,
  /^how\s+are\s+you/i,
  /^how'?s\s+it\s+going/i,
  /hello.*how\s+are/i,
  /hey.*how\s+are/i,
  /hi.*how\s+are/i,
];

const IDENTITY_PATTERNS = [
  /who\s+are\s+you/i,
  /what\s+are\s+you/i,
  /what's\s+your\s+name/i,
  /whats\s+your\s+name/i,
  /your\s+name/i,
  /introduce\s+yourself/i,
  /tell\s+me\s+about\s+yourself/i,
  /what\s+do\s+you\s+do/i,
  /who\s+is\s+iris/i,
  /are\s+you\s+iris/i,
];

const FOLLOWUP_PATTERNS = [
  /tell\s+me\s+more/i,
  /go\s+on/i,
  /more\s+about\s+that/i,
  /continue/i,
  /keep\s+going/i,
  /expand\s+on/i,
  /elaborate/i,
  /what\s+else/i,
  /and\s+then/i,
  /more\s+detail/i,
  /dig\s+deeper/i,
];

const CLARIFY_PATTERNS = [
  /no\s+idea/i,
  /don'?t\s+understand/i,
  /what\s+do\s+you\s+mean/i,
  /confused/i,
  /makes?\s+no\s+sense/i,
  /huh\??/i,
  /what\??$/i,
  /lost\s+me/i,
  /over\s+my\s+head/i,
  /too\s+technical/i,
  /can\s+you\s+simplify/i,
  /say\s+that\s+again/i,
  /i'?m\s+lost/i,
  /what\s+are\s+you\s+saying/i,
  /what\s+are\s+you\s+talking/i,
];

const META_KNOWLEDGE_PATTERNS = [
  /your\s+architecture/i,
  /how\s+(?:do|are)\s+you\s+built/i,
  /how\s+(?:do|were)\s+you\s+(?:work|made|created)/i,
  /what\s+(?:tech|stack|pipeline)/i,
  /4.?lane\s+rag/i,
  /four.?lane/i,
  /why\s+do\s+you\s+use/i,
  /what\s+changed\s+recently/i,
  /recent\s+changes/i,
  /what'?s\s+new/i,
  /your\s+(?:design|system|pipeline|stack)/i,
  /under\s+the\s+hood/i,
  /how\s+(?:does|do)\s+your\s+(?:rag|retrieval|pipeline)/i,
  /what\s+models?\s+(?:do|can)\s+you/i,
  /state\s+machine/i,
  /fsm/i,
  /streaming\s+tts/i,
  /conversation\s+bias/i,
];

// ── Helper ───────────────────────────────────────────────────────────

function countMatches(input: string, signals: string[]): number {
  let count = 0;
  for (const sig of signals) {
    if (input.includes(sig)) count++;
  }
  return count;
}

function matchesAny(input: string, patterns: RegExp[]): boolean {
  for (const p of patterns) {
    if (p.test(input)) return true;
  }
  return false;
}

function extractKeywords(input: string): string[] {
  return input
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

/**
 * Detect if user is echoing back Iris's last reply.
 * Returns true if >60% token overlap with last Iris response.
 */
function detectEcho(userText: string, lastTurn: ConversationTurn | null): boolean {
  if (!lastTurn) return false;

  const userTokens = new Set(
    userText.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 1)
  );
  const irisTokens = lastTurn.irisText
    .toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 1);

  if (irisTokens.length === 0 || userTokens.size === 0) return false;

  let overlap = 0;
  for (const t of irisTokens) {
    if (userTokens.has(t)) overlap++;
  }

  return overlap / irisTokens.length > 0.6;
}

// ── Lane selection ───────────────────────────────────────────────────

function selectLanes(specialRoute: SpecialRoute, intent: Intent, sensitive: boolean): Lane[] {
  if (sensitive) return ['playbook'];

  if (specialRoute === 'identity') return ['persona'];
  if (specialRoute === 'greeting') return ['playbook'];
  if (specialRoute === 'followup') return ['playbook', 'knowledge'];
  if (specialRoute === 'clarify') return ['playbook'];
  if (specialRoute === 'echo') return ['playbook'];
  if (specialRoute === 'meta') return ['knowledge'];

  switch (intent) {
    case 'question':
      return ['playbook', 'knowledge', 'lore'];
    case 'smalltalk':
      return ['playbook', 'lore'];
    case 'debug':
    case 'brainstorm':
    case 'decide':
    case 'vent':
      return ['playbook', 'knowledge'];
    default:
      return ['playbook', 'knowledge', 'lore'];
  }
}

// ── Main classifier ──────────────────────────────────────────────────

export function classifyState(
  userText: string,
  lastTurn?: ConversationTurn | null,
): ConversationState {
  const lower = userText.toLowerCase().trim();

  // ── Detect special routes first ──
  let specialRoute: SpecialRoute = null;

  if (matchesAny(lower, IDENTITY_PATTERNS)) {
    specialRoute = 'identity';
  } else if (matchesAny(lower, META_KNOWLEDGE_PATTERNS)) {
    specialRoute = 'meta';
  } else if (matchesAny(lower, GREETING_PATTERNS)) {
    specialRoute = 'greeting';
  } else if (lastTurn && detectEcho(lower, lastTurn)) {
    specialRoute = 'echo';
  } else if (matchesAny(lower, FOLLOWUP_PATTERNS)) {
    specialRoute = 'followup';
  } else if (matchesAny(lower, CLARIFY_PATTERNS)) {
    specialRoute = 'clarify';
  }

  // ── Score each intent ──
  const scores: Record<Intent, number> = {
    question: countMatches(lower, QUESTION_SIGNALS),
    debug: countMatches(lower, DEBUG_SIGNALS),
    brainstorm: countMatches(lower, BRAINSTORM_SIGNALS),
    vent: countMatches(lower, VENT_SIGNALS),
    decide: countMatches(lower, DECIDE_SIGNALS),
    smalltalk: countMatches(lower, SMALLTALK_SIGNALS),
  };

  // Boost question if ends with ?
  if (lower.endsWith('?')) scores.question += 2;

  // Short utterances lean toward smalltalk only if no other signals
  // (Fixed: removed blanket wordCount <= 3 → smalltalk += 2 bias)
  const wordCount = lower.split(/\s+/).length;

  // Override intent for special routes
  if (specialRoute === 'identity') {
    scores.question += 3; // identity questions are questions
  } else if (specialRoute === 'meta') {
    scores.question += 3; // meta-architecture questions are questions
  } else if (specialRoute === 'greeting') {
    scores.smalltalk += 5; // greetings are always smalltalk
  } else if (specialRoute === 'followup') {
    scores.question += 2; // followups are continuations of substantive turns
  } else if (specialRoute === 'clarify') {
    scores.question += 1;
  }

  // Pick highest scoring intent
  let intent: Intent = 'smalltalk';
  let maxScore = 0;
  for (const [key, val] of Object.entries(scores) as [Intent, number][]) {
    if (val > maxScore) {
      maxScore = val;
      intent = key;
    }
  }

  // If no signals matched at all, default based on word count
  if (maxScore === 0) {
    intent = wordCount > 5 ? 'question' : 'smalltalk';
  }

  // Determine tone
  let tone: Tone = 'noir-dry';
  if (countMatches(lower, WARM_SIGNALS) >= 2) tone = 'warm';
  else if (countMatches(lower, BLUNT_SIGNALS) >= 2) tone = 'blunt';
  else if (intent === 'vent') tone = 'warm';

  // Determine length budget
  let length: LengthBudget = 'short';
  if (specialRoute === 'identity') length = 'short'; // concise intro
  else if (specialRoute === 'meta') length = 'medium'; // architecture answers need space
  else if (specialRoute === 'greeting') length = '1line'; // brief greeting
  else if (specialRoute === 'clarify') length = 'short';
  else if (specialRoute === 'echo') length = '1line';
  else if (intent === 'smalltalk' && wordCount <= 3 && !specialRoute) length = '1line';
  else if (intent === 'debug') length = 'medium';
  else if (intent === 'question' && wordCount > 10) length = 'medium';

  // Sensitivity check
  const sensitive = countMatches(lower, SENSITIVE_SIGNALS) > 0;

  // Extract keywords for downstream retrieval
  const keywords = extractKeywords(lower);

  // Select which lanes to query
  const selectedLanes = selectLanes(specialRoute, intent, sensitive);

  return { intent, tone, length, sensitive, keywords, specialRoute, selectedLanes };
}
