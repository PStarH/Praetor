import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type {
  CommanderRunIntent,
  CommanderRunMeta,
  CommanderRunContextV2,
  CommanderAgentCard,
  MissionStatus,
  MissionPriority,
  MissionRiskLevel,
  MissionGovernanceMode,
  ProjectMemoryKind,
} from '@praetor/core';
import {
  createSlimSnapshot,
  getDefaultInvocationProfile,
  recommendStrategy,
} from '@praetor/core';
import type { IWarRoomStore } from './store';
import type { ProjectMemoryStoreAdapter } from './memoryStoreAdapter';
import type { AgentStateStore } from './agentStateStore';
import {
  isMissionStatus,
  isMissionPriority,
  isMissionRiskLevel,
  isMissionGovernanceMode,
  isProjectMemoryKind,
  isLogLevel,
  mapErrorToStatusCode,
  toErrorMessage,
} from './routeHelpers';
import {
  calculateGovernanceStats,
  generateGovernanceAlerts,
  generateWeeklyGovernanceReport,
} from './governanceObserver';
import { hasRole, type UserRole } from './userStore';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user && !req.apiKeyId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

type OwnedResource = { tenantId?: string; ownerId?: string };

function principalId(req: Request): string | undefined {
  return req.user?.id ?? req.apiKeyId;
}

function principalTenant(req: Request): string | undefined {
  return req.user?.tenantId ?? req.tenantId;
}

function hasAdminRole(req: Request): boolean {
  return !!req.user && hasRole(req.user.role, 'admin');
}

function isSuperAdmin(req: Request): boolean {
  return !!req.user && hasRole(req.user.role, 'super_admin');
}

function resourceOwnership(value: unknown): OwnedResource {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    tenantId: typeof record.tenantId === 'string' ? record.tenantId : undefined,
    ownerId: typeof record.ownerId === 'string' ? record.ownerId : undefined,
  };
}

export function canAccessProject(req: Request, project: unknown): boolean {
  if (isSuperAdmin(req)) return true;
  const principal = principalId(req);
  const tenant = principalTenant(req);
  if (!principal || !tenant) return false;
  const ownership = resourceOwnership(project);
  // Legacy WarRoom projects predate tenant metadata; bind them to the configured
  // local tenant instead of exposing them to every authenticated tenant.
  const projectTenant = ownership.tenantId ?? process.env.COMMANDER_DEFAULT_TENANT_ID ?? 'local';
  return projectTenant === tenant && (hasAdminRole(req) || ownership.ownerId === principal);
}

function projectFromSnapshot(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  return (snapshot as Record<string, unknown>).project;
}

function requireRole(requiredRole: UserRole = 'admin') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !hasRole(req.user.role, requiredRole)) {
      res.status(403).json({ error: 'Insufficient privileges' });
      return;
    }
    next();
  };
}

export interface CreateProjectRouterOptions {
  /**
   * When true, only GET (read-only) routes are mounted. Used for the /v1
   * enterprise surface (spec WS3 §5.1) where WarRoom is demoted to a
   * read-only ops panel — POST/PATCH endpoints are omitted entirely so
   * they 404 rather than being reachable.
   */
  readOnly?: boolean;
}

