/**
 * ConsensusPage — Plugin control + data plane for builtin-consensus.
 *
 * Shows plugin status (registered/enabled), topology state machine snapshot,
 * and provides enable/disable toggle.
 */
import { useState, useEffect, useCallback } from 'react';
import { Network, Power, PowerOff, RefreshCw } from 'lucide-react';
import { Badge, Button, MetricCard } from '../components/ui';
import {
  fetchConsensusStatus,
  enableConsensusPlugin,
  disableConsensusPlugin,
  type PluginStatus,
} from '../api';

interface ConsensusStatus extends PluginStatus {
  topologyState?: string;
}

export function ConsensusPage() {
  const [status, setStatus] = useState<ConsensusStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await fetchConsensusStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = async () => {
    if (!status) return;
    setToggling(true);
    try {
      if (status.enabled) {
        await disableConsensusPlugin();
      } else {
        await enableConsensusPlugin();
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setToggling(false);
    }
  };

  const registered = status?.registered ?? false;
  const enabled = status?.enabled ?? false;
  const topologyState = status?.topologyState ?? '—';

  const stateVariant = (state: string): 'success' | 'warning' | 'error' | 'info' => {
    switch (state) {
      case 'NORMAL':
        return 'success';
      case 'ALERT':
        return 'warning';
      case 'LOCKDOWN':
      case 'ESCALATE':
        return 'error';
      default:
        return 'info';
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>
          <Network size={20} /> Consensus
        </h1>
        <p>Praetor-BFT-C3: SAC, CourtEval, BPD, topology state machine, adaptive stopping.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong>builtin-consensus</strong>
            {!registered && <Badge variant="error">Not Registered</Badge>}
            {registered && enabled && <Badge variant="success">Enabled</Badge>}
            {registered && !enabled && <Badge variant="warning">Disabled</Badge>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw size={14} /> Refresh
            </Button>
            {registered && (
              <Button
                variant={enabled ? 'danger' : 'primary'}
                onClick={() => void handleToggle()}
                disabled={toggling}
              >
                {enabled ? <PowerOff size={14} /> : <Power size={14} />}
                {enabled ? 'Disable' : 'Enable'}
              </Button>
            )}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="metric-row">
          <MetricCard label="Topology State" value={topologyState} />
          <MetricCard label="Plugin" value={enabled ? 'Active' : 'Inactive'} />
        </div>
        {topologyState !== '—' && (
          <div style={{ marginTop: 8 }}>
            <Badge variant={stateVariant(topologyState)}>{topologyState}</Badge>
          </div>
        )}
      </div>

      <div className="card">
        <h3>About</h3>
        <p style={{ color: 'var(--text-dim)', fontSize: '0.85rem' }}>
          This plugin provides the Praetor-BFT-C3 consensus and fault tolerance stack: SAC
          protocol (receiver-side evaluation), CourtEval (adversarial court evaluation), BPD
          detector (backward propagation detection), topology state machine (4-state dynamic
          switching), and adaptive stopping (Beta-Binomial + KS test). It is heavy-weight — enable
          only for multi-agent runs that need Byzantine fault tolerance.
        </p>
      </div>
    </div>
  );
}
