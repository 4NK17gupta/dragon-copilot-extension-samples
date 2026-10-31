import express from 'express';

// Compressed request bodies are rejected with 415 rather than inflated: body-parser
// below 2.4.0 crashes the process on trailing bytes after a compressed body
// (GHSA-27r3-jxmh-p828), and none of the sandbox's clients compress requests.
export const jsonBodyParser = express.json({ inflate: false });
