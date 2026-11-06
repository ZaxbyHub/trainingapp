// vitest.setup.ts — SheetJS Node-ESM file-I/O registration for the packtool specs
// (issue #276).
//
// SheetJS 0.19+ (the vendored 0.20.3 tarball) resolves `import 'xlsx'` to its
// ESM build (package.json exports.import -> xlsx.mjs), which never loads Node's
// `fs` on its own: XLSX.readFile / XLSX.writeFile throw "cannot save file" until
// the host registers it with XLSX.set_fs (the SheetJS-documented Node ESM
// integration). Production packtool code only calls XLSX.read on in-memory
// buffers, so it needs no registration; the specs' fixture helpers write real
// .xlsx files with XLSX.writeFile, so the test environment registers fs here.
// Setup files run in each test file's own module graph, so this is the same
// `xlsx` module instance the specs import.
import * as fs from 'node:fs';
import * as XLSX from 'xlsx';

XLSX.set_fs(fs);
