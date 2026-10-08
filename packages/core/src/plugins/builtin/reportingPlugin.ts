/**
 * reportingPlugin — Built-in CommanderPlugin for HTML report rendering.
 *
 * Registers as `builtin-reporting` (category: 'monitoring'). HTML reports are
 * an optional output format — many users consume JSON or logs and never need
 * rendered HTML. The plugin exposes the renderer as a tool and keeps the
 * public API contract (getHTMLReportRenderer / createWarRoomHTMLReport) stable
 * so apps/api/runtimeEndpoints.ts can continue importing them from @praetor/core.
 *
 * No hooks installed — reporting is explicitly invoked via the
 * POST /api/runtime/render-report endpoint or the render_report tool.
 */
import type { CommanderPlugin } from '../../pluginManager';
import { getHTMLReportRenderer, createWarRoomHTMLReport } from './reporting';
import type { HTMLReportRenderer } from './reporting';
import { getGlobalLogger } from '../../logging';

// Re-export the public API so @praetor/core consumers see no change.
// apps/api/src/runtimeEndpoints.ts imports these from '@praetor/core'.
export { getHTMLReportRenderer, createWarRoomHTMLReport };

// ============================================================================
// Reporting Plugin factory
// ============================================================================

export function createReportingPlugin(): CommanderPlugin {
  let renderer: HTMLReportRenderer | null = null;

  return {
    name: 'builtin-reporting',
    version: '0.1.0',
    description: 'HTML report renderer for WarRoom and custom reports',
    category: 'monitoring',
    configSchema: {
      type: 'object',
      properties: {
        theme: {
          type: 'string',
          description: 'Color theme (currently only "dark" is supported)',
          default: 'dark',
        },
        maxSections: {
          type: 'number',
          description: 'Maximum number of sections per report (safety cap)',
          default: 50,
        },
      },
    },

    onLoad: async (ctx) => {
      const cfg = ctx.config;
      // The renderer is a tenant-aware singleton; grab the shared instance so
      // the tool and the public API (getHTMLReportRenderer) stay in sync.
      renderer = getHTMLReportRenderer();
      getGlobalLogger().info(
        'ReportingPlugin',
        `HTML report renderer loaded (theme=${cfg.theme ?? 'dark'})`,
      );
    },

    onUnload: async () => {
      renderer = null;
      getGlobalLogger().info('ReportingPlugin', 'HTML report renderer unloaded');
    },

    tools: [
      {
        name: 'render_report',
        description:
          'Render a WarRoom HTML report from project/operation/health/metrics/narrative data. ' +
          'Returns a complete HTML document string suitable for file save or HTTP response.',
        inputSchema: {
          type: 'object',
          properties: {
            projectName: { type: 'string', description: 'Project name' },
            operationCodename: { type: 'string', description: 'Operation codename' },
            health: {
              type: 'string',
              enum: ['GREEN', 'AMBER', 'RED'],
              description: 'Overall health status',
            },
            metrics: { type: 'object', description: 'Key-value metrics to display' },
            narrative: { type: 'string', description: 'Free-form narrative text' },
            topAgents: {
              type: 'array',
              description: 'Top performing agents',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  completed: { type: 'number' },
                },
              },
            },
            missionSummary: { type: 'object', description: 'Mission summary counts' },
            recentEvents: {
              type: 'array',
              description: 'Recent log events',
              items: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string' },
                  level: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
          required: ['projectName', 'operationCodename'],
        },
        execute: async (args) => {
          const r = renderer ?? getHTMLReportRenderer();
          const report = createWarRoomHTMLReport({
            projectName: String(args.projectName ?? ''),
            operationCodename: String(args.operationCodename ?? ''),
            health: (args.health as 'GREEN' | 'AMBER' | 'RED') ?? 'GREEN',
            metrics: (args.metrics as Record<string, string | number>) ?? {},
            narrative: (args.narrative as string) ?? '',
            topAgents: (args.topAgents as Array<{ name: string; completed: number }>) ?? [],
            missionSummary: (args.missionSummary as Record<string, number>) ?? {},
            recentEvents: args.recentEvents as Array<{
              timestamp: string;
              level: string;
              message: string;
            }>,
          });
          return r.render(report);
        },
      },
    ],
  };
}
