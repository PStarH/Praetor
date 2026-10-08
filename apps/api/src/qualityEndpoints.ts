import { Router, type NextFunction, type Request, type Response } from 'express';
import { HallucinationDetector } from '@praetor/core';
import { tenantKey } from '@praetor/core/runtime/tenantContext';
import { getConsistencyMonitorManager, type ConsistencyReport } from './consistencyMonitor';
import { hasRole } from './userStore';

function requestTenant(req: Request): string | undefined {
  const bound = req.tenantId;
  const claim = req.user?.tenantId;
  if (bound && claim && bound !== claim) return undefined;
  return bound ?? claim;
}

function requireConsistencyTenant(req: Request, res: Response, next: NextFunction): void {
  if ((!req.user && !req.apiKeyId) || !requestTenant(req)) {
    res
      .status(req.user || req.apiKeyId ? 403 : 401)
      .json({ error: 'Tenant-bound identity required' });
    return;
  }
  next();
}

function requireConsistencyWriter(req: Request, res: Response, next: NextFunction): void {
  const role = req.user?.role;
  const scopes = req.apiScopes ?? req.user?.scopes ?? [];
  const authorized =
    (!!role && hasRole(role, 'operator')) ||
    scopes.includes('quality:write') ||
    scopes.includes('admin') ||
    scopes.includes('*');
  if (!authorized) {
    res.status(403).json({ error: 'Consistency write authority is required' });
    return;
  }
  next();
}

function scopedMission(req: Request, missionId: string): string {
  const tenantId = requestTenant(req);
  if (!tenantId) throw new Error('Tenant context required');
  return tenantKey(tenantId, missionId);
}

export function createQualityRouter(): Router {
  const router = Router();
  const hallucinationDetector = new HallucinationDetector();

  // AUDIT-R4F3: same tenant+writer gates as the consistency routes — these
  // run ~12 regex detectors over caller-sized strings.
  router.post(
    '/api/quality/hallucination-check',
    requireConsistencyTenant,
    requireConsistencyWriter,
    (req, res) => {
      const { input, output } = req.body;
      if (!input || !output) {
        return res.status(400).json({ error: 'Both input and output are required' });
      }
      // AUDIT-R4F3: bound detector input (regex CPU per request).
      const MAX_QA_INPUT = 200_000;
      const inStr = typeof input === 'string' ? input : JSON.stringify(input);
      const outStr = typeof output === 'string' ? output : JSON.stringify(output);
      if (inStr.length > MAX_QA_INPUT || outStr.length > MAX_QA_INPUT) {
        return res.status(413).json({ error: `Input/output exceed ${MAX_QA_INPUT} characters` });
      }
      const report = hallucinationDetector.analyze(inStr, outStr);
      res.json(report);
    },
  );

  router.get('/api/quality/hallucination-check/info', (_req, res) => {
    res.json({
      signals: [
        'overconfidence',
        'unsupported_specificity',
        'fabricated_reference',
        'temporal_impossibility',
        'inconsistency',
        'numeric_anomaly',
      ],
      thresholds: {
        pass: 'riskScore < 0.3',
        flag_for_review: '0.3 <= riskScore < 0.6',
        reject: 'riskScore >= 0.6',
      },
    });
  });

  router.post(
    '/api/quality/check',
    requireConsistencyTenant,
    requireConsistencyWriter,
    (req, res) => {
      const { input, output } = req.body ?? {};
      if (!output) {
        return res.status(400).json({ error: 'output is required' });
      }

      const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? '');
      const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

      const hallucinationReport = hallucinationDetector.analyze(inputStr, outputStr);

      let consensusScore = 1.0;
      const consensusSignals: string[] = [];

      const hasHedging =
        /\b(might|may|could|likely|possibly|approximately|around|I think|it seems)\b/i.test(
          outputStr,
        );
      if (hasHedging) consensusSignals.push('hedging_language');

      const contradictions = (
        outputStr.match(/\bhowever\b|\bbut\b|\bon the other hand\b|\bcontrary to\b/gi) ?? []
      ).length;
      if (contradictions > 3) {
        consensusScore -= 0.2;
        consensusSignals.push(`contradiction_markers:${contradictions}`);
      }

      const sentences = outputStr.split(/[.!?]+/).filter((s: string) => s.trim().length > 20);
      const unique = new Set(sentences.map((s: string) => s.trim().toLowerCase()));
      const repRate = 1 - unique.size / Math.max(sentences.length, 1);
      if (repRate > 0.3) {
        consensusScore -= 0.25;
        consensusSignals.push(`repetition:${(repRate * 100).toFixed(0)}%`);
      }
      consensusScore = Math.max(0, Math.min(1, consensusScore));

      const handoffSignals: string[] = [];
      let handoffPassed = true;
      if (!input) {
        handoffPassed = false;
        handoffSignals.push('missing_input');
      }

      const outputValid = outputStr.trim().length > 0;

      res.json({
        hallucination: hallucinationReport,
        consensus: {
          score: consensusScore,
          passed: consensusScore >= 0.67,
          signals: consensusSignals,
        },
        handoff: {
          passed: handoffPassed,
          signals: handoffSignals,
        },
        outputValidation: {
          passed: outputValid,
        },
        overall: {
          passed:
            hallucinationReport.recommendation !== 'reject' &&
            consensusScore >= 0.67 &&
            handoffPassed &&
            outputValid,
        },
      });
    },
  );

  router.post(
    '/api/consistency/record',
    requireConsistencyTenant,
    requireConsistencyWriter,
    (req, res) => {
      const { missionId, agentId, outputType, content } = req.body ?? {};
      if (!agentId || !content) {
        return res.status(400).json({ error: 'agentId and content are required' });
      }
      const manager = getConsistencyMonitorManager();
      manager.recordOutput(scopedMission(req, missionId ?? 'global'), {
        agentId,
        type: outputType ?? 'analysis',
        content,
        timestamp: Date.now(),
      });
      res.json({ status: 'recorded' });
    },
  );

  router.get('/api/consistency/check/:missionId', requireConsistencyTenant, (req, res) => {
    const manager = getConsistencyMonitorManager();
    const report = manager.checkConsistency(scopedMission(req, String(req.params.missionId)));
    res.json(report);
  });

  router.get('/api/consistency/status', requireConsistencyTenant, (req, res) => {
    const manager = getConsistencyMonitorManager();
    const all = manager.getAllConsistencyStatus();
    const result: Record<string, ConsistencyReport> = {};
    const tenantId = requestTenant(req)!;
    const prefix = `${tenantKey(tenantId, '')}`;
    all.forEach((report, scopedId) => {
      if (scopedId.startsWith(prefix)) result[scopedId.slice(prefix.length)] = report;
    });
    res.json(result);
  });

  return router;
}
