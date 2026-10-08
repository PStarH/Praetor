import { useEffect, useState } from 'react';
import { ScoreGauge } from '../components/ScoreGauge';
import { DimensionBars } from '../components/DimensionBars';
import { ComplianceHeatmap } from '../components/ComplianceHeatmap';
import { TrendSparkline } from '../components/TrendSparkline';
import { fetchSecurityPosture } from '../api';
import type { ComplianceAuditReport, AuditChecklistItem } from '../types';

export function SecurityPosturePage() {
  const [report, setReport] = useState<ComplianceAuditReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchSecurityPosture()
      .then((data) => {
        if (!cancelled) {
          setReport(data);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="page">
        <div className="page-head">
          <span className="section-label">Security Posture</span>
          <h1>Security Posture Dashboard</h1>
        </div>
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <span style={{ color: 'var(--text-muted)' }}>Loading security posture…</span>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="page">
        <div className="page-head">
          <span className="section-label">Security Posture</span>
          <h1>Security Posture Dashboard</h1>
        </div>
        <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
          <p style={{ color: 'var(--accent-amber)', fontSize: '0.8rem', marginBottom: '8px' }}>
            {error ?? 'No posture data available'}
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
            Run a security posture assessment to generate posture data. The backend reads snapshots
            from <code>.commander/posture-snapshots.json</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <span className="section-label">Security Posture</span>
        <h1>Security Posture & Red Team Dashboard</h1>
        <p className="page-desc">
          ISO 42001:2023 &amp; NIST AI RMF 1.0 control mapping with configured red-team signals.
          Snapshot history tracks self-assessed posture across CI/CD runs; this is not
          certification.
        </p>
      </div>

      <div className="dashboard-grid">
        {/* ── Metrics Row ──────────────────────────────────────────── */}
        <div className="metric-row">
          <MetricCard
            label="Posture Score"
            value={report.posture.overallScore}
            suffix={`/100 · ${report.posture.grade}`}
            icon="S"
            color="var(--accent-green)"
          />
          <MetricCard
            label="Red Team Score"
            value={report.redTeam?.securityScore ?? 0}
            suffix={`/100 · ${report.redTeam?.blocked ?? 0}/${report.redTeam?.totalScenarios ?? 0} blocked`}
            icon="R"
            color={report.redTeam?.passed ? 'var(--accent-green)' : 'var(--accent-red)'}
          />
          <MetricCard
            label="ISO 42001"
            value={report.isoCompliance.compliancePercentage}
            suffix={`% · ${report.isoCompliance.gaps.length} gaps`}
            icon="I"
            color={
              report.isoCompliance.fullyCompliant ? 'var(--accent-green)' : 'var(--accent-amber)'
            }
          />
          <MetricCard
            label="NIST AI RMF"
            value={report.nistRmfAlignment.alignmentPercentage}
            suffix={`% · ${report.nistRmfAlignment.gaps.length} gaps`}
            icon="N"
            color="var(--accent-blue)"
          />
        </div>

        {/* ── Gauge + Dimension Bars Row ──────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: '12px' }}>
          <ScoreGauge posture={report.posture} />
          <DimensionBars dimensions={report.posture.dimensions} />
        </div>

        {/* ── Compliance Heatmap ──────────────────────────────────── */}
        <ComplianceHeatmap iso={report.isoCompliance} nist={report.nistRmfAlignment} />

        {/* ── Trend + Red Team Row ────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <TrendSparkline history={report.postureHistory} trend={report.trendAnalysis} />
          <RedTeamCard report={report} />
        </div>

        {/* ── Audit Checklist ─────────────────────────────────────── */}
        <AuditChecklistSection checklist={report.auditChecklist} />

        {/* ── Strengths & Risks ───────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="card narrative" style={{ padding: '14px 16px' }}>
            <div className="section-label" style={{ marginBottom: '6px' }}>
              Top Strengths
            </div>
            {report.posture.topStrengths.map((s) => (
              <div
                key={s}
                style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px' }}
              >
                + {s}
              </div>
            ))}
          </div>
          <div className="card narrative narrative-amber" style={{ padding: '14px 16px' }}>
            <div className="section-label" style={{ marginBottom: '6px' }}>
              Top Risks
            </div>
            {report.posture.topRisks.map((r) => (
              <div
                key={r}
                style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '4px' }}
              >
                - {r}
              </div>
            ))}
          </div>
        </div>

        {/* ── New Capabilities ──────────────────────────────────── */}
        <NewCapabilitiesSection />

        {/* ── Report Meta ─────────────────────────────────────────── */}
        <div
          style={{
            fontSize: '0.64rem',
            color: 'var(--text-muted)',
            textAlign: 'center',
            padding: '12px 0',
          }}
        >
          Report {report.metadata.reportId} · Generated{' '}
          {new Date(report.metadata.generatedAt).toLocaleString('en')}
          {report.metadata.commitHash && ` · commit ${report.metadata.commitHash}`}
          {report.signature && ` · signed ${report.signature.slice(0, 12)}...`}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  suffix,
  icon,
  color,
}: {
  label: string;
  value: number;
  suffix: string;
  icon: string;
  color: string;
}) {
  return (
    <div className="card metric" style={{ borderLeft: `2px solid ${color}` }}>
      <div className="metric-head">
        <span className="metric-icon" style={{ color }}>
          {icon}
        </span>
        <span className="metric-label">{label}</span>
      </div>
      <span className="metric-value" style={{ fontSize: '1.8rem' }}>
        {value}
      </span>
      <span
        style={{
          display: 'block',
          fontSize: '0.65rem',
          color: 'var(--text-tertiary)',
          marginTop: '2px',
        }}
      >
        {suffix}
      </span>
    </div>
  );
}

function RedTeamCard({ report }: { report: ComplianceAuditReport }) {
  const rt = report.redTeam;
  if (!rt) return null;

  const passed = rt.passed;
  const statusColor = passed ? 'var(--accent-green)' : 'var(--accent-red)';

  return (
    <div className="card" style={{ padding: '16px 18px', borderLeft: `2px solid ${statusColor}` }}>
      <div className="section-head" style={{ marginBottom: '10px' }}>
        <div>
          <span className="section-label">Red Team</span>
          <h2 style={{ fontSize: '1.1rem' }}>
            {passed ? 'PASSED' : 'FAILED'} · Score {rt.securityScore}/100
          </h2>
        </div>
        <span
          className="bdg"
          style={{
            borderColor: statusColor,
            color: statusColor,
            background: `${statusColor}20`,
          }}
        >
          {rt.mode}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: '10px',
          marginBottom: '10px',
        }}
      >
        <StatBlock label="Blocked" value={rt.blocked.toString()} color="var(--accent-green)" />
        <StatBlock label="Detected" value={rt.detected.toString()} color="var(--accent-amber)" />
        <StatBlock label="Missed" value={rt.missed.toString()} color="var(--accent-red)" />
      </div>

      <div style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
        {rt.totalScenarios} scenarios · {rt.errors} errors
        {rt.regressions > 0 && (
          <span style={{ color: 'var(--accent-red)', marginLeft: '8px' }}>
            {rt.regressions} regressions
          </span>
        )}
      </div>
    </div>
  );
}

