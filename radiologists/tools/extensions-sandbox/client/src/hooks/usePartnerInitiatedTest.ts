import { useCallback, useEffect, useRef, useState } from 'react';
import type { PartnerInitiatedResult } from '../types/testing';

type Phase = 'idle' | 'starting' | 'waiting' | 'stopping';

interface Operation {
  cancelled: boolean;
  startedAt: number;
  runId?: string;
  callbackUrl?: string;
  timer?: ReturnType<typeof setTimeout>;
  pollController?: AbortController;
  stopping?: Promise<void>;
}

interface RunStatus {
  runId: string;
  callbackPath: string;
  status: 'waiting' | 'completed';
  result?: PartnerInitiatedResult;
  error?: string;
}

interface Options {
  manifestInfo: object | null;
  manifestRevision: number;
  capability: string;
  toolName: string;
  onComplete: (result: PartnerInitiatedResult, elapsedMs: number, callbackUrl: string) => void;
}

export function usePartnerInitiatedTest({
  manifestInfo, manifestRevision, capability, toolName, onComplete,
}: Options) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Operation | null>(null);
  const mounted = useRef(true);

  const reportError = useCallback((message: string) => {
    if (mounted.current) setError(message);
    else console.error(message);
  }, []);

  const release = useCallback((operation: Operation) => {
    clearTimeout(operation.timer);
    operation.pollController?.abort();
    if (active.current !== operation) return;
    active.current = null;
    if (mounted.current) {
      setPhase('idle');
      setCallbackUrl(null);
    }
  }, []);

  const stop = useCallback((operation: Operation): Promise<void> => {
    if (operation.stopping) return operation.stopping;
    operation.stopping = (async () => {
      try {
        const response = await fetch(`/api/manifest/partner-initiated/${encodeURIComponent(operation.runId!)}`, {
          method: 'DELETE',
          keepalive: true,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (cause) {
        reportError(`Could not stop the partner-initiated listener; it may still be listening. ${
          cause instanceof Error ? cause.message : String(cause)
        }`);
      } finally {
        release(operation);
      }
    })();
    return operation.stopping;
  }, [release, reportError]);

  const cancel = useCallback(async () => {
    const operation = active.current;
    if (!operation) return;
    operation.cancelled = true;
    clearTimeout(operation.timer);
    operation.pollController?.abort();
    if (mounted.current) {
      setPhase('stopping');
      setCallbackUrl(null);
    }
    // A pending start must finish so its run ID can be cancelled on the server.
    if (operation.runId) await stop(operation);
  }, [stop]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setError(null);
    return () => { void cancel(); };
  }, [manifestInfo, manifestRevision, capability, toolName, cancel]);

  const start = useCallback(async () => {
    if (active.current) return;
    const operation: Operation = { cancelled: false, startedAt: performance.now() };
    active.current = operation;
    setError(null);
    setPhase('starting');

    const poll = async (): Promise<void> => {
      if (operation.cancelled) return;
      operation.pollController = new AbortController();
      try {
        const response = await fetch(`/api/manifest/partner-initiated/${encodeURIComponent(operation.runId!)}`, {
          signal: operation.pollController.signal,
          cache: 'no-store',
        });
        const data: RunStatus = await response.json();
        if (operation.cancelled) return;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (data.status === 'completed' && data.result) {
          release(operation);
          onComplete(data.result, Math.round(performance.now() - operation.startedAt), operation.callbackUrl!);
        } else if (data.status === 'waiting') {
          operation.timer = setTimeout(() => { void poll(); }, 1000);
        } else {
          throw new Error('The sandbox returned an invalid listener status.');
        }
      } catch (cause) {
        if (operation.cancelled) return;
        reportError(`Could not retrieve the partner-initiated test result. ${
          cause instanceof Error ? cause.message : String(cause)
        }`);
        operation.cancelled = true;
        await stop(operation);
      }
    };

    try {
      const response = await fetch('/api/manifest/partner-initiated/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability, tool: toolName }),
      });
      const data: RunStatus = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (!data.runId || !data.callbackPath) throw new Error('The sandbox did not return a listener URL.');
      operation.runId = data.runId;
      operation.callbackUrl = new URL(data.callbackPath, window.location.origin).href;
      if (operation.cancelled) {
        await stop(operation);
        return;
      }
      setCallbackUrl(operation.callbackUrl);
      setPhase('waiting');
      void poll();
    } catch (cause) {
      if (!operation.cancelled) {
        reportError(`Could not start the partner-initiated listener. ${
          cause instanceof Error ? cause.message : String(cause)
        }`);
      }
      if (operation.runId) await stop(operation);
      else release(operation);
    }
  }, [capability, toolName, onComplete, release, reportError, stop]);

  return { phase, isActive: phase !== 'idle', callbackUrl, error, start, cancel };
}
