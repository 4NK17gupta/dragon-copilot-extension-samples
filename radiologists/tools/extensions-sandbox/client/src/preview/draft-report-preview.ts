interface DraftSection {
  name: string;
  content: string;
  sectionOrder: number;
  aiGenerated: boolean;
}

type DraftReportPreview =
  | { kind: 'report'; format: 'plain_text' | 'markdown'; sections: DraftSection[] }
  | { kind: 'error'; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ENVELOPE_KEYS = ['draftReport', 'manifestName', 'toolName'];

/** Mirrors the server: a body with any ingest-envelope key is an envelope, and its draftReport is the output. */
function unwrapDraftReport(body: unknown): unknown {
  if (!isRecord(body)) return body;
  const isEnvelope = ENVELOPE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
  return isEnvelope ? body.draftReport : body;
}

function isDraftSection(value: unknown): value is DraftSection {
  return isRecord(value)
    && typeof value.name === 'string' && /^[a-z][a-z_]*$/.test(value.name)
    && typeof value.content === 'string'
    && typeof value.aiGenerated === 'boolean'
    && typeof value.sectionOrder === 'number'
    && Number.isInteger(value.sectionOrder) && value.sectionOrder >= 1;
}

/** The server validates the full schema; these guards narrow only the display fields. */
export function buildDraftReportPreview(result: unknown): DraftReportPreview | null {
  if (result == null) return null;
  if (!isRecord(result)) {
    return { kind: 'error', message: 'The sandbox returned an invalid partner-initiated result.' };
  }
  if (typeof result.status === 'number' && (result.status < 200 || result.status >= 300)) {
    return {
      kind: 'error',
      message: `The incoming request was rejected (HTTP ${result.status}). No AI draft is available. See the Results tab for details.`,
    };
  }
  if (typeof result.status !== 'number' || !Number.isFinite(result.status)
    || !isRecord(result.validation) || result.validation.valid !== true) {
    return {
      kind: 'error',
      message: 'The incoming request has not passed validation. No AI draft is available. See the Results tab for details.',
    };
  }

  const body = unwrapDraftReport(result.rawBody);
  const content = isRecord(body) ? body.reportContent : undefined;
  const report = isRecord(content) ? content.structuredReport : undefined;
  if (!isRecord(content) || content.format !== 'structured_report'
    || !isRecord(report) || (report.format !== 'plain_text' && report.format !== 'markdown')
    || !Array.isArray(report.sections) || !report.sections.every(isDraftSection)) {
    return {
      kind: 'error',
      message: 'The incoming output is not a supported structured draft report. See the Outputs tab for the raw payload.',
    };
  }

  return {
    kind: 'report',
    format: report.format,
    sections: [...report.sections].sort((a, b) => a.sectionOrder - b.sectionOrder),
  };
}
