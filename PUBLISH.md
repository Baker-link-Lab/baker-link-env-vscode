# Releasing the Baker Link Env VS Code Extension

GitHub Actions builds a release VSIX. It does not publish to the VS Code
Marketplace or Open VSX; upload the VSIX to the Marketplace manually.

## Release

1. Update `version` in [package.json](package.json) and both root version fields
   in [package-lock.json](package-lock.json). Update [CHANGELOG.md](CHANGELOG.md).
   The extension version is independent of the desktop app.
2. Commit the changes and create a GitHub Release in
   `Baker-link-Lab/baker-link-env-vscode` with a matching `vX.Y.Z` tag.
3. Publishing the GitHub Release triggers
   [Build Release VSIX](.github/workflows/release.yml). It validates the version,
   runs checks and tests, and packages the minified extension.
4. Download `baker-link-env.vsix` from the GitHub Release assets. It is also
   available as the workflow artifact `baker-link-env-vsix`.
5. Upload that VSIX through the
   [baker-link-lab publisher management page](https://marketplace.visualstudio.com/manage/publishers/baker-link-lab)
   and verify the Marketplace version.

Draft releases do not trigger the workflow. No Marketplace credentials, Azure
configuration, or `BAKER_LINK_PUBLISH_ENABLED` variable are required.
The workflow uses GitHub's automatic token only to attach the release asset.

## Local build

```sh
npm ci
npm test
npm run package
```

The output is `baker-link-env-X.Y.Z.vsix`. Packaging runs `vscode:prepublish`,
which builds the minified release bundle. A VSIX or GitHub Release does not
imply Marketplace publication.
