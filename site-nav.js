/* Shared slide-in nav drawer for the standalone pages (scanners,
   calculators, guides). These pages previously offered only "Home" and a
   couple of footer links, so arriving on one from search was a dead end —
   you could go back to the app but not sideways to any sibling page.

   Deliberately self-contained: it injects its own CSS as well as its own
   markup, because flipping-guide.html and runelite-plugin.html don't load
   finder-page.css. That keeps adoption to a single <script> tag per page
   and means no page needs to share a stylesheet to get the drawer.

   Colors are hardcoded rather than var()-based for the same reason — the
   custom-property names differ between finder-page.css and the pages with
   their own styles, so referencing them would silently render unstyled
   somewhere. Values mirror finder-page.css's palette. */
(function () {
  var LINKS = [
    { href: '/', label: 'Home — Trading Terminal' },
    { group: 'Scanners' },
    { href: '/high-vol-margins.html', label: 'High Volume Margins' },
    { href: '/low-vol-margins.html', label: 'Low Volume Margins' },
    { href: '/biggest-losers-24h.html', label: 'Biggest Losers (24h)' },
    { href: '/reliable-14d-margins.html', label: 'Reliable 14-Day Margins' },
    { href: '/at-5d-highs.html', label: 'At 5-Day Highs' },
    { href: '/at-5d-lows.html', label: 'At 5-Day Lows' },
    { group: 'Calculators & Guides' },
    { href: '/high-alch-calculator.html', label: 'High Alch Calculator' },
    { href: '/cannonball-profit-calculator.html', label: 'Cannonball Profit' },
    { href: '/flipping-guide.html', label: 'Flipping Guide' },
    { href: '/burnt-food-collectors.html', label: 'Burnt Food & Collectors' }
  ];

  var CSS = [
    '.sn-toggle{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;',
    'width:36px;height:36px;padding:0;border:none;background:transparent;color:#D0CABD;cursor:pointer;border-radius:6px}',
    '.sn-toggle:hover,.sn-toggle[aria-expanded="true"]{background:#1B1815;color:#fff}',
    '.sn-toggle svg{width:20px;height:20px;display:block}',
    /* The topbar is space-between with brand + CTA; adding a third item would
       strand the brand mid-row, so pin the CTA right and let the rest sit left. */
    '.topbar{justify-content:flex-start;gap:12px}',
    '.topbar .cta{margin-left:auto}',
    '.sn-drawer{position:fixed;top:0;bottom:0;left:0;z-index:1100;width:min(290px,84vw);',
    'display:flex;flex-direction:column;gap:2px;padding:10px;background:#1B1815;',
    'border-right:1px solid #2B2621;box-shadow:8px 0 34px rgba(0,0,0,.6);overflow-y:auto;',
    '-webkit-overflow-scrolling:touch;transform:translateX(-100%);visibility:hidden;',
    'transition:transform .22s ease,visibility .22s}',
    '.sn-drawer.open{transform:translateX(0);visibility:visible}',
    '.sn-backdrop{position:fixed;inset:0;z-index:1090;background:rgba(5,7,12,.6);',
    'backdrop-filter:blur(2px);opacity:0;visibility:hidden;transition:opacity .22s ease,visibility .22s}',
    '.sn-backdrop.open{opacity:1;visibility:visible}',
    /* Close control is a second hamburger in the same spot as the one that
       opened the drawer, not an × in the far corner — same button, same
       place, toggling both ways, so the pointer never crosses the panel to
       undo the tap it just made. Sizing mirrors .sn-toggle's. */
    '.sn-head{display:flex;align-items:center;gap:4px;padding:0 0 10px}',
    '.sn-brand{display:flex;align-items:center;gap:8px;font-weight:800;color:#fff;font-size:15px;text-decoration:none}',
    '.sn-brand img{width:20px;height:20px;image-rendering:pixelated}',
    '.sn-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;',
    'width:36px;height:36px;padding:0;background:transparent;border:none;color:#D0CABD;cursor:pointer;border-radius:6px}',
    '.sn-close svg{width:20px;height:20px;display:block}',
    '.sn-close:hover{color:#fff;background:#0C0B09}',
    '.sn-label{color:#8A8274;font-size:10px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;padding:10px 10px 4px}',
    '.sn-link{display:block;padding:9px 10px;border-radius:6px;color:#D0CABD;text-decoration:none;font-size:13.5px}',
    '.sn-link:hover{background:#0C0B09;color:#fff;text-decoration:none}',
    /* Current page marked rather than linked-to-itself, so the drawer always
       answers "where am I" as well as "where can I go". */
    '.sn-link[aria-current="page"]{color:#C9A64D;font-weight:700;background:rgba(201,166,77,.08)}'
  ].join('');

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var bar = document.querySelector('.topbar');
    if (!bar || document.querySelector('.sn-drawer')) return;

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    // Normalise "/x.html", "/x", and "/" so the current page highlights
    // regardless of how the host serves extensionless URLs.
    var here = location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (here !== '/' && here.slice(-1) === '/') here = here.slice(0, -1);

    var BURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"></line>'
      + '<line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg>';

    var html = '<div class="sn-head">'
      + '<button type="button" class="sn-close" aria-label="Close menu">' + BURGER + '</button>'
      + '<a class="sn-brand" href="/">'
      + '<img src="https://oldschool.runescape.wiki/images/Gilded_scimitar.png" alt="">PocketGE</a></div>';
    LINKS.forEach(function (l) {
      if (l.group) { html += '<div class="sn-label">' + l.group + '</div>'; return; }
      var target = l.href.replace(/\.html$/, '');
      if (target !== '/' && target.slice(-1) === '/') target = target.slice(0, -1);
      html += '<a class="sn-link" href="' + l.href + '"'
        + (target === here ? ' aria-current="page"' : '') + '>' + l.label + '</a>';
    });

    var drawer = document.createElement('nav');
    drawer.className = 'sn-drawer';
    drawer.setAttribute('aria-label', 'Site menu');
    drawer.innerHTML = html;

    var backdrop = document.createElement('div');
    backdrop.className = 'sn-backdrop';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sn-toggle';
    toggle.setAttribute('aria-label', 'Open menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = BURGER;

    bar.insertBefore(toggle, bar.firstChild);
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);

    function set(open) {
      drawer.classList.toggle('open', open);
      backdrop.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    toggle.addEventListener('click', function (e) { e.stopPropagation(); set(!drawer.classList.contains('open')); });
    backdrop.addEventListener('click', function () { set(false); });
    drawer.addEventListener('click', function (e) { if (e.target.closest('a,.sn-close')) set(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  });
})();
