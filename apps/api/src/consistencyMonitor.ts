/**
 * Consistency Monitor v3 for Multi-Agent Systems
 *
 * Improved semantic similarity with:
 * - Stop-word filtering and word normalization
 * - N-gram overlap (bigrams) for better semantic matching
 * - Key phrase extraction for factual comparison
 * - Completeness checking (does output cover all input requirements?)
 * - v3: Disk persistence for consistency snapshots
 *
 * Based on research:
 * - Galileo AI "10 Multi-Agent Coordination Strategies" (2025)
 * - "Chain-of-Verification Reduces Hallucination in LLMs" (Dhuliawala et al., 2023)
 * - BERTScore methodology (Zhang et al., 2020)
 */

import { reportSilentFailure } from '@praetor/core';
import * as fs from 'fs';
import * as path from 'path';

const PERSISTENCE_DIR = '.commander_consistency';
const SNAPSHOT_FILE = 'consistency-snapshots.ndjson';

// REL-6: bound the snapshot log so it never becomes a disk-fill outage, and so
// reads never load the whole file. Once the file exceeds MAX_SNAPSHOT_BYTES it
// is rewritten to keep only the newest ROTATE_KEEP_LINES entries; reads scan
// only the last TAIL_READ_BYTES rather than the entire history.
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const ROTATE_KEEP_LINES = 1000;
const TAIL_READ_BYTES = 512 * 1024;

/**
 * Read the last `maxBytes` of a file and return its complete lines, oldest
 * first. If the read starts mid-file the leading partial line is discarded so
 * callers never parse a torn record. Bounded memory regardless of file size.
 */
function readTailLines(filePath: string, maxBytes: number): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    if (length <= 0) return [];
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf-8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

