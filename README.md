# patchtogo

Security patches for npm packages that nobody is patching.

When a CVE lands on an unmaintained or slow-moving npm package, patchtogo forks it, fixes it in a public pull request and publishes the fix as `@patchtogo/<package>`, which you can swap in with `overrides`. Every PR commit ships as an unreviewed preview build. Stable releases need two reviewer approvals and are published from GitHub Actions with npm provenance.

See [patchtogo.ai](https://patchtogo.ai) for how it works.

## Development

Requires Node 24 and pnpm 12.

```sh
pnpm install
pnpm dev
pnpm docs:dev
```

`apps/agent` is the Node service (GitHub webhooks and the AI patching agent). `apps/docs` is the VitePress site.

## License

MIT. Patched packages keep their original license and attribution, and are provided without warranty.
