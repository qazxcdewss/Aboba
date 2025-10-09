import { DomainEvent } from './index';

export type EventHandler = (event: DomainEvent) => Promise<void> | void;

export interface EventBus {
  emit(event: DomainEvent): Promise<void>;
  on(eventName: string, handler: EventHandler): () => void;
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers: Map<string, Set<EventHandler>> = new Map();

  async emit(event: DomainEvent): Promise<void> {
    const set = this.handlers.get(event.name);
    if (!set || set.size === 0) return;
    await Promise.all(
      Array.from(set).map(async (h) => {
        try {
          await h(event);
        } catch (err) {
          /* eslint-disable no-console */ console.error(
            '[eventbus] handler failed',
            event.name,
            err,
          );
        }
      }),
    );
  }

  on(eventName: string, handler: EventHandler): () => void {
    const set = this.handlers.get(eventName) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(eventName, set);
    return () => {
      const s = this.handlers.get(eventName);
      if (s) {
        s.delete(handler);
        if (s.size === 0) this.handlers.delete(eventName);
      }
    };
  }
}

export const eventBus: EventBus = new InMemoryEventBus();
