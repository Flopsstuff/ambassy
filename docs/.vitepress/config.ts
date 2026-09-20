import { defineConfig } from 'vitepress';

/**
 * The documentation site: the Markdown in `docs/`, with navigation around it.
 *
 * Everything structural lives here rather than in front matter, so the pages stay plain
 * Markdown — they are read in the repository at least as often as on the web, and a file
 * that opens with six lines of `nav_order:` is worse to read there for the sake of being
 * better to read here.
 */
export default defineConfig({
  title: 'Ambassy',
  description: 'A sandbox for the A2A protocol, and a bridge from it to a real coding agent.',
  // The site is served from a repository path, not a domain of its own.
  base: '/ambassy/',
  cleanUrls: true,
  lastUpdated: true,

  themeConfig: {
    nav: [
      { text: 'Architecture', link: '/architecture' },
      { text: 'A2A', link: '/a2a' },
      { text: 'Bridges', link: '/acp-bridge' },
      { text: 'Audit', link: '/repository-audit' },
    ],

    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'The A2A side', link: '/a2a' },
        ],
      },
      {
        text: 'The bridges',
        items: [
          { text: 'The ACP bridge', link: '/acp-bridge' },
          { text: 'The MCP bridge', link: '/mcp-bridge' },
          { text: 'Permissions', link: '/permissions' },
        ],
      },
      {
        text: 'Running it',
        items: [
          { text: 'Configuration', link: '/configuration' },
          { text: 'As a service', link: '/service' },
          { text: 'Logging', link: '/logging' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ],
      },
      {
        text: 'Keeping it honest',
        items: [
          { text: 'Tests', link: '/testing' },
          { text: 'Repository audit', link: '/repository-audit' },
        ],
      },
    ],

    search: { provider: 'local' },
    outline: 'deep',
    socialLinks: [{ icon: 'github', link: 'https://github.com/Flopsstuff/ambassy' }],
    editLink: {
      pattern: 'https://github.com/Flopsstuff/ambassy/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Apache License 2.0',
      copyright: 'Flopsstuff',
    },
  },
});
