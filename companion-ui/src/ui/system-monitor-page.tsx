import { useEffect, useState } from 'react';
import { loadSystemMonitor, type MonitorLane, type MonitorSource, type SystemMonitorSnapshot } from '../lib/system-monitor.js';
import '../styles/system-monitor.css';

const REFRESH_MS = 30_000;
const STALE_MS = REFRESH_MS * 3;
const STATUS: Record<string, string> = { ok: 'Run recorded', skipped: 'Blocked / skipped', degraded: 'Degraded', failed: 'Failed', stale: 'Overdue', paused: 'Disabled / paused', never: 'No evidence' };
const OUTREACH: Record<string, string> = { received: 'Impulse being applied', off: 'Disabled at source', shadow: 'Shadow; pressure unchanged', applied: 'Raised per-contact pressure', no_live_desire: 'No one to raise pressure for', lane_disabled: 'Social desire disabled', interrupted: 'Interrupted; not re-applied' };
function clock(value: number | null): string { return value === null || !Number.isFinite(value) ? 'No recorded evidence' : new Date(value).toLocaleString(); }
function title(value: string): string { return value.replaceAll('_', ' '); }
function sourceFailure(source: MonitorSource<unknown>): string | null {
  return source.status === 'available' ? null : source.status === 'forbidden' ? 'Access unavailable. Sign in with permission to view this companion’s Garden.' : source.status === 'error' ? 'Evidence could not be read. Refresh to retry.' : 'This evidence source is unavailable.';
}
function Lane({ lane }: { lane: MonitorLane }) {
  return <details className={`monitor-lane status-${lane.status}`}>
    <summary><span>{lane.label}</span><strong>{STATUS[lane.status] ?? 'Unknown'}</strong></summary>
    <p>{lane.reason ? title(lane.reason) : lane.status === 'failed' ? 'A failure was recorded. Private error bodies are not shown.' : 'No gate reason recorded.'}</p>
    <dl><dt>Last check / activity</dt><dd>{clock(lane.lastEventAt)}</dd><dt>{lane.source === 'scheduler' ? 'Last successful completion' : 'Last successful observation'} in available evidence</dt><dd>{clock(lane.lastSuccessAt)}</dd>
      {lane.nextRunDueAt !== null && <><dt>Next due</dt><dd>{clock(lane.nextRunDueAt)}</dd></>}
    </dl>
    {lane.counts.length > 0 && <dl>{lane.counts.map(([key, value]) => <div key={key}><dt>{title(key)}</dt><dd>{key.endsWith('AtMs') ? clock(value) : value}</dd></div>)}</dl>}
    <p className="monitor-caption">{lane.sinceProcessStart ? 'Observations since this process started; absence is not proof of health.' : `Evidence source: ${title(lane.source)}.`}</p>
    {lane.recent.length > 0 && <ol>{lane.recent.map((event, index) => <li key={`${event.at}:${index}`}><time>{clock(event.at)}</time> · {title(event.outcome)}{event.reason ? ` · ${title(event.reason)}` : ''}</li>)}</ol>}
  </details>;
}
function Lanes({ label, lanes }: { label: string; lanes: MonitorLane[] }) {
  return <section className="monitor-section"><h2>{label}</h2>{lanes.length ? lanes.map(lane => <Lane key={lane.id} lane={lane} />) : <p>No lane evidence is available.</p>}</section>;
}

