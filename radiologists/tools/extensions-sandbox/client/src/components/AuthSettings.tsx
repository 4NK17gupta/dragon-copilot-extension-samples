import { useState, useEffect, useCallback } from 'react';
import {
  Button,
  Input,
  Switch,
  Spinner,
  Link,
} from '@fluentui/react-components';

/** A redacted auth config as returned by GET /api/auth/config. */
interface SafeAuthConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  scope: string;
  hasSecret: boolean;
}

interface ClaimCheck {
  claim: string;
  expected: string;
  actual?: string;
  passed: boolean;
}

interface TestResult {
  success: boolean;
  expiresOnMs?: number;
  claimChecks?: ClaimCheck[];
  error?: string;
  troubleshooting?: string[];
}

const UNREACHABLE_MESSAGE = 'Could not reach the sandbox server.';

/**
 * POSTs a (partial) auth config and returns the server's redacted view.
 * Throws an Error with a user-facing message when the save does not succeed.
 */
async function postAuthConfig(body: Record<string, unknown>): Promise<SafeAuthConfig> {
  let res: Response;
  try {
    res = await fetch('/api/auth/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(UNREACHABLE_MESSAGE);
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const detail = typeof data?.error === 'string' && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(`Could not save auth settings: ${detail}`);
  }
  return (await res.json()) as SafeAuthConfig;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Could not save auth settings.';
}

/**
 * Auth configuration panel for sandbox-to-extension service-to-service
 * authentication (Entra ID client credentials). The client secret is
 * write-only: it is sent to the server but never returned, so the field shows
 * a "secret stored" hint rather than the value.
 */
export function AuthSettings() {
  const [config, setConfig] = useState<SafeAuthConfig | null>(null);
  const [secret, setSecret] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [togglePending, setTogglePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch('/api/auth/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SafeAuthConfig | null) => {
        if (data) setConfig(data);
      })
      .catch(() => {
        // Server unreachable – leave config null; the section stays collapsed.
      });
  }, []);

  const update = useCallback((patch: Partial<SafeAuthConfig>) => {
    setConfig((prev) => (prev ? { ...prev, ...patch } : prev));
    setTestResult(null);
  }, []);

  /** Saves every field; resolves to false (and shows the error) when the save fails. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!config) return false;
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {
        enabled: config.enabled,
        tenantId: config.tenantId,
        clientId: config.clientId,
        scope: config.scope,
      };
      // Only send the secret when the user typed a new one.
      if (secret) body.clientSecret = secret;

      const updated = await postAuthConfig(body);
      setConfig(updated);
      setSecret('');
      return true;
    } catch (err) {
      setSaveError(toMessage(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [config, secret]);

  /**
   * Persists the enabled flag as soon as it is toggled, so executions honour the
   * switch without a separate Save. Unsaved edits to the other fields are kept.
   */
  const toggleEnabled = useCallback(async (enabled: boolean) => {
    update({ enabled });
    setSaveError(null);
    setTogglePending(true);
    try {
      const updated = await postAuthConfig({ enabled });
      setConfig((prev) =>
        prev ? { ...prev, enabled: updated.enabled, hasSecret: updated.hasSecret } : updated,
      );
    } catch (err) {
      setConfig((prev) => (prev ? { ...prev, enabled: !enabled } : prev));
      setSaveError(toMessage(err));
    } finally {
      setTogglePending(false);
    }
  }, [update]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Save first so the test uses the latest values; the save error is shown instead.
      if (!(await save())) return;
      const res = await fetch('/api/auth/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data: TestResult = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ success: false, error: UNREACHABLE_MESSAGE });
    } finally {
      setTesting(false);
    }
  }, [save]);

  if (!config) {
    return null;
  }

  return (
    <div className="auth-settings">
      <div className="auth-settings-header">
        <Switch
          checked={config.enabled}
          disabled={togglePending || saving}
          onChange={(_, data) => void toggleEnabled(data.checked)}
          label="Authenticate calls with Entra ID (client credentials)"
        />
        <Link className="auth-toggle-link" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Hide settings' : 'Configure'}
        </Link>
      </div>

      {saveError && (
        <div role="alert" className="auth-test-result auth-test-error auth-save-error">
          {saveError}
        </div>
      )}

      {expanded && (
        <div className="auth-settings-body">
          <div className="form-field">
            <label className="field-label">Tenant ID</label>
            <Input
              value={config.tenantId}
              placeholder="00000000-0000-0000-0000-000000000000"
              onChange={(_, data) => update({ tenantId: data.value })}
            />
          </div>

          <div className="form-field">
            <label className="field-label">Client ID</label>
            <Input
              value={config.clientId}
              placeholder="d9350f5d-71c2-46b9-b41d-3c5d51ffe6e8"
              onChange={(_, data) => update({ clientId: data.value })}
            />
          </div>

          <div className="form-field">
            <label className="field-label">Client Secret</label>
            <Input
              type="password"
              value={secret}
              placeholder={config.hasSecret ? '•••••••• (secret stored)' : 'Enter client secret'}
              onChange={(_, data) => setSecret(data.value)}
            />
            <p className="field-description">
              The secret is stored on the sandbox server in memory only and is never
              displayed again.
            </p>
          </div>

          <div className="form-field">
            <label className="field-label">Application ID URI / Scope</label>
            <Input
              value={config.scope}
              placeholder="api://{tenant}/ext.contoso.com"
              onChange={(_, data) => update({ scope: data.value })}
            />
            <p className="field-description">
              A bare Application ID URI is fine — “/.default” is appended automatically.
            </p>
          </div>

          <div className="auth-settings-actions">
            <Button appearance="primary" onClick={() => void save()} disabled={saving || togglePending}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button onClick={testConnection} disabled={testing || togglePending}>
              {testing ? <Spinner size="tiny" /> : 'Test connection'}
            </Button>
          </div>

          {testResult && (
            <div
              className={`auth-test-result ${testResult.success ? 'auth-test-success' : 'auth-test-error'}`}
            >
              {testResult.success ? (
                <>
                  <strong>Token acquired successfully.</strong>
                  {testResult.expiresOnMs && (
                    <p className="field-description">
                      Expires at {new Date(testResult.expiresOnMs).toLocaleTimeString()}.
                    </p>
                  )}
                  {testResult.claimChecks && (
                    <ul className="claim-check-list">
                      {testResult.claimChecks.map((c) => (
                        <li key={c.claim} className={c.passed ? 'claim-pass' : 'claim-fail'}>
                          <code>{c.claim}</code>: {c.passed ? '✓' : '✗'} expected{' '}
                          <code>{c.expected}</code>
                          {!c.passed && c.actual !== undefined && (
                            <>
                              {' '}
                              — got <code>{c.actual}</code>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <>
                  <strong>{testResult.error || 'Authentication failed.'}</strong>
                  {testResult.troubleshooting && (
                    <ul>
                      {testResult.troubleshooting.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
