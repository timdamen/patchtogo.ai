---
layout: home

hero:
  name: patchtogo
  text: Security patches for npm packages that nobody is patching
  tagline: When a CVE lands on an unmaintained or slow-moving package, patchtogo forks it, fixes it in the open and publishes a drop-in replacement you can pin with overrides.
  actions:
    - theme: brand
      text: How it works
      link: /how-it-works
    - theme: alt
      text: GitHub
      link: https://github.com/timdamen/patchtogo.ai

features:
  - title: Fast
    details: An agent picks up new advisories right away, drafts a minimal fix plus an exploit regression test, and publishes a preview build from the pull request.
  - title: Reviewable
    details: Every patch is a public pull request. A named group of reviewers approves each fix before it reaches the stable channel.
  - title: Verifiable
    details: Stable releases come from GitHub Actions with npm provenance, so you can trace every published tarball back to the exact commit.
---