function StatBlock({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: '1.3rem', fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
        {value}
      </div>
      <div
        style={{
          fontSize: '0.6rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginTop: '2px',
        }}
      >
        {label}
      </div>
    </div>
  );
}

function NewCapabilitiesSection() {
  const capabilities = [
    {
      icon: '⚛',
      title: 'Post-Quantum Crypto',
      desc: 'SHA-512 double-hash construction with 512-bit HMAC keys for 256-bit quantum security. Ready for ML-KEM-768 upgrade.',
      color: 'var(--accent-purple)',
      tag: 'crypto_defense',
    },
    {
      icon: '⨯',
      title: 'Fuzz Test Framework',
      desc: 'Mutation-based tool input fuzzer with 6 strategies (byte flip, boundary inject, structure mutate, injection insert, type confuse, unicode mangle). Coverage-guided feedback loop.',
      color: 'var(--accent-amber)',
      tag: 'fuzz_testing',
    },
    {
      icon: '⟐',
      title: 'Cross-Agent Correlator',
      desc: '6 correlation rules detect coordinated attacks spanning multiple agents — exfiltration, privilege escalation, lateral movement, DoS, C2, collusion.',
      color: 'var(--accent-blue)',
      tag: 'runtime_defense',
    },
    {
      icon: '▣',
      title: 'Threat Intelligence Feed',
      desc: 'Dynamic threat feed with TLP 4-level classification, 8 built-in emerging signatures, source registration, and SupplyChainScanner integration.',
      color: 'var(--accent-green)',
      tag: 'supply_chain',
    },
    {
      icon: '⨂',
      title: 'ML Injection Detector',
      desc: 'Embedding-based semantic injection detection using 64-dim character n-gram hashing, k-NN classification across 5 languages, with auto-learning.',
      color: 'var(--accent-cyan)',
      tag: 'input_security',
    },
    {
      icon: '◈',
      title: 'Multimodal Content Scanner',
      desc: 'File fingerprinting for 15 types with SVG XSS, GIFAR polyglot, PDF /JS /Launch detection. Magic byte + extension consistency validation.',
      color: 'var(--accent-pink)',
      tag: 'input_security',
    },
    {
      icon: '⧁',
      title: 'AppContainer Sandbox',
      desc: 'Windows sandbox isolation via PowerShell AppContainer profiles with capability SIDs. Auto-detected on Win8+. Complements Seatbelt/bwrap/Docker sandbox chain.',
      color: 'var(--accent-amber)',
      tag: 'tool_safety',
    },
    {
      icon: '✓',
      title: 'Sandbox Verifier',
      desc: 'Formal sandbox verification with 7 cross-platform isolation tests: file read/write/escape, network access, process fork, env sanitization. Control-coverage reporting is separate from external audit evidence.',
      color: 'var(--accent-cyan)',
      tag: 'operational_readiness',
    },
    {
      icon: '♪',
      title: 'Voice Content Scanner',
      desc: 'Enhanced audio scanning: voice command injection (Hey Siri/OK Google/Alexa), DTMF frequency pair detection, spectrogram hidden data, LSB steganography analysis.',
      color: 'var(--accent-pink)',
      tag: 'input_security',
    },
    {
      icon: '🔒',
      title: 'TEE Sandbox',
      desc: 'Hardware-level Trusted Execution Environment: AWS Nitro Enclaves + GCP Confidential VMs (AMD SEV-SNP / Intel TDX). Memory encryption + cryptographic attestation.',
      color: 'var(--accent-purple)',
      tag: 'tool_safety',
    },
    {
      icon: '▦',
      title: 'MITRE ATLAS Mapper',
      desc: 'Automatic mapping of security events to MITRE ATLAS tactics/techniques (14 tactics, 60+ techniques). Generates ATLAS Navigator heatmaps + control-coverage reports.',
      color: 'var(--accent-blue)',
      tag: 'compliance',
    },
    {
      icon: '⧂',
      title: 'Adaptive HITL Engine',
      desc: 'Risk-adaptive human-in-the-loop: 6 dynamic strategies (auto→deny), multi-signal composite scoring from 6 sources, behavior profile learning, time-decay escalation, explainability trail.',
      color: 'var(--accent-cyan)',
      tag: 'runtime_defense',
    },
    {
      icon: '▣',
      title: 'Benchmark Runner',
      desc: 'CI/CD security benchmark scoring: embedded AgentDojo, Agent-SafetyBench, and AgentHarm test cases with trend tracking, baselines, and gate enforcement.',
      color: 'var(--accent-green)',
      tag: 'compliance',
    },
    {
      icon: '◉',
      title: 'Supply Chain Attestor',
      desc: 'SPDX 2.3 SBOM generation + Sigstore keyless signing + in-toto DSSE attestation. Cryptographic provenance proof for all Praetor components (US EO 14028).',
      color: 'var(--accent-purple)',
      tag: 'supply_chain',
    },
    {
      icon: 'ε',
      title: 'Differential Privacy Layer',
      desc: 'ε-DP Laplace + Gaussian mechanisms for cross-agent memory sharing. Auto-sensitivity analysis, per-agent budget accounting, and query sanitization (EU AI Act Art. 10 data minimization).',
      color: 'var(--accent-cyan)',
      tag: 'data_privacy',
    },
  ];

  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="section-head" style={{ marginBottom: '12px' }}>
        <div>
          <span className="section-label">Latest Additions</span>
          <h2 style={{ fontSize: '1.1rem' }}>New Capabilities · Gap-Fill Sprint</h2>
        </div>
        <span
          className="bdg"
          style={{
            borderColor: 'var(--accent-green)',
            color: 'var(--accent-green)',
            background: 'var(--accent-green)20',
          }}
        >
          15 modules
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
        {capabilities.map((cap) => (
          <div
            key={cap.title}
            style={{
              padding: '12px 14px',
              background: 'var(--bg-elevated)',
              borderLeft: `2px solid ${cap.color}`,
              borderRadius: '0 4px 4px 0',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
              <span style={{ color: cap.color, fontSize: '0.85rem', lineHeight: 1 }}>
                {cap.icon}
              </span>
              <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                {cap.title}
              </span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: '0.5rem',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-muted)',
                  background: 'var(--bg-surface)',
                  padding: '1px 5px',
                  borderRadius: '3px',
                }}
              >
                {cap.tag.replace(/_/g, ' ')}
              </span>
            </div>
            <div style={{ fontSize: '0.64rem', color: 'var(--text-tertiary)', lineHeight: '1.5' }}>
              {cap.desc}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AuditChecklistSection({ checklist }: { checklist: AuditChecklistItem[] }) {
  const byCategory = new Map<string, AuditChecklistItem[]>();
  for (const item of checklist) {
    const arr = byCategory.get(item.category) ?? [];
    arr.push(item);
    byCategory.set(item.category, arr);
  }

  const passed = checklist.filter((c) => c.status === 'passed').length;
  const total = checklist.length;

  return (
    <div className="card" style={{ padding: '16px 18px' }}>
      <div className="section-head" style={{ marginBottom: '10px' }}>
        <div>
          <span className="section-label">Audit Readiness</span>
          <h2 style={{ fontSize: '1.1rem' }}>
            Checklist · {passed}/{total} passed
          </h2>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
        {[...byCategory.entries()].map(([category, items]) => (
          <div key={category}>
            <h3
              style={{
                fontSize: '0.72rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--text-tertiary)',
                marginBottom: '6px',
              }}
            >
              {category}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {items.map((item) => {
                const icon =
                  item.status === 'passed'
                    ? '✓'
                    : item.status === 'failed'
                      ? '✗'
                      : item.status === 'pending'
                        ? '○'
                        : '─';
                const color =
                  item.status === 'passed'
                    ? 'var(--accent-green)'
                    : item.status === 'failed'
                      ? 'var(--accent-red)'
                      : item.status === 'pending'
                        ? 'var(--accent-amber)'
                        : 'var(--text-muted)';
                return (
                  <div
                    key={item.id}
                    style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}
                  >
                    <span style={{ color, fontWeight: 600, fontSize: '0.72rem', flexShrink: 0 }}>
                      {icon}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                      {item.item}
                    </span>
                    {item.notes && (
                      <span
                        style={{
                          fontSize: '0.6rem',
                          color: 'var(--text-muted)',
                          fontStyle: 'italic',
                        }}
                      >
                        {item.notes}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
