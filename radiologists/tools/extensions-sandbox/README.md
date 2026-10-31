# Microsoft Dragon Copilot (radiologists) Extensions Sandbox

A local development environment for testing and validating Microsoft Dragon Copilot (radiologists) extensions before deployment to customer sites.

**Why this exists**: validating a manifest and its payloads currently requires deploying to a real Dragon Copilot environment. The sandbox runs that loop locally — load a manifest, point it at your extension, and see the manifest, request, and response payloads validated against the Extensibility API contract before you ship.

**Who it's for**: partners building radiology extensions.

**Where it fits**: author your manifest with `tools/dragon-copilot-cli` — or generate one without leaving the sandbox via the **Generate Manifest** button in the Manifest Editor — run your extension (or one of the samples in `radiologists/src/samples/ContractBased`), then load the manifest here to test.

## Prerequisites

- [Node.js](https://nodejs.org/) `^20.19.0 || >=22.12.0` — required by Vite 8 (client) and Vitest 4 (server); their Rolldown native binding will not load on Node 18
- npm >= 9.x

## Quick Start

```bash
# 1. Navigate to the sandbox directory
cd radiologists/tools/extensions-sandbox

# 2. Install dependencies
npm install

# 3. Start the sandbox
npm run dev
```

Open `http://localhost:3000` in your browser.

`npm run dev` starts both the frontend (Vite dev server on port 3000) and the backend (Express on port 4000) concurrently, with hot-reload. The frontend proxies API calls to the backend automatically, so port 3000 is the only URL you need.

> The Express server binds to `127.0.0.1` and is reachable only from the local machine.
> It also rejects (`403`) requests whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`,
> and state-changing requests sent from a non-local browser `Origin`, so other web pages cannot
> drive it through DNS rebinding or cross-site form posts. Clients that send no `Origin`
> (curl, the samples) are unaffected. The sandbox's own routes reject compressed request bodies
> (`Content-Encoding: gzip`, `deflate` or `br`) with `415`; send JSON uncompressed.

### Testing partner-initiated tools

For a `partnerInitiated` tool, your service calls Dragon Copilot rather than the other way round. The
sandbox stands in for Dragon Copilot's submission endpoint, at the same path:

```
POST http://localhost:3000/api/v1/tenants/{customerTenantId}/environments/{environmentId}/draft-report-ai-results
```

Port `4000` works too. Point your service's Dragon Copilot base URL at the sandbox and send what you
would send to Dragon Copilot: the full request, with `manifestName`, `toolName` and `draftReport`, as
[Submitting a result](../../partner-initiated/README.md#submitting-a-result) describes. While the sandbox
is listening (see **Run Test** below), the endpoint answers the way Dragon Copilot does:

- the same status codes, `reason` values and bodies, with an `x-ms-correlation-id` header on every response;
- the same validation, with the same error keys, messages and order. A missing property, a value of the
  wrong type, a number sent as a string and a name with surrounding spaces are all handled as Dragon
  Copilot handles them;
- the same checks after validation, in the same order: the environment, the extension (`manifestName`,
  plus the Marketplace IDs if you send them), the tool, a result already stored for
  `draftReport.identifier`, then the order with the accession number.

One difference in wording is deliberate. Where Dragon Copilot's message names one of its internal .NET
types, the sandbox's message gives a short name instead, such as `DraftReport` or `Section`.

The endpoint answers for a simulated customer environment, which the **Setup** tab shows and lets you change:

| Setting | Default | Notes |
|---|---|---|
| Customer tenant ID | `11111111-1111-1111-1111-111111111111` | The first ID in the URL. |
| Environment ID | `22222222-2222-2222-2222-222222222222` | The second ID in the URL. |
| Installed extension | The loaded manifest, installed as a custom app | As during development, it has no Marketplace IDs, so a submission that sends them gets `ExtensionNotFound`. To test an extension purchased from Microsoft Marketplace, turn on **Extension purchased from Microsoft Marketplace** and enter its publisher, offer and plan IDs. A submission without Marketplace IDs matches either way. |
| Orders | `ACC-0000001` | Accession numbers, one per line. List one twice to get `MultipleOrdersMatched`. |

The bundled example request uses accession number `ACC-0000001`, the default order. It also sends
placeholder Marketplace IDs (`101`, `202` and `303`), so against the default custom app it gets
`404 ExtensionNotFound`, as it would from Dragon Copilot. To send it as it is, turn on
**Extension purchased from Microsoft Marketplace** and enter those IDs, or remove the three IDs from the
request. Either way, load the sample manifest, `radiologists/src/samples/PartnerInitiated/extension.yaml`,
first.

Stored results are kept in memory until you clear them in **Setup**, click **Reset Session**, or restart the
sandbox, so sending the same `draftReport.identifier` again gets `409 ResultAlreadyStored`, as it would
from Dragon Copilot. Stopping listening, **Reset Inputs** and changes in **Setup** keep them; results are
stored per environment, so another environment ID starts with none.

Not simulated:

- **Authentication.** The endpoint doesn't check the access token, its permission or its tenant, so it
  never answers `401` or `403`. See [Authentication](../../partner-initiated/authentication.md).
- **Clinical data.** Orders are the accession numbers you list, and nothing is written to a patient
  record. Use synthetic data.
- **Failures inside Dragon Copilot**, which answer `500`.

**Run Test** starts listening. While the sandbox listens, the endpoint answers every submission and the
sandbox shows each one: **Results** lists the requests, newest first, with each check the endpoint made
for the one you select; **Outputs** shows its request and response; and **Dragon Copilot Preview** shows
the AI draft. A bar on every tab shows how many requests the sandbox has received and which one the tabs
are showing, with its status and time; its button stops listening, or starts it again. The tabs move to
each new request as it arrives, unless you pick an older one in **Results**: that one stays until you
click **Show latest** in the bar. The sandbox keeps the last 20 requests since you clicked **Run Test**,
and adds each one to the session's consolidated validation report.

Listening stops when you click **Stop listening** or **Reset Inputs**, choose another tool, change the
manifest or close the page. Until you click **Run Test** again, the endpoint answers `503` with a message,
and checks and stores nothing.

For example, load the sample manifest, turn on **Extension purchased from Microsoft Marketplace** with IDs
`101`, `202` and `303`, and click **Run Test**. Then, from the sandbox directory in PowerShell 7, send the
bundled example:

```powershell
$body = Get-Content ..\..\partner-initiated\samples\PreDraftReportGeneration-Ingest-Request-Example.json -Raw
$uri = 'http://localhost:3000/api/v1/tenants/11111111-1111-1111-1111-111111111111/environments/22222222-2222-2222-2222-222222222222/draft-report-ai-results'
Invoke-WebRequest -Method Post -Uri $uri -ContentType 'application/json' -Body $body -SkipHttpErrorCheck
```

[`submit-pre-draft-report.http`](../../src/samples/PartnerInitiated/submit-pre-draft-report.http) works
too, with `@dragonCopilot = http://localhost:3000` and the default IDs above.

The run API is `POST /api/manifest/partner-initiated/start` with
`{ "capability": "preDraftReportGeneration", "tool": "<manifest tool name>" }` to start listening,
`GET /api/manifest/partner-initiated/{runId}?after={n}` for the requests after the `n`th, and
`DELETE /api/manifest/partner-initiated/{runId}` to stop. Only one run listens at a time, so starting
another replaces it. A script that sends submissions without the UI starts a run this way first.
The UI polls every second while listening; it does not use
Server-Sent Events (SSE). The draft report schemas in `radiologists/partner-initiated/`
are synced into the server before dev/build/test and packaged with the built server.
After a successful submission, **Dragon Copilot Preview** displays an **AI draft** card
with the submitted sections sorted by `sectionOrder`, uppercase section labels,
and AI/third-party disclaimers. A `title` section appears without a label; no
title or clinical content is inferred from study metadata. Both `plain_text`
(preserving line breaks) and `markdown` section content are supported. Markdown
HTML is displayed as text, links are non-interactive, and images are represented
by their alternate text without loading remote resources. A rejected submission
shows an error rather than a draft; the full request and response remain in **Outputs**.
The public capability identifier remains `preDraftReportGeneration`; existing
tool names, template IDs, and example filenames are unchanged.

### Creating a manifest with the CLI wizard

If you don't have a manifest yet, click **Generate Manifest** in the Manifest Editor toolbar. The
dialog asks the core questions from `dragon-copilot radiologists init`, either starting from a built-in
template (`quality-check` for Report Optimization, `pre-draft-report` for AI Draft) or from your own
values — extension name, tenant, and one or more tools, each with a name, description, tool type,
output, and optional relevance filtering by body part and modality.

Each tool's **Tool type** decides what else is asked:

- **Contract Based** (`qualityCheck`): Dragon Copilot calls your endpoint, so the tool needs an API
  endpoint and at least one input data type.
- **Partner Initiated** (`preDraftReportGeneration`, AI Draft): you submit draft reports to Dragon
  Copilot, so there is no endpoint or input to fill in. The output name and description switch to the
  draft report defaults unless you have already changed them. Relevance filtering is declarative and
  not currently enforced for these tools.

The capability is shown read-only; it follows from the tool type. Use **Add another tool** to put
several tools, of either type, in one manifest. Tool names must be unique, and **Generate manifest**
stays disabled until they are.

**Generate manifest** posts the answers to `POST /api/cli/generate`, where the CLI's own manifest code
assembles the YAML; the result is loaded into the editor and validated immediately, so you can go
straight to testing. If the answers produce a manifest the schema rejects (for example a name that
isn't camelCase), the YAML is still loaded and the errors are shown against their line numbers.

The CLI is invoked as a library, not as a binary — you don't need `dragon-copilot` installed to use
the wizard.

### Production build

To build and run the compiled output instead:

```bash
npm run build
npm start
```

`npm start` runs the API server only, on `http://localhost:4000` — it does not serve the UI. Use `npm run dev` if you want the sandbox UI.

## Development

### Server logging

The Express server emits scoped, leveled logs through a shared logger (`server/src/utils/logger.ts`). Each entry is tagged with a scope identifying the area (e.g. `http`, `manifest`, `extension-call`, `validate`, `auth`, `validation`).

**Level** is controlled by the `LOG_LEVEL` environment variable (`debug` | `info` | `warn` | `error`), defaulting to `info`:

```bash
# Windows (PowerShell)
$env:LOG_LEVEL = "debug"; npm run dev

# macOS / Linux
LOG_LEVEL=debug npm run dev
```

- `info` (default) shows request flow, outbound extension calls, and validation outcomes.
- `debug` additionally surfaces verbose dumps such as raw request bodies and a reproducible `curl` command for each outbound call.

**Format** is controlled by the `LOG_FORMAT` environment variable (`pretty` | `json`). It defaults to `pretty` in development and `json` in production (`NODE_ENV=production`):

- `pretty` — human-readable lines, e.g. `[sandbox-server] [manifest] 2026-06-25T... Validating manifest...`
- `json` — one structured object per line, suitable for machine parsing / log aggregation, e.g. `{"time":"2026-06-25T...","level":"info","scope":"manifest","msg":"Validating manifest..."}`

```bash
# Force structured JSON output in development
LOG_FORMAT=json npm run dev
```

**Secrets are never logged.** Bearer tokens / `Authorization` headers are redacted, and client secrets never reach the logs; only non-sensitive metadata (tenant id, client id, scope, expiry) may appear.

## Running the tests

```bash
npm test          # every workspace
npm test --workspace=client
```

`jsdom` is declared in the **root** `package.json` rather than only in `client`, and it must stay
there. Both `client` and `server` depend on Vitest, so npm hoists Vitest to the workspace root, and
Node resolves a package's imports from the importer's own location upward — a `jsdom` installed only
under `client/node_modules` is invisible to the hoisted Vitest, which fails with
`Cannot find package 'jsdom'`. Declaring it at the root keeps exactly one copy where Vitest can
resolve it, and lets `client`'s own `jsdom` dependency dedupe onto it.

Keep it pinned to `^26.x`. jsdom 30 requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`, which would
drop the Node 20 support declared in `engines` and used by CI.

## Project Structure

```
extensions-sandbox/
├── package.json          # Root workspace configuration
├── client/               # React + Vite frontend
│   ├── src/
│   │   ├── main.tsx      # Application entry point
│   │   ├── App.tsx       # Root component
│   │   └── App.css       # Global styles
│   ├── index.html        # HTML template
│   ├── vite.config.ts    # Vite configuration with API proxy
│   └── tsconfig.json     # TypeScript configuration
├── shared/               # Logic shared by client and server
│   ├── src/
│   │   ├── index.ts      # Public entry point
│   │   ├── input-parsing.ts  # Parses/groups flat form inputs into nested objects
│   │   └── __tests__/    # Unit tests
│   └── tsconfig.json     # TypeScript configuration
└── server/               # Express backend
    ├── scripts/
    │   ├── generate-output-schemas.ts  # Generates JSON Schemas from OpenAPI spec
    │   └── sync-schemas.ts             # Syncs the manifest schema, OpenAPI spec, partner-initiated schemas, and CLI manifest core from their owners
    ├── src/
    │   ├── index.ts      # Server entry point
    │   ├── cli/
    │   │   ├── README.md               # Why this folder is synced, not authored here
    │   │   └── radiologists/           # CLI manifest core, synced from the CLI (git-ignored)
    │   ├── schemas/
    │   │   ├── radiologists/
    │   │   │   ├── radiologists-extension-manifest-schema.json  # Synced from the CLI (git-ignored)
    │   │   │   ├── radiologists-extensibility-api.yaml          # Synced from radiologists/ (git-ignored)
    │   │   │   └── partner-initiated/                           # Draft report schemas and samples/ example payloads, synced from radiologists/partner-initiated/ (git-ignored)
    │   │   ├── generated-schemas/      # Auto-generated (do not edit by hand)
    │   │   │   ├── patient-information.json
    │   │   │   ├── quality-check-result.json
    │   │   │   └── report.json
    │   │   └── manifest.schema.ts      # TypeScript types for manifests
    │   ├── routes/
    │   │   ├── cli.ts                  # Manifest generation with the CLI's own code
    │   │   ├── dragon-copilot-api.ts   # The simulated Dragon Copilot submission endpoint (/api/v1)
    │   │   ├── manifest.ts
    │   │   └── partner-initiated.ts    # Run Test for partnerInitiated tools: start, poll and stop a run
    │   ├── services/
    │   │   ├── draft-report-submission/  # Reads and validates a submission as Dragon Copilot does
    │   │   ├── manifest-schema.ts      # Shared manifest schema validation + error shaping
    │   │   └── validation.ts
    │   ├── store/
    │   │   ├── partner-run.ts          # The listening run and the requests it recorded
    │   │   └── simulated-environment.ts  # The customer environment the simulated endpoint answers for
    │   ├── utils/
    │   │   └── schema-path.ts          # Central path resolution for schemas
    │   └── __tests__/
    │       └── fixtures/               # Test resource files, including:
    │           ├── valid-manifest-partner-initiated.json   # AI Draft: one partnerInitiated tool, no endpoint/inputs
    │           └── valid-manifest-mixed-tool-types.json    # contractBased + partnerInitiated tools (mirrors radiologists/manifest/extension.yaml)
    └── tsconfig.json     # TypeScript configuration
```

### Generated Schemas

The `server/src/schemas/generated-schemas/` folder contains JSON Schema files that are **auto-generated** from the OpenAPI specification (`radiologists-extensibility-api.yaml`). These files should not be edited by hand — they are regenerated on every build and test run via:

```bash
npm run generate-schemas
```

The generation script (`scripts/generate-output-schemas.ts`) extracts the `PatientInformation`, `Report`, and `QualityCheckResult` schema definitions (and everything they reference, e.g. `Recommendation`, `Provenance`) from the OpenAPI YAML and produces standalone JSON Schema files. `patient-information.json` and `report.json` are used to validate and describe tool *inputs*; `quality-check-result.json` is used to validate extension *responses*.

> **Note:** The sandbox owns none of the contracts it validates against, nor the code behind the CLI
> wizard. All of them are synced in at dev/build/test time by `scripts/sync-schemas.ts`, and the local
> copies are git-ignored so the upstream copy stays the single source of truth:
> the manifest schema (`radiologists-extension-manifest-schema.json`) and the manifest core
> (`src/cli/radiologists/`) are owned by the `tools/dragon-copilot-cli` package, the OpenAPI spec
> (`radiologists-extensibility-api.yaml`) is owned by `radiologists/`, and the draft report schemas
> for `partnerInitiated` tools (`partner-initiated/draft-report-schema.json` and
> `partner-initiated/draft-report-ingest-request-schema.json`) are owned by `radiologists/partner-initiated/`.
> The example ingest request and retrieve response payloads (`PreDraftReportGeneration-*-Example.json`)
> are copied byte-for-byte from `radiologists/partner-initiated/samples/` into `partner-initiated/samples/`;
> their source paths are recorded in `src/utils/schema-path.ts`.
> `src/__tests__/schema-sync.test.ts` fails if any copy drifts from its source, and
> `src/__tests__/manifest-validation.test.ts` fails if the AI Draft and mixed manifest fixtures drift from
> `radiologists/src/samples/PartnerInitiated/extension.yaml` and `radiologists/manifest/extension.yaml`. The OpenAPI spec will
> be replaced with an internal package reference once `diag-radex-extension-service` publishes its
> authoritative version.

## API Endpoints

All routes are served under `http://localhost:4000`.

### Health

| Method | Path        | Description         |
|--------|-------------|---------------------|
| GET    | /api/health | Server health check |

### Manifest

| Method | Path                                              | Description                                                             |
|--------|---------------------------------------------------|-------------------------------------------------------------------------|
| POST   | /api/manifest/upload                              | Upload a manifest file (JSON or YAML), validate it, and store it in session |
| POST   | /api/manifest/validate                            | Validate raw manifest text supplied in the request body                 |
| GET    | /api/manifest                                     | Get the currently loaded manifest metadata (404 if none)                |
| GET    | /api/manifest/raw                                 | Get the raw manifest text exactly as uploaded                           |
| DELETE | /api/manifest                                     | Reset Session: clear the session manifest, its validation results and listening run, and the simulated endpoint's stored results |
| GET    | /api/manifest/capabilities                        | List capabilities with their display names, grouped by each tool's `capability` field |
| GET    | /api/manifest/capabilities/:capabilityName/tools  | List the tools defined under a given capability                         |
| POST   | /api/manifest/execute                             | Execute a tool: validate the inputs, POST a `ProcessRequest` to the endpoint the manifest declares, then validate the response |
| POST   | /api/manifest/partner-initiated/start             | Run Test for a `partnerInitiated` tool: start listening for submissions to the simulated Dragon Copilot endpoint, replacing any earlier run |
| GET    | /api/manifest/partner-initiated/:runId            | Poll a run: the endpoint URL, the number of requests, and the kept requests, each with its request, response and checks. `?after=n` returns only the requests after the `n`th |
| DELETE | /api/manifest/partner-initiated/:runId            | Stop listening                                                          |

`/api/manifest/execute` validates on both sides of the call. Inputs are checked against the schemas
for their declared content-types before the extension is reached — a failure returns `422` and no
call is made — and the returned payload is checked against the tool's output schema. Both results
come back in the response body, as `inputValidation` and `validation`. The `/api/validate/*` routes
below expose the same checks individually, for validating a payload without executing anything.

Malformed request bodies are rejected before any of this: invalid JSON returns `400`, an
oversized body `413`, and `inputs` that is not an object of string values — or that uses a
reserved name segment (`__proto__`, `prototype`, `constructor`) — returns `400`. Server errors
return a generic `500` and are logged without the request body.

### Validation

| Method | Path                              | Description                                                        |
|--------|-----------------------------------|--------------------------------------------------------------------|
| POST   | /api/validate/inputs/:toolName    | Validate tool inputs against the schemas for their declared content-types |
| POST   | /api/validate/:toolName           | Validate a tool response payload against the expected output schema |
| GET    | /api/validate/results             | List all validation results stored for the session                 |
| DELETE | /api/validate/results             | Clear stored validation results                                    |

Input and response validation return `200` when valid and `422` when the payload fails schema validation.

### Simulated Dragon Copilot API

| Method | Path                                                                                   | Description |
|--------|----------------------------------------------------------------------------------------|-------------|
| POST   | /api/v1/tenants/:customerTenantId/environments/:environmentId/draft-report-ai-results | Submit a draft report, as to Dragon Copilot, while the sandbox is listening; `503` otherwise. See [Testing partner-initiated tools](#testing-partner-initiated-tools). |

Like Dragon Copilot, other methods on that path get `405` with `Allow: POST`, and other `/api/v1`
paths get `404` with no body.

### Simulated environment

| Method | Path                                      | Description |
|--------|-------------------------------------------|-------------|
| GET    | /api/simulated-environment                | The simulated customer environment, its submission path and the number of stored results |
| PUT    | /api/simulated-environment                | Change the customer tenant ID, environment ID, Marketplace IDs (`null` for a custom app) and orders |
| DELETE | /api/simulated-environment/stored-results | Forget stored results                    |

### Authentication

| Method | Path             | Description                                             |
|--------|------------------|---------------------------------------------------------|
| GET    | /api/auth/config | Get auth config (secret redacted)                       |
| POST   | /api/auth/config | Update auth config (secret write-only)                  |
| POST   | /api/auth/test   | Acquire a token and validate claims (no extension call) |

### CLI

| Method | Path              | Description                                                          |
|--------|-------------------|----------------------------------------------------------------------|
| GET    | /api/cli/options  | Templates, selectable values, and field defaults the wizard renders   |
| POST   | /api/cli/generate | Generate a manifest from a template or wizard answers, returned as YAML |

`POST /api/cli/generate` takes `mode: "template"` (with a `template` id) or `mode: "custom"` (with an
`extension` object and a `tools` array), plus the `tenantId` in both cases. Each tool has a `toolType`
(`contractBased` by default); `endpoint` and `inputTypes` are used only for `contractBased` tools, and
the capability defaults to the one paired with the tool type. A single `tool` object is still accepted
in place of `tools`, but not both together. An omitted or blank `mode` defaults to `template`; any
other value, including a non-string, is rejected. It returns `200` with the generated `yaml`, `400`
when the request itself is unusable (unsupported `mode`, no tenant, unknown template, no tool, both
`tool` and `tools`, duplicate tool names), and `422` when the generated manifest fails schema
validation — in which case the `yaml` is still returned alongside the errors so the editor can show
them in context.

`GET /api/cli/options` also returns `capabilityByToolType` and `outputDefaultsByToolType`, and each
template summary lists the `toolTypes` it uses.

Generation runs the manifest core owned by `tools/dragon-copilot-cli` in-process (synced into
`src/cli/radiologists/`); the CLI binary is never spawned, and it does not need to be installed.

## Architecture

The sandbox reproduces, locally, the path a request takes through the Dragon Copilot Extension
Runtime — so that a manifest which works here works when deployed.

1. **Load the manifest.** A manifest is uploaded (`POST /api/manifest/upload`), pasted
   (`POST /api/manifest/validate`), or generated by the CLI wizard (`POST /api/cli/generate`, which
   runs the CLI's own manifest code in-process). YAML and JSON are both accepted and normalized to
   the same object.
2. **Validate against the contract.** The manifest is checked against the JSON Schema owned by
   `tools/dragon-copilot-cli` — the same schema the CLI enforces — so the sandbox cannot accept a
   manifest the platform would reject. Errors are mapped back to line/column positions in the
   original text for display in the editor. To bound the work per request, a manifest with more
   than 10,000 values (for example from expanded YAML aliases) is rejected without validation; above
   2,000 values only the first schema error is listed; at most 100 errors are listed per run; and
   line numbers are shown only for sources of up to 50,000 characters and 2,000 lines.
3. **Parse capabilities and tools.** Tools are grouped by their `capability` field to drive the UI,
   exposing which tools exist and what inputs each declares.
4. **Parse and validate inputs.** Form values arrive as flat dot-delimited paths
   (`report.reportText`) and are grouped into the nested objects the extension expects. Each input
   is then validated against the JSON Schema for its declared content-type
   (e.g. `application/vnd.ms-dragon.rad.report+json`), generated from the Extensibility API
   OpenAPI spec. Inputs that fail are reported and the call is not made.
5. **Call the extension.** The validated inputs are wrapped in a `ProcessRequest` envelope and
   POSTed to the endpoint the manifest declares. When authentication is enabled, the server
   acquires an Entra token via client credentials and attaches it as a `Bearer` token; the secret
   stays in server memory only.
6. **Validate the response.** The returned `ProcessResponse` payload is validated against the
   output schema for the tool's declared output content-type. Results are stored in the session so
   they can be reviewed in the **Results** and **Outputs** tabs.

Steps 4–6 all happen inside `POST /api/manifest/execute`, so the validation cannot be skipped by
calling the API directly — the UI renders what that one call returns.

The client never talks to your extension directly — every call is proxied through the server, which
is where schema loading, validation, and token acquisition live.

**Stack**: React 19 + Vite (client, port 3000), Express 5 + TypeScript (server, port 4000), a
`shared` workspace for logic used by both, and npm workspaces tying them together. The Vite dev
server proxies `/api/*` to the backend.

## Testing against a sample extension

Rather than shipping its own throwaway extension service, the sandbox is meant to be pointed at the canonical **Quickstart sample extension** that lives alongside these samples: [`SampleExtension.Radiologists.Web.Quickstart`](../../src/samples/ContractBased/README.md). It implements the same `ProcessRequest`/`ProcessResponse` envelope contract from the Extensibility API for Dragon Copilot (radiologists) and returns a schema-valid `QualityCheckResult` payload, so you can exercise the sandbox UI end-to-end without deploying a real extension.

### Start the sample extension

```bash
# From the repository root
cd radiologists/src/samples/ContractBased
dotnet run --project SampleExtension.Radiologists.Web.Quickstart
```

The service listens on `http://localhost:5080` (https `https://localhost:7080`) and exposes its processing endpoint at `POST /v1/process`.

### Run it from the sandbox

1. Start the sample extension (port `5080`, above).
2. Start the sandbox (`npm run dev` from `extensions-sandbox/`).
3. Load the shared manifest [`extension.yaml`](../../src/samples/ContractBased/extension.yaml) — its `sampleQualityCheckTool` already targets `http://localhost:5080/v1/process`, so there is nothing to edit.
4. Click **Validate**. The Testing panel stays closed until the manifest validates, so this step is required (uploading alone does not open it).
5. Switch to the **Setup** tab, fill in the report inputs, and click **Run**.
6. View results in the **Results** and **Outputs** tabs.

### Example Response

The Quickstart returns a canned `QualityCheckResult` (source: `SampleExtension.Radiologists.Web.Quickstart/MockData/qualitycheck-response.json`):

```json
{
  "success": true,
  "message": "Payload processed successfully.",
  "payload": {
    "qualityCheckResult": {
      "recommendations": [
        {
          "qualityCheckType": "Clinical",
          "description": "Replace 'paddock steatosis' with 'hepatic steatosis'.",
          "reason": "'Paddock steatosis' is a well-known speech-to-text mis-hearing of 'hepatic steatosis' (fatty liver); leaving the erroneous term in the report can mislead downstream clinicians and break automated coding.",
          "severityScorePercent": 85,
          "provenance": [
            { "text": "paddock steatosis", "startPosition": 42, "endPosition": 59 }
          ]
        }
      ]
    }
  }
}
```

## Authentication

The sandbox can authenticate calls to your extension endpoint using **Microsoft Entra ID service-to-service (client credentials)** authentication, mirroring the Dragon Copilot Extension Runtime-to-Extension authentication scheme. When enabled, the sandbox backend acquires an OAuth 2.0 access token and attaches it as a `Bearer` token on every tool execution.

### One-time setup (in the partner tenant)

1. **Service principal for the Dragon Copilot Extension Runtime** — create a service principal for the Dragon Copilot Extension Runtime (client id `d9350f5d-71c2-46b9-b41d-3c5d51ffe6e8`) in your tenant:
   ```powershell
   New-MgServicePrincipal -AppId d9350f5d-71c2-46b9-b41d-3c5d51ffe6e8
   ```
2. **Extension app registration** — create a single-tenant app registration for your extension with an Application ID URI of the form `api://{partner_tenant_id}/{FQDN_of_extension_endpoint}` and set `requestedAccessTokenVersion: 2` in its manifest.
3. **Client secret** — create a client secret for the calling app (the Dragon Copilot Extension Runtime, or your own app registered as the caller).

### Configuring in the sandbox

In the **Setup** tab, open **Authentication → Configure**:

| Field | Description |
|-------|-------------|
| **Authenticate calls** | Toggle service-to-service auth on/off. Off = unauthenticated calls (for local testing). The toggle is saved as soon as you flip it; if the save fails, it switches back and the error is shown. |
| **Tenant ID** | The Entra tenant that issues the token (your partner tenant). |
| **Client ID** | The calling app's client id (defaults to the Dragon Copilot Extension Runtime client id). |
| **Client Secret** | Stored **in memory on the server only**; never returned to the UI or logged. |
| **Application ID URI / Scope** | Your extension's Application ID URI. A bare URI is fine — `/.default` is appended automatically. |

Click **Save**, then **Test connection** to acquire a token without calling the extension. **Test connection** saves first and does not run if the save fails; save errors are shown under the toggle. The result shows the token expiry and a claims-validation summary.

### How it works

1. The backend requests a token via the client credentials grant:
   ```http
   POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
   Content-Type: application/x-www-form-urlencoded

   grant_type=client_credentials
   &client_id=d9350f5d-71c2-46b9-b41d-3c5d51ffe6e8
   &client_secret=<secret>
   &scope=api://{tenantId}/ext.contoso.com/.default
   ```
2. Tokens are **cached** until shortly before expiry (60s skew) to avoid unnecessary requests.
3. The token is sent to your endpoint as `Authorization: Bearer <token>`.
4. Your extension should validate these JWT claims: `iss`, `idtyp` (must be `app`), and `azp` (must equal the Dragon Copilot Extension Runtime client id `d9350f5d-71c2-46b9-b41d-3c5d51ffe6e8`). The sandbox surfaces these as pass/fail guidance in the test results.

### Security notes

- The client secret is held **in server memory only** — it is never persisted to disk, returned by `GET /api/auth/config`, or written to logs.
- Auth can be toggled off at any time to test unauthenticated endpoints.
- Tokens are only sent to `https://` endpoints, or to `http://` endpoints on `localhost`, `127.0.0.1` or `[::1]`. When auth is enabled (or a token is supplied) and the tool's endpoint is plain HTTP on any other host, `/api/manifest/execute` returns `400` without calling it.
- See [Microsoft Entra JWT claims validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation) for details on validating tokens in your extension.

### Offline end-to-end testing (no Azure)

To exercise the full **authentication-enabled** flow without a real Entra tenant, set the `ENTRA_TOKEN_ENDPOINT` environment variable so the sandbox acquires tokens from a local fake issuer instead of `login.microsoftonline.com`. The value may include a `{tenantId}` placeholder.

1. Start a fake token issuer that returns a JWT-shaped `access_token`. The token's `iss` and `tid` must use the **same tenant GUID** you enter in the UI, otherwise the `iss` claim check cannot be verified locally:
   ```powershell
   node -e "const c={iss:'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',idtyp:'app',azp:'d9350f5d-71c2-46b9-b41d-3c5d51ffe6e8',tid:'11111111-1111-1111-1111-111111111111'};const t=['e30',Buffer.from(JSON.stringify(c)).toString('base64url'),'sig'].join('.');require('http').createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({access_token:t,expires_in:3600,token_type:'Bearer'}))}).listen(9200,()=>console.log('fake issuer on :9200'))"
   ```
2. Start the sandbox (server **and** client) pointed at the fake issuer:
   ```powershell
   $env:ENTRA_TOKEN_ENDPOINT = "http://localhost:9200/token"
   npm run dev
   ```
3. In the UI, enable authentication and configure it with **Tenant ID** `11111111-1111-1111-1111-111111111111` (the GUID baked into the fake token above), the Dragon Copilot Extension Runtime client id as **Client ID**, any non-empty **Client Secret**, and a scope. Click **Test connection** — you'll get a token and all three claim checks (`iss` / `idtyp` / `azp`) green, entirely offline. Run a test against a [sample extension](#testing-against-a-sample-extension) to verify the end-to-end enabled-auth path.

> `ENTRA_TOKEN_ENDPOINT` is for local testing only. Leave it unset in any real environment so tokens are acquired from Microsoft Entra ID.

### Testing the authentication feature

Five layers, from zero-setup to full end-to-end. Ports: client `:3000`, sandbox server `:4000`, echo listener `:9100`.

**1. Automated tests (no setup)** — fastest regression check. The auth suites mock the token endpoint and cover acquisition, caching, expiry refresh, error mapping, claim checks, and secret-never-leaked:
```powershell
npm run clean --workspaces --if-present
npm test --workspace=server
```

**2. Config & secret handling (no Azure)** — start the app (`npm run dev`), then verify the write-only secret contract:
```powershell
# Save config with a secret:
curl.exe -s -X POST http://localhost:4000/api/auth/config -H "Content-Type: application/json" `
  --data '{"enabled":true,"tenantId":"tid","clientSecret":"my-secret","scope":"api://tid/ext.contoso.com"}'

# GET must show hasSecret:true but NEVER the secret value:
curl.exe -s http://localhost:4000/api/auth/config
```
Confirm the GET response contains no `clientSecret`, and that saving other fields with an empty secret keeps `hasSecret:true`.

**3. Error paths (no Azure)** — click **Test connection** (or `POST /api/auth/test`) with bad input:
- Missing fields → `invalid_config` with guidance.
- Fake tenant/secret → Entra returns `invalid_client` / `invalid_scope`, surfaced as a clear error. No extension call is made on auth failure.

**4. Real token acquisition (needs an Entra app)** — with a real tenant, app registration, and client secret (per [One-time setup](#one-time-setup-in-the-partner-tenant)), click **Test connection** → expect **Token acquired**, an expiry time, and green `iss` / `idtyp` / `azp` claim checks.

**5. End-to-end — confirm the Bearer reaches the extension.**

*No Azure (forwarding seam):* the `/execute` proxy still forwards a body-supplied `bearerToken` when auth is disabled. Start an echo listener and call `/execute` directly:
```powershell
# Echo listener on :9100 that prints the Authorization header and returns a valid envelope:
node -e "require('http').createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log('AUTH:',q.headers.authorization);r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({success:true,message:'ok',payload:{'quality-result':{recommendations:[]}}}))})}).listen(9100)"

# Set the manifest tool endpoint to http://localhost:9100/v1/process, then:
curl.exe -s -X POST http://localhost:4000/api/manifest/execute -H "Content-Type: application/json" `
  --data '{"capability":"qualityCheck","tool":"chestCtQuality","inputs":{"report":"..."},"bearerToken":"test-token-123"}'
```
The listener prints `AUTH: Bearer test-token-123`, proving the token is attached on the wire.

*Fully offline with auth ON:* mint a token from a local fake issuer via the `ENTRA_TOKEN_ENDPOINT` override (see [Offline end-to-end testing](#offline-end-to-end-testing-no-azure) for details), then run a test against the echo/mock endpoint to exercise the entire enabled-auth path without Azure:
```powershell
# 1. Fake token issuer on :9200 returning a JWT-shaped access_token with valid claims
#    (iss + tid use the same tenant GUID you'll enter in the UI):
node -e "const c={iss:'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',idtyp:'app',azp:'d9350f5d-71c2-46b9-b41d-3c5d51ffe6e8',tid:'11111111-1111-1111-1111-111111111111'};const t=['e30',Buffer.from(JSON.stringify(c)).toString('base64url'),'sig'].join('.');require('http').createServer((q,r)=>{r.writeHead(200,{'Content-Type':'application/json'});r.end(JSON.stringify({access_token:t,expires_in:3600,token_type:'Bearer'}))}).listen(9200,()=>console.log('fake issuer on :9200'))"

# 2. Point the sandbox (server + client) at the fake issuer and start it:
$env:ENTRA_TOKEN_ENDPOINT = "http://localhost:9200/token"
npm run dev
```
Then enable authentication in the UI with **Tenant ID** `11111111-1111-1111-1111-111111111111` (the GUID baked into the fake token), click **Test connection** (all three claim checks green, no Azure), and run a tool test against the echo listener above to confirm the full enabled-auth path end-to-end. Leave `ENTRA_TOKEN_ENDPOINT` unset in any real environment.

## Dragon Copilot Preview pane

The **Results** and **Outputs** tabs answer "is my response schema-valid?". The
**Dragon Copilot Preview** tab answers the other half: *how will a clinician actually see this?*
After a tool run it renders the most recent result the way Dragon Copilot would surface it, so the
end-user experience can be checked before deploying.

What it renders, in order of preference:

| Output shape | Rendered as |
| --- | --- |
| A recommendation list (`{ recommendations: [...] }`, or a bare array of recommendations) | The **Report optimization** card from the Dragon Copilot for radiologists design: a counted title ("Report optimization (N)"), recommendations grouped under their `qualityCheckType`, each bullet reading `description`, then `reason`, then the partner name in parentheses, and the "AI-generated content may be incorrect" / "Third-party generated content" disclaimers |
| An Adaptive Card (`type: "AdaptiveCard"`, optionally wrapped in a `{ contentType, content }` envelope) | The formatted-JSON viewer with a warning: Dragon Copilot for radiologists does not support Adaptive Cards, so a clinician would not see this output |
| Anything else | The formatted-JSON viewer, with a note explaining why it is not shown as a recommendation list |

Recommendation output is detected structurally, so both `payload["quality-result"]` and the
Quickstart's `payload.qualityCheckResult` preview identically. The card shows only what the
Dragon Copilot surface shows: `severityScorePercent`, `additionalInfo`, `provenance`, and
`referenceResources` are omitted, and the full response stays available on the **Outputs** tab.
The manifest has no publisher display name, so the partner credit is the manifest `name` made
readable (for example, `sampleQualityCheckExtension` becomes "Sample Quality Check Extension").

The Dragon Copilot frame uses DCR's dark theme, and the Report optimization card is open by default
and can be collapsed from its header, as in DCR. Run status — the `ProcessResponse` message and any
HTTP failure — is shown above the frame rather than inside it, because it describes the run for the
partner and is not part of what the clinician sees. A non-2xx extension response shows only the HTTP
status and any `ProcessResponse` message — nothing from its payload is drawn in the frame, because
Dragon Copilot would show the clinician nothing; the full body stays on the **Outputs** tab. If the
run fails before the extension responds (sandbox authentication, unreachable endpoint, network
error), the pane shows that error instead of the not-run state. Before any tool has run, the frame
shows the card's not-run state ("Run smart impression to view suggestions."), which is what DCR
shows until Smart Impression triggers the extension; in the sandbox, running a tool from the
**Setup** tab plays that role. The raw JSON tabs are unaffected.

### Result sources

The pane previews a *result*, not a transport payload, and results will eventually come from more
than one place. Rendering therefore goes through a small provider abstraction in
`client/src/preview/`:

```
client/src/preview/
├── types.ts                   # ResultSource, PreviewModel, PreviewBlock, PreviewContext, ResultProvider
├── extension-api-provider.ts  # Translates a sandbox ExecuteResult into a PreviewModel
├── registry.ts                # Source registry + the planned pixel-ai / powerscribe sources
└── index.ts
```

A provider turns a source-specific payload into the renderer-neutral `PreviewModel` the pane draws.
`extension-api` is implemented today. Two further sources are declared in the registry but are not
yet available, so the pane does not offer them as selectable sources:

- **Pixel AI app** — image and overlay results returned by pixel-based imaging AI applications.
- **PowerScribe** — results surfaced from PowerScribe, for side-by-side comparison with extension
  output.

Adding either one means implementing a `ResultProvider` and calling `registerResultProvider` — no
change to `DragonCopilotPreview.tsx` or `TestingPanel.tsx`. A provider receives
`buildPreview(input, context)`: `input` is the untyped source payload it is responsible for
narrowing, and `context` carries what the pane knows but the payload does not, such as the selected
`toolName` and the manifest's `extensionName`. Once a provider reports `available: true`, the
pane shows a selector so the clinician
view can be switched between sources.

## Upcoming Features

- Sample scenario picker & sample data packs
