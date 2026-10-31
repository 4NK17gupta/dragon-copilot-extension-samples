import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
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

function renderSettings() {
  render(
    <FluentProvider theme={webLightTheme}>
      <SimulatedEnvironmentSettings />
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

  it('shows nothing when the sandbox does not return an environment', async () => {
    fetchMock.mockImplementation(async () => json(null));
    const { container } = render(
      <FluentProvider theme={webLightTheme}>
        <SimulatedEnvironmentSettings />
      </FluentProvider>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.querySelector('.simulated-environment')).toBeNull();
  });
});
