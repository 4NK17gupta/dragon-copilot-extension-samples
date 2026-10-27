import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { DragonCopilotPreview } from '../DragonCopilotPreview';
import { buildDraftReportPreview } from '../../preview/draft-report-preview';

const example = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../../../partner-initiated/samples/PreDraftReportGeneration-Ingest-Request-Example.json'),
  'utf-8',
));
const validResult = {
  status: 200,
  rawBody: example.draftReport,
  validation: { valid: true },
};

function section(name: string, content: string, sectionOrder: number, aiGenerated = true) {
  return { name, content, sectionOrder, aiGenerated, aiConfidence: 0.95 };
}

function resultWithSections(sections: unknown[], format = 'plain_text') {
  return {
    ...validResult,
    rawBody: {
      ...example.draftReport,
      reportContent: { format: 'structured_report', structuredReport: { format, sections } },
    },
  };
}

describe('PartnerInitiatedPreview', () => {
  it('shows an empty AI draft shell and instructions before receiving a report', () => {
    const { container } = render(<DragonCopilotPreview toolType="partnerInitiated" result={null} />);
    expect(screen.getByRole('heading', { name: 'AI draft' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('No draft report received yet');
    expect(container.querySelector('.dc-ai-draft-report')).toBeEmptyDOMElement();
    expect(container.querySelector('.dc-disclaimers')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Result source' })).toBeNull();
    expect(screen.queryByText(/Smart Impression/)).toBeNull();
  });

  it('renders the canonical raw draft report, not ingest metadata or JSON', () => {
    const { container } = render(<DragonCopilotPreview toolType="partnerInitiated" result={validResult} />);
    const draft = screen.getByRole('region', { name: 'AI draft' });
    expect(within(draft).getByText('TECHNIQUE:')).toBeVisible();
    expect(within(draft).getByText('CT scan performed with contrast enhancement')).toBeVisible();
    expect(within(draft).getByText('IMPRESSION:')).toBeVisible();
    expect(within(draft).getByText('No acute cardiopulmonary abnormality.')).toBeVisible();
    expect(within(draft).getByText('AI-generated content may be incorrect')).toBeVisible();
    expect(within(draft).getByText('Third-party generated content')).toBeVisible();
    expect(draft).not.toHaveTextContent(example.draftReport.identifier);
    expect(draft).not.toHaveTextContent(example.draftReport.imagingStudy.accessionNumber);
    expect(draft).not.toHaveTextContent(example.draftReport.imagingStudy.patientMrn);
    expect(container.querySelector('.dc-preview-json')).toBeNull();
  });

  it('renders the draft report from a full ingest envelope without showing envelope metadata', () => {
    const { container } = render(
      <DragonCopilotPreview toolType="partnerInitiated" result={{ ...validResult, rawBody: example }} />,
    );
    const draft = screen.getByRole('region', { name: 'AI draft' });
    expect(within(draft).getByText('No acute cardiopulmonary abnormality.')).toBeVisible();
    expect(draft).not.toHaveTextContent(example.manifestName);
    expect(draft).not.toHaveTextContent(example.toolName);
    expect(draft).not.toHaveTextContent(example.draftReport.identifier);
    expect(container.querySelector('.dc-preview-json')).toBeNull();
  });

  it('orders sections without mutating the input, preserves ties and plain text, and does not infer missing sections', () => {
    const sections = [
      section('impression', 'Last section', 5),
      section('history', 'Line one\nLine two\n\n**Literal text**', 2),
      section('title', 'Example study', 1, false),
      section('custom_section', 'Custom content', 2),
    ];
    const before = JSON.stringify(sections);
    const { container } = render(
      <DragonCopilotPreview toolType="partnerInitiated" result={resultWithSections(sections)} />,
    );
    expect([...container.querySelectorAll('.dc-ai-draft-section')].map((node) => node.textContent)).toEqual([
      'Example study',
      'HISTORY:Line one\nLine two\n\n**Literal text**',
      'CUSTOM SECTION:Custom content',
      'IMPRESSION:Last section',
    ]);
    expect(JSON.stringify(sections)).toBe(before);
    expect(container.querySelector('strong')).toBeNull();
    expect(screen.queryByText('TITLE:')).toBeNull();
    expect(screen.queryByText('FINDINGS:')).toBeNull();
  });

  it('renders Markdown formatting without executing HTML or fetching external content', () => {
    const content = '**Bold** and *emphasis*\n\n- First\n- Second\n\n[Reference](https://example.com)\n\n'
      + '![Image description](https://example.com/image.png)\n\n'
      + '<img src="https://example.com/tracker" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n'
      + '[Unsafe](javascript:alert%281%29)';
    const { container } = render(
      <DragonCopilotPreview toolType="partnerInitiated" result={resultWithSections([section('findings', content, 1)], 'markdown')} />,
    );
    const draft = screen.getByRole('region', { name: 'AI draft' });
    expect(draft.querySelector('strong')).toHaveTextContent('Bold');
    expect(draft.querySelector('em')).toHaveTextContent('emphasis');
    expect(within(draft).getAllByRole('listitem')).toHaveLength(2);
    expect(within(draft).getByText('Image description')).toBeVisible();
    expect(within(draft).getByText('Reference')).toBeVisible();
    expect(container.querySelector('img, script, iframe, a')).toBeNull();
    expect(draft.textContent).toContain('<script>alert(1)</script>');
  });

  it.each([
    { sections: [] },
    { sections: [section('findings', '', 1)] },
    { sections: [section('findings', ' \n ', 1)] },
  ])(
    'explicitly reports an empty draft without inventing clinical content ($sections)',
    ({ sections }) => {
      render(<DragonCopilotPreview toolType="partnerInitiated" result={resultWithSections(sections)} />);
      expect(screen.getByRole('status')).toHaveTextContent('contains no section text');
      expect(screen.queryByText('AI-generated content may be incorrect')).toBeNull();
    },
  );

  it('does not label non-AI sections as AI-generated', () => {
    render(<DragonCopilotPreview toolType="partnerInitiated" result={resultWithSections([section('history', 'Submitted history', 1, false)])} />);
    expect(screen.getByText('Third-party generated content')).toBeVisible();
    expect(screen.queryByText('AI-generated content may be incorrect')).toBeNull();
  });

  it.each([400, 413, 415, 422, 500])('does not display a rejected body for HTTP %s', (status) => {
    const { container } = render(
      <DragonCopilotPreview toolType="partnerInitiated" result={{ ...validResult, status }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(`HTTP ${status}`);
    expect(container.querySelector('.dc-preview-frame')).toBeNull();
    expect(screen.queryByText('No acute cardiopulmonary abnormality.')).toBeNull();
  });

  it.each([undefined, { valid: false }])('requires successful schema validation (%j)', (validation) => {
    render(<DragonCopilotPreview toolType="partnerInitiated" result={{ ...validResult, validation }} />);
    expect(screen.getByRole('status')).toHaveTextContent('has not passed validation');
    expect(screen.queryByRole('region', { name: 'AI draft' })).toBeNull();
  });

  it.each([
    { ...validResult, rawBody: { manifestName: example.manifestName, toolName: example.toolName } },
    { ...validResult, rawBody: { ...example, draftReport: 'not a report' } },
    { ...validResult, rawBody: '<html>Not JSON</html>' },
    resultWithSections([section('findings', 'Unsupported encoding', 1)], 'html'),
    resultWithSections([{ name: 'findings', content: 'Missing order' }]),
    resultWithSections([section('findings', 'Invalid order', 0)]),
    resultWithSections([section('findings', 'Valid section', 1), null]),
  ])('does not display incomplete or unrecognized reports', (result) => {
    render(<DragonCopilotPreview toolType="partnerInitiated" result={result} />);
    expect(screen.getByRole('status')).toHaveTextContent('not a supported structured draft report');
    expect(screen.queryByRole('region', { name: 'AI draft' })).toBeNull();
  });

  it('surfaces listener errors and clears previous content when the next run starts', () => {
    const { rerender } = render(<DragonCopilotPreview toolType="partnerInitiated" result={validResult} />);
    expect(screen.getByText('No acute cardiopulmonary abnormality.')).toBeVisible();
    rerender(<DragonCopilotPreview toolType="partnerInitiated" result={null} executionError={{ message: 'Listener unavailable' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Listener unavailable');
    expect(screen.queryByRole('region', { name: 'AI draft' })).toBeNull();
    rerender(<DragonCopilotPreview toolType="partnerInitiated" result={null} />);
    expect(screen.getByRole('status')).toHaveTextContent('No draft report received yet');
    expect(screen.queryByText('No acute cardiopulmonary abnormality.')).toBeNull();
  });

  it('rejects malformed run results without throwing', () => {
    expect(buildDraftReportPreview('not a result')?.kind).toBe('error');
    expect(buildDraftReportPreview({ ...validResult, status: NaN })?.kind).toBe('error');
    expect(buildDraftReportPreview(undefined)).toBeNull();
  });
});
