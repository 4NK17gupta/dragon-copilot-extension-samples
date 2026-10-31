import { Button, Link } from '@fluentui/react-components';
import { CodeRegular, RecordStopRegular } from '@fluentui/react-icons';
import type { CapturePhase } from '../hooks/usePartnerInitiatedTest';
import type { CapturedRequest } from '../types/testing';
import { describeOutcome, formatReceivedTime } from './captureText';

interface PartnerCaptureBarProps {
  phase: CapturePhase;
  stopped: boolean;
  /** How many requests the sandbox has received while listening, including any no longer kept. */
  count: number;
  lastRequest?: CapturedRequest;
  /** The request the Results, Outputs and Dragon Copilot Preview tabs show. */
  shownRequest: CapturedRequest | null;
  /** Starts listening when the sandbox isn't listening, and stops it otherwise. */
  onToggle: () => void;
  /** Shows the latest request, so the tabs follow new requests again. */
  onShowLatest: () => void;
  /** Extra classes, such as one that lines the bar up with a tab's content. */
  className?: string;
}

const NOT_LISTENING = 'The endpoint answers 503 until you click Run Test.';
const requestCount = (count: number) => `${count} ${count === 1 ? 'request' : 'requests'}`;

/** What screen readers announce as listening starts and stops, and as requests arrive. */
function announcement({ phase, count }: PartnerCaptureBarProps): string {
  switch (phase) {
    case 'starting':
      return 'Starting to listen…';
    case 'stopping':
      return 'Stopping…';
    case 'idle':
      return `Stopped listening. ${NOT_LISTENING}`;
    default:
      return count === 0 ? 'Listening. No requests received yet.' : `Listening. ${requestCount(count)} received.`;
  }
}

/**
 * Shows on every tab while the sandbox listens for requests to a partnerInitiated tool, and after it
 * stops: how many requests arrived, and which one the tabs show. The button says whether the sandbox is
 * listening, and stops or starts it from any tab.
 */
export function PartnerCaptureBar(props: PartnerCaptureBarProps) {
  const { phase, stopped, count, lastRequest, shownRequest, onToggle, onShowLatest, className } = props;
  if (phase === 'idle' && !stopped) return null;
  const listening = phase !== 'idle';
  const showingLatest = shownRequest !== null && shownRequest.sequence === lastRequest?.sequence;
  const classes = ['capture-bar', listening ? '' : 'capture-bar-stopped', className ?? ''].filter(Boolean).join(' ');

  return (
    <section className={classes} aria-label="Request listener">
      <span className="visually-hidden" role="status">{announcement(props)}</span>
      <div className="capture-bar-fields">
        <div className="capture-bar-field">
          <span className="capture-bar-label">Requests</span>{' '}
          <span className="capture-bar-value"><strong>{count}</strong></span>
        </div>
        <div className="capture-bar-field">
          {' '}<span className="capture-bar-label">Showing</span>{' '}
          {shownRequest ? (
            <span className="capture-bar-value">
              <strong>#{shownRequest.sequence}</strong>{' '}
              <span className={`capture-bar-badge ${shownRequest.validation.valid ? 'pass' : 'fail'}`}>
                {describeOutcome(shownRequest)}
              </span>{' '}
              <span className="capture-bar-muted">{formatReceivedTime(shownRequest.receivedAt)}</span>{' '}
              {showingLatest
                ? <span className="capture-bar-badge latest">Latest</span>
                : lastRequest && <Link onClick={onShowLatest}>Show latest</Link>}
            </span>
          ) : (
            <span className="capture-bar-value">
              <span className="capture-bar-muted" aria-hidden="true">—</span>
              <span className="visually-hidden">None</span>
            </span>
          )}
        </div>
        {!listening && <p className="capture-bar-note">{NOT_LISTENING}</p>}
      </div>
      <Button
        className="capture-bar-button"
        appearance={listening ? 'secondary' : 'primary'}
        icon={listening ? <RecordStopRegular /> : <CodeRegular />}
        onClick={onToggle}
        disabled={phase === 'stopping'}
      >
        {listening ? 'Stop listening' : 'Run Test'}
      </Button>
    </section>
  );
}