/** Rewrite the snapshot file in place, retaining only the newest lines. */
function rotateSnapshotFile(filePath: string): void {
  const kept = readTailLines(filePath, MAX_SNAPSHOT_BYTES).slice(-ROTATE_KEEP_LINES);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Append a consistency snapshot to disk (NDJSON format).
 * Non-blocking — failures are silently caught.
 */
export function persistConsistencySnapshot(report: ConsistencyReport, missionId?: string): void {
  try {
    const dir = path.resolve(process.cwd(), PERSISTENCE_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const record = {
      timestamp: new Date().toISOString(),
      missionId,
      report: {
        agentCount: report.agentCount,
        consistencyLevel: report.consistencyLevel,
        agreementScore: report.agreementScore,
        conflicts: report.conflicts.map((c) => ({
          agentIds: c.agentIds,
          conflictType: c.conflictType,
          severity: c.severity,
          description: c.description,
        })),
        bftStatus: report.bftStatus,
        completeness: report.completeness,
      },
    };
    const filePath = path.join(dir, SNAPSHOT_FILE);
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
    // Bound file growth: rotate once it exceeds the cap.
    try {
      if (fs.statSync(filePath).size > MAX_SNAPSHOT_BYTES) {
        rotateSnapshotFile(filePath);
      }
    } catch (rotateErr) {
      reportSilentFailure(rotateErr, 'consistencyMonitor:rotate');
    }
  } catch (err) {
    reportSilentFailure(err, 'consistencyMonitor:53');
    /* best-effort persistence */
  }
}

/**
 * Load persisted consistency snapshots from disk. Reads only the tail of the
 * file (bounded memory) and tolerates torn/corrupt lines instead of failing.
 */
export function loadConsistencySnapshots(
  limit = 100,
): Array<{ timestamp: string; missionId?: string; report: Partial<ConsistencyReport> }> {
  try {
    const filePath = path.resolve(process.cwd(), PERSISTENCE_DIR, SNAPSHOT_FILE);
    if (!fs.existsSync(filePath)) return [];
    const lines = readTailLines(filePath, TAIL_READ_BYTES);
    const records: Array<{
      timestamp: string;
      missionId?: string;
      report: Partial<ConsistencyReport>;
    }> = [];
    for (const line of lines.slice(-limit)) {
      try {
        records.push(JSON.parse(line));
      } catch {
        /* skip a torn/corrupt trailing record */
      }
    }
    return records.reverse();
  } catch (err) {
    reportSilentFailure(err, 'consistencyMonitor:71');
    return [];
  }
}

// ==================== 类型定义 ====================

export type AgentOutputType = 'decision' | 'analysis' | 'recommendation' | 'fact';

export type ConsistencyLevel = 'high' | 'medium' | 'low' | 'conflicting';

export interface AgentOutput {
  agentId: string;
  taskId?: string;
  missionId?: string;
  type: AgentOutputType;
  content: string;
  timestamp: number;
  metadata?: {
    confidence?: number;
    reasoning?: string;
    sources?: string[];
  };
}

export interface ConsistencyMonitorConfig {
  similarityThreshold: number;
  conflictThreshold: number;
  windowSize: number;
  enableBFT: boolean;
  bftMinNodes?: number;
  onConsistencyChange?: (level: ConsistencyLevel, details: ConsistencyReport) => void;
}

const DEFAULT_CONFIG: ConsistencyMonitorConfig = {
  similarityThreshold: 0.8,
  conflictThreshold: 0.2,
  windowSize: 10,
  enableBFT: true,
  bftMinNodes: 4,
};

export interface ConsistencyReport {
  timestamp: number;
  agentCount: number;
  consistencyLevel: ConsistencyLevel;
  agreementScore: number;
  similarityMatrix: number[][];
  conflicts: ConsistencyConflict[];
  consensus?: {
    agreedOutput: string;
    supportingAgents: string[];
    opposingAgents: string[];
    confidence: number;
  };
  bftStatus?: {
    totalNodes: number;
    faultyNodes: number;
    toleratedFaults: number;
    hasConsensus: boolean;
  };
  /** Completeness analysis (if input requirements provided) */
  completeness?: CompletenessReport;
}

export interface ConsistencyConflict {
  agentIds: string[];
  conflictType: 'semantic' | 'logical' | 'factual';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  outputs: AgentOutput[];
  suggestedResolution?: string;
}

export interface ConsistencySnapshot {
  timestamp: number;
  missionId?: string;
  report: ConsistencyReport;
}

/**
 * Completeness report — does output cover all requirements?
 */
export interface CompletenessReport {
  /** Requirements extracted from input */
  requirements: string[];
  /** Which requirements are covered in the output */
  covered: string[];
  /** Which requirements are missing */
  missing: string[];
  /** Completeness score 0-1 */
  score: number;
  /** Suggestions for improving completeness */
  suggestions: string[];
}

// ==================== Stop Words & Normalization ====================

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'and',
  'but',
  'or',
  'not',
  'no',
  'nor',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'than',
  'too',
  'very',
  'just',
  'about',
  'above',
  'again',
  'also',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'came',
  'come',
  'did',
  'does',
  'each',
  'else',
  'for',
  'from',
  'get',
  'got',
  'has',
  'had',
  'he',
  'her',
  'here',
  'him',
  'himself',
  'his',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'like',
  'make',
  'many',
  'me',
  'might',
  'more',
  'most',
  'much',
  'must',
  'my',
  'never',
  'now',
  'of',
  'on',
  'only',
  'or',
  'other',
  'our',
  'out',
  'over',
  're',
  'said',
  'she',
  'should',
  'since',
  'so',
  'some',
  'still',
  'such',
  'take',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'up',
  'us',
  'very',
  'want',
  'was',
  'way',
  'we',
  'well',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/**
 * Normalize a word: lowercase, strip punctuation, basic stemming
 */
function normalizeWord(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Basic suffix stripping (not full stemming, but helps)
  if (w.length > 4) {
    w = w.replace(/(?:ing|tion|ment|ness|able|ible|ful|less|ous|ive|al|ly|ed|er|est|ize|ise)$/, '');
  }
  return w;
}

/**
 * Extract content words (no stop words, normalized)
 */
function extractContentWords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => normalizeWord(w))
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Extract bigrams for n-gram overlap
 */
function extractBigrams(words: string[]): string[] {
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]}_${words[i + 1]}`);
  }
  return bigrams;
}

/**
 * Extract key phrases (noun-like phrases)
 */
function extractKeyPhrases(text: string): string[] {
  const phrases: string[] = [];
  // Simple noun phrase patterns
  const npPatterns = [
    /\b[A-Z][a-z]+(?: [A-Z][a-z]+){2,6}\b/g,
    /\b(?:the|a|an) (?:\w+ ){1,3}(?:system|method|approach|algorithm|model|framework|library|function|API|database|server|process|module|component)\b/gi,
    /\b\w+(?:_\w+){1,6}\b/g,
    /\b\w+(?:\.\w+){1,6}\b/g,
  ];

  for (const pattern of npPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      phrases.push(...matches.map((m) => m.toLowerCase()));
    }
  }

  return Array.from(new Set(phrases));
}

// ==================== 核心类 ====================

export class ConsistencyMonitor {
  private config: ConsistencyMonitorConfig;
  private outputHistory: Map<string, AgentOutput[]> = new Map();
  private snapshots: ConsistencySnapshot[] = [];
  private lastReport?: ConsistencyReport;

  constructor(config: Partial<ConsistencyMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ==================== 核心操作 ====================

  recordOutput(output: AgentOutput): void {
    const agentOutputs = this.outputHistory.get(output.agentId) || [];
    agentOutputs.push(output);
    if (agentOutputs.length > this.config.windowSize) {
      agentOutputs.shift();
    }
    this.outputHistory.set(output.agentId, agentOutputs);
  }

  checkConsistency(missionId?: string): ConsistencyReport {
    const timestamp = Date.now();
    const allOutputs = this.getRecentOutputs();
    const agentIds = Array.from(this.outputHistory.keys());

    const similarityMatrix = this.buildSimilarityMatrix(allOutputs);
    const agreementScore = this.calculateAgreementScore(similarityMatrix);
    const consistencyLevel = this.determineConsistencyLevel(agreementScore);
    const conflicts = this.detectConflicts(allOutputs, similarityMatrix);
    const consensus = this.attemptConsensus(allOutputs, agreementScore);
    const bftStatus = this.config.enableBFT
      ? this.checkBFTStatus(agentIds.length, conflicts)
      : undefined;

    const report: ConsistencyReport = {
      timestamp,
      agentCount: agentIds.length,
      consistencyLevel,
      agreementScore,
      similarityMatrix,
      conflicts,
      consensus,
      bftStatus,
    };

    if (
      this.config.onConsistencyChange &&
      (!this.lastReport || this.lastReport.consistencyLevel !== consistencyLevel)
    ) {
      this.config.onConsistencyChange(consistencyLevel, report);
    }

    this.snapshots.push({ timestamp, missionId, report });
    this.lastReport = report;

    // Persist to disk (non-blocking)
    persistConsistencySnapshot(report, missionId);

    return report;
  }

  /**
   * Check completeness: does the output cover all requirements from the input?
   * Based on chain-of-verification methodology.
   */
  checkCompleteness(input: string, output: string): CompletenessReport {
    const requirements = this.extractRequirements(input);
    const covered: string[] = [];
    const missing: string[] = [];

    const outputWordsSet = new Set(extractContentWords(output));
    const outputLower = output.toLowerCase();

    for (const req of requirements) {
      const reqWords = extractContentWords(req);
      const reqPhrases = extractKeyPhrases(req);

      // Check if requirement's key words appear in output
      const wordMatches = reqWords.filter((w) => outputWordsSet.has(w)).length;
      const wordCoverage = reqWords.length > 0 ? wordMatches / reqWords.length : 1;

      // Check if requirement's key phrases appear in output
      const phraseMatches = reqPhrases.filter((p) => outputLower.includes(p)).length;
      const phraseCoverage = reqPhrases.length > 0 ? phraseMatches / reqPhrases.length : 1;

      // Combined coverage
      const coverage = Math.max(wordCoverage, phraseCoverage);

      if (coverage >= 0.4) {
        covered.push(req);
      } else {
        missing.push(req);
      }
    }

    const score = requirements.length > 0 ? covered.length / requirements.length : 1;
    const suggestions = missing.map((r) => `Address missing requirement: "${r}"`);

    return { requirements, covered, missing, score, suggestions };
  }

  /**
   * Combined consistency + completeness check
   */
  checkQuality(
    missionId: string,
    input?: string,
    outputs?: Map<string, string>,
  ): ConsistencyReport {
    const report = this.checkConsistency(missionId);

    if (input && outputs && outputs.size > 0) {
      // Check completeness for each agent's output
      const completenessReports: CompletenessReport[] = [];
      outputs.forEach((output) => {
        const cr = this.checkCompleteness(input, output);
        completenessReports.push(cr);
      });

      // Average completeness
      const avgScore =
        completenessReports.length > 0
          ? completenessReports.reduce((s, r) => s + r.score, 0) / completenessReports.length
          : 1;

      const missingSet = new Set(completenessReports.flatMap((r) => r.missing));
      const coveredSet = new Set(completenessReports.flatMap((r) => r.covered));
      const allMissing = Array.from(missingSet);
      const allCovered = Array.from(coveredSet);

      report.completeness = {
        requirements: completenessReports[0]?.requirements ?? [],
        covered: allCovered,
        missing: allMissing,
        score: avgScore,
        suggestions: allMissing.map((r) => `Address missing requirement: "${r}"`),
      };
    }

    return report;
  }

  private getRecentOutputs(): AgentOutput[] {
    const recent: AgentOutput[] = [];
    this.outputHistory.forEach((outputs) => {
      if (outputs.length > 0) {
        recent.push(outputs[outputs.length - 1]);
      }
    });
    return recent;
  }

  // ==================== 相似度计算 (Improved) ====================

  private buildSimilarityMatrix(outputs: AgentOutput[]): number[][] {
    const n = outputs.length;
    const matrix: number[][] = Array(n)
      .fill(null)
      .map(() => Array(n).fill(0));

    // Pre-compute features for each output
    const features = outputs.map((o) => ({
      contentWords: extractContentWords(o.content),
      bigrams: extractBigrams(extractContentWords(o.content)),
      keyPhrases: extractKeyPhrases(o.content),
      rawLower: o.content.toLowerCase(),
    }));

    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        if (i === j) {
          matrix[i][j] = 1.0;
        } else {
          const similarity = this.calculateEnhancedSimilarity(features[i], features[j]);
          matrix[i][j] = similarity;
          matrix[j][i] = similarity;
        }
      }
    }

    return matrix;
  }

  /**
   * Enhanced semantic similarity combining:
   * 1. Content word Jaccard (filtered, normalized)
   * 2. Bigram overlap (captures phrase-level similarity)
   * 3. Key phrase overlap (captures domain-specific terms)
   * 4. Length ratio (penalizes wildly different lengths)
   */
  private calculateEnhancedSimilarity(
    f1: { contentWords: string[]; bigrams: string[]; keyPhrases: string[]; rawLower: string },
    f2: { contentWords: string[]; bigrams: string[]; keyPhrases: string[]; rawLower: string },
  ): number {
    // 1. Content word Jaccard
    const words2 = new Set(f2.contentWords);
    const wordIntersection = f1.contentWords.filter((x) => words2.has(x));
    const wordUnion = new Set(f1.contentWords.concat(f2.contentWords));
    const wordJaccard = wordUnion.size > 0 ? wordIntersection.length / wordUnion.size : 1;

    // 2. Bigram overlap
    const bigrams2Set = new Set(f2.bigrams);
    const bigramIntersection = f1.bigrams.filter((x) => bigrams2Set.has(x));
    const bigramUnion = new Set(f1.bigrams.concat(f2.bigrams));
    const bigramOverlap = bigramUnion.size > 0 ? bigramIntersection.length / bigramUnion.size : 1;

    // 3. Key phrase overlap
    const phraseIntersection = f1.keyPhrases.filter((p) => f2.rawLower.includes(p));
    const phraseScore =
      f1.keyPhrases.length > 0 ? phraseIntersection.length / f1.keyPhrases.length : 1;

    // 4. Length ratio
    const len1 = f1.contentWords.length;
    const len2 = f2.contentWords.length;
    const lengthRatio = Math.max(len1, len2) > 0 ? Math.min(len1, len2) / Math.max(len1, len2) : 1;

    // Weighted combination
    return 0.35 * wordJaccard + 0.25 * bigramOverlap + 0.25 * phraseScore + 0.15 * lengthRatio;
  }

  private calculateAgreementScore(similarityMatrix: number[][]): number {
    const n = similarityMatrix.length;
    if (n <= 1) return 1.0;

    let totalSimilarity = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        totalSimilarity += similarityMatrix[i][j];
        count++;
      }
    }
    return count > 0 ? totalSimilarity / count : 1.0;
  }

  private determineConsistencyLevel(score: number): ConsistencyLevel {
    if (score >= this.config.similarityThreshold) return 'high';
    else if (score >= 0.5) return 'medium';
    else if (score >= this.config.conflictThreshold) return 'low';
    else return 'conflicting';
  }

  // ==================== 冲突检测 ====================

  private detectConflicts(
    outputs: AgentOutput[],
    similarityMatrix: number[][],
  ): ConsistencyConflict[] {
    const conflicts: ConsistencyConflict[] = [];
    const n = outputs.length;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const similarity = similarityMatrix[i][j];

        if (similarity < this.config.conflictThreshold) {
          // Determine conflict type based on content analysis
          const conflictType = this.classifyConflictType(outputs[i], outputs[j]);

          conflicts.push({
            agentIds: [outputs[i].agentId, outputs[j].agentId],
            conflictType,
            severity: similarity < 0.1 ? 'critical' : 'high',
            description: `Agent ${outputs[i].agentId} and ${outputs[j].agentId} have conflicting outputs (similarity: ${similarity.toFixed(2)})`,
            outputs: [outputs[i], outputs[j]],
            suggestedResolution: 'Escalate to human review or use consensus voting',
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * Classify conflict type based on content analysis
   */
  private classifyConflictType(
    output1: AgentOutput,
    output2: AgentOutput,
  ): 'semantic' | 'logical' | 'factual' {
    // Check for numerical contradictions (factual)
    const nums1: string[] = output1.content.match(/\b\d+(?:\.\d+)?\b/g) || [];
    const nums2: string[] = output2.content.match(/\b\d+(?:\.\d+)?\b/g) || [];
    const nums2Set = new Set(nums2);
    const sharedNums = nums1.filter((n) => nums2Set.has(n));
    if (nums1.length > 0 && nums2.length > 0 && sharedNums.length === 0) {
      return 'factual';
    }

    // Check for logical contradictions (negation differences)
    const hasNegation1 = /\b(not|no|never|none|neither|n't)\b/i.test(output1.content);
    const hasNegation2 = /\b(not|no|never|none|neither|n't)\b/i.test(output2.content);
    if (hasNegation1 !== hasNegation2) {
      return 'logical';
    }

    return 'semantic';
  }

  // ==================== 共识机制 ====================

  private attemptConsensus(
    outputs: AgentOutput[],
    agreementScore: number,
  ): ConsistencyReport['consensus'] | undefined {
    if (outputs.length === 0) return undefined;

    if (agreementScore >= this.config.similarityThreshold) {
      const mostRepresentative = this.findMostRepresentativeOutput(outputs);
      return {
        agreedOutput: mostRepresentative.content,
        supportingAgents: outputs.map((o) => o.agentId),
        opposingAgents: [],
        confidence: agreementScore,
      };
    }

    if (agreementScore >= 0.5 && outputs.length >= 3) {
      return this.voteConsensus(outputs);
    }

    return undefined;
  }

  private findMostRepresentativeOutput(outputs: AgentOutput[]): AgentOutput {
    if (outputs.length === 1) return outputs[0];

    let bestOutput = outputs[0];
    let bestAvgSimilarity = 0;

    for (let i = 0; i < outputs.length; i++) {
      let totalSim = 0;
      for (let j = 0; j < outputs.length; j++) {
        if (i !== j) {
          totalSim = this.calculateEnhancedSimilarity(
            {
              contentWords: extractContentWords(outputs[i].content),
              bigrams: extractBigrams(extractContentWords(outputs[i].content)),
              keyPhrases: extractKeyPhrases(outputs[i].content),
              rawLower: outputs[i].content.toLowerCase(),
            },
            {
              contentWords: extractContentWords(outputs[j].content),
              bigrams: extractBigrams(extractContentWords(outputs[j].content)),
              keyPhrases: extractKeyPhrases(outputs[j].content),
              rawLower: outputs[j].content.toLowerCase(),
            },
          );
        }
      }
      const avgSim = totalSim / (outputs.length - 1);
      if (avgSim > bestAvgSimilarity) {
        bestAvgSimilarity = avgSim;
        bestOutput = outputs[i];
      }
    }

    return bestOutput;
  }

  private voteConsensus(outputs: AgentOutput[]): ConsistencyReport['consensus'] {
    const groups = new Map<string, AgentOutput[]>();

    for (const output of outputs) {
      let matched = false;
      groups.forEach((group, key) => {
        if (matched) return;
        const sim = this.calculateEnhancedSimilarity(
          {
            contentWords: extractContentWords(output.content),
            bigrams: extractBigrams(extractContentWords(output.content)),
            keyPhrases: extractKeyPhrases(output.content),
            rawLower: output.content.toLowerCase(),
          },
          {
            contentWords: extractContentWords(key),
            bigrams: extractBigrams(extractContentWords(key)),
            keyPhrases: extractKeyPhrases(key),
            rawLower: key.toLowerCase(),
          },
        );
        if (sim >= 0.7) {
          group.push(output);
          matched = true;
        }
      });
      if (!matched) {
        groups.set(output.content, [output]);
      }
    }

    const allGroups = Array.from(groups.values());
    let largestGroup = allGroups[0];
    for (let i = 1; i < allGroups.length; i++) {
      if (allGroups[i].length > largestGroup.length) {
        largestGroup = allGroups[i];
      }
    }

    const supportingAgents = largestGroup.map((o) => o.agentId);
    const opposingAgents = outputs
      .filter((o) => !supportingAgents.includes(o.agentId))
      .map((o) => o.agentId);

    return {
      agreedOutput: largestGroup[0].content,
      supportingAgents,
      opposingAgents,
      confidence: supportingAgents.length / outputs.length,
    };
  }

  // ==================== BFT 检查 ====================

  private checkBFTStatus(
    totalNodes: number,
    conflicts: ConsistencyConflict[],
  ): ConsistencyReport['bftStatus'] {
    const faultyNodes = new Set<string>();
    for (const conflict of conflicts) {
      if (conflict.severity === 'critical' || conflict.severity === 'high') {
        conflict.agentIds.forEach((id) => faultyNodes.add(id));
      }
    }

    const f = faultyNodes.size;
    const toleratedFaults = Math.floor((totalNodes - 1) / 3);

    return {
      totalNodes,
      faultyNodes: f,
      toleratedFaults,
      hasConsensus: f <= toleratedFaults,
    };
  }

  // ==================== Requirement Extraction ====================

  /**
   * Extract requirements from input text.
   * Based on chain-of-verification: decompose input into verifiable sub-questions.
   */
  private extractRequirements(input: string): string[] {
    const requirements: string[] = [];

    // Split on common requirement markers
    const markers = [
      /(?:need|require|want|expect|should|must|include|ensure)\s+(?:to\s+)?(?:be\s+)?(.+?)(?:\.|,|;|$)/gi,
      /(?:make sure|verify|check|confirm)\s+(?:that\s+)?(.+?)(?:\.|,|;|$)/gi,
      /(?:step \d+|first|second|third|finally|lastly)[,:]\s*(.+?)(?:\.|,|;|$)/gi,
      /(?:•|-|\*)\s+(.+?)(?:\.|,|;|$)/gm, // Bullet points
      /(?:\d+\.\s+)(.+?)(?:\.|,|;|$)/gm, // Numbered lists
    ];

    for (const pattern of markers) {
      let match;
      while ((match = pattern.exec(input)) !== null) {
        const req = match[1].trim();
        if (req.length > 5 && req.length < 200) {
          requirements.push(req);
        }
      }
    }

    // If no structured requirements found, extract key noun phrases
    if (requirements.length === 0) {
      const phrases = extractKeyPhrases(input);
      if (phrases.length > 0) {
        requirements.push(...phrases.slice(0, 5));
      }
    }

    return Array.from(new Set(requirements));
  }

  // ==================== 查询操作 ====================

  getLastReport(): ConsistencyReport | undefined {
    return this.lastReport;
  }
  getSnapshots(limit?: number): ConsistencySnapshot[] {
    return limit ? this.snapshots.slice(-limit) : [...this.snapshots];
  }
  getAgentOutputHistory(agentId: string): AgentOutput[] {
    return this.outputHistory.get(agentId) || [];
  }
  clearHistory(): void {
    this.outputHistory.clear();
    this.snapshots = [];
    this.lastReport = undefined;
  }
}

// ==================== 管理器 ====================

export class ConsistencyMonitorManager {
  private monitors: Map<string, ConsistencyMonitor> = new Map();
  private globalConfig: Partial<ConsistencyMonitorConfig> = {};

  setGlobalConfig(config: Partial<ConsistencyMonitorConfig>): void {
    this.globalConfig = config;
  }

  getMonitor(missionId: string): ConsistencyMonitor {
    let monitor = this.monitors.get(missionId);
    if (!monitor) {
      monitor = new ConsistencyMonitor(this.globalConfig);
      this.monitors.set(missionId, monitor);
    }
    return monitor;
  }

  recordOutput(missionId: string, output: AgentOutput): void {
    this.getMonitor(missionId).recordOutput(output);
  }

  checkConsistency(missionId: string): ConsistencyReport {
    return this.getMonitor(missionId).checkConsistency(missionId);
  }

  checkCompleteness(missionId: string, input: string, output: string): CompletenessReport {
    return this.getMonitor(missionId).checkCompleteness(input, output);
  }

  getAllConsistencyStatus(): Map<string, ConsistencyReport> {
    const status = new Map<string, ConsistencyReport>();
    this.monitors.forEach((monitor, missionId) => {
      const lastReport = monitor.getLastReport();
      if (lastReport) status.set(missionId, lastReport);
    });
    return status;
  }

  clearMission(missionId: string): void {
    this.monitors.get(missionId)?.clearHistory();
  }

  clearAll(): void {
    this.monitors.forEach((monitor) => monitor.clearHistory());
  }
}

// ==================== 单例导出 ====================

let globalManager: ConsistencyMonitorManager | null = null;

export function getConsistencyMonitorManager(): ConsistencyMonitorManager {
  if (!globalManager) globalManager = new ConsistencyMonitorManager();
  return globalManager;
}

export function resetConsistencyMonitorManager(): void {
  if (globalManager) {
    globalManager.clearAll();
    globalManager = null;
  }
}
