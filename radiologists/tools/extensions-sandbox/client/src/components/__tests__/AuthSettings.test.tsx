import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { AuthSettings } from '../AuthSettings';

const storedConfig = {
  enabled: false,
  tenantId: 'tenant-id',
  clientId: 'client-id',
  scope: 'api://extension',
  hasSecret: true,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let handleConfigPost: (body: Record<string, unknown>) => Response;

beforeEach(() => {
  handleConfigPost = (body) => json({ ...storedConfig, ...body });
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === '/api/auth/config' && init?.method === 'POST') {
      return handleConfigPost(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    if (url === '/api/auth/config') return json(storedConfig);
    if (url === '/api/auth/test') return json({ success: true });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderAuthSettings() {
  render(
    <FluentProvider theme={webLightTheme}>
      <AuthSettings />
    </FluentProvider>,
  );
  return (await screen.findByRole('switch')) as HTMLInputElement;
}

function configPosts() {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === '/api/auth/config' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
}

function testCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === '/api/auth/test');
}

describe('AuthSettings', () => {
  it('saves the enabled toggle immediately', async () => {
    const toggle = await renderAuthSettings();

    fireEvent.click(toggle);

    await waitFor(() => expect(configPosts()).toEqual([{ enabled: true }]));
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.checked).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reverts the toggle and shows the server error when saving fails', async () => {
    handleConfigPost = () => json({ error: 'Cross-site requests are not allowed.' }, 403);
    const toggle = await renderAuthSettings();

    fireEvent.click(toggle);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save auth settings: Cross-site requests are not allowed.',
    );
    expect(toggle.checked).toBe(false);
  });

  it('shows an alert when the server cannot be reached', async () => {
    handleConfigPost = () => {
      throw new TypeError('Failed to fetch');
    };
    const toggle = await renderAuthSettings();

    fireEvent.click(toggle);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the sandbox server.');
    expect(toggle.checked).toBe(false);
  });

  it('saves the fields before testing the connection', async () => {
    await renderAuthSettings();
    fireEvent.click(screen.getByText('Configure'));
    fireEvent.change(screen.getByPlaceholderText('•••••••• (secret stored)'), {
      target: { value: 'new-secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Token acquired successfully.')).toBeInTheDocument();
    expect(configPosts()).toEqual([
      {
        enabled: false,
        tenantId: 'tenant-id',
        clientId: 'client-id',
        scope: 'api://extension',
        clientSecret: 'new-secret',
      },
    ]);
    expect(testCalls()).toHaveLength(1);
  });

  it('does not test the connection when saving fails', async () => {
    handleConfigPost = () => new Response('Internal error', { status: 500 });
    await renderAuthSettings();
    fireEvent.click(screen.getByText('Configure'));

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save auth settings: HTTP 500');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Test connection' })).not.toBeDisabled(),
    );
    expect(testCalls()).toHaveLength(0);
  });
});
