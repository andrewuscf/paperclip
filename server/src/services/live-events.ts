import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

/**
 * EventEmitter stops at the first listener that throws. Live-event delivery is
 * advisory (the database remains the durable source of truth), so one broken
 * websocket/SSE subscriber must never prevent later subscribers from seeing a
 * committed event or turn an already-committed HTTP mutation into a 500.
 *
 * rawListeners() preserves EventEmitter's once-listener wrappers, including
 * their self-removal semantics, while still letting us isolate each callback.
 */
function emitIsolated(channel: string, event: LiveEvent) {
  for (const listener of emitter.rawListeners(channel)) {
    try {
      (listener as LiveEventListener).call(emitter, event);
    } catch (error) {
      logger.warn(
        { err: error, companyId: event.companyId, eventType: event.type, eventId: event.id },
        "live-event subscriber failed",
      );
    }
  }
}

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitIsolated(input.companyId, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitIsolated("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
