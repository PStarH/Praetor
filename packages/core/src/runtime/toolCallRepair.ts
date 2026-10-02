/**
 * Tool Call Argument Repair — Multi-Strategy Malformed Argument Recovery
 *
 * LLMs sometimes emit malformed JSON: trailing commas, markdown fences,
 * single quotes, text-wrapped JSON, or even XML-like tool call formats.
 * This module applies conservative repair strategies to recover parseable
 * arguments before validation and execution.
 *
 * Design principles (from Hermes):
 * - Never invent data — only fix clearly fixable structural issues
 * - Record all repairs for observability
 * - Stop at first successful parse
 */
import { getGlobalLogger } from '../logging';

// ============================================================================
// Types
// ============================================================================

export interface RepairResult {
  args: Record<string, unknown>;
  repairs: string[];
}

export interface TextToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Parse the XML-like tool-call format emitted by some OpenAI-compatible
 * providers. Only explicit <tool_call> blocks are accepted; ordinary prose
 * is never interpreted as a tool invocation.
 */
export function parseTextToolCalls(content: string): TextToolCall[] {
  const results: TextToolCall[] = [];
  const blockPattern = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockPattern.exec(content)) !== null) {
    const block = blockMatch[1];
    const functionMatch = block.match(
      /<(?:function|tool)(?:=|_)([^>]+)>|<(?:function|tool)\s+name=["']([^"']+)["'][^>]*>/i,
    );
    let name = (functionMatch?.[1] ?? functionMatch?.[2] ?? '').trim();
    if (!name) {
      const jsonNameMatch = block.match(/"name"\s*:\s*["']([^"']+)["']/i);
      if (jsonNameMatch) name = jsonNameMatch[1].trim();
    }
    if (!name) continue;

    const args: Record<string, unknown> = {};
    const parameterPattern =
      /<parameter(?:=|\s+name=)["']?([^>"']+)["']?>([\s\S]*?)<\/parameter>/gi;
    let parameterMatch: RegExpExecArray | null;
    while ((parameterMatch = parameterPattern.exec(block)) !== null) {
      args[parameterMatch[1].trim()] = parseTextToolArgument(parameterMatch[2].trim());
    }

    if (Object.keys(args).length === 0) {
      const headerMatch = block.match(/<tool_call_header>([\s\S]*?)<\/tool_call_header>/i);
      if (headerMatch) {
        try {
          const parsed = JSON.parse(headerMatch[1].trim());
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(args, parsed);
          }
        } catch {
          /* ignore */
        }
      }
    }

    if (Object.keys(args).length === 0) {
      const argumentsMatch = block.match(/<arguments?>([\s\S]*?)<\/(?:arguments?)>/i);
      if (argumentsMatch) {
        try {
          const parsed = JSON.parse(argumentsMatch[1].trim());
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(args, parsed);
          }
        } catch (err) {
          getGlobalLogger().debug('ToolCallRepair', 'Text tool arguments were not JSON', {
            error: (err as Error)?.message,
          });
        }
      }
    }

    if (Object.keys(args).length === 0) {
      const jsonCandidate = block.replace(/<\/?[^>]+>/g, '').trim();
      if (jsonCandidate.startsWith('{') && jsonCandidate.endsWith('}')) {
        try {
          const parsed = JSON.parse(jsonCandidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (parsed.arguments && typeof parsed.arguments === 'object') {
              Object.assign(args, parsed.arguments);
            } else if (parsed.parameters && typeof parsed.parameters === 'object') {
              Object.assign(args, parsed.parameters);
            } else {
              Object.assign(args, parsed);
              delete args.name;
            }
          }
        } catch {
          /* ignore */
        }
      }
    }

    results.push({
      id: `call_text_${Date.now()}_${results.length}`,
      name,
      arguments: args,
    });
  }

  return results;
}

function parseTextToolArgument(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      // Keep malformed values as strings so schema validation can reject them.
    }
  }
  return value;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Attempt to repair malformed tool call arguments.
 * Applies multiple strategies in order, stopping at first success.
 * Conservative: returns original input unchanged if nothing works.
 */
export function repairToolCallArguments(rawArgs: unknown, _toolName: string): RepairResult {
  // Strategy 1: Already an object (Anthropic returns parsed objects)
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    // Guard against prototype pollution (use hasOwnProperty to avoid false positives from inherited properties)
    const args = rawArgs as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(args, '__proto__') ||
      Object.prototype.hasOwnProperty.call(args, 'constructor') ||
      Object.prototype.hasOwnProperty.call(args, 'prototype')
    ) {
      const sanitized: Record<string, unknown> = {};
      for (const key of Object.keys(args)) {
        if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
          sanitized[key] = args[key];
        }
      }
      return { args: sanitized, repairs: ['removed dangerous keys'] };
    }
    return { args, repairs: [] };
  }

  if (typeof rawArgs !== 'string') {
    return { args: {}, repairs: ['non-string non-object input, returned empty'] };
  }

  const raw = rawArgs;

  // Strategy 2: Direct JSON.parse
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed, repairs: [] };
    }
  } catch (e) {
    getGlobalLogger().debug('ToolCallRepair', 'Direct JSON parse failed', {
      error: (e as Error)?.message,
    });
  }

  // Strategy 3: Common-fix parse
  const fixed = applyCommonFixes(raw);
  if (fixed !== raw) {
    try {
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed, repairs: describeFixes(raw, fixed) };
      }
    } catch (e) {
      getGlobalLogger().debug('ToolCallRepair', 'Common-fix JSON parse failed', {
        error: (e as Error)?.message,
      });
    }
  }

  // Strategy 4: Regex extraction — find first {...} block
  const extracted = extractJsonObject(raw);
  if (extracted) {
    try {
      const parsed = JSON.parse(extracted);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed, repairs: ['extracted JSON object from surrounding text'] };
      }
    } catch (e) {
      getGlobalLogger().debug('ToolCallRepair', 'Extracted JSON parse failed', {
        error: (e as Error)?.message,
      });
    }
  }

  // Strategy 5: XML-like tool call format (generalized MiMo pattern)
  const xmlParsed = parseXmlLikeToolCall(raw);
  if (xmlParsed) {
    return { args: xmlParsed, repairs: ['parsed XML-like tool call format'] };
  }

  // All strategies failed — return empty args, let validation handle it
  return { args: {}, repairs: ['all repair strategies failed'] };
}

