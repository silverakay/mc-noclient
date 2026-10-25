# Release Rules

- Every delivered application update increments the minor version once: V5.1, V5.2, V5.3, and so on. Do not reuse the previous version or increment only the patch number.
- Use valid internal SemVer: the V5.1 release is `5.1.0`; the next release is `5.2.0`. Multiple fixes within one unreleased update share that update's version.
- Keep `package.json`, the root version entries in `package-lock.json`, the visible version in `app/renderer/index.html`, release notes, and artifact names consistent. Do not change dependency versions when bumping the application version.
- Preserve old release directories and user data. Never include account credentials or bridge pairing secrets in public packages.
- User override on 2026-10-24: V6.0 and later do not require signing; keep `build.forceCodeSigning: false`. Label unsigned artifacts and release notes clearly. Never claim publisher verification, substitute certificates, install trust roots, or weaken Windows application control. Successful packaging alone does not prove the executable can start.
- The explicitly requested V6.0 release uses internal SemVer `6.0.0`; subsequent updates increment the minor version once.