export function SystemMonitorPage({ companionId, companionLabel, authorized, active, load = loadSystemMonitor }: {
  companionId: string | null; companionLabel: string; authorized: boolean; active: boolean;
  load?: typeof loadSystemMonitor;
}) {
  const [snapshot, setSnapshot] = useState<SystemMonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [scope, setScope] = useState<'companion' | 'fleet'>('companion');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setSnapshot(null); setFailed(false);
    if (!active || !authorized || !companionId) { setLoading(false); return; }
    const controller = new AbortController();
    let running = false;
    const update = async () => {
      setNow(Date.now());
      if (running || document.visibilityState === 'hidden') return;
      running = true; setLoading(true);
      try {
        const result = await load(companionId, controller.signal);
        if (!controller.signal.aborted) {
          if (result.companionId !== companionId) throw new Error('Monitor scope mismatch');
          setSnapshot(result); setFailed(false);
        }
      } catch { if (!controller.signal.aborted) { setSnapshot(null); setFailed(true); } }
      finally { running = false; if (!controller.signal.aborted) setLoading(false); }
    };
    void update();
    const timer = window.setInterval(() => { void update(); }, REFRESH_MS);
    const visible = () => { void update(); };
    document.addEventListener('visibilitychange', visible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [active, authorized, companionId, load, refresh]);
  const current = authorized && snapshot?.companionId === companionId ? snapshot : null;
  const health = current?.health.status === 'available' ? current.health.data : null;
  const configuration = health?.configuration;
  const lanes = health?.lanes ?? [];
  const stale = health !== null && now - health.generatedAt > STALE_MS;
  const incidents = current?.incidents.status === 'available' ? current.incidents.data.filter(i => i.scope === (scope === 'fleet' ? 'system' : 'companion')) : [];
  return <main className="system-monitor" aria-label="System monitor">
    <header><div><p className="monitor-caption">Runtime evidence</p><h1>System monitor</h1><p>{scope === 'companion' ? companionLabel : 'Fleet shared services'}</p></div>
      <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={!authorized || loading}>Refresh</button></header>
    {!authorized || !companionId ? <p role="status">Sign in and select a companion to view authorized system evidence.</p> : <>
      <nav aria-label="Monitor scope"><button type="button" aria-pressed={scope === 'companion'} onClick={() => setScope('companion')}>This companion</button><button type="button" aria-pressed={scope === 'fleet'} onClick={() => setScope('fleet')}>Fleet services</button></nav>
      <p className="monitor-caption">Refreshes every 30 seconds while visible. A successful check does not prove every subsystem is working.</p>
      {loading && <p role="status">Reading runtime evidence…</p>}
      {failed && <p role="alert">System evidence could not be read. Refresh to retry.</p>}
      {current && <p>Last fetched: {clock(current.fetchedAt)}</p>}
      {stale && <p role="alert">Stale snapshot. The latest recorded activity may be older than this page.</p>}
      {scope === 'companion' && <>
        {current && sourceFailure(current.health) && <p role="alert">Subsystems: {sourceFailure(current.health)}</p>}
        {health && <>
          <p className="monitor-caption">Process started: {clock(health.processStartedAt)}. Snapshot: {clock(health.generatedAt)}.</p>
          <Lanes label="Scheduler and checks" lanes={lanes.filter(l => l.source === 'scheduler')} />
          <section className="monitor-section"><h2>Free time</h2><p>Configured: {configuration ? configuration.freeTimeEnabled ? 'Enabled' : 'Disabled' : 'Configuration unavailable'}</p>
            <p className="monitor-caption">Gate checks show whether offering free time was allowed. Completed blocks show start/end times, activity, rest by choice, and chooser failures. A live in-progress block is not separately reported by this source.</p>
            {lanes.filter(l => l.id === 'free_time').map(l => <Lane key={l.id} lane={l} />)}
          </section>
          <section className="monitor-section"><h2>Proactive communication</h2>
            <p>EmoSim: {configuration ? title(configuration.emosimProactivityMode) : 'Configuration unavailable'} · Social desire: {configuration ? configuration.socialDesireEnabled ? 'Enabled' : 'Disabled' : 'Unknown'} · Concerns: {configuration ? configuration.weightedThoughtOutreachEnabled ? 'Enabled' : 'Disabled' : 'Unknown'}</p>
            {configuration?.proactive.status === 'available' ? <><p>Felt impulses: {configuration.proactive.summary.total}. Last source fire: {clock(configuration.proactive.summary.lastFiredAtMs)}.</p>
              <p>Last confirmed delivery: {clock(configuration.proactive.summary.lastDeliveredAtMs)}</p>
              <dl className="monitor-counts">{configuration.proactive.summary.states.map(s => <div key={s.state}><dt>{OUTREACH[s.state]}</dt><dd>{s.count}</dd></div>)}</dl>
              <p className="monitor-caption">An impulse only raises pressure for people she already feels drawn to; each person then gets their own outreach moment. A source fire is not a delivered message.</p></> : <p>Durable proactive delivery evidence {configuration?.proactive.status === 'error' ? 'could not be read' : 'is unavailable'}.</p>}
            {lanes.filter(l => ['weighted_thought_outreach', 'social_desire_outreach'].includes(l.id)).map(l => <Lane key={l.id} lane={l} />)}
          </section>
          <Lanes label="Memory and background work" lanes={lanes.filter(l => l.source !== 'scheduler' && !['free_time', 'weighted_thought_outreach', 'social_desire_outreach'].includes(l.id))} />
        </>}
      </>}
      <section className="monitor-section"><h2>{scope === 'fleet' ? 'Shared-service incidents' : 'Recorded incidents'}</h2>
        {current && sourceFailure(current.incidents) ? <p role="alert">{sourceFailure(current.incidents)}</p> : current && incidents.length === 0 ? <p>No incidents recorded in the available window. This does not certify health.</p> : incidents.map(i => <article className={`monitor-incident incident-${i.status}`} key={i.id}><strong>{title(i.code)}</strong><p>{i.status} · {i.count} occurrences · {clock(i.at)}</p></article>)}
        {scope === 'fleet' && <p className="monitor-caption">These are system-owned incidents from the existing fleet health stream. Other companions’ private activity is not included.</p>}
      </section>
      {scope === 'companion' && <section className="monitor-section"><h2>Recent model providers</h2>
        {current && sourceFailure(current.providers) ? <p role="alert">{sourceFailure(current.providers)}</p> : current?.providers.status === 'available' && current.providers.data.length === 0 ? <p>No operator-visible calls recorded today.</p> : current?.providers.status === 'available' && current.providers.data.map((p, index) => <article key={`${p.at}:${index}`}><strong>{p.model}</strong><p>{p.provider} · serving provider: {p.servingProvider ?? 'Not recorded in this source'} · {p.status}</p><p className="monitor-caption">{clock(p.at)}</p></article>)}
      </section>}
    </>}
  </main>;
}
