export interface DomainEvent {
  name: string;
  id: string;
  at: string;
  actor?: { type: 'user' | 'system' | 'bot'; id?: string };
  payload: Record<string, unknown>;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  traceId?: string;
}

export function ok<T>(data: T) {
  return { data };
}


