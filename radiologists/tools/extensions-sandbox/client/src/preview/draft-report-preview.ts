interface DraftSection {
  name: string;
  content: string;
  sectionOrder: number;
  aiGenerated: boolean;
  aiConfidence: number;
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

/**
 * Reads a JSON number, or a number written as a string such as "0.9", which Dragon Copilot and the
 * server's binder also accept. The server has already checked the string's format by this point.
 */
function displayNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value !== '' && value.trim() === value ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function toDraftSection(value: unknown): DraftSection | null {
  if (!isRecord(value)) return null;
  const aiConfidence = displayNumber(value.aiConfidence);
  const sectionOrder = displayNumber(value.sectionOrder);
  if (typeof value.name !== 'string' || !/^[a-z][a-z_]*$/.test(value.name)
    || typeof value.content !== 'string'
    || typeof value.aiGenerated !== 'boolean'
    || aiConfidence === undefined || aiConfidence < 0 || aiConfidence > 1
    || sectionOrder === undefined || !Number.isInteger(sectionOrder) || sectionOrder < 1) {
    return null;
  }
  return { name: value.name, content: value.content, sectionOrder, aiGenerated: value.aiGenerated, aiConfidence };
}

function isDraftSection(section: DraftSection | null): section is DraftSection {
  return section !== null;
}

/** Formats an `aiConfidence` between 0 and 1 as a percentage with at most one decimal place. */
export function formatConfidence(aiConfidence: number): string {
  return `${Math.round(aiConfidence * 1000) / 10}%`;
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
  const sections = isRecord(report) && Array.isArray(report.sections) ? report.sections.map(toDraftSection) : null;
  if (!isRecord(content) || content.format !== 'structured_report'
    || !isRecord(report) || (report.format !== 'plain_text' && report.format !== 'markdown')
    || sections === null || !sections.every(isDraftSection)) {
    return {
      kind: 'error',
      message: 'The incoming output is not a supported structured draft report. See the Outputs tab for the raw payload.',
    };
  }

  return {
    kind: 'report',
    format: report.format,
    sections: sections.sort((a, b) => a.sectionOrder - b.sectionOrder),
  };
}
