# vendor/

Third-party artifacts committed to this repository because no registry publishes the
required version. Each entry records its upstream provenance, license, and the hash
the package lockfiles pin. A change to any file here must be accompanied by a
lockfile refresh in every consuming package (`npm install` per package), because
`npm ci` with a warm cache installs the previously locked bytes without re-reading the
tarball on disk; `tests/test_vendored_xlsx.py` fails when the tarball and the
lockfile `integrity` disagree.

## sheetjs/xlsx-0.20.3.tgz

- **Package:** `xlsx` (SheetJS Community Edition) 0.20.3.
- **Consumers:** `web_ui`, `desktop`, `packtool` — each `package.json` declares
  `"xlsx": "file:../vendor/sheetjs/xlsx-0.20.3.tgz"`.
- **Why vendored (issue #276):** the npm registry's latest `xlsx` is 0.18.5, which
  carries GHSA-4r6h-8v6p-xvw6 (HIGH, prototype pollution, fixed in 0.19.3) and
  GHSA-5pgg-2g8v-p4x9 (HIGH, ReDoS, fixed in 0.20.2). SheetJS publishes 0.19 and later
  only on its own CDN. A `file:` tarball keeps `npm audit` visibility (npm evaluates
  the dependency by name and version), unlike a bare CDN URL.
- **Upstream URL:** <https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz>
- **Size:** 2,409,319 bytes.
- **SHA-512 (hex):**
  `a0b0eade3c3b01c2ea2961f60210a9553665f267fa5f661178ff8d7a1d12254cd5fc1759623b61f78b46e6da22301d4f3eb62dc4e09f6a850292fb6e1fedc024`
- **Lockfile integrity (SRI, base64):**
  `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`
- **License:** Apache-2.0 (SheetJS Community Edition; see `package/LICENSE` inside the
  tarball). Listed in `docs/licenses.md`.
- **Line endings:** `.gitattributes` marks `vendor/sheetjs/*.tgz` binary so no
  checkout converts the bytes.

### Fetch and verify

```bash
curl -fsSLo vendor/sheetjs/xlsx-0.20.3.tgz \
  https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
sha512sum vendor/sheetjs/xlsx-0.20.3.tgz
# expect a0b0eade3c3b01c2...6a850292fb6e1fedc024 (full hex above)
python -c "import base64,hashlib;print('sha512-'+base64.b64encode(hashlib.sha512(open('vendor/sheetjs/xlsx-0.20.3.tgz','rb').read()).digest()).decode())"
# expect the lockfile integrity string above
```

### Updating

1. Fetch the new tarball from `https://cdn.sheetjs.com/xlsx-<version>/xlsx-<version>.tgz`
   into `vendor/sheetjs/` and delete the old one.
2. Update the `file:` spec in all three `package.json` files and run `npm install` in
   each package so every lockfile records the new version and integrity.
3. Update this file, `docs/licenses.md`, and the pinned version in
   `tests/test_vendored_xlsx.py`; run
   `cd tests && python -m pytest test_vendored_xlsx.py -q`.
4. Dependabot is not relied on for `file:` dependencies; SheetJS currency is a manual
   check.
