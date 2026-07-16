# proprietary/

Reserved namespace for Tugra's **proprietary Pro & Cloud** packages.

This directory is intentionally **empty** in the open-source repository. The core
in this repo is AGPL-3.0 (see [`../LICENSE`](../LICENSE)); the Pro and Cloud
editions are a proprietary layer that is developed and shipped **separately**:

- Source lives in a **private repository**, never merged into this AGPL core.
- Packages use the reserved `@tugra/cloud-*` npm namespace.
- Proprietary code is **not** part of the OSS Docker image.

The open-source `requireEdition` gate (see
[`../docs/open-core.md`](../docs/open-core.md)) is where such features attach at
runtime, without any proprietary code entering this repository.

Keeping this placeholder documents the boundary so contributions and reviews can
tell open core from the proprietary layer at a glance.
