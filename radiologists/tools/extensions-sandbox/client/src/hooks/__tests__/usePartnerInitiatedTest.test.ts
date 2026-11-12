import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { usePartnerInitiatedTest } from '../usePartnerInitiatedTest';
import type { CapturedRequest } from '../../types/testing';

const callbackPath = '/api/v1/tenants/11111111-1111-1111-1111-111111111111/environments/22222222-2222-2222-2222-222222222222/draft-report-ai-results';
const capture = { runId: 'test-run', status: 'capturing', callbackPath, count: 0, requests: [] as CapturedRequest[] };
const runPath = '/api/manifest/partner-initiated/test-run';
const options = {
  manifestInfo: { name: 'example' },
  manifestRevision: 1,
  capability: 'preDraftReportGeneration',
  toolName: 'preDraftTool',
};
type Props = Omit<typeof options, 'manifestInfo'> & { manifestInfo: object | null };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function captured(sequence: number, status = 200): CapturedRequest {
  return {
    sequence,
    receivedAt: '2026-10-08T00:00:00.000Z',
    path: callbackPath,
    status,
    statusText: status === 200 ? 'OK' : 'Conflict',
    rawBody: { draftReport: { identifier: `report-${sequence}` } },
    validation: {
      valid: status === 200,
      toolName: 'preDraftTool',
      outputContentType: 'application/vnd.ms-dragon.rad.draft-report+json',
      checks: [{ check: 'Draft report stored', passed: status === 200 }],
      summary: { passed: status === 200 ? 1 : 0, failed: status === 200 ? 0 : 1 },
      timestamp: '2026-10-08T00:00:00.000Z',
    },
  };
}

/** Answers polls with the given requests, filtered by `after` as the sandbox does. */
function serve(requests: CapturedRequest[], count = requests.length) {
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (init?.method === 'POST') return json(capture, 201);
    const after = Number(new URL(String(input), window.location.origin).searchParams.get('after') ?? 0);
    return json({ ...capture, count, requests: requests.filter((request) => request.sequence > after) });
  });
}

const polls = () => fetchMock.mock.calls.filter(([, init]) => !init?.method).map(([url]) => String(url));
const deletes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  serve([]);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  await act(async () => { cleanup(); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startCapture(onRequest = vi.fn()) {
  const hook = renderHook((props: Props) => usePartnerInitiatedTest({ ...props, onRequest }), { initialProps: options as Props });
  await act(async () => { await hook.result.current.start(); });
  return { ...hook, onRequest };
}

const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });

describe('usePartnerInitiatedTest', () => {
  it('starts listening without executing the extension', async () => {
    const { result, onRequest } = await startCapture();

    expect(result.current.phase).toBe('capturing');
    expect(fetchMock).toHaveBeenCalledWith('/api/manifest/partner-initiated/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ capability: options.capability, tool: options.toolName }),
    }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(false);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('reports each request once, in order, and keeps capturing', async () => {
    const { result, onRequest } = await startCapture();
    serve([captured(1)]);
    await tick();
    expect(onRequest.mock.calls).toEqual([[captured(1)]]);

    serve([captured(1), captured(2, 409), captured(3, 409)]);
    await tick();
    expect(onRequest.mock.calls.map(([request]) => request.sequence)).toEqual([1, 2, 3]);
    expect(polls()).toEqual([`${runPath}?after=0`, `${runPath}?after=1`]);
    expect(result.current.phase).toBe('capturing');

    await tick();
    expect(onRequest).toHaveBeenCalledTimes(3);
    expect(polls().at(-1)).toBe(`${runPath}?after=3`);
  });

  it('stops capturing and polling', async () => {
    const { result } = await startCapture();
    serve([captured(1)]);
    await tick();
    await act(async () => { await result.current.cancel(); });

    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
    expect(result.current.phase).toBe('idle');
    const callCount = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(callCount);
  });

  it('starts again after stopping, reading the new capture from the start', async () => {
    const { result } = await startCapture();
    serve([captured(1)]);
    await tick();
    await act(async () => { await result.current.cancel(); });
    await act(async () => { await result.current.start(); });

    expect(result.current.phase).toBe('capturing');
    await tick();
    expect(polls().at(-1)).toBe(`${runPath}?after=0`);
  });

  it('stops a pending start once its capture ID arrives instead of leaving the endpoint open', async () => {
    let resolveStart!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveStart = resolve; }));
    const onRequest = vi.fn();
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onRequest }));
    let starting!: Promise<void>;
    act(() => { starting = result.current.start(); });
    await act(async () => { await result.current.cancel(); });
    expect(result.current.phase).toBe('stopping');

    await act(async () => {
      resolveStart(json(capture, 201));
      await starting;
    });

    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('idle');
  });

  it.each([
    { manifestRevision: 2 },
    { toolName: 'anotherTool' },
    { capability: 'qualityCheck' },
    { manifestInfo: null },
  ])('ends the capture when the context changes: %j', async (change) => {
    const { result, rerender, onRequest } = await startCapture();
    serve([captured(1)]);
    await tick();
    await act(async () => { rerender({ ...options, ...change }); });

    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
    expect(result.current.phase).toBe('idle');
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it('ends the capture on clear', async () => {
    const { result } = await startCapture();
    serve([captured(1)]);
    await tick();
    await act(async () => { result.current.clear(); });

    expect(fetchMock).toHaveBeenCalledWith(runPath, expect.objectContaining({ method: 'DELETE' }));
    expect(result.current.phase).toBe('idle');
  });

  it('stops capturing when the page is hidden, and when the component unmounts', async () => {
    await startCapture();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(deletes()).toEqual([[runPath, expect.objectContaining({ method: 'DELETE', keepalive: true })]]);

    const second = await startCapture();
    await act(async () => { second.unmount(); });
    expect(deletes()).toHaveLength(2);
    expect(deletes()[1][1]).toMatchObject({ keepalive: true });
  });

  it('ignores requests from a poll that arrives after Stop', async () => {
    let resolvePoll!: (response: Response) => void;
    const { result, onRequest } = await startCapture();
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Promise((resolve) => { resolvePoll = resolve; });
    });
    await tick();
    await act(async () => { await result.current.cancel(); });
    await act(async () => { resolvePoll(json({ ...capture, count: 1, requests: [captured(1)] })); });
    expect(onRequest).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
  });

  it('reports a start failure without capturing', async () => {
    fetchMock.mockResolvedValue(json({ error: 'No manifest loaded.' }, 400));
    const { result } = renderHook(() => usePartnerInitiatedTest({ ...options, onRequest: vi.fn() }));
    await act(async () => { await result.current.start(); });
    expect(result.current.error).toBe('Could not start listening. No manifest loaded.');
    expect(result.current.phase).toBe('idle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops and says why when the sandbox ends the capture', async () => {
    const { result } = await startCapture();
    fetchMock.mockImplementation(async (_input, init) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ error: 'The run has stopped or was replaced.' }, 404),
    );
    await tick();
    expect(result.current.error).toBe('Stopped listening. The run has stopped or was replaced.');
    expect(result.current.phase).toBe('idle');
  });

  it('reports a failed stop rather than claiming the endpoint stopped answering', async () => {
    const { result } = await startCapture();
    fetchMock.mockRejectedValue(new Error('Network unavailable'));
    await act(async () => { await result.current.cancel(); });
    expect(result.current.error).toContain('the sandbox may still answer requests');
  });
});
