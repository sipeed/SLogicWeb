# Deployment

[The deployment workflow](../.github/workflows/deploy-pages.yml) builds on pushes to
`main` and publishes the same artifact to GitHub Pages and Qiniu. It includes the
analyzer, decoder runtime, offline shell, and OTA pages. Build output is not committed.

## Configuration

- Set GitHub Pages to **GitHub Actions** and allow deployments from `main`.
- Set the repository variable `QINIU_BUCKET` to a public-read bucket in the uploader's
  supported region (`z2`).
- Add repository secrets `QINIU_ACCESS_KEY` and `QINIU_SECRET_KEY`.

The workflow checks out submodules, vendors runtime assets, runs checks, and stages
`sub_service/ota` under `/ota/`. Refer to the workflow for the exact build commands.
The hosted build uses an absolute base of `/`.

## Hosting requirements

- Use HTTPS for WebUSB. Serve `.wasm` as `application/wasm` and JavaScript modules
  with a JavaScript MIME type.
- Keep HTML, `sw.js`, manifests, and other mutable entry points fresh. Content-hashed
  assets may be cached; retain old hashed files so open tabs remain usable.
- Serve `/ota/` as a directory. The bare `/ota` URL must navigate there before its
  relative scripts and styles load. Missing assets must return 404.

[The publisher](../.github/scripts/upload-qiniu.mjs) uploads resources before HTML
and the service worker, then the workflow refreshes and verifies CDN content.
Incomplete uploads fail the job.

## Verification

```sh
node --test .github/scripts/upload-qiniu.test.mjs
```

Before publishing, check that the analyzer and both OTA pages load, decoder assets
have the correct MIME types, and refreshed entry points match the build artifact.
