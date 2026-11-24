# Publishing the alpha

The 16 `@vibecore/*` packages are prepared as `0.1.0-alpha.1`, with MIT licensing,
public access, and the `alpha` tag. The workspace root remains private and must
never be published. This preparation is not proof of an npm release or production
readiness. Nginx server activation, certificate lifecycle, and live-provider
acceptance remain incomplete. The private website is not part of this release.

## Before publication

Use the pinned pnpm version and Node 22 or 24. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:package
pnpm test:tarballs
pnpm test:nginx
git diff --check
git status --short
```

Review and intentionally commit the release files, push them, and verify GitHub
CI. Do not bypass pnpm Git checks or blindly stage unrelated changes. Authenticate
locally with npm and verify that the account can publish under `@vibecore`.
Never paste credentials or OTPs into chat, source, or documentation.

## Publish

Only after those checks, from the clean, up-to-date main branch:

```sh
pnpm -r publish --access public --tag alpha
```

This is an external write: it publishes packages to npm. It is not a dry run.
Complete any authentication challenge locally. Publication is not atomic across
packages: if interrupted, inspect which versions exist before retrying. Never
reuse an already published version for different contents or promote to `latest`
just to resolve a failure.

## Verify the registry result

Check every published package/version, then test from an empty directory outside
the source checkout:

```sh
npm view @vibecore/cli@0.1.0-alpha.1 version
npm view @vibecore/cli dist-tags --json
npx --yes @vibecore/cli@0.1.0-alpha.1 --version
npx --yes @vibecore/cli@0.1.0-alpha.1 --help
```

Only advertise `npx @vibecore/cli@alpha` after the registry and fresh-install
checks pass. These checks execute the published CLI; use a disposable directory.
