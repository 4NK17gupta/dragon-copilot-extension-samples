import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Link, Switch, Textarea } from '@fluentui/react-components';
import { CopyRegular } from '@fluentui/react-icons';

/** The customer environment the sandbox's simulated Dragon Copilot endpoint answers for. */
interface SimulatedEnvironment {
  customerTenantId: string;
  environmentId: string;
  marketplace: { publisherId: string; offerId: string; planId: string } | null;
  orders: string[];
  submissionPath: string;
  storedResultCount: number;
}

interface Draft {
  customerTenantId: string;
  environmentId: string;
  purchased: boolean;
  publisherId: string;
  offerId: string;
  planId: string;
  orders: string;
}

const UNREACHABLE_MESSAGE = 'Could not reach the sandbox server.';

function isSimulatedEnvironment(value: unknown): value is SimulatedEnvironment {
  const candidate = value as SimulatedEnvironment | null;
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.submissionPath === 'string' && Array.isArray(candidate.orders);
}

function toDraft(environment: SimulatedEnvironment): Draft {
  return {
    customerTenantId: environment.customerTenantId,
    environmentId: environment.environmentId,
    purchased: environment.marketplace !== null,
    publisherId: environment.marketplace?.publisherId ?? '',
    offerId: environment.marketplace?.offerId ?? '',
    planId: environment.marketplace?.planId ?? '',
    orders: environment.orders.join('\n'),
  };
}

async function callApi(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<SimulatedEnvironment> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined
      ? { method }
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error(UNREACHABLE_MESSAGE);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof error === 'string' && error ? error : `HTTP ${response.status}`);
  }
  if (!isSimulatedEnvironment(data)) {
    throw new Error('The sandbox returned an invalid simulated environment.');
  }
  return data;
}

interface Props {
  /** Change it after a submission so the stored result count is reloaded. */
  refreshKey?: number;
}

/**
 * Shows where to send submissions for partnerInitiated tools, and the customer environment the
 * simulated endpoint checks them against: the customer tenant, the environment, how the loaded
 * extension was installed, and the orders.
 */
export function SimulatedEnvironmentSettings({ refreshKey = 0 }: Props) {
  const [environment, setEnvironment] = useState<SimulatedEnvironment | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tenantId = useId();
  const environmentId = useId();
  const publisherId = useId();
  const offerId = useId();
  const planId = useId();
  const ordersId = useId();

  useEffect(() => {
    let current = true;
    callApi('GET', '/api/simulated-environment')
      .then((loaded) => {
        if (!current) return;
        setEnvironment(loaded);
        // Keep edits that haven't been saved yet.
        setDraft((previous) => previous ?? toDraft(loaded));
      })
      .catch(() => {
        // Server unreachable: leave the section hidden.
      });
    return () => { current = false; };
  }, [refreshKey]);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const apply = useCallback(async (action: () => Promise<SimulatedEnvironment>, replaceDraft: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await action();
      setEnvironment(updated);
      if (replaceDraft) setDraft(toDraft(updated));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  if (!environment || !draft) {
    return null;
  }

  const endpointUrl = new URL(environment.submissionPath, window.location.origin).href;
  const update = (patch: Partial<Draft>) => setDraft((previous) => previous && { ...previous, ...patch });

  const save = () => {
    if (draft.purchased && [draft.publisherId, draft.offerId, draft.planId].some((id) => !id.trim())) {
      setError("Enter the publisher, offer and plan IDs, or turn off 'Extension purchased from Microsoft Marketplace'.");
      return;
    }
    void apply(() => callApi('PUT', '/api/simulated-environment', {
      customerTenantId: draft.customerTenantId,
      environmentId: draft.environmentId,
      marketplace: draft.purchased ? { publisherId: draft.publisherId, offerId: draft.offerId, planId: draft.planId } : null,
      orders: draft.orders.split('\n').map((order) => order.trim()).filter((order) => order.length > 0),
    }), true);
  };

  const clearStoredResults = () => void apply(() => callApi('DELETE', '/api/simulated-environment/stored-results'), false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpointUrl);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: the URL is still shown for manual copying.
    }
  };

  return (
    <div className="simulated-environment">
      <div className="simulated-environment-header">
        <span className="field-label">Simulated Dragon Copilot endpoint</span>
        <Link className="simulated-environment-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Hide settings' : 'Configure'}
        </Link>
      </div>

      <div className="simulated-environment-url">
        <code>POST {endpointUrl}</code>
        <Button size="small" appearance="subtle" icon={<CopyRegular />} aria-label="Copy endpoint URL" onClick={() => void copy()}>
          {copied ? 'Copied' : undefined}
        </Button>
      </div>
      <p className="field-description">
        Send submissions here as you would to Dragon Copilot. The endpoint answers while the sandbox is listening (Run Test), and answers 503 otherwise.
        The extension installed in this environment is the loaded manifest.
      </p>
      <p className="field-description">
        Stored results: {environment.storedResultCount}
        {environment.storedResultCount > 0 && (
          <>
            {' '}
            <Link onClick={clearStoredResults} disabled={busy}>Clear stored results</Link>
          </>
        )}
      </p>

      {error && <div role="alert" className="simulated-environment-error">{error}</div>}

      {expanded && (
        <div className="simulated-environment-body">
          <div className="form-field">
            <label className="field-label" htmlFor={tenantId}>Customer tenant ID</label>
            <Input className="simulated-environment-input" id={tenantId} value={draft.customerTenantId} onChange={(_, data) => update({ customerTenantId: data.value })} />
          </div>
          <div className="form-field">
            <label className="field-label" htmlFor={environmentId}>Environment ID</label>
            <Input className="simulated-environment-input" id={environmentId} value={draft.environmentId} onChange={(_, data) => update({ environmentId: data.value })} />
          </div>

          <div className="form-field">
            <Switch
              checked={draft.purchased}
              onChange={(_, data) => update({ purchased: data.checked })}
              label="Extension purchased from Microsoft Marketplace"
            />
            <p className="field-description">
              {draft.purchased
                ? 'A request with Marketplace IDs must send these. One without them still matches by manifest name, as in Dragon Copilot.'
                : 'Installed as a custom app, as during development. Dragon Copilot never matches Marketplace IDs to a custom app, so a request with them gets ExtensionNotFound.'}
            </p>
          </div>
          {draft.purchased && (
            <>
              <div className="form-field">
                <label className="field-label" htmlFor={publisherId}>Publisher ID</label>
                <Input className="simulated-environment-input" id={publisherId} value={draft.publisherId} onChange={(_, data) => update({ publisherId: data.value })} />
              </div>
              <div className="form-field">
                <label className="field-label" htmlFor={offerId}>Offer ID</label>
                <Input className="simulated-environment-input" id={offerId} value={draft.offerId} onChange={(_, data) => update({ offerId: data.value })} />
              </div>
              <div className="form-field">
                <label className="field-label" htmlFor={planId}>Plan ID</label>
                <Input className="simulated-environment-input" id={planId} value={draft.planId} onChange={(_, data) => update({ planId: data.value })} />
              </div>
            </>
          )}

          <div className="form-field">
            <label className="field-label" htmlFor={ordersId}>Orders (accession numbers)</label>
            <Textarea className="simulated-environment-input" id={ordersId} value={draft.orders} resize="vertical" onChange={(_, data) => update({ orders: data.value })} />
            <p className="field-description">One per line. List a number twice to give it two orders.</p>
          </div>

          <div className="simulated-environment-actions">
            <Button appearance="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
