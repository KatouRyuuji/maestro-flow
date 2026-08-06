# Vendored Transformers.js runtime

`transformers/` is copied without source changes from the official
`@huggingface/transformers@3.8.1` npm tarball. Maestro loads the vendored Node.js
bundle through the `#maestro-transformers` package import.

The upstream package declares `sharp@^0.34.1`. Maestro instead declares the
vendored runtime dependencies directly and requires `sharp@^0.35.3`, because
`sharp <0.35.0` is affected by GHSA-f88m-g3jw-g9cj (CVE-2026-33327,
CVE-2026-33328, CVE-2026-35590, and CVE-2026-35591).

Source package: https://www.npmjs.com/package/@huggingface/transformers/v/3.8.1
License: Apache-2.0 (`transformers/LICENSE`)
Official tarball SHA-256: `207714c36765b87accfd9b7b0672c3505805af97140990e0d9f8ac6e3cd5471e`

The vendored code should be removed and the registry dependency restored after
an upstream Transformers.js release accepts `sharp >=0.35.0`.
