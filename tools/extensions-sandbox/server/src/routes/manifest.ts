import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import multer from 'multer';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { ExtensionManifest } from '../schemas/manifest.schema.js';
import { sessionStore } from '../store/session.js';

export const manifestRouter = Router();

const upload = multer({
  limits: { fileSize: 1 * 1024 * 1024 }, // 1MB limit
  fileFilter: (_req, file, cb) => {
    const allowedExtensions = ['.json', '.yaml', '.yml'];
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type '${ext}'. Accepted: .json, .yaml, .yml`));
    }
  },
});

// Load the official DCR extension manifest JSON schema
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const schemaPath = join(__dirname, '..', 'schemas', 'dcr-extension-manifest-schema.json');
const manifestJsonSchema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv({ allErrors: true, verbose: true });
addFormats(ajv);
const validate = ajv.compile(manifestJsonSchema);

/**
 * POST /api/manifest/upload
 * Accepts a manifest file (JSON or YAML), validates it, and stores it in session.
 */
manifestRouter.post('/upload', upload.single('manifest'), (req, res) => {
  if (!req.file) {
    res.status(400).json({
      valid: false,
      errors: [{ path: null, message: 'No file uploaded', severity: 'error' }],
      message: 'No manifest file provided.',
    });
    return;
  }

  const fileContent = req.file.buffer.toString('utf-8');
  const ext = req.file.originalname.toLowerCase().slice(req.file.originalname.lastIndexOf('.'));

  // Parse file content
  let parsed: unknown;
  try {
    if (ext === '.json') {
      parsed = JSON.parse(fileContent);
    } else {
      parsed = yaml.load(fileContent);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown parse error';
    res.status(400).json({
      valid: false,
      errors: [{ path: null, message: `Failed to parse file: ${message}`, severity: 'error' }],
      message: 'File could not be parsed as JSON or YAML.',
    });
    return;
  }

  // Validate against schema
  const isValid = validate(parsed);

  if (!isValid) {
    const errors = (validate.errors ?? []).map((err) => ({
      path: err.instancePath || '/',
      message: `${err.instancePath || '/'}: ${err.message}`,
      severity: 'error' as const,
    }));

    res.status(422).json({
      valid: false,
      errors,
      message: `Manifest validation failed with ${errors.length} error(s).`,
    });
    return;
  }

  const manifest = parsed as ExtensionManifest;
  sessionStore.setManifest(manifest);

  // Extract capabilities
  const capabilities = [...new Set(manifest.tools.map((t) => t.capability))];

  res.json({
    valid: true,
    manifest: {
      name: manifest.name,
      version: manifest.version,
      toolCount: manifest.tools.length,
      capabilities,
    },
    message: `Manifest is valid. ${manifest.tools.length} tool(s) found across ${capabilities.length} capability(ies).`,
  });
});

/**
 * GET /api/manifest
 * Returns the currently loaded manifest metadata (or 404 if none).
 */
manifestRouter.get('/', (_req, res) => {
  const manifest = sessionStore.getManifest();
  if (!manifest) {
    res.status(404).json({ error: 'No manifest loaded. Upload a manifest first.' });
    return;
  }

  const capabilities = [...new Set(manifest.tools.map((t) => t.capability))];
  res.json({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    toolCount: manifest.tools.length,
    capabilities,
  });
});

/**
 * DELETE /api/manifest
 * Clears the current session manifest.
 */
manifestRouter.delete('/', (_req, res) => {
  sessionStore.clear();
  res.json({ message: 'Manifest cleared.' });
});
