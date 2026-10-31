import { describe, it, expect } from 'vitest';
import {
  InvalidInputError, parseInputValues, groupInputsByName, parseAndGroupInputs,
} from '../input-parsing.js';

/**
 * Unit tests for form input parsing and grouping.
 * These functions sit between the UI form and payload validation, so an
 * empty value leaking through as an empty object causes a spurious 422.
 */

describe('parseInputValues', () => {
  it('parses JSON object and array strings', () => {
    const result = parseInputValues({
      obj: '{"reportText":"findings"}',
      arr: '[1,2,3]',
    });
    expect(result.obj).toEqual({ reportText: 'findings' });
    expect(result.arr).toEqual([1, 2, 3]);
  });

  it('keeps primitive-looking strings as strings to protect clinical identifiers', () => {
    const result = parseInputValues({
      mrn: '0012345',
      accession: '42',
      flag: 'true',
    });
    expect(result.mrn).toBe('0012345');
    expect(result.accession).toBe('42');
    expect(result.flag).toBe('true');
  });

  it('falls back to the raw string when JSON parsing fails', () => {
    const result = parseInputValues({ broken: '{not valid json}' });
    expect(result.broken).toBe('{not valid json}');
  });
});

describe('groupInputsByName', () => {
  it('groups dot-delimited paths under the input name', () => {
    const result = groupInputsByName({
      'report.reportText': 'findings',
      'report.reportId': 'r-1',
    });
    expect(result).toEqual({ report: { reportText: 'findings', reportId: 'r-1' } });
  });

  it('keeps non-dotted keys as-is', () => {
    expect(groupInputsByName({ report: 'findings' })).toEqual({ report: 'findings' });
  });

  it('omits a group entirely when every field is empty', () => {
    const result = groupInputsByName({
      'report.reportText': '',
      'report.reportId': '',
    });
    expect(result).toEqual({});
    expect('report' in result).toBe(false);
  });

  it('omits a group whose fields are null or undefined', () => {
    const result = groupInputsByName({
      'report.reportText': null,
      'report.reportId': undefined,
    });
    expect(result).toEqual({});
  });

  it('keeps a group that has at least one non-empty field', () => {
    const result = groupInputsByName({
      'report.reportText': 'findings',
      'report.reportId': '',
    });
    expect(result).toEqual({ report: { reportText: 'findings' } });
  });

  it('omits empty non-dotted values', () => {
    expect(groupInputsByName({ report: '', priorReport: 'text' })).toEqual({
      priorReport: 'text',
    });
  });

  it('preserves falsy-but-meaningful values such as 0 and false', () => {
    const result = groupInputsByName({
      'report.score': 0,
      'report.reviewed': false,
    });
    expect(result).toEqual({ report: { score: 0, reviewed: false } });
  });
});

describe('parseAndGroupInputs', () => {
  it('parses then groups in one step', () => {
    const result = parseAndGroupInputs({
      'report.reportText': 'findings',
      'report.metadata': '{"modality":"CT"}',
    });
    expect(result).toEqual({
      report: { reportText: 'findings', metadata: { modality: 'CT' } },
    });
  });

  it('does not emit an empty group for a fully blank optional input', () => {
    const result = parseAndGroupInputs({
      'report.reportText': 'findings',
      'priorReport.reportText': '',
    });
    expect(result).toEqual({ report: { reportText: 'findings' } });
    expect('priorReport' in result).toBe(false);
  });
});

describe('unsafe inputs', () => {
  it.each([
    ['null', null],
    ['an array', ['report']],
    ['a string', 'report'],
  ])('rejects inputs that are %s', (_label, inputs) => {
    expect(() => parseAndGroupInputs(inputs as unknown as Record<string, string>))
      .toThrow(InvalidInputError);
  });

  it.each([
    ['a number', 42],
    ['an object', { reportText: 'findings' }],
    ['null', null],
  ])('rejects a value that is %s instead of crashing', (_label, value) => {
    expect(() => parseAndGroupInputs({ report: value } as unknown as Record<string, string>))
      .toThrow("Input 'report' must be a string.");
  });

  it.each([
    '__proto__.polluted',
    'constructor.prototype.polluted',
    'report.__proto__',
    '__proto__',
  ])('rejects the reserved name %s without changing Object.prototype', (name) => {
    // A computed key creates an own "__proto__" property, as JSON.parse does for a request body.
    const inputs: Record<string, string> = { [name]: '{"x":"yes"}' };
    expect(() => parseAndGroupInputs(inputs)).toThrow(InvalidInputError);
    expect(() => groupInputsByName(inputs)).toThrow(InvalidInputError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('groups an input named after an Object.prototype member as an ordinary field', () => {
    expect(groupInputsByName({ 'toString.value': 'a' })).toEqual({ toString: { value: 'a' } });
  });
});
