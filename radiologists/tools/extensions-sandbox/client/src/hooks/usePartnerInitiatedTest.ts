import { useCallback, useEffect, useRef, useState } from 'react';
import type { CapturedRequest } from '../types/testing';

/** The most requests the sandbox keeps for a capture. */
export const MAX_CAPTURED_REQUESTS = 20;
const POLL_INTERVAL_MS = 1000;
const RUNS_PATH = '/api/manifest/partner-initiated';

export type CapturePhase = 'idle' | 'starting' | 'capturing' | 'stopping';

interface Capture {
  /** Set once the capture is ending, so late responses are ignored. */
  ended: boolean;
  /** Whether the sandbox shows that capturing stopped once the capture has ended. */
  showStopped: boolean;
  runId?: string;
  lastSequence: number;
  timer?: ReturnType<typeof setTimeout>;
  pollController?: AbortController;
  stopping?: Promise<void>;
}

interface CaptureResponse {
  runId?: string;
  status?: string;
  count?: number;
  requests?: CapturedRequest[];
  error?: string;
}

interface Options {
  manifestInfo: object | null;
  manifestRevision: number;
  capability: string;
  toolName: string;
  /** Called for each request the sandbox answers while capturing, oldest first. */
  onRequest: (request: CapturedRequest) => void;
}

const capturePath = (runId: string) => `${RUNS_PATH}/${encodeURIComponent(runId)}`;
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

async function readCapture(response: Response): Promise<CaptureResponse> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * Run Test for partnerInitiated tools. A capture opens the sandbox's simulated Dragon Copilot
 * endpoint, which answers requests only while a capture is open, and reports every request it answers.
 * A new manifest or tool, Reset Inputs, or leaving the page ends the capture.
 */
export function usePartnerInitiatedTest({ manifestInfo, manifestRevision, capability, toolName, onRequest }: Options) {
  const [phase, setPhase] = useState<CapturePhase>('idle');
  const [stopped, setStopped] = useState(false);
  const [count, setCount] = useState(0);
  const [requests, setRequests] = useState<CapturedRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Capture | null>(null);
  const mounted = useRef(true);
  const onRequestRef = useRef(onRequest);

  useEffect(() => {
    onRequestRef.current = onRequest;
  }, [onRequest]);

  const reportError = useCallback((message: string) => {
    if (mounted.current) setError(message);
    else console.error(message);
  }, []);

  const release = useCallback((capture: Capture) => {
    clearTimeout(capture.timer);
    capture.pollController?.abort();
    if (active.current !== capture) return;
    active.current = null;
    if (mounted.current) {
      setPhase('idle');
      if (capture.showStopped) setStopped(true);
    }
  }, []);

  const stopOnServer = useCallback((capture: Capture): Promise<void> => {
    capture.stopping ??= (async () => {
      try {
        const response = await fetch(capturePath(capture.runId!), { method: 'DELETE', keepalive: true });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (cause) {
        reportError(`Could not stop listening; the sandbox may still answer requests. ${messageOf(cause)}`);
      } finally {
        release(capture);
      }
    })();
    return capture.stopping;
  }, [release, reportError]);

  /** Ends a capture. A pending start finishes first, so that its capture is stopped too. */
  const end = useCallback(async (capture: Capture, showStopped: boolean) => {
    capture.showStopped = (capture.ended ? capture.showStopped : true) && showStopped;
    capture.ended = true;
    clearTimeout(capture.timer);
    capture.pollController?.abort();
    if (mounted.current && active.current === capture) setPhase('stopping');
    if (capture.runId) await stopOnServer(capture);
  }, [stopOnServer]);

  /** Stop capturing: the endpoint answers 503 until the next start. */
  const cancel = useCallback(async () => {
    const capture = active.current;
    if (capture) await end(capture, true);
  }, [end]);

  /** Ends any capture and forgets its requests. */
  const clear = useCallback(() => {
    const capture = active.current;
    if (capture) void end(capture, false);
    setStopped(false);
    setRequests([]);
    setCount(0);
    setError(null);
  }, [end]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    setStopped(false);
    setRequests([]);
    setCount(0);
    setError(null);
    return () => {
      const capture = active.current;
      if (capture) void end(capture, false);
    };
  }, [manifestInfo, manifestRevision, capability, toolName, end]);

  useEffect(() => {
    const handlePageHide = () => {
      const capture = active.current;
      if (capture) void end(capture, true);
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [end]);

  const start = useCallback(async () => {
    if (active.current) return;
    const capture: Capture = { ended: false, showStopped: true, lastSequence: 0 };
    active.current = capture;
    setError(null);
    setStopped(false);
    setRequests([]);
    setCount(0);
    setPhase('starting');

    const poll = async (): Promise<void> => {
      if (capture.ended) return;
      capture.pollController = new AbortController();
      try {
        const response = await fetch(`${capturePath(capture.runId!)}?after=${capture.lastSequence}`, {
          signal: capture.pollController.signal,
          cache: 'no-store',
        });
        const data = await readCapture(response);
        if (capture.ended) return;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (data.status !== 'capturing' || !Array.isArray(data.requests) || typeof data.count !== 'number') {
          throw new Error('The sandbox returned an invalid run.');
        }
        const received = data.requests.filter((request) => request.sequence > capture.lastSequence);
        if (received.length > 0) {
          capture.lastSequence = Math.max(...received.map((request) => request.sequence));
          setRequests((current) => [...current, ...received].slice(-MAX_CAPTURED_REQUESTS));
          for (const request of received) onRequestRef.current(request);
        }
        setCount(data.count);
        capture.timer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
      } catch (cause) {
        if (capture.ended) return;
        reportError(`Stopped listening. ${messageOf(cause)}`);
        await end(capture, true);
      }
    };

    try {
      const response = await fetch(`${RUNS_PATH}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability, tool: toolName }),
      });
      const data = await readCapture(response);
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (!data.runId) throw new Error('The sandbox did not return a run.');
      capture.runId = data.runId;
      if (capture.ended) {
        await stopOnServer(capture);
        return;
      }
      setPhase('capturing');
      capture.timer = setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    } catch (cause) {
      if (!capture.ended) {
        reportError(`Could not start listening. ${messageOf(cause)}`);
        capture.ended = true;
        capture.showStopped = false;
      }
      if (capture.runId) await stopOnServer(capture);
      else release(capture);
    }
  }, [capability, toolName, end, release, reportError, stopOnServer]);

  return {
    phase,
    isActive: phase !== 'idle',
    /** True after a capture stopped, until the next start, Reset Inputs, or a new manifest or tool. */
    stopped,
    /** How many requests the capture has answered, including any no longer kept. */
    count,
    /** The capture's last {@link MAX_CAPTURED_REQUESTS} requests, oldest first. */
    requests,
    error,
    start,
    cancel,
    clear,
  };
}
