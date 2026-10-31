/**
 * Binds and validates a draft report submission the way Dragon Copilot's ASP.NET Core endpoint does:
 * System.Text.Json reads the body into the request types, then their validation attributes run.
 * Errors use Dragon Copilot's keys, messages and order. Where Dragon Copilot's message names one of
 * its internal .NET types, the message gives the type's short name instead, such as `DraftReport`.
 */
import { JsonReaderError, Utf8JsonReader } from './json-reader.js';
import { ModelState } from './model-state.js';

/** The name of the endpoint's body parameter, which keys the error added when the body can't be read. */
const BODY_PARAMETER = 'draftReportRequestDto';

// .NET's whitespace (char.IsWhiteSpace), which string.Trim and string.IsNullOrWhiteSpace use.
const SURROUNDING_WHITE_SPACE =
  /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/g;
const WHITE_SPACE_ONLY = /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;
const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const EMPTY_GUID = /^[0-]+$/;
const QUOTED_DOUBLE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const JSON_INTEGER = /^-?[0-9]+$/;
const QUOTED_INTEGER = /^[+-]?[0-9]+$/;
const SPECIAL_PATH_CHARACTERS = /[. '\/"[\]()\t\n\r\f\b\\\u0085\u2028\u2029]/;

type BoundValue = string | number | boolean | null | BoundObject | BoundValue[];
interface BoundObject {
  [name: string]: BoundValue;
}

type Rule =
  | { type: 'required' }
  | { type: 'stringLength'; maximum: number; minimum?: number }
  | { type: 'pattern'; pattern: RegExp; source: string; message?: string }
  | { type: 'allowedValues'; values: readonly string[] }
  | { type: 'range'; minimum: number; maximum: number }
  | { type: 'noControlCharacters' };

type Kind =
  | { type: 'string' }
  | { type: 'boolean' }
  | { type: 'double'; nullable: boolean }
  | { type: 'int32' }
  | { type: 'object'; model: TypeModel }
  | { type: 'array'; element: Kind; typeName: string };

interface PropertyModel {
  /** The property's name in JSON. */
  json: string;
  /** The property's .NET name, which validation error keys and messages use. */
  name: string;
  kind: Kind;
  /** Whether the property must appear in the JSON, as the C# `required` modifier demands. */
  required?: boolean;
  /** Whether Dragon Copilot trims the value. */
  trim?: boolean;
  rules?: readonly Rule[];
}

interface TypeModel {
  /** The short name messages give the type, such as `DraftReport`. */
  typeName: string;
  /** In declaration order, which is the order missing properties are listed in. */
  properties: readonly PropertyModel[];
}

const STRING: Kind = { type: 'string' };
const BOOLEAN: Kind = { type: 'boolean' };
const DOUBLE: Kind = { type: 'double', nullable: false };
const NULLABLE_DOUBLE: Kind = { type: 'double', nullable: true };
const INT32: Kind = { type: 'int32' };
const REQUIRED: Rule = { type: 'required' };
const NO_CONTROL_CHARACTERS: Rule = { type: 'noControlCharacters' };

const typeModel = (typeName: string, properties: PropertyModel[]): TypeModel => ({ typeName, properties });
const object = (model: TypeModel): Kind => ({ type: 'object', model });
const list = (element: Kind, elementTypeName: string): Kind => ({
  type: 'array',
  element,
  typeName: `System.Collections.Generic.IReadOnlyCollection\`1[${elementTypeName}]`,
});
const listOf = (model: TypeModel): Kind => list(object(model), model.typeName);
const range = (minimum: number, maximum: number): Rule => ({ type: 'range', minimum, maximum });
const allowed = (...values: string[]): Rule => ({ type: 'allowedValues', values });

const CodeModel = typeModel('Code', [
  { json: 'system', name: 'System', kind: STRING, required: true, rules: [REQUIRED, allowed('SNOMED-CT', 'ICD-10', 'ICD-11', 'RadLex', 'LOINC', 'CPT')] },
  { json: 'code', name: 'Code', kind: STRING, required: true, rules: [REQUIRED] },
  { json: 'display', name: 'Display', kind: STRING, required: true, rules: [REQUIRED] },
]);

const SectionModel = typeModel('Section', [
  {
    json: 'name',
    name: 'Name',
    kind: STRING,
    required: true,
    rules: [REQUIRED, { type: 'pattern', pattern: /^[a-z][a-z_]*$/, source: '^[a-z][a-z_]*$' }],
  },
  { json: 'content', name: 'Content', kind: STRING, required: true, rules: [REQUIRED] },
  { json: 'aiGenerated', name: 'AiGenerated', kind: BOOLEAN, required: true, rules: [REQUIRED] },
  { json: 'aiConfidence', name: 'AiConfidence', kind: DOUBLE, required: true, rules: [REQUIRED, range(0, 1)] },
  { json: 'sectionOrder', name: 'SectionOrder', kind: INT32, required: true, rules: [REQUIRED, range(1, 2147483647)] },
  { json: 'codes', name: 'Codes', kind: listOf(CodeModel) },
]);

const StructuredReportModel = typeModel('StructuredReport', [
  { json: 'format', name: 'Format', kind: STRING, required: true, rules: [REQUIRED, allowed('plain_text', 'markdown')] },
  { json: 'sections', name: 'Sections', kind: listOf(SectionModel), required: true, rules: [REQUIRED] },
]);

const ReportContentModel = typeModel('ReportContent', [
  { json: 'format', name: 'Format', kind: STRING, required: true, rules: [REQUIRED, allowed('structured_report')] },
  { json: 'structuredReport', name: 'StructuredReport', kind: object(StructuredReportModel), required: true, rules: [REQUIRED] },
]);

const SeriesModel = typeModel('Series', [
  { json: 'seriesUid', name: 'SeriesUid', kind: STRING },
  { json: 'instanceUids', name: 'InstanceUids', kind: list(STRING, 'System.String') },
]);

const ImagingStudyModel = typeModel('ImagingStudy', [
  { json: 'studyUid', name: 'StudyUid', kind: STRING, required: true, rules: [REQUIRED] },
  { json: 'series', name: 'Series', kind: listOf(SeriesModel) },
  { json: 'accessionNumber', name: 'AccessionNumber', kind: STRING, required: true, rules: [REQUIRED] },
  { json: 'patientMrn', name: 'PatientMrn', kind: STRING },
  { json: 'modality', name: 'Modality', kind: STRING },
  { json: 'bodyParts', name: 'BodyParts', kind: list(STRING, 'System.String') },
  { json: 'procedureCode', name: 'ProcedureCode', kind: STRING },
  { json: 'studyDateTime', name: 'StudyDateTime', kind: STRING },
]);

const ImagingStudyPriorModel = typeModel('ImagingStudyPrior', [
  { json: 'studyUid', name: 'StudyUid', kind: STRING, required: true, rules: [REQUIRED] },
  { json: 'studyDateTime', name: 'StudyDateTime', kind: STRING },
  { json: 'modality', name: 'Modality', kind: STRING },
]);

const AISystemInfoModel = typeModel('AISystemInfo', [
  { json: 'version', name: 'Version', kind: STRING, required: true, rules: [REQUIRED] },
]);

const QualityMetricsModel = typeModel('QualityMetrics', [
  { json: 'overallConfidenceScore', name: 'OverallConfidenceScore', kind: NULLABLE_DOUBLE, rules: [range(0, 1)] },
  { json: 'imageQualityScore', name: 'ImageQualityScore', kind: DOUBLE, required: true, rules: [REQUIRED, range(0, 1)] },
  { json: 'diagnosticCertaintyScore', name: 'DiagnosticCertaintyScore', kind: NULLABLE_DOUBLE, rules: [range(0, 1)] },
]);

const DraftReportModel = typeModel('DraftReport', [
  { json: 'identifier', name: 'Identifier', kind: STRING, required: true, rules: [REQUIRED] },
  { json: 'category', name: 'Category', kind: STRING },
  { json: 'code', name: 'Code', kind: STRING },
  { json: 'aiSystemInfo', name: 'AISystemInfo', kind: object(AISystemInfoModel), required: true, rules: [REQUIRED] },
  { json: 'imagingStudy', name: 'ImagingStudy', kind: object(ImagingStudyModel), required: true, rules: [REQUIRED] },
  { json: 'imagingStudyPriors', name: 'ImagingStudyPriors', kind: listOf(ImagingStudyPriorModel) },
  { json: 'reportContent', name: 'ReportContent', kind: object(ReportContentModel), required: true, rules: [REQUIRED] },
  { json: 'qualityMetrics', name: 'QualityMetrics', kind: object(QualityMetricsModel) },
]);

const marketplaceId = (json: string, name: string): PropertyModel => ({
  json,
  name,
  kind: STRING,
  trim: true,
  rules: [{ type: 'stringLength', maximum: 256, minimum: 1 }, NO_CONTROL_CHARACTERS],
});

const camelCaseName = (json: string, name: string): PropertyModel => ({
  json,
  name,
  kind: STRING,
  required: true,
  trim: true,
  rules: [
    REQUIRED,
    { type: 'stringLength', maximum: 256 },
    {
      type: 'pattern',
      pattern: /^[a-z][a-zA-Z0-9]*$/,
      source: '^[a-z][a-zA-Z0-9]*$',
      message: `The ${name} must be camelCase and contain only letters and digits.`,
    },
    NO_CONTROL_CHARACTERS,
  ],
});

const DraftReportRequestModel = typeModel('DraftReportIngestRequest', [
  marketplaceId('publisherId', 'PublisherId'),
  marketplaceId('offerId', 'OfferId'),
  marketplaceId('planId', 'PlanId'),
  camelCaseName('manifestName', 'ManifestName'),
  {
    json: 'version',
    name: 'Version',
    kind: STRING,
    trim: true,
    rules: [
      // .NET's \d matches any Unicode decimal digit.
      { type: 'pattern', pattern: /^\p{Nd}+\.\p{Nd}+\.\p{Nd}+$/u, source: '^\\d+\\.\\d+\\.\\d+$', message: 'The Version must be in x.y.z form.' },
      { type: 'stringLength', maximum: 64 },
      NO_CONTROL_CHARACTERS,
    ],
  },
  camelCaseName('toolName', 'ToolName'),
  { json: 'draftReport', name: 'DraftReport', kind: object(DraftReportModel), required: true, rules: [REQUIRED] },
]);

/** A submission that passed validation: the values Dragon Copilot uses to store it. */
export interface DraftReportSubmission {
  customerTenantId: string;
  environmentId: string;
  manifestName: string;
  toolName: string;
  publisherId: string | null;
  offerId: string | null;
  planId: string | null;
  identifier: string;
  accessionNumber: string;
}

export interface BindingResult {
  /** Every error, keyed and ordered as Dragon Copilot reports them. */
  modelState: ModelState;
  /** The submission, when the route and body are valid. */
  submission?: DraftReportSubmission;
}

function trimWhiteSpace(value: string): string {
  return value.replace(SURROUNDING_WHITE_SPACE, '');
}

function isNullOrWhiteSpace(value: BoundValue): boolean {
  return value === null || (typeof value === 'string' && WHITE_SPACE_ONLY.test(value));
}

/**
 * Binds and validates a submission.
 * @param customerTenantId The customer tenant ID from the route, URL-decoded.
 * @param environmentId The environment ID from the route, URL-decoded.
 * @param body The body as UTF-8.
 */
export function bindDraftReportRequest(customerTenantId: string, environmentId: string, body: Uint8Array): BindingResult {
  const modelState = new ModelState();
  const tenantId = trimWhiteSpace(customerTenantId);
  const environment = trimWhiteSpace(environmentId);
  checkRouteGuid(modelState, 'tenantId', tenantId);
  checkRouteGuid(modelState, 'environmentId', environment);

  let model: BoundObject | null = null;
  if (body.length === 0) {
    addEmptyBody(modelState);
  } else {
    try {
      model = new BodyReader(withoutByteOrderMark(body)).readRequest();
      if (model === null) {
        // A body of `null` deserializes to nothing, which counts as an empty body.
        addEmptyBody(modelState);
      }
    } catch (error) {
      if (!(error instanceof BindingError)) {
        throw error;
      }
      modelState.add(error.key, error.message);
      modelState.add(BODY_PARAMETER, `The ${BODY_PARAMETER} field is required.`);
    }
  }

  if (model !== null) {
    const errorsBefore = modelState.errorCount;
    validateObject(DraftReportRequestModel, model, '', modelState);
    // The request's own rule runs only when everything in the body is valid.
    if (modelState.errorCount === errorsBefore) {
      checkMarketplaceIds(model, modelState);
    }
  }

  if (!modelState.isValid || model === null) {
    return { modelState };
  }

  const draftReport = model.DraftReport as BoundObject;
  const imagingStudy = draftReport.ImagingStudy as BoundObject;
  return {
    modelState,
    submission: {
      customerTenantId: tenantId,
      environmentId: environment,
      manifestName: model.ManifestName as string,
      toolName: model.ToolName as string,
      publisherId: (model.PublisherId as string | undefined) ?? null,
      offerId: (model.OfferId as string | undefined) ?? null,
      planId: (model.PlanId as string | undefined) ?? null,
      identifier: draftReport.Identifier as string,
      accessionNumber: imagingStudy.AccessionNumber as string,
    },
  };
}

function addEmptyBody(modelState: ModelState): void {
  modelState.add('', 'A non-empty request body is required.');
  modelState.add(BODY_PARAMETER, `The ${BODY_PARAMETER} field is required.`);
}

function checkRouteGuid(modelState: ModelState, name: string, value: string): void {
  if (!GUID.test(value) || EMPTY_GUID.test(value)) {
    modelState.add(name, `${name} must be a valid non-empty GUID.`);
  }
}

function withoutByteOrderMark(body: Uint8Array): Uint8Array {
  return body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? body.subarray(3) : body;
}

function withPosition(message: string, path: string, lineNumber: number, bytePositionInLine: number): string {
  return `${message} Path: ${path} | LineNumber: ${lineNumber} | BytePositionInLine: ${bytePositionInLine}.`;
}

function appendPropertyName(path: string, name: string): string {
  return SPECIAL_PATH_CHARACTERS.test(name) ? `${path}['${name}']` : `${path}.${name}`;
}

function sameName(left: string, right: string): boolean {
  return left.length === right.length && left.toUpperCase() === right.toUpperCase();
}

function missingPropertiesMessage(typeName: string, missing: PropertyModel[]): string {
  let names = '';
  for (const property of missing) {
    names += `${names ? ', ' : ''}'${property.json}'`;
    // Like System.Text.Json, stop listing once the list is long.
    if (names.length >= 60) {
      break;
    }
  }
  return `JSON deserialization for type '${typeName}' was missing required properties including: ${names}.`;
}

function parseQuotedDouble(text: string | undefined): number | undefined {
  if (text === 'NaN') {
    return Number.NaN;
  }
  if (text === 'Infinity') {
    return Number.POSITIVE_INFINITY;
  }
  if (text === '-Infinity') {
    return Number.NEGATIVE_INFINITY;
  }
  if (text === undefined || !QUOTED_DOUBLE.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function parseInt32(text: string | undefined, format: RegExp): number | undefined {
  if (text === undefined || !format.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return value >= -2147483648 && value <= 2147483647 ? value : undefined;
}

/** An error that stops reading the body, keyed by the JSON path where it happened. */
class BindingError extends Error {
  constructor(readonly key: string, message: string) {
    super(message);
    this.name = 'BindingError';
  }
}

/**
 * Reads the body into the request types in document order, stopping at the first problem: a syntax
 * error, a value of the wrong type, or an object missing a required property when it closes.
 */
class BodyReader {
  private readonly reader: Utf8JsonReader;

  constructor(data: Uint8Array) {
    this.reader = new Utf8JsonReader(data);
  }

  readRequest(): BoundObject | null {
    this.read('$');
    let model: BoundObject | null = null;
    if (this.reader.tokenType !== 'null') {
      if (this.reader.tokenType !== 'startObject') {
        throw this.conversionError('$', DraftReportRequestModel.typeName);
      }
      model = this.readObject(DraftReportRequestModel, '$');
    }
    // Anything after the top-level value is an error.
    this.read('$');
    return model;
  }

  private read(path: string): void {
    this.withPath(path, () => this.reader.read());
  }

  private skip(path: string): void {
    this.withPath(path, () => this.reader.skip());
  }

  private withPath(path: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      if (error instanceof JsonReaderError) {
        throw new BindingError(path, withPosition(error.message, path, error.lineNumber, error.bytePositionInLine));
      }
      throw error;
    }
  }

  private conversionError(path: string, typeName: string): BindingError {
    return new BindingError(
      path,
      withPosition(`The JSON value could not be converted to ${typeName}.`, path, this.reader.line, this.reader.bytePositionAfterToken),
    );
  }

  private readObject(model: TypeModel, path: string): BoundObject {
    const values: BoundObject = {};
    const present = new Set<PropertyModel>();
    for (;;) {
      this.read(path);
      if (this.reader.tokenType === 'endObject') {
        break;
      }

      const name = this.reader.getPropertyName();
      if (name === undefined) {
        throw this.conversionError(path, model.typeName);
      }
      const valuePath = appendPropertyName(path, name);
      const property = model.properties.find((candidate) => sameName(candidate.json, name));
      this.read(valuePath);
      if (!property) {
        this.skip(valuePath);
        continue;
      }

      // A property that appears twice is read twice, and the last value wins.
      const value = this.readValue(property.kind, valuePath);
      values[property.name] = property.trim && typeof value === 'string' ? trimWhiteSpace(value) : value;
      present.add(property);
    }

    const missing = model.properties.filter((property) => property.required && !present.has(property));
    if (missing.length > 0) {
      throw new BindingError(path, missingPropertiesMessage(model.typeName, missing));
    }
    return values;
  }

  private readValue(kind: Kind, path: string): BoundValue {
    const { reader } = this;
    const token = reader.tokenType;
    switch (kind.type) {
      case 'string': {
        const text = token === 'string' ? reader.getString() : undefined;
        if (token === 'null') {
          return null;
        }
        if (text !== undefined) {
          return text;
        }
        throw this.conversionError(path, 'System.String');
      }
      case 'boolean':
        if (token === 'true' || token === 'false') {
          return token === 'true';
        }
        throw this.conversionError(path, 'System.Boolean');
      case 'double': {
        if (token === 'null' && kind.nullable) {
          return null;
        }
        // Dragon Copilot also reads a number written as a string, such as "0.9".
        const value = token === 'number'
          ? Number(reader.getNumberText())
          : token === 'string' ? parseQuotedDouble(reader.getString()) : undefined;
        if (value !== undefined) {
          return value;
        }
        throw this.conversionError(path, kind.nullable ? 'System.Nullable`1[System.Double]' : 'System.Double');
      }
      case 'int32': {
        const value = token === 'number'
          ? parseInt32(reader.getNumberText(), JSON_INTEGER)
          : token === 'string' ? parseInt32(reader.getString(), QUOTED_INTEGER) : undefined;
        if (value !== undefined) {
          return value;
        }
        throw this.conversionError(path, 'System.Int32');
      }
      case 'object':
        if (token === 'null') {
          return null;
        }
        if (token !== 'startObject') {
          throw this.conversionError(path, kind.model.typeName);
        }
        return this.readObject(kind.model, path);
      case 'array': {
        if (token === 'null') {
          return null;
        }
        if (token !== 'startArray') {
          throw this.conversionError(path, kind.typeName);
        }
        const items: BoundValue[] = [];
        for (;;) {
          const itemPath = `${path}[${items.length}]`;
          this.read(itemPath);
          if (reader.tokenType === 'endArray') {
            return items;
          }
          items.push(this.readValue(kind.element, itemPath));
        }
      }
    }
  }
}

function validateObject(model: TypeModel, value: BoundObject, prefix: string, modelState: ModelState): void {
  for (const property of model.properties) {
    const key = prefix ? `${prefix}.${property.name}` : property.name;
    const propertyValue = value[property.name] ?? null;
    for (const rule of property.rules ?? []) {
      const message = checkRule(rule, propertyValue, property.name);
      if (message) {
        modelState.add(key, message);
      }
    }
    validateChildren(property.kind, propertyValue, key, modelState);
  }
}

function validateChildren(kind: Kind, value: BoundValue, key: string, modelState: ModelState): void {
  if (value === null) {
    return;
  }
  if (kind.type === 'object') {
    validateObject(kind.model, value as BoundObject, key, modelState);
  } else if (kind.type === 'array') {
    (value as BoundValue[]).forEach((item, index) => validateChildren(kind.element, item, `${key}[${index}]`, modelState));
  }
}

function checkRule(rule: Rule, value: BoundValue, name: string): string | undefined {
  switch (rule.type) {
    case 'required':
      return isNullOrWhiteSpace(value) ? `The ${name} field is required.` : undefined;
    case 'stringLength':
      if (typeof value !== 'string' || (value.length <= rule.maximum && value.length >= (rule.minimum ?? 0))) {
        return undefined;
      }
      return rule.minimum === undefined
        ? `The field ${name} must be a string with a maximum length of ${rule.maximum}.`
        : `The field ${name} must be a string with a minimum length of ${rule.minimum} and a maximum length of ${rule.maximum}.`;
    case 'pattern':
      // Like RegularExpressionAttribute, an empty string passes.
      if (typeof value !== 'string' || value.length === 0 || rule.pattern.test(value)) {
        return undefined;
      }
      return rule.message ?? `The field ${name} must match the regular expression '${rule.source}'.`;
    case 'allowedValues':
      // Like AllowedValuesAttribute, a missing value isn't one of the allowed values.
      return typeof value === 'string' && rule.values.includes(value)
        ? undefined
        : `The ${name} field does not equal any of the values specified in AllowedValuesAttribute.`;
    case 'range':
      // NaN and infinities are out of range.
      if (typeof value !== 'number' || (value >= rule.minimum && value <= rule.maximum)) {
        return undefined;
      }
      return `The field ${name} must be between ${rule.minimum} and ${rule.maximum}.`;
    case 'noControlCharacters':
      return typeof value === 'string' && CONTROL_CHARACTER.test(value) ? `${name} must not contain control characters.` : undefined;
  }
}

function checkMarketplaceIds(model: BoundObject, modelState: ModelState): void {
  const supplied = ['PublisherId', 'OfferId', 'PlanId'].filter((name) => !isNullOrWhiteSpace(model[name] ?? null)).length;
  if (supplied > 0 && supplied < 3) {
    modelState.add('MarketplaceExtensionIdentifiers', 'PublisherId, OfferId and PlanId must be supplied together or omitted together.');
  }
}
