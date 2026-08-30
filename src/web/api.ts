import type {
  CapabilityReport,
  ConnectionStatus,
  InvestigationOffer,
  Report,
  Target,
  TargetFilter,
  TargetSelection,
  TimeRangeId,
} from '../shared/types.ts'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const payload = (await response.json()) as T | { error: string }

  if (!response.ok || (payload && typeof payload === 'object' && 'error' in payload)) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error: string }).error
        : `Request failed (HTTP ${response.status})`
    throw new Error(message)
  }
  return payload as T
}

export const api = {
  health: () => call<ConnectionStatus>('/api/health'),

  refresh: () => call<{ metricCount: number }>('/api/refresh', { method: 'POST' }),

  targets: () => call<Target[]>('/api/targets'),

  capabilities: () => call<CapabilityReport>('/api/capabilities'),

  narrowingLabels: (job: string) => call<string[]>(`/api/targets/${encodeURIComponent(job)}/labels`),

  narrowingValues: (job: string, label: string, filters: TargetFilter[]) =>
    call<string[]>(
      `/api/targets/${encodeURIComponent(job)}/labels/${encodeURIComponent(label)}/values` +
        `?filters=${encodeURIComponent(JSON.stringify(filters))}`,
    ),

  investigations: (target: TargetSelection) =>
    call<InvestigationOffer[]>('/api/investigations', {
      method: 'POST',
      body: JSON.stringify(target),
    }),

  run: (investigationId: string, target: TargetSelection, range: TimeRangeId) =>
    call<Report>('/api/run', {
      method: 'POST',
      body: JSON.stringify({ investigationId, target, range }),
    }),
}
