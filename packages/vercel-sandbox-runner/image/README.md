# Vercel Sandbox runner image

This directory defines the M08 custom OCI image. It is evaluation-only and may
be published solely to the linked non-production project's `sandbox-benchmark`
VCR repository. Never place environment files or credentials in the build
context; the repository `.dockerignore` excludes them.

## Required build and publication gates

1. Use an organization-approved, non-production Vercel project and review VCR/Sandbox public-beta terms, region, retention, and access controls.
2. Build from a clean, reviewed commit with the repository-root build context:

   ```text
   docker buildx build --platform linux/amd64 --file packages/vercel-sandbox-runner/image/Containerfile --build-arg SOURCE_REVISION=<full-commit> --tag vcr.vercel.com/<team>/<project>/ai-website-runner:<full-commit> .
   ```

3. Run the image locally without credentials and require the broker self-check, non-root default user, absent `sudo`, fixed executable paths, read-only broker files, and empty environment/host mounts.
4. Authenticate to VCR only with project-scoped OIDC or an approved short-lived token supplied through standard input. Never write the token into this repository, the image, build arguments, logs, or shell history.
5. Push the commit tag, resolve the VCR-reported immutable `sha256` digest, and create the approved manifest with the exact `repository@sha256:<digest>` reference and `vercelRunnerImageSpecDigest()` value. Mutable tags are not accepted by the adapter.
6. Boot a non-persistent Sandbox from that digest and run the forbidden-host-resource suite before changing ADR-019 from live-acceptance-pending. Invoke the broker with the Sandbox API's explicit privileged-command option; the image deliberately contains no `sudo` executable.

The image intentionally contains no repository source, provider credential, production secret, Docker daemon, or `sudo`. The provider-started root broker accepts only fixed-path, mode-restricted UID/GID 10001 staging files, deletes each control file before use, enforces the image's fixed maximum limits, and drops permanently to UID/GID 10001 before checkout or untrusted command execution.