export function createProjectRouter(
  store: IWarRoomStore,
  memoryStore: ProjectMemoryStoreAdapter,
  agentStateStore: AgentStateStore,
  options?: CreateProjectRouterOptions,
): Router {
  const readOnly = options?.readOnly ?? false;
  const router = Router();
  router.use(requireAuth);

  router.get('/projects', (req, res) => {
    const projects = store.listProjects().filter((project) => canAccessProject(req, project));
    res.json(projects);
  });

  router.get('/projects/:projectId/agents', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(store.listAgents(req.params.projectId));
  });

  router.get('/projects/:projectId/agents/:agentId/state', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const agent = snapshot.agents.find((a) => a.agentId === req.params.agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const state = agentStateStore.get(req.params.projectId, req.params.agentId);
    if (!state) {
      return res.status(404).json({ error: 'Agent state not found' });
    }
    res.json(state);
  });

  if (!readOnly) {
    router.patch('/projects/:projectId/agents/:agentId/state', (req, res) => {
      const snapshot = store.getProjectSnapshot(req.params.projectId);
      if (!snapshot) {
        return res.status(404).json({ error: 'Project not found' });
      }
      if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const agent = snapshot.agents.find((a) => a.agentId === req.params.agentId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      const { summary, preferences, tags } = req.body as {
        summary?: string;
        preferences?: string;
        tags?: string[];
      };
      try {
        const state = agentStateStore.upsert({
          projectId: req.params.projectId,
          agentId: req.params.agentId,
          summary,
          preferences,
          tags,
        });
        res.json(state);
      } catch (error) {
        res.status(400).json({ error: toErrorMessage(error) });
      }
    });
  }

  router.get('/projects/:projectId/war-room', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(snapshot);
  });

  router.get('/projects/:projectId/run-context', async (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const {
      agentId,
      missionId,
      memoryLimit,
      intent,
      runId,
      issuedByKind,
      issuedById,
      issuedByLabel,
    } = req.query as {
      agentId?: string;
      missionId?: string;
      memoryLimit?: string;
      intent?: CommanderRunIntent;
      runId?: string;
      issuedByKind?: 'HUMAN' | 'AGENT' | 'SYSTEM';
      issuedById?: string;
      issuedByLabel?: string;
    };
    const limit = memoryLimit ? Number(memoryLimit) : 12;
    const memoryItems = await memoryStore.search(req.params.projectId, { limit });
    let recommendedMemorySelection = { items: memoryItems, sourceTags: ['recent'] };
    if (missionId) {
      const lowerLimit = Math.min(limit, 12);
      const missionScoped = (
        await memoryStore.search(req.params.projectId, {
          limit: lowerLimit,
          kind: undefined,
        })
      ).filter((item) => item.missionId === missionId);
      if (missionScoped.length > 0) {
        recommendedMemorySelection = { items: missionScoped, sourceTags: ['mission-scoped'] };
      }
    }
    const recommendedItems = recommendedMemorySelection.items;
    const now = new Date().toISOString();
    // Synthetic runId is WarRoom UI context only — not kernel durable authority.
    // Clients must not treat this as GET /v1/runs/:id.
    const runMeta: CommanderRunMeta = {
      runId: runId || `${req.params.projectId}-${now}`,
      issuedAt: now,
      issuedBy: issuedByKind
        ? { kind: issuedByKind, id: issuedById, label: issuedByLabel }
        : undefined,
    };
    const slimSnapshot = createSlimSnapshot(snapshot, {
      focusMissionId: missionId,
      maxMissionsPerBucket: 6,
      maxLogs: 8,
    });
    const roster: CommanderAgentCard[] = snapshot.agents.map((agent) => ({
      id: agent.agentId,
      projectId: req.params.projectId,
      name: agent.agentName,
      callsign: agent.callsign,
      status: agent.status,
      specialty: agent.specialty,
      governanceRole: (() => {
        const fullAgent = store
          .listAgents(req.params.projectId)
          .find((a) => a.id === agent.agentId);
        return fullAgent?.governanceRole ?? 'EXECUTOR';
      })(),
    }));
    const focusMission = missionId
      ? slimSnapshot.focusMission?.id === missionId
        ? slimSnapshot.focusMission
        : [
            ...slimSnapshot.missionBoard.running,
            ...slimSnapshot.missionBoard.blocked,
            ...slimSnapshot.missionBoard.planned,
            ...slimSnapshot.missionBoard.done,
          ].find((mission) => mission.id === missionId)
      : undefined;
    const effectiveIntent = intent || 'EXECUTE';
    const focusAgent =
      (agentId ? roster.find((a) => a.id === agentId) : undefined) ??
      (focusMission ? roster.find((a) => a.id === focusMission.assignedAgentId) : undefined);
    const guidance = focusAgent
      ? {
          invocationProfile: getDefaultInvocationProfile({
            agent: focusAgent,
            mission: focusMission,
            intent: effectiveIntent,
          }),
          strategy: recommendStrategy({
            projectId: req.params.projectId,
            run: runMeta,
            focus: { agentId, missionId, intent: effectiveIntent },
            slimSnapshot,
            recentMemory: memoryItems,
            recommendedMemory: {
              items: recommendedItems,
              sourceTags: recommendedMemorySelection.sourceTags,
            },
            guidance: undefined,
            agentRoster: roster,
          }),
        }
      : undefined;
    const context: CommanderRunContextV2 = {
      projectId: req.params.projectId,
      run: runMeta,
      focus: { agentId, missionId, intent: effectiveIntent },
      slimSnapshot,
      recentMemory: memoryItems,
      recommendedMemory: {
        items: recommendedItems,
        sourceTags: recommendedMemorySelection.sourceTags,
      },
      guidance,
      agentRoster: roster,
    };
    res.json(context);
  });

  router.get('/projects/:projectId/memory', async (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const limit = req.query.limit ? Number(req.query.limit) : 24;
    try {
      res.json(await memoryStore.list(req.params.projectId, limit));
    } catch (error) {
      res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  router.get('/projects/:projectId/memory/overview', async (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    try {
      res.json(await memoryStore.overview(req.params.projectId));
    } catch (error) {
      res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  router.get('/projects/:projectId/memory/search', async (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const { kind, tags, q, limit } = req.query as {
      kind?: string;
      tags?: string;
      q?: string;
      limit?: string;
    };
    const parsedKind = kind && isProjectMemoryKind(kind) ? kind : undefined;
    const parsedTags = tags
      ? tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    const query = q?.trim() || undefined;
    try {
      const items = await memoryStore.search(req.params.projectId, {
        kind: parsedKind,
        tags: parsedTags,
        query,
        limit: limit ? Number(limit) : undefined,
      });
      res.json(items);
    } catch (error) {
      res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
    }
  });

  if (!readOnly) {
    router.post('/projects/:projectId/missions', (req, res) => {
      const snapshot = store.getProjectSnapshot(req.params.projectId);
      if (!snapshot || !canAccessProject(req, projectFromSnapshot(snapshot))) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const { title, objective, assignedAgentId, priority, riskLevel, governanceMode } =
        req.body as Record<string, string | undefined>;
      if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
      if (!assignedAgentId?.trim())
        return res.status(400).json({ error: 'assignedAgentId is required' });
      const nextPriority = priority ?? 'MEDIUM';
      if (!isMissionPriority(nextPriority))
        return res.status(400).json({ error: 'Invalid priority' });
      const nextRiskLevel =
        riskLevel && isMissionRiskLevel(riskLevel) ? (riskLevel as MissionRiskLevel) : undefined;
      const nextGovernanceMode =
        governanceMode && isMissionGovernanceMode(governanceMode)
          ? (governanceMode as MissionGovernanceMode)
          : undefined;
      try {
        const mission = store.createMission({
          projectId: req.params.projectId,
          title: title.trim(),
          objective: objective?.trim() || 'No objective provided yet.',
          assignedAgentId: assignedAgentId.trim(),
          priority: nextPriority as MissionPriority,
          riskLevel: nextRiskLevel,
          governanceMode: nextGovernanceMode,
        });
        res.status(201).json(mission);
      } catch (error) {
        res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
      }
    });

    router.patch('/missions/:missionId', async (req, res) => {
      const { status, priority, assignedAgentId, title, objective, riskLevel, governanceMode } =
        req.body as Record<string, string | undefined>;
      if (status && !isMissionStatus(status))
        return res.status(400).json({ error: 'Invalid status' });
      if (priority && !isMissionPriority(priority))
        return res.status(400).json({ error: 'Invalid priority' });
      if (riskLevel && !isMissionRiskLevel(riskLevel))
        return res.status(400).json({ error: 'Invalid riskLevel' });
      if (governanceMode && !isMissionGovernanceMode(governanceMode))
        return res.status(400).json({ error: 'Invalid governanceMode' });
      try {
        const existing = store.getProjectSnapshot(
          store
            .listProjects()
            .find((project) =>
              store
                .getProjectSnapshot(project.id)
                ?.missions.some((mission) => mission.id === req.params.missionId),
            )?.id ?? '',
        );
        if (!existing || !canAccessProject(req, projectFromSnapshot(existing))) {
          return res.status(404).json({ error: 'Mission not found' });
        }
        const mission = store.updateMission(req.params.missionId, {
          status: status as MissionStatus | undefined,
          priority: priority as MissionPriority | undefined,
          assignedAgentId: assignedAgentId?.trim(),
          title: title?.trim(),
          objective: objective?.trim(),
          riskLevel: riskLevel as MissionRiskLevel | undefined,
          governanceMode: governanceMode as MissionGovernanceMode | undefined,
        });
        if (mission.status === 'DONE') {
          try {
            const existingSummary = (await memoryStore.list(mission.projectId, 100)).find(
              (item) => item.missionId === mission.id && item.kind === 'SUMMARY',
            );
            if (!existingSummary) {
              await memoryStore.append({
                projectId: mission.projectId,
                missionId: mission.id,
                agentId: mission.assignedAgentId,
                kind: 'SUMMARY',
                duration: 'EPISODIC',
                title: `任务完成：${mission.title}`,
                content: `任务「${mission.title}」已完成（优先级 ${mission.priority}，风险等级 ${mission.riskLevel}，治理模式 ${mission.governanceMode}）。目标：${mission.objective}`,
                tags: [
                  'mission',
                  'done',
                  mission.priority.toLowerCase(),
                  mission.riskLevel.toLowerCase(),
                ],
              });
            }
          } catch (e) {
            process.stderr.write(
              `[MemorySummary] Failed to create auto-summary: ${(e as Error)?.message}\n`,
            );
          }
        }
        res.json(mission);
      } catch (error) {
        res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
      }
    });

    // ── POST /missions/:missionId/approve — 显式审批放行高风险任务 ────────
    // MANUAL 治理模式下的 HIGH/CRITICAL 任务在 PATCH 时会被 409 阻断，
    // 必须通过此显式审批端点以 bypassGovernance=true 标记为 DONE。
    // 仅 admin（及更高）可调用；审计日志主体取自 JWT，忽略 body.approver。
    router.post(
      '/missions/:missionId/approve',
      requireAuth,
      requireRole('admin'),
      async (req, res) => {
        const { comment } = req.body as { comment?: string };
        const approver = req.user!.username;
        const missionId = Array.isArray(req.params.missionId)
          ? req.params.missionId[0]
          : req.params.missionId;
        if (!missionId) {
          res.status(400).json({ error: 'missionId is required' });
          return;
        }
        try {
          const snapshot = store
            .listProjects()
            .map((project) => store.getProjectSnapshot(project.id))
            .find((candidate) => candidate?.missions.some((mission) => mission.id === missionId));
          if (!snapshot || !canAccessProject(req, projectFromSnapshot(snapshot))) {
            return res.status(404).json({ error: 'Mission not found' });
          }
          const mission = store.updateMission(
            missionId,
            { status: 'DONE' },
            { bypassGovernance: true },
          );
          // 记录审批日志
          store.createLog({
            missionId: mission.id,
            message: `Mission approved by ${approver}${comment ? `: ${comment}` : ''}`,
            level: 'SUCCESS',
          });
          // 创建自动摘要（与 PATCH 路径一致）
          try {
            const existingSummary = (await memoryStore.list(mission.projectId, 100)).find(
              (item) => item.missionId === mission.id && item.kind === 'SUMMARY',
            );
            if (!existingSummary) {
              await memoryStore.append({
                projectId: mission.projectId,
                missionId: mission.id,
                agentId: mission.assignedAgentId,
                kind: 'SUMMARY',
                duration: 'EPISODIC',
                title: `任务完成：${mission.title}`,
                content: `任务「${mission.title}」经审批完成（优先级 ${mission.priority}，风险等级 ${mission.riskLevel}，治理模式 ${mission.governanceMode}）。目标：${mission.objective}`,
                tags: ['mission', 'done', 'approved', mission.priority.toLowerCase()],
              });
            }
          } catch (e) {
            process.stderr.write(
              `[MemorySummary] Failed to create auto-summary on approve: ${(e as Error)?.message}\n`,
            );
          }
          res.json(mission);
        } catch (error) {
          res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
        }
      },
    );

    router.post('/projects/:projectId/memory', async (req, res) => {
      const snapshot = store.getProjectSnapshot(req.params.projectId);
      if (!snapshot) return res.status(404).json({ error: 'Project not found' });
      if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
        return res.status(404).json({ error: 'Project not found' });
      }
      const { title, content, kind, missionId, agentId, tags } = req.body as {
        title?: string;
        content?: string;
        kind?: string;
        missionId?: string;
        agentId?: string;
        tags?: string[];
      };
      if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
      if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
      if (
        missionId !== undefined &&
        !snapshot.missions.some((mission) => mission.id === missionId)
      ) {
        return res.status(404).json({ error: 'Mission not found' });
      }
      if (agentId !== undefined && !snapshot.agents.some((agent) => agent.agentId === agentId)) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      const memoryKind: ProjectMemoryKind = isProjectMemoryKind(kind || 'SUMMARY')
        ? ((kind || 'SUMMARY') as ProjectMemoryKind)
        : 'SUMMARY';
      const safeTags = Array.isArray(tags)
        ? tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
        : [];
      try {
        const item = await memoryStore.append({
          projectId: req.params.projectId,
          missionId,
          agentId,
          kind: memoryKind,
          duration: 'EPISODIC',
          title: title.trim(),
          content: content.trim(),
          tags: safeTags,
        });
        res.status(201).json(item);
      } catch (error) {
        res.status(400).json({ error: toErrorMessage(error) });
      }
    });

    router.post('/missions/:missionId/logs', (req, res) => {
      const { message, level } = req.body as { message?: string; level?: string };
      if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
      const nextLevel = level ?? 'INFO';
      if (!isLogLevel(nextLevel)) return res.status(400).json({ error: 'Invalid log level' });
      try {
        const project = store
          .listProjects()
          .find((candidate) =>
            store
              .getProjectSnapshot(candidate.id)
              ?.missions.some((mission) => mission.id === req.params.missionId),
          );
        const snapshot = project ? store.getProjectSnapshot(project.id) : undefined;
        if (!snapshot || !canAccessProject(req, projectFromSnapshot(snapshot))) {
          return res.status(404).json({ error: 'Mission not found' });
        }
        const log = store.createLog({
          missionId: req.params.missionId,
          message: message.trim(),
          level: nextLevel,
        });
        res.status(201).json(log);
      } catch (error) {
        res.status(mapErrorToStatusCode(error)).json({ error: toErrorMessage(error) });
      }
    });
  }

  router.get('/projects/:projectId/governance/stats', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Mission has a richer schema than `Record<string, unknown>` accepts;
    // widen through an unknown cast at the call site.
    res.json(
      calculateGovernanceStats(
        snapshot.missions as unknown as Record<string, unknown>[],
        snapshot.agents as unknown as Record<string, unknown>[],
      ),
    );
  });

  router.get('/projects/:projectId/governance/alerts', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const stats = calculateGovernanceStats(
      snapshot.missions as unknown as Record<string, unknown>[],
      snapshot.agents as unknown as Record<string, unknown>[],
    );
    res.json(generateGovernanceAlerts(stats));
  });

  router.get('/projects/:projectId/governance/weekly-report', (req, res) => {
    const snapshot = store.getProjectSnapshot(req.params.projectId);
    if (!snapshot) return res.status(404).json({ error: 'Project not found' });
    if (!canAccessProject(req, projectFromSnapshot(snapshot))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Mission has a richer schema than `Record<string, unknown>` accepts;
    // widen through an unknown cast at the call site.
    const stats = calculateGovernanceStats(
      snapshot.missions as unknown as Record<string, unknown>[],
      snapshot.agents as unknown as Record<string, unknown>[],
    );
    const alerts = generateGovernanceAlerts(stats);
    res.type('text/markdown').send(generateWeeklyGovernanceReport(stats, alerts));
  });

  return router;
}
