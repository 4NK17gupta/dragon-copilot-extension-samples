import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePartnerInitiatedTest } from '../usePartnerInitiatedTest';
import type { PartnerInitiatedResult } from '../../types/testing';

const run = {
  runId: 'test-run',
  callbackPath: '/api/partnerInitiated/00000000-0000-0000-0000-000000000000/preDraftTool',
  status: 'waiting',
};
const runPath = '/api/manifest/partner-initiated/test-run';
const options = {
  manifestInfo: { name: 'example' },
  manifestRevision: 1,
  capability: 'preDraftReportGeneration',
  toolName: 'preDraftTool',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function outputResult(valid: boolean): PartnerInitiatedResult {
  return {
    status: valid ? 200 : 422,
    statusText: valid ? 'OK' : 'Unprocessable Entity',
    rawBody: { identifier: 'example-report' },
    validation: {
      valid,
      toolName: 'preDraftTool',
      outputContentType: 'application/vnd.ms-dragon.rad.pre-draft-report+json',
      checks: [{ check: 'Output schema', passed: valid }],
      summary: { passed: valid ? 1 : 0, failed: valid ? 0 : 1 },
      timestamp: '2026-10-08T00:00:00Z',
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return json(run);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { cleanup(); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePartnerInitiatedTest', () => {
  it('starts listening and exposes an absolute callback URL without executing the extension', async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete }));
    await act(async () => { await result.current.start(); });

    expect(result.current.phase).toBe('waiting');
    expect(result.current.callbackUrl).toBe(new URL(run.callbackPath, window.location.origin).href);
    expect(fetchMock).toHaveBeenCalledWith('/api/manifest/partner-initiated/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ capability: options.capability, tool: options.toolName }),
    }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([true, false])('delivers the completed validation result (valid=%s) and stops polling', async (valid) => {
    const onComplete = vi.fn();
    const completed = outputResult(valid);
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete }));
    await act(async () => { await result.current.start(); });
    fetchMock.mockResolvedValue(json({ ...run, status: 'completed', result: completed }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    expect(onComplete).toHaveBeenCalledWith(completed, expect.any(Number), expect.stringContaining(run.callbackPath));
    expect(result.current.phase).toBe('idle');
    expect(result.current.error).toBeNull();
    const callCount = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(callCount);
  });

  it('cancels the active listener and stops polling', async () => {
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete: vi.fn() }));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.cancel(); });

    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
    expect(result.current.phase).toBe('idle');
    expect(result.current.callbackUrl).toBeNull();
    const callCount = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(callCount);
  });

  it('cancels a pending start when its run ID arrives instead of leaving an orphan listener', async () => {
    let resolveStart!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete }));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    await act(async () => { await result.current.cancel(); });
    expect(result.current.phase).toBe('stopping');

    await act(async () => {
      resolveStart(json(run, 201));
      await starting;
    });

    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('idle');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each([
    { manifestRevision: 2 },
    { toolName: 'anotherTool' },
    { capability: 'qualityCheck' },
    { manifestInfo: null },
  ])('cancels when the selected context changes: %j', async (change) => {
    const onComplete = vi.fn();
    const initialProps = { ...options, manifestInfo: options.manifestInfo as object | null };
    const { result, rerender } = renderHook(
      (props) => usePartnerInitiatedTest({ ...props, onComplete }), { initialProps },
    );
    await act(async () => { await result.current.start(); });
    await act(async () => { rerender({ ...initialProps, ...change }); });

    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
    expect(result.current.phase).toBe('idle');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('disarms the listener when the component unmounts', async () => {
    const { result, unmount } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete: vi.fn() }));
    await act(async () => { await result.current.start(); });
    await act(async () => { unmount(); });
    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE', keepalive: true }));
  });

  it('ignores a completed poll that arrives after cancellation', async () => {
    let resolvePoll!: (response: Response) => void;
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') return json(run);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Promise((resolve) => { resolvePoll = resolve; });
    });
    const onComplete = vi.fn();
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete }));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.cancel(); });
    await act(async () => { resolvePoll(json({ ...run, status: 'completed', result: outputResult(true) })); });
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('surfaces start failures without switching to a waiting state', async () => {
    fetchMock.mockResolvedValue(json({ error: 'No manifest loaded.' }, 404));
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete: vi.fn() }));
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toContain('No manifest loaded.');
    expect(result.current.phase).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a polling failure and disarms the listener', async () => {
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete: vi.fn() }));
    await act(async () => { await result.current.start(); });
    fetchMock.mockImplementation(async (_input, init) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ error: 'Run expired.' }, 404),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.error).toContain('Run expired.');
    expect(result.current.phase).toBe('idle');
    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
  });

  it('reports cancellation failures rather than claiming the server stopped listening', async () => {
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onComplete: vi.fn() }));
    await act(async () => { await result.current.start(); });
    fetchMock.mockRejectedValue(new Error('Network unavailable'));
    await act(async () => { await result.current.cancel(); });
    expect(result.current.error).toContain('it may still be listening');
  });
});