/**
 * Tier 3.1: produce concrete suggestions for repairing validation errors.
 * Each suggestion is a one-sentence hint the LLM can use to self-correct.
 */
export function suggestRepairsForValidationErrors(
  errors: Array<{ path: string; message: string; expectedType?: string; actualValue?: unknown }>,
): string[] {
  return errors.map((e) => {
    if (e.message.includes('required')) {
      return `Add the required argument "${e.path}" with an appropriate value.`;
    }
    if (e.expectedType === 'string' && typeof e.actualValue !== 'string') {
      return `Change "${e.path}" to a string. Try: "${String(e.actualValue ?? '')}".`;
    }
    if (e.expectedType === 'number' && typeof e.actualValue === 'string') {
      const n = Number(e.actualValue);
      return `Change "${e.path}" to a number. Try: ${Number.isFinite(n) ? n : 0}.`;
    }
    if (e.expectedType === 'boolean' && typeof e.actualValue !== 'boolean') {
      return `Change "${e.path}" to a boolean (true or false).`;
    }
    if (e.expectedType === 'array' && !Array.isArray(e.actualValue)) {
      return `Wrap "${e.path}" in an array: [${JSON.stringify(e.actualValue)}].`;
    }
    if (e.message.includes('enum')) {
      return `Choose a valid value for "${e.path}" from the tool's allowed enum values.`;
    }
    return `Fix "${e.path}" to match the expected schema.`;
  });
}

// ============================================================================
// Strategy 3: Common-Fix Parse
// ============================================================================

function applyCommonFixes(s: string): string {
  let result = s;

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  result = result.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');

  // Strip leading non-JSON text — find first { or [
  const firstBrace = result.indexOf('{');
  const firstBracket = result.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) start = Math.min(firstBrace, firstBracket);
  else if (firstBrace >= 0) start = firstBrace;
  else if (firstBracket >= 0) start = firstBracket;

  if (start > 0) {
    result = result.slice(start);
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');

  // Remove single-line comments (only at line start)
  result = result.replace(/^\s*\/\/.*$/gm, '');

  // Remove block comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');

  // Replace single quotes with double quotes (conservative)
  if (!result.includes('"') || result.replace(/[^"]/g, '').length % 2 !== 0) {
    const singleQuoteCount = (result.match(/'/g) || []).length;
    if (singleQuoteCount >= 2 && singleQuoteCount % 2 === 0) {
      result = result.replace(/'/g, '"');
    }
  }

  return result.trim();
}

function describeFixes(original: string, _fixed: string): string[] {
  const fixes: string[] = [];
  if (original.includes('```')) fixes.push('stripped markdown code fences');
  if (/,\s*[}\]]/.test(original)) fixes.push('removed trailing comma');
  if (/\/\//.test(original) || /\/\*/.test(original)) fixes.push('removed comments');
  if (original.includes("'") && !original.includes('"')) fixes.push('replaced single quotes');
  if (fixes.length === 0) fixes.push('applied common fixes');
  return fixes;
}

// ============================================================================
// Strategy 4: Regex Extraction
// ============================================================================

function extractJsonObject(s: string): string | null {
  const braceStart = s.indexOf('{');
  if (braceStart >= 0) {
    const block = extractBalancedBlock(s, braceStart, '{', '}');
    if (block) return block;
  }

  const bracketStart = s.indexOf('[');
  if (bracketStart >= 0) {
    const block = extractBalancedBlock(s, bracketStart, '[', ']');
    if (block) return block;
  }

  return null;
}

function extractBalancedBlock(
  s: string,
  start: number,
  openChar: string,
  closeChar: string,
): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === openChar) depth++;
    else if (ch === closeChar) depth--;

    if (depth === 0 && i > start) {
      return s.slice(start, i + 1);
    }
  }

  return null;
}

// ============================================================================
// Strategy 5: XML-Like Tool Call Format (generalized MiMo pattern)
// ============================================================================

/**
 * Parse XML-like tool call format used by some models.
 */
function parseXmlLikeToolCall(s: string): Record<string, unknown> | null {
  const funcMatch = s.match(/<function[=_]([^>]+)>/);
  if (!funcMatch) return null;

  const args: Record<string, unknown> = {};
  const paramRegex = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
  let paramMatch;

  while ((paramMatch = paramRegex.exec(s)) !== null) {
    const key = paramMatch[1].trim();
    let value: unknown = paramMatch[2].trim();

    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else if (/^-?\d+(\.\d+)?$/.test(value as string)) value = Number(value);

    args[key] = value;
  }

  return Object.keys(args).length > 0 ? args : null;
}
