// Declare only device-proven page routes: omission serves native on older shells/update screen on current ones, not automatic bundler reachability.
// Required grants gate entire route; declare only after supporting shell ships. Optional grants hide one affordance on otherwise complete page.
// Builder owns declarations and manifest checks MobileWebBundleRouteSchema. Haptics census derives required token from every reachable seam.
export const MOBILE_WEB_PAGE_ROUTES = [
  // Home needs navigate/storage for session hops and app pins; shared protocol-wall Update action needs externalLink. Wide ownsHostArea permits sidebar.
  {
    pathname: '/h/[hostId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics'],
    canOwnHostArea: true
  },
  // History needs navigate for session/resume, storage for shared sidebar width and externalLink for layout protocol wall.
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // Tasks needs navigate/storage plus provider externalLink and comment-review clipboard writes; grants persist from opening route.
  {
    pathname: '/h/[hostId]/tasks',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // Accounts needs navigate/storage/externalLink for Back/shared layout wall; haptics census requires seam grant.
  {
    pathname: '/h/[hostId]/accounts',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // Create Workspace overlay needs navigate to close/open session; shared form/layout supply other grants.
  {
    pathname: '/h/[hostId]/new-workspace',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // The paired desktop's machines, read-only with Wake and Sleep; grants as for accounts.
  {
    pathname: '/h/[hostId]/machines',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // The file explorer. `navigate` because its Back pops the native stack. `storage` for the shared
  // components the host layout renders above it.
  //
  // `externalLink` is the layout wall's here, the single opener the census finds in this closure:
  // nothing the explorer itself renders opens a URL. It is also inherited, and that is what makes
  // the hop below cheap: a row opens the preview, and because that is a page route and this list
  // covers what it declares, the handoff keeps that push inside this document.
  // Grants are resolved once, from the route the shell opened (`grantsForRoute` on
  // `session.routePathname`), so a preview reached that way runs under *this* route's grants for
  // the life of the session. Covering the preview is therefore what buys the cheap in-document hop,
  // not what makes it correct: a target this list did not cover would be handed to the shell and
  // reopened under its own grants instead. The census beside it reads that relation off this list.
  //
  // `native.clipboard.write` covers source Copy in a preview opened inside this document.
  {
    pathname: '/h/[hostId]/files/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    // Older shells cannot open PDFs; the preview asks for an app update instead.
    optionalGrants: ['native.pdf.view']
  },
  // Preview itself uses Markdown externalLink and Source Copy clipboard; explorer inherits same grants for in-document hop.
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    optionalGrants: ['native.pdf.view']
  },
  // Hub grants cover Back/review navigation, shared storage, PR link openers and conflict-command Copy.
  // Keep pr/history Redirects native: listing them would leave page session bound to pathname redirect already left; native replaces into hub once.
  {
    pathname: '/h/[hostId]/source-control/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // Review grants cover Back/native-session navigation, shared layout, PR links and copy-notes.
  // Match hub grants so both directions stay in-document under opening session’s capabilities; census detects future mismatch.
  {
    pathname: '/h/[hostId]/review/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // Session alone needs media/audio/screencast grants: native clipboard read/write, navigation/storage/external links/haptics come from actual closure callers.
  // Media pick/read/release are all-or-none; partial set can start handle upload it cannot finish. Audio start/read/stop likewise must permit closing mic; device owns wake lock.
  // screencastBinary lets the pane request wantsBinary from shells that encode frames.
  // Keep externalNavigation optional: older shells still render complete artifact with links inert, rather than sending entire session native. Grant/closure censuses pin callers.
  {
    pathname: '/h/[hostId]/session/[worktreeId]',
    grants: [
      'navigate',
      'storage',
      'externalLink',
      'haptics',
      'screencastBinary',
      'native.clipboard.write',
      'native.clipboard.read',
      'native.media.pick',
      'native.media.read',
      'native.media.release',
      'native.audio.start',
      'native.audio.read',
      'native.audio.stop'
    ],
    // Optional media.name preserves attachment on older shells by falling back to filename derived from type.
    optionalGrants: ['externalNavigation', 'native.media.name', 'native.pdf.view']
  }
]
