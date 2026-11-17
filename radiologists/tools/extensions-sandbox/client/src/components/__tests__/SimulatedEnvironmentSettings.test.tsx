import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Button, FluentProvider, webLightTheme } from '@fluentui/react-components';
import { SimulatedEnvironmentSettings } from '../SimulatedEnvironmentSettings';

const submissionPath = (environmentId: string) =>
  `/api/v1/tenants/11111111-1111-1111-1111-111111111111/environments/${environmentId}/draft-report-ai-results`;

const stored = {
  customerTenantId: '11111111-1111-1111-1111-111111111111',
  environmentId: '22222222-2222-2222-2222-222222222222',
  marketplace: { publisherId: '101', offerId: '202', planId: '303' },
  orders: ['ACC-0000001'],
  submissionPath: submissionPath('22222222-2222-2222-2222-222222222222'),
  storedResultCount: 1,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let handlePut: (body: Record<string, unknown>) => Response;
/** The environment the sandbox returns before any save. */
let environment: Record<string, unknown>;

beforeEach(() => {
  environment = stored;
  handlePut = (body) => json({
    ...stored,
    ...body,
    submissionPath: submissionPath(String(body.environmentId)),
  });
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === '/api/simulated-environment' && init?.method === 'PUT') {
      return handlePut(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    if (url === '/api/simulated-environment/stored-results' && init?.method === 'DELETE') {
      return json({ ...stored, storedResultCount: 0 });
    }
    if (url === '/api/simulated-environment') return json(environment);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSettings(props: Parameters<typeof SimulatedEnvironmentSettings>[0] = {}) {
  render(
    <FluentProvider theme={webLightTheme}>
      <SimulatedEnvironmentSettings {...props} />
    </FluentProvider>,
  );
}

function puts() {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/simulated-environment' && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

describe('SimulatedEnvironmentSettings', () => {
  it('shows the submission URL and the stored result count', async () => {
    renderSettings();
    expect(await screen.findByText(`POST ${new URL(stored.submissionPath, window.location.origin).href}`)).toBeInTheDocument();
    expect(screen.getByText(/Stored results: 1/)).toBeInTheDocument();
  });

  it('shows the authentication disclaimer as small print right after the endpoint URL', async () => {
    renderSettings();
    const url = await screen.findByText(`POST ${new URL(stored.submissionPath, window.location.origin).href}`);
    const disclaimer = screen.getByRole('note');
    expect(disclaimer).toHaveTextContent(
      'Authentication is not simulated: the sandbox endpoint does not check the access token Dragon Copilot requires.',
    );
    expect(disclaimer).toHaveClass('simulated-environment-disclaimer');
    expect(url.closest('.simulated-environment-url')!.nextElementSibling).toBe(disclaimer);
  });

  it('makes Save a secondary button that is disabled while saving', async () => {
    let finishPut!: () => void;
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === 'PUT') await new Promise<void>((resolve) => { finishPut = resolve; });
      return serve(input, init);
    });
    render(
      <FluentProvider theme={webLightTheme}>
        <SimulatedEnvironmentSettings />
        <Button appearance="secondary">Secondary reference</Button>
        <Button appearance="primary">Primary reference</Button>
      </FluentProvider>,
    );
    fireEvent.click(await screen.findByText('Configure'));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.className).toBe(screen.getByRole('button', { name: 'Secondary reference' }).className);
    expect(save.className).not.toBe(screen.getByRole('button', { name: 'Primary reference' }).className);

    fireEvent.click(save);
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    finishPut();
    expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('saves the environment, orders and Marketplace IDs, then shows the new URL', async () => {
    renderSettings();
    fireEvent.click(await screen.findByText('Configure'));
    fireEvent.change(screen.getByLabelText('Environment ID'), { target: { value: '33333333-3333-3333-3333-333333333333' } });
    fireEvent.change(screen.getByLabelText('Orders (accession numbers)'), { target: { value: 'ACC-1\n\n ACC-2 \n' } });
    fireEvent.change(screen.getByLabelText('Plan ID'), { target: { value: '404' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({
      customerTenantId: stored.customerTenantId,
      environmentId: '33333333-3333-3333-3333-333333333333',
      marketplace: { publisherId: '101', offerId: '202', planId: '404' },
      orders: ['ACC-1', 'ACC-2'],
    });
    expect(await screen.findByText(/33333333-3333-3333-3333-333333333333\/draft-report-ai-results/)).toBeInTheDocument();
  });

  it('saves a custom app installation without Marketplace IDs', async () => {
    renderSettings();
    fireEvent.click(await screen.findByText('Configure'));
    fireEvent.click(screen.getByRole('switch', { name: 'Extension purchased from Microsoft Marketplace' }));
    expect(screen.queryByLabelText('Publisher ID')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].marketplace).toBeNull();
  });

  it('starts as a custom app, and asks for all three Marketplace IDs before saving a purchase', async () => {
    environment = { ...stored, marketplace: null };
    renderSettings();
    fireEvent.click(await screen.findByText('Configure'));
    const purchased = screen.getByRole('switch', { name: 'Extension purchased from Microsoft Marketplace' });
    expect(purchased).not.toBeChecked();
    expect(screen.getByText(/^Installed as a custom app, as during development\./)).toBeInTheDocument();

    fireEvent.click(purchased);
    expect(screen.getByText(/One without them still matches by manifest name/)).toBeInTheDocument();
    for (const label of ['Publisher ID', 'Offer ID', 'Plan ID']) {
      expect(screen.getByLabelText(label)).toHaveValue('');
    }
    fireEvent.change(screen.getByLabelText('Publisher ID'), { target: { value: 'contoso' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Enter the publisher, offer and plan IDs, or turn off 'Extension purchased from Microsoft Marketplace'.",
    );
    expect(puts()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Offer ID'), { target: { value: 'ai-draft' } });
    fireEvent.change(screen.getByLabelText('Plan ID'), { target: { value: 'standard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].marketplace).toEqual({ publisherId: 'contoso', offerId: 'ai-draft', planId: 'standard' });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows why a save was turned away', async () => {
    handlePut = () => json({ error: 'environmentId must be a non-empty GUID.' }, 400);
    renderSettings();
    fireEvent.click(await screen.findByText('Configure'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('environmentId must be a non-empty GUID.');
  });

  it('clears stored results', async () => {
    renderSettings();
    fireEvent.click(await screen.findByText('Clear stored results'));
    expect(await screen.findByText(/Stored results: 0/)).toBeInTheDocument();
    expect(screen.queryByText('Clear stored results')).toBeNull();
  });

  it('offers Clear stored results while the Requests received panel lists requests, and reports the clear', async () => {
    environment = { ...stored, storedResultCount: 0 };
    const onStoredResultsCleared = vi.fn();
    renderSettings({ requestCount: 2, onStoredResultsCleared });
    fireEvent.click(await screen.findByText('Clear stored results'));
    await waitFor(() => expect(onStoredResultsCleared).toHaveBeenCalledTimes(1));
  });

  it('keeps the Requests received panel when clearing stored results fails', async () => {
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      init?.method === 'DELETE' ? json({ error: 'Clear failed.' }, 500) : serve(input, init));
    const onStoredResultsCleared = vi.fn();
    renderSettings({ requestCount: 1, onStoredResultsCleared });
    fireEvent.click(await screen.findByText('Clear stored results'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Clear failed.');
    expect(onStoredResultsCleared).not.toHaveBeenCalled();
  });

  it('says why the endpoint could not be loaded, and loads it on Try again', async () => {
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load the simulated endpoint. Could not reach the sandbox server. Try again',
    );

    fetchMock.mockImplementation(serve);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(`POST ${new URL(stored.submissionPath, window.location.origin).href}`)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the sandbox does not return an environment', async () => {
    fetchMock.mockImplementation(async () => json(null));
    renderSettings();
    expect(await screen.findByRole('alert')).toHaveTextContent('The sandbox returned an invalid simulated environment.');
  });

  it('tells assistive technology whether the settings are shown', async () => {
    renderSettings();
    const toggle = await screen.findByRole('button', { name: 'Configure' });
    const settings = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(settings).not.toBeVisible();

    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide settings' })).toHaveAttribute('aria-expanded', 'true');
    expect(settings).toBeVisible();
  });

  it('announces that the endpoint URL was copied', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      renderSettings();
      fireEvent.click(await screen.findByRole('button', { name: 'Copy endpoint URL' }));
      expect(await screen.findByText('Endpoint URL copied')).toHaveAttribute('role', 'status');
      expect(writeText).toHaveBeenCalledWith(new URL(stored.submissionPath, window.location.origin).href);
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
